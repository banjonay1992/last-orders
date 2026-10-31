// End-to-end tests of the Worker and the room Durable Object, running in
// the real Workers runtime through @cloudflare/vitest-plugin. Clients talk
// to the room over genuine WebSockets.

import { evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { HostView, ScreenView, ServerMessage, TeamView } from "../../src/shared/protocol";
import type { QuizInput } from "../../src/shared/quiz";

const ORIGIN = "https://quiz.test";

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

  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      if (event.data === "pong") return;
      this.messages.push(JSON.parse(event.data as string) as ServerMessage);
      this.wake?.();
    });
    ws.addEventListener("close", () => this.wake?.());
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
  const res = await SELF.fetch(`${ORIGIN}/api/rooms`, { method: "POST" });
  expect(res.status).toBe(201);
  return res.json();
}

async function connect(code: string, first?: unknown): Promise<Client> {
  const res = await SELF.fetch(`${ORIGIN}/api/rooms/${code}/ws`, { headers: { Upgrade: "websocket" } });
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
