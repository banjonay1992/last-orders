// End-to-end tests of the Worker and the room Durable Object, running in
// the real Workers runtime through @cloudflare/vitest-plugin. Clients talk
// to the room over genuine WebSockets.

import { evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../../src/shared/limits";
import type { HostView, ScreenView, ServerMessage, TeamView } from "../../src/shared/protocol";
import type { QuizInput } from "../../src/shared/quiz";
import { CLOSE_RATE_LIMITED, handleApi } from "../../src/worker/index";
import { RATE_POLICIES } from "../../src/worker/ratelimit";
import { CLOSE_FLOODING } from "../../src/worker/room";

const ORIGIN = "https://quiz.test";

// Requests are rate limited per client IP, so each test gets its own
// made-up address from the documentation range unless it asks for one.
let ipCounter = 0;
const freshIp = () => `198.51.100.${++ipCounter}`;
let testIp = freshIp();
const ipHeaders = (ip = testIp) => ({ "CF-Connecting-IP": ip });

const QUIZ: QuizInput = {
  format: "last-orders-quiz",
  version: 1,
  title: "Worker test",
  rounds: [
    { title: "Answers", questions: [{ type: "choice", prompt: "Pick B", options: ["A", "B"], answer: 1, timeLimitSeconds: 30 }] },
    { title: "Buzz", mode: "buzzer", questions: [{ type: "text", prompt: "Say yes", answers: ["yes"] }] },
  ],
};

class Client {
  readonly messages: ServerMessage[] = [];
  private cursor = 0;
  private wake: (() => void) | null = null;

  closeCode: number | null = null;

  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      if (event.data === "pong") return;
      this.messages.push(JSON.parse(event.data as string) as ServerMessage);
      this.wake?.();
    });
    ws.addEventListener("close", (event) => {
      this.closeCode = event.code;
      this.wake?.();
    });
  }

  async closed(timeoutMs = 3000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.closeCode === null) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the socket to close");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.closeCode;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Resolves with the next message (after earlier waits) that matches. */
  async next<T extends ServerMessage>(match: (m: ServerMessage) => m is T, timeoutMs?: number): Promise<T>;
  async next(match: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  async next(match: (m: ServerMessage) => boolean, timeoutMs = 3000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = this.cursor; i < this.messages.length; i++) {
        if (match(this.messages[i]!)) {
          this.cursor = i + 1;
          return this.messages[i]!;
        }
      }
      if (Date.now() > deadline) throw new Error(`Timed out. Saw: ${JSON.stringify(this.messages.slice(this.cursor))}`);
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, 50);
      });
    }
  }

  async state<V = HostView | TeamView | ScreenView>(where: (v: V) => boolean = () => true): Promise<V> {
    const msg = await this.next((m) => m.type === "state" && where(m.view as V));
    return (msg as Extract<ServerMessage, { type: "state" }>).view as V;
  }

  async error(): Promise<Extract<ServerMessage, { type: "error" }>> {
    return (await this.next((m) => m.type === "error")) as Extract<ServerMessage, { type: "error" }>;
  }
}

async function createRoom(): Promise<{ code: string; hostToken: string }> {
  testIp = freshIp();
  const res = await SELF.fetch(`${ORIGIN}/api/rooms`, { method: "POST", headers: ipHeaders() });
  expect(res.status).toBe(201);
  return res.json();
}

async function connect(code: string, first?: unknown, ip = testIp): Promise<Client> {
  const res = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/ws`, { headers: { Upgrade: "websocket", ...ipHeaders(ip) } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const client = new Client(ws);
  if (first) client.send(first);
  return client;
}

async function hostOf(room: { code: string; hostToken: string }): Promise<Client> {
  const host = await connect(room.code, { type: "auth.host", hostToken: room.hostToken });
  await host.next((m) => m.type === "welcome");
  await host.state();
  return host;
}

async function joinAs(code: string, name: string): Promise<{ client: Client; teamId: string; token: string }> {
  const client = await connect(code, { type: "auth.join", name });
  const welcome = (await client.next((m) => m.type === "welcome")) as Extract<ServerMessage, { type: "welcome" }>;
  return { client, teamId: welcome.teamId!, token: welcome.token! };
}

const stub = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(code));

describe("HTTP API", () => {
  it("creates rooms with four-letter codes and reports on them", async () => {
    const room = await createRoom();
    expect(room.code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(room.hostToken.length).toBeGreaterThanOrEqual(32);
    const info = await SELF.fetch(`${ORIGIN}/api/rooms/${room.code.toLowerCase()}`);
    expect(await info.json()).toEqual({ exists: true, quizTitle: null, teams: 0 });
  });

  it("returns 404 for rooms that do not exist and 400 for malformed codes", async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/rooms/ZZZZ`)).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/api/rooms/AEIOU`)).status).toBe(400);
    const ws = await SELF.fetch(`${ORIGIN}/api/rooms/ZZZZ/ws`, { headers: { Upgrade: "websocket" } });
    expect(ws.status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/api/nothing`)).status).toBe(404);
  });

  it("insists on a WebSocket upgrade for the socket route", async () => {
    const room = await createRoom();
    expect((await SELF.fetch(`${ORIGIN}/api/rooms/${room.code}/ws`)).status).toBe(426);
  });
});

describe("room over WebSockets", () => {
  it("seats a team and shows it to the host and the big screen", async () => {
    const room = await createRoom();
    const host = await hostOf(room);
    const screen = await connect(room.code, { type: "auth.screen" });
    await screen.state();
    const { client, teamId, token } = await joinAs(room.code, "  Quiz   Team Aguilera ");
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const teamState = await client.state<TeamView>();
    expect(teamState.me).toMatchObject({ id: teamId, name: "Quiz Team Aguilera", connected: true });
    const hv = await host.state<HostView>((v) => v.teams.length === 1);
    expect(hv.teams[0]!.name).toBe("Quiz Team Aguilera");
    await screen.state<ScreenView>((v) => v.teams.length === 1);
  });

  it("refuses commands before authentication, from the screen and with a bad host token", async () => {
    const room = await createRoom();
    const anon = await connect(room.code);
    anon.send({ type: "host.open" });
    expect((await anon.error()).code).toBe("not_authorised");

    const screen = await connect(room.code, { type: "auth.screen" });
    await screen.state();
    screen.send({ type: "host.loadQuiz", quiz: QUIZ });
    expect((await screen.error()).code).toBe("not_authorised");

    const fake = await connect(room.code, { type: "auth.host", hostToken: "x".repeat(32) });
    expect((await fake.error()).code).toBe("not_authorised");

    const junk = await connect(room.code);
    junk.send("{not json");
    expect((await junk.error()).code).toBe("bad_message");
  });

  it("refuses a duplicate team name", async () => {
    const room = await createRoom();
    await joinAs(room.code, "Twins");
    const second = await connect(room.code, { type: "auth.join", name: "twins" });
    expect((await second.error()).code).toBe("name_taken");
  });

  it("lets a phone take back its seat after dropping, even after the room is evicted from memory", async () => {
    const room = await createRoom();
    const host = await hostOf(room);
    host.send({ type: "host.loadQuiz", quiz: QUIZ });
    await host.state<HostView>((v) => v.quiz !== null);
    const { client, teamId, token } = await joinAs(room.code, "Resumers");
    host.send({ type: "host.goto", stage: { kind: "question", round: 0, question: 0 } });
    host.send({ type: "host.open" });
    await client.state<TeamView>((v) => v.question?.phase === "open");
    client.send({ type: "team.answer", questionKey: "0.0", value: 1 });
    await client.state<TeamView>((v) => v.myAnswer?.value === 1);

    // The phone locks: its socket closes. The host sees it go offline.
    client.ws.close(1000, "screen locked");
    await host.state<HostView>((v) => v.teams[0]?.connected === false);

    // The room goes quiet and is evicted from memory; storage survives.
    host.ws.close(1000, "lid closed");
    await evictDurableObject(stub(room.code), { webSockets: "close" });

    const again = await connect(room.code, { type: "auth.resume", token });
    const welcome = await again.next((m) => m.type === "welcome");
    expect(welcome).toMatchObject({ role: "team", teamId, name: "Resumers" });
    const view = await again.state<TeamView>();
    expect(view.me.connected).toBe(true);
    expect(view.question?.phase).toBe("open");
    expect(view.myAnswer?.value).toBe(1);

    const stranger = await connect(room.code, { type: "auth.resume", token: "y".repeat(32) });
    expect((await stranger.error()).code).toBe("unknown_token");
  });

  it("schedules an alarm for a question's deadline", async () => {
    const room = await createRoom();
    const host = await hostOf(room);
    host.send({ type: "host.loadQuiz", quiz: QUIZ });
    host.send({ type: "host.goto", stage: { kind: "question", round: 0, question: 0 } });
    host.send({ type: "host.open" });
    const view = await host.state<HostView>((v) => v.question?.phase === "open");
    const alarm = await runInDurableObject(stub(room.code), (_instance, state) => state.storage.getAlarm());
    expect(view.question?.closesAt).not.toBeNull();
    expect(alarm).toBe(view.question!.closesAt);
  });

  it("keeps buzzes in arrival order across sockets", async () => {
    const room = await createRoom();
    const host = await hostOf(room);
    host.send({ type: "host.loadQuiz", quiz: QUIZ });
    const red = await joinAs(room.code, "Red");
    const blue = await joinAs(room.code, "Blue");
    host.send({ type: "host.goto", stage: { kind: "question", round: 1, question: 0 } });
    host.send({ type: "host.open" });
    await blue.client.state<TeamView>((v) => v.question?.phase === "open");
    blue.client.send({ type: "team.buzz", questionKey: "1.0" });
    await blue.client.state<TeamView>((v) => v.myBuzz !== null);
    red.client.send({ type: "team.buzz", questionKey: "1.0" });
    const hv = await host.state<HostView>((v) => (v.question?.buzzes.length ?? 0) === 2);
    expect(hv.question!.buzzes.map((b) => b.name)).toEqual(["Blue", "Red"]);
    expect(hv.detail?.activeBuzzTeamId).toBe(blue.teamId);
    red.client.send({ type: "team.buzz", questionKey: "1.0" });
    expect((await red.client.error()).code).toBe("already_buzzed");
  });

  it("disconnects a removed team and closes the room for everyone on request", async () => {
    const room = await createRoom();
    const host = await hostOf(room);
    const { client, teamId } = await joinAs(room.code, "Rowdy");
    await host.state<HostView>((v) => v.teams.length === 1);
    host.send({ type: "host.kick", teamId });
    await client.next((m) => m.type === "kicked");
    await host.state<HostView>((v) => v.teams.length === 0);

    const screen = await connect(room.code, { type: "auth.screen" });
    await screen.state();
    host.send({ type: "host.closeRoom" });
    await screen.next((m) => m.type === "closed");
    expect((await SELF.fetch(`${ORIGIN}/api/rooms/${room.code}`)).status).toBe(404);
    const keys = await runInDurableObject(stub(room.code), async (_instance, state) => [...(await state.storage.list()).keys()]);
    expect(keys).toEqual([]);
  });
});

describe("abuse limits", () => {
  const deny = { limit: async () => ({ success: false }) };
  const bare = () => ({ ASSETS: env.ASSETS, ROOMS: env.ROOMS });

  it("limits room creation per client IP", async () => {
    const ip = freshIp();
    const create = () => SELF.fetch(`${ORIGIN}/api/rooms`, { method: "POST", headers: ipHeaders(ip) });
    for (let i = 0; i < RATE_POLICIES.createRoom.limit; i++) expect((await create()).status).toBe(201);
    const refused = await create();
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: string }).error).toMatch(/too many/i);
    // Someone else in a different pub is unaffected.
    expect((await SELF.fetch(`${ORIGIN}/api/rooms`, { method: "POST", headers: ipHeaders(freshIp()) })).status).toBe(201);
  });

  it("limits room lookups per client IP", async () => {
    const room = await createRoom();
    const ip = freshIp();
    const look = () => SELF.fetch(`${ORIGIN}/api/rooms/${room.code}`, { headers: ipHeaders(ip) });
    for (let i = 0; i < RATE_POLICIES.connect.limit; i++) expect((await look()).status).toBe(200);
    expect((await look()).status).toBe(429);
  });

  it("explains a refused socket and closes it with a retryable code", async () => {
    const room = await createRoom();
    const req = new Request(`${ORIGIN}/api/rooms/${room.code}/ws`, { headers: { Upgrade: "websocket", ...ipHeaders() } });
    const res = await handleApi(req, { ...bare(), CONNECT_LIMITER: deny });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const client = new Client(ws);
    ws.accept();
    expect(await client.error()).toMatchObject({ code: "rate_limited" });
    expect(await client.closed()).toBe(CLOSE_RATE_LIMITED);
    // Nothing reached the room.
    expect(await runInDurableObject(stub(room.code), (_instance, state) => state.getWebSockets().length)).toBe(0);
  });

  it("falls back to an in-memory limiter when the bindings are missing", async () => {
    const ip = freshIp();
    const create = () => handleApi(new Request(`${ORIGIN}/api/rooms`, { method: "POST", headers: ipHeaders(ip) }), bare());
    for (let i = 0; i < RATE_POLICIES.createRoom.limit; i++) expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(429);
  });

  it("drops a flood of messages from one socket, warns, then disconnects it", async () => {
    const room = await createRoom();
    const host = await hostOf(room);
    const { client } = await joinAs(room.code, "Spammers");
    for (let i = 0; i < 30; i++) client.send({ type: "team.joker", round: 0 });
    expect((await client.next((m) => m.type === "error" && m.code === "rate_limited")).type).toBe("error");
    for (let i = 0; i < 100; i++) client.send({ type: "team.joker", round: 0 });
    expect(await client.closed()).toBe(CLOSE_FLOODING);
    // The host's own socket has its own budget and still works.
    host.send({ type: "host.adjust", teamId: (await host.state<HostView>((v) => v.teams.length === 1)).teams[0]!.id, delta: 1 });
    await host.state<HostView>((v) => v.teams[0]?.score === 1);
  });

  it(`seats at most ${LIMITS.teamsPerRoom} teams in a room`, async () => {
    const room = await createRoom();
    for (let i = 0; i < LIMITS.teamsPerRoom; i++) await joinAs(room.code, `Table ${i + 1}`);
    const late = await connect(room.code, { type: "auth.join", name: "One too many" });
    expect((await late.error()).code).toBe("room_full");
  });
});

describe("host control", () => {
  it("issues a long random host token that is unrelated to the room code", async () => {
    const a = await createRoom();
    const b = await createRoom();
    expect(a.hostToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a.hostToken).not.toContain(a.code);
    expect(a.hostToken).not.toBe(b.hostToken);
  });

  it("never accepts the room code, or another room's token, as a host token", async () => {
    const room = await createRoom();
    const other = await createRoom();

    const byCode = await connect(room.code, { type: "auth.host", hostToken: room.code });
    expect((await byCode.error()).code).toBe("bad_message");
    byCode.send({ type: "host.closeRoom" });
    expect((await byCode.error()).code).toBe("not_authorised");

    const padded = await connect(room.code, { type: "auth.host", hostToken: room.code.repeat(8) });
    expect((await padded.error()).code).toBe("not_authorised");
    expect(await padded.closed()).toBe(4001);

    const borrowed = await connect(room.code, { type: "auth.host", hostToken: other.hostToken });
    expect((await borrowed.error()).code).toBe("not_authorised");
    expect(await borrowed.closed()).toBe(4001);

    expect((await SELF.fetch(`${ORIGIN}/api/rooms/${room.code}`)).status).toBe(200);
  });

  it("refuses host commands from teams and the big screen", async () => {
    const room = await createRoom();
    const { client } = await joinAs(room.code, "Chancers");
    await client.state();
    for (const cmd of [{ type: "host.loadQuiz", quiz: QUIZ }, { type: "host.resetGame" }, { type: "host.closeRoom" }]) {
      client.send(cmd);
      expect((await client.error()).code).toBe("not_authorised");
    }
    const screen = await connect(room.code, { type: "auth.screen" });
    await screen.state();
    screen.send({ type: "host.closeRoom" });
    expect((await screen.error()).code).toBe("not_authorised");
    expect((await SELF.fetch(`${ORIGIN}/api/rooms/${room.code}`)).status).toBe(200);
  });

  it("never sends the host token to teams, the big screen or the lookup route", async () => {
    const room = await createRoom();
    const host = await hostOf(room);
    host.send({ type: "host.loadQuiz", quiz: QUIZ });
    const { client } = await joinAs(room.code, "Nosy");
    const screen = await connect(room.code, { type: "auth.screen" });
    await host.state<HostView>((v) => v.quiz !== null && v.teams.length === 1);
    await client.state();
    await screen.state();
    const info = await (await SELF.fetch(`${ORIGIN}/api/rooms/${room.code}`)).text();
    for (const seen of [JSON.stringify(client.messages), JSON.stringify(screen.messages), JSON.stringify(host.messages), info]) {
      expect(seen).not.toContain(room.hostToken);
    }
  });
});
