import { describe, expect, it } from "vitest";
import { isRoomCode, LIMITS, normaliseRoomCode } from "../../src/shared/limits";
import { parseClientMessage } from "../../src/shared/protocol";
import { nextStage } from "../../src/client/lib/flow";
import { testQuiz } from "./helpers";

const parse = (v: unknown) => parseClientMessage(typeof v === "string" ? v : JSON.stringify(v));

describe("client message parsing", () => {
  it("accepts well-formed messages", () => {
    expect(parse({ type: "auth.screen" }).ok).toBe(true);
    expect(parse({ type: "team.answer", questionKey: "0.1", value: 2 }).ok).toBe(true);
    expect(parse({ type: "host.goto", stage: { kind: "question", round: 1, question: 0 } }).ok).toBe(true);
  });

  it("tidies team names and refuses unreadable ones", () => {
    const ok = parse({ type: "auth.join", name: "  The   Quizzly\tBears " });
    expect(ok).toEqual({ ok: true, message: { type: "auth.join", name: "The Quizzly Bears" } });
    expect(parse({ type: "auth.join", name: "   " }).ok).toBe(false);
    expect(parse({ type: "auth.join", name: "x".repeat(LIMITS.teamNameChars + 1) }).ok).toBe(false);
    expect(parse({ type: "auth.join", name: "Zero​Width" }).ok).toBe(false);
  });

  it("refuses junk with a short reason", () => {
    expect(parse("not json")).toEqual({ ok: false, error: "Message is not valid JSON" });
    expect(parse({ type: "host.nuke" })).toEqual({ ok: false, error: "Unknown message type" });
    expect(parse({ type: "team.answer", questionKey: "../etc", value: 1 }).ok).toBe(false);
    expect(parse({ type: "host.adjust", teamId: "abcd", delta: 1000 }).ok).toBe(false);
    expect(parse({ type: "team.tiebreak", value: "lots" }).ok).toBe(false);
    expect(parseClientMessage(new ArrayBuffer(4)).ok).toBe(false);
    expect(parse("x".repeat(LIMITS.messageChars + 1))).toEqual({ ok: false, error: "Message too large" });
  });

  it("validates tokens strictly", () => {
    expect(parse({ type: "auth.resume", token: "short" }).ok).toBe(false);
    expect(parse({ type: "auth.resume", token: "has spaces in it, sadly" }).ok).toBe(false);
    expect(parse({ type: "auth.resume", token: "abcdefghijklmnopqrstuvwxyz012345" }).ok).toBe(true);
  });
});

describe("room codes", () => {
  it("normalises and checks codes", () => {
    expect(normaliseRoomCode(" bc-df ")).toBe("BCDF");
    expect(isRoomCode("BCDF")).toBe(true);
    expect(isRoomCode("ABCD")).toBe(false); // vowels are never issued
    expect(isRoomCode("BCD")).toBe(false);
  });
});

describe("host running order", () => {
  it("walks lobby, rounds, questions and scores in order", () => {
    const quiz = testQuiz();
    expect(nextStage({ kind: "lobby" }, quiz, {})).toEqual({ kind: "roundIntro", round: 0 });
    expect(nextStage({ kind: "roundIntro", round: 0 }, quiz, {})).toEqual({ kind: "question", round: 0, question: 0 });
    expect(nextStage({ kind: "question", round: 0, question: 0 }, quiz, {})).toEqual({ kind: "question", round: 0, question: 1 });
    expect(nextStage({ kind: "question", round: 0, question: 1 }, quiz, {})).toEqual({ kind: "scoreboard" });
    expect(nextStage({ kind: "scoreboard" }, quiz, { "0.0": "revealed", "0.1": "revealed" })).toEqual({ kind: "roundIntro", round: 1 });
    expect(nextStage({ kind: "scoreboard" }, quiz, { "2.0": "revealed" })).toEqual({ kind: "final" });
    expect(nextStage({ kind: "final" }, quiz, {})).toBeNull();
    expect(nextStage({ kind: "lobby" }, null, {})).toBeNull();
  });
});
