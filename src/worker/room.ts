// One Durable Object per room. It owns the sockets and the storage, and
// hands every game decision to the pure reducer in game.ts.
//
// Sockets use the hibernation API: when the pub goes quiet between rounds
// the object can be evicted from memory without dropping any phones. On
// wake-up the constructor reloads state from storage and each socket's
// role comes back from its serialised attachment.

import { DurableObject } from "cloudflare:workers";
import { LIMITS, ROOM_IDLE_TTL_MS } from "../shared/limits";
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type AuthMessage,
  type ErrorCode,
  type HostCommand,
  type RoleView,
  type ServerMessage,
  type TeamCommand,
} from "../shared/protocol";
import type { Quiz } from "../shared/quiz";
import type { Env } from "./env";
import {
  createRoom,
  expire,
  findTeamByToken,
  isHostToken,
  joinTeam,
  nextDeadline,
  reduce,
  type QuestionState,
  type RoomState,
} from "./game";
import { randomId } from "./ids";
import { CLOSE_FLOODING, SOCKET_DROP_LIMIT, SOCKET_MESSAGES, TokenBucket } from "./ratelimit";
import { hostView, screenView, teamView } from "./views";

type Attachment = { role: "pending" } | { role: "host" } | { role: "screen" } | { role: "team"; teamId: string };

/** Everything except the quiz and per-question records, which are stored under their own keys. */
type Meta = Omit<RoomState, "quiz" | "questions">;

const Q_PREFIX = "q:";

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class Room extends DurableObject<Env> {
  private room: RoomState | null = null;
  /**
   * Message budgets per socket. Held in memory only: if the room hibernates
   * the budgets start full again, which is fine because a quiet room is not
   * being flooded.
   */
  private buckets = new WeakMap<WebSocket, TokenBucket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    void ctx.blockConcurrencyWhile(async () => {
      this.room = await this.load();
    });
  }

  // -------------------------------------------------------------------------
  // Storage

  private async load(): Promise<RoomState | null> {
    const meta = await this.ctx.storage.get<Meta>("meta");
    if (!meta) return null;
    const quiz = (await this.ctx.storage.get<Quiz>("quiz")) ?? null;
    const stored = await this.ctx.storage.list<QuestionState>({ prefix: Q_PREFIX });
    const questions: Record<string, QuestionState> = {};
    for (const [key, value] of stored) questions[key.slice(Q_PREFIX.length)] = value;
    return { ...meta, quiz, questions };
  }

  /**
   * Writes only what changed. The reducer never mutates, so a changed
   * question record is simply one whose object identity differs.
   */
  private async save(prev: RoomState | null, next: RoomState): Promise<void> {
    const { quiz, questions, ...meta } = next;
    const puts: [string, unknown][] = [["meta", meta]];
    const deletes: string[] = [];
    if (!prev || prev.quiz !== quiz) {
      if (quiz) puts.push(["quiz", quiz]);
      else deletes.push("quiz");
    }
    for (const [key, qs] of Object.entries(questions)) {
      if (!prev || prev.questions[key] !== qs) puts.push([Q_PREFIX + key, qs]);
    }
    if (prev) for (const key of Object.keys(prev.questions)) if (!(key in questions)) deletes.push(Q_PREFIX + key);
    for (const part of chunk(puts, 128)) await this.ctx.storage.put(Object.fromEntries(part));
    for (const part of chunk(deletes, 128)) await this.ctx.storage.delete(part);
  }

  private async scheduleAlarm(): Promise<void> {
    if (!this.room) return;
    const expiry = this.room.updatedAt + ROOM_IDLE_TTL_MS;
    const deadline = nextDeadline(this.room);
    await this.ctx.storage.setAlarm(deadline !== null ? Math.min(deadline, expiry) : expiry);
  }

  private async commit(next: RoomState): Promise<void> {
    const prev = this.room;
    this.room = next;
    await this.save(prev, next);
    await this.scheduleAlarm();
    this.dropRemovedTeams();
    this.broadcast();
  }

  /** Deletes every trace of the room and disconnects everyone. */
  private async destroy(reason: string): Promise<void> {
    this.room = null;
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, { type: "closed", reason });
      try {
        ws.close(4000, "room closed");
      } catch {
        // Already closing.
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // -------------------------------------------------------------------------
  // HTTP entry points (called by the Worker, never directly by browsers)

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      if (this.room) return new Response("exists", { status: 409 });
      const body = (await request.json()) as { code: string; hostToken: string };
      await this.commit(createRoom(body.code, body.hostToken, Date.now()));
      return new Response(null, { status: 201 });
    }

    if (url.pathname === "/info") {
      if (!this.room) return Response.json({ exists: false }, { status: 404 });
      return Response.json({ exists: true, quizTitle: this.room.quiz?.title ?? null, teams: this.room.teams.length });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      if (!this.room) return new Response("Room not found", { status: 404 });
      if (this.ctx.getWebSockets().length >= LIMITS.socketsPerRoom) {
        return new Response("Room is full", { status: 503 });
      }
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ role: "pending" } satisfies Attachment);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  // -------------------------------------------------------------------------
  // WebSocket handlers

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (!this.room) {
      this.send(ws, { type: "closed", reason: "This room has ended." });
      ws.close(4000, "room closed");
      return;
    }
    if (!this.withinBudget(ws)) return;
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) return this.sendError(ws, "bad_message", parsed.error);
    const msg = parsed.message;
    const att = this.attachment(ws);

    if (msg.type.startsWith("auth.")) {
      if (att.role !== "pending") return this.sendError(ws, "bad_message", "This connection has already joined.");
      return this.authenticate(ws, msg as AuthMessage);
    }

    if (att.role === "pending" || att.role === "screen") {
      return this.sendError(ws, "not_authorised", "This connection cannot send commands.");
    }

    if (msg.type === "host.closeRoom") {
      if (att.role !== "host") return this.sendError(ws, "not_authorised", "Only the quizmaster can do that.");
      return this.destroy("The quizmaster has closed this room. Thanks for playing.");
    }

    const actor = att.role === "host" ? ({ role: "host" } as const) : ({ role: "team", teamId: att.teamId } as const);
    const result = reduce(this.room, actor, msg as HostCommand | TeamCommand, Date.now());
    if (!result.ok) return this.sendError(ws, result.error.code, result.error.message);
    await this.commit(result.state);
  }

  /**
   * Charges one message to the socket's budget. Over budget, the message is
   * dropped with an occasional warning; a socket that keeps going is closed.
   */
  private withinBudget(ws: WebSocket): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(ws);
    if (!bucket) {
      bucket = new TokenBucket(SOCKET_MESSAGES, now);
      this.buckets.set(ws, bucket);
    }
    if (bucket.take(now)) return true;
    if (bucket.dropped >= SOCKET_DROP_LIMIT) {
      try {
        ws.close(CLOSE_FLOODING, "too many messages");
      } catch {
        // Already closing.
      }
    } else if (bucket.dropped === 1 || bucket.dropped % 10 === 0) {
      this.sendError(ws, "rate_limited", "Slow down: that was too many messages at once. Some were ignored.");
    }
    return false;
  }

  private async authenticate(ws: WebSocket, msg: AuthMessage): Promise<void> {
    const room = this.room!;
    switch (msg.type) {
      case "auth.host": {
        if (!isHostToken(room, msg.hostToken)) {
          this.sendError(ws, "not_authorised", "That host link is not valid for this room.");
          ws.close(4001, "not authorised");
          return;
        }
        this.setAttachment(ws, { role: "host" });
        this.send(ws, { type: "welcome", role: "host", protocol: PROTOCOL_VERSION });
        this.sendState(ws);
        return;
      }
      case "auth.screen": {
        this.setAttachment(ws, { role: "screen" });
        this.send(ws, { type: "welcome", role: "screen", protocol: PROTOCOL_VERSION });
        this.sendState(ws);
        return;
      }
      case "auth.join": {
        const result = joinTeam(room, msg.name, { teamId: randomId(9), token: randomId(24) }, Date.now());
        if (!result.ok) return this.sendError(ws, result.error.code, result.error.message);
        const { team } = result.state;
        this.setAttachment(ws, { role: "team", teamId: team.id });
        this.send(ws, { type: "welcome", role: "team", protocol: PROTOCOL_VERSION, teamId: team.id, token: team.token, name: team.name });
        await this.commit(result.state.room);
        return;
      }
      case "auth.resume": {
        const team = findTeamByToken(room, msg.token);
        if (!team) return this.sendError(ws, "unknown_token", "We could not find your team in this room. You may need to join again.");
        this.setAttachment(ws, { role: "team", teamId: team.id });
        this.send(ws, { type: "welcome", role: "team", protocol: PROTOCOL_VERSION, teamId: team.id, token: team.token, name: team.name });
        // Everyone else learns the team is back online.
        this.broadcast();
        return;
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // The runtime may already have completed the close handshake.
    }
    if (this.room && this.attachment(ws).role === "team") this.broadcast(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    if (this.room && this.attachment(ws).role === "team") this.broadcast(ws);
  }

  override async alarm(): Promise<void> {
    if (!this.room) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const now = Date.now();
    if (now >= this.room.updatedAt + ROOM_IDLE_TTL_MS) {
      await this.destroy("This room closed after being idle for a long time.");
      return;
    }
    const next = expire(this.room, now);
    if (next !== this.room) await this.commit(next);
    else await this.scheduleAlarm();
  }

  // -------------------------------------------------------------------------
  // Fan-out

  private attachment(ws: WebSocket): Attachment {
    return (ws.deserializeAttachment() as Attachment | null) ?? { role: "pending" };
  }

  private setAttachment(ws: WebSocket, att: Attachment): void {
    ws.serializeAttachment(att);
  }

  private openSockets(exclude?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws !== exclude && ws.readyState === WebSocket.OPEN);
  }

  private connectedTeams(exclude?: WebSocket): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.openSockets(exclude)) {
      const att = this.attachment(ws);
      if (att.role === "team") ids.add(att.teamId);
    }
    return ids;
  }

  private viewFor(ws: WebSocket, connected: ReadonlySet<string>, cache: Map<string, RoleView | null>): RoleView | null {
    const room = this.room;
    if (!room) return null;
    const att = this.attachment(ws);
    const cacheKey = att.role === "team" ? `team:${att.teamId}` : att.role;
    if (cache.has(cacheKey)) return cache.get(cacheKey)!;
    let view: RoleView | null = null;
    if (att.role === "host") view = hostView(room, connected);
    else if (att.role === "screen") view = screenView(room, connected);
    else if (att.role === "team") view = teamView(room, connected, att.teamId);
    cache.set(cacheKey, view);
    return view;
  }

  private sendState(ws: WebSocket): void {
    const view = this.viewFor(ws, this.connectedTeams(), new Map());
    if (view) this.send(ws, { type: "state", view, serverNow: Date.now() });
  }

  /** Sends every connected client its own fresh view. */
  private broadcast(exclude?: WebSocket): void {
    const connected = this.connectedTeams(exclude);
    const cache = new Map<string, RoleView | null>();
    const serverNow = Date.now();
    for (const ws of this.openSockets(exclude)) {
      const view = this.viewFor(ws, connected, cache);
      if (view) this.send(ws, { type: "state", view, serverNow });
    }
  }

  private dropRemovedTeams(): void {
    const room = this.room;
    if (!room) return;
    const present = new Set(room.teams.map((t) => t.id));
    for (const ws of this.openSockets()) {
      const att = this.attachment(ws);
      if (att.role === "team" && !present.has(att.teamId)) {
        this.send(ws, { type: "kicked" });
        this.setAttachment(ws, { role: "pending" });
        try {
          ws.close(4003, "removed by quizmaster");
        } catch {
          // Already closing.
        }
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // The socket closed between listing and sending. Its close handler tidies up.
    }
  }

  private sendError(ws: WebSocket, code: ErrorCode, message: string): void {
    this.send(ws, { type: "error", code, message });
  }
}
