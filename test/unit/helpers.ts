import { expect } from "vitest";
import type { HostCommand, TeamCommand } from "../../src/shared/protocol";
import { parseQuiz, type Quiz, type QuizInput } from "../../src/shared/quiz";
import { createRoom, joinTeam, reduce, type Actor, type GameError, type RoomState } from "../../src/worker/game";

export const HOST: Actor = { role: "host" };
export const team = (teamId: string): Actor => ({ role: "team", teamId });

/** A small quiz covering every question type and both round modes. */
export const TEST_QUIZ: QuizInput = {
  format: "last-orders-quiz",
  version: 1,
  title: "Test quiz",
  rounds: [
    {
      title: "Round one",
      questions: [
        { type: "choice", prompt: "Pick B", options: ["A", "B", "C"], answer: 1, points: 1 },
        { type: "text", prompt: "Capital of France?", answers: ["Paris"], points: 2, timeLimitSeconds: 10 },
      ],
    },
    {
      title: "Buzzers",
      mode: "buzzer",
      jokerAllowed: false,
      questions: [{ type: "text", prompt: "Largest ocean?", answers: ["Pacific"], points: 3 }],
    },
    {
      title: "Round three",
      questions: [{ type: "text", prompt: "Gold symbol?", answers: ["Au"], points: 1 }],
    },
  ],
  tiebreaker: { prompt: "How many?", answer: 100 },
};

export function testQuiz(): Quiz {
  const parsed = parseQuiz(TEST_QUIZ);
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return parsed.quiz;
}

/** A clock the tests move by hand. */
export class Clock {
  constructor(public now = 1_000_000) {}
  tick(ms: number): number {
    this.now += ms;
    return this.now;
  }
}

/** Drives a room through the reducer and fails loudly on unexpected errors. */
export class Game {
  state: RoomState;
  clock = new Clock();
  private seq = 0;

  constructor() {
    this.state = createRoom("BCDF", "host-token-0123456789", this.clock.now);
  }

  join(name: string): string {
    const n = ++this.seq;
    const result = joinTeam(this.state, name, { teamId: `team${n}`, token: `token-${n}-abcdefghijklmnop` }, this.clock.now);
    if (!result.ok) throw new Error(result.error.message);
    this.state = result.state.room;
    return result.state.team.id;
  }

  host(cmd: HostCommand): this {
    return this.as(HOST, cmd);
  }

  as(actor: Actor, cmd: HostCommand | TeamCommand): this {
    this.clock.tick(10);
    const result = reduce(this.state, actor, cmd, this.clock.now);
    if (!result.ok) throw new Error(`${cmd.type} failed: ${result.error.code} ${result.error.message}`);
    this.state = result.state;
    return this;
  }

  /** Runs a command expected to fail and returns the error. State is unchanged. */
  reject(actor: Actor, cmd: HostCommand | TeamCommand): GameError {
    const result = reduce(this.state, actor, cmd, this.clock.now);
    expect(result.ok, `${cmd.type} should have been refused`).toBe(false);
    return (result as { ok: false; error: GameError }).error;
  }

  loaded(): this {
    return this.host({ type: "host.loadQuiz", quiz: TEST_QUIZ });
  }

  show(round: number, question: number): this {
    return this.host({ type: "host.goto", stage: { kind: "question", round, question } });
  }
}
