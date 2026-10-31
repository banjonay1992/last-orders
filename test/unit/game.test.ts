import { describe, expect, it } from "vitest";
import { LIMITS } from "../../src/shared/limits";
import {
  createRoom,
  expire,
  findTeamByToken,
  isHostToken,
  joinTeam,
  nextDeadline,
  questionState,
  reduce,
  standings,
  teamScores,
} from "../../src/worker/game";
import { Game, HOST, team, TEST_QUIZ } from "./helpers";

describe("joining", () => {
  it("seats teams in join order with a zero score", () => {
    const g = new Game();
    const a = g.join("The Quizzly Bears");
    const b = g.join("Les Quizerables");
    expect(g.state.teams.map((t) => t.name)).toEqual(["The Quizzly Bears", "Les Quizerables"]);
    expect(teamScores(g.state)).toEqual({ [a]: 0, [b]: 0 });
  });

  it("refuses a duplicate name regardless of case", () => {
    const g = new Game();
    g.join("Quiz Khalifa");
    const result = joinTeam(g.state, "quiz khalifa", { teamId: "other", token: "other-token-abcdefgh" }, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("name_taken");
  });

  it("refuses teams once the room is full", () => {
    const g = new Game();
    for (let i = 0; i < LIMITS.teamsPerRoom; i++) g.join(`Team ${i}`);
    const result = joinTeam(g.state, "One too many", { teamId: "late", token: "late-token-abcdefghij" }, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("room_full");
  });

  it("lets teams join after the quiz has started", () => {
    const g = new Game().loaded();
    g.show(0, 0).host({ type: "host.open" });
    const late = g.join("Latecomers");
    g.as(team(late), { type: "team.answer", questionKey: "0.0", value: 1 });
    expect(questionState(g.state, "0.0").answers[late]?.value).toBe(1);
  });

  it("checks the host token in constant time and exactly", () => {
    const room = createRoom("BCDF", "abcdefghijklmnopqrstuvwx", 0);
    expect(isHostToken(room, "abcdefghijklmnopqrstuvwx")).toBe(true);
    expect(isHostToken(room, "abcdefghijklmnopqrstuvwy")).toBe(false);
    expect(isHostToken(room, "abc")).toBe(false);
  });
});

describe("reconnection", () => {
  it("finds a team by its resume token, keeping its answers and score", () => {
    const g = new Game().loaded();
    const a = g.join("Sherlock Homies");
    g.show(0, 0).host({ type: "host.open" }).as(team(a), { type: "team.answer", questionKey: "0.0", value: 1 }).host({ type: "host.reveal" });
    const token = g.state.teams[0]!.token;
    // A phone that slept comes back with only its token.
    const found = findTeamByToken(g.state, token);
    expect(found?.id).toBe(a);
    expect(teamScores(g.state)[a]).toBe(1);
  });

  it("does not find a team for an unknown or removed token", () => {
    const g = new Game();
    const a = g.join("Gone Soon");
    const token = g.state.teams[0]!.token;
    expect(findTeamByToken(g.state, "nope-nope-nope-nope")).toBeUndefined();
    g.host({ type: "host.kick", teamId: a });
    expect(findTeamByToken(g.state, token)).toBeUndefined();
  });

  it("refuses commands from a team that has been removed", () => {
    const g = new Game().loaded();
    const a = g.join("Kicked");
    g.host({ type: "host.kick", teamId: a });
    expect(g.reject(team(a), { type: "team.joker", round: 0 }).code).toBe("unknown_team");
  });
});

describe("permissions", () => {
  it("only lets the host run host commands", () => {
    const g = new Game();
    const a = g.join("Sneaky");
    expect(g.reject(team(a), { type: "host.loadQuiz", quiz: TEST_QUIZ }).code).toBe("not_authorised");
    expect(g.reject(HOST, { type: "team.joker", round: 0 }).code).toBe("not_authorised");
  });

  it("refuses an invalid quiz with readable errors", () => {
    const g = new Game();
    const err = g.reject(HOST, { type: "host.loadQuiz", quiz: { ...TEST_QUIZ, rounds: [] } });
    expect(err.code).toBe("invalid_quiz");
    expect(err.message).toContain("rounds");
  });
});

describe("answer locking", () => {
  it("accepts and replaces answers while open", () => {
    const g = new Game().loaded();
    const a = g.join("A");
    g.show(0, 0).host({ type: "host.open" });
    g.as(team(a), { type: "team.answer", questionKey: "0.0", value: 0 });
    g.as(team(a), { type: "team.answer", questionKey: "0.0", value: 1 });
    expect(questionState(g.state, "0.0").answers[a]?.value).toBe(1);
  });

  it("refuses answers before the question opens", () => {
    const g = new Game().loaded();
    const a = g.join("Eager");
    g.show(0, 0);
    expect(g.reject(team(a), { type: "team.answer", questionKey: "0.0", value: 1 }).code).toBe("wrong_phase");
  });

  it("refuses changes once locked, and after reveal for good", () => {
    const g = new Game().loaded();
    const a = g.join("A");
    g.show(0, 0).host({ type: "host.open" }).as(team(a), { type: "team.answer", questionKey: "0.0", value: 0 });
    g.host({ type: "host.lock" });
    expect(g.reject(team(a), { type: "team.answer", questionKey: "0.0", value: 1 }).code).toBe("locked");
    g.host({ type: "host.reveal" });
    expect(g.reject(team(a), { type: "team.answer", questionKey: "0.0", value: 1 }).code).toBe("locked");
    expect(g.reject(HOST, { type: "host.reopen" }).code).toBe("wrong_phase");
    expect(questionState(g.state, "0.0").answers[a]?.value).toBe(0);
  });

  it("reveal locks an open question in one step", () => {
    const g = new Game().loaded();
    const a = g.join("A");
    g.show(0, 0).host({ type: "host.open" }).as(team(a), { type: "team.answer", questionKey: "0.0", value: 1 });
    g.host({ type: "host.reveal" });
    expect(questionState(g.state, "0.0").phase).toBe("revealed");
    expect(g.reject(team(a), { type: "team.answer", questionKey: "0.0", value: 2 }).code).toBe("locked");
  });

  it("can reopen a locked question that has not been revealed", () => {
    const g = new Game().loaded();
    const a = g.join("A");
    g.show(0, 0).host({ type: "host.open" }).host({ type: "host.lock" }).host({ type: "host.reopen" });
    g.as(team(a), { type: "team.answer", questionKey: "0.0", value: 2 });
    expect(questionState(g.state, "0.0").answers[a]?.value).toBe(2);
  });

  it("locks the question when the host moves on", () => {
    const g = new Game().loaded();
    const a = g.join("A");
    g.show(0, 0).host({ type: "host.open" }).show(0, 1);
    expect(questionState(g.state, "0.0").phase).toBe("locked");
    expect(g.reject(team(a), { type: "team.answer", questionKey: "0.0", value: 1 }).code).toBe("locked");
  });

  it("refuses an answer for a question that is not on screen", () => {
    const g = new Game().loaded();
    const a = g.join("A");
    g.show(0, 0).host({ type: "host.open" });
    expect(g.reject(team(a), { type: "team.answer", questionKey: "0.1", value: "Paris" }).code).toBe("stale_question");
  });

  it("validates answers against the question type", () => {
    const g = new Game().loaded();
    const a = g.join("A");
    g.show(0, 0).host({ type: "host.open" });
    expect(g.reject(team(a), { type: "team.answer", questionKey: "0.0", value: 7 }).code).toBe("invalid_answer");
    expect(g.reject(team(a), { type: "team.answer", questionKey: "0.0", value: "B" }).code).toBe("invalid_answer");
    g.show(0, 1).host({ type: "host.open" });
    expect(g.reject(team(a), { type: "team.answer", questionKey: "0.1", value: "   " }).code).toBe("invalid_answer");
    g.as(team(a), { type: "team.answer", questionKey: "0.1", value: "  Paris \n" });
    expect(questionState(g.state, "0.1").answers[a]?.value).toBe("Paris");
  });
});

describe("late answers", () => {
  it("rejects an answer that arrives after the deadline by server time, even before any alarm", () => {
    const g = new Game().loaded();
    const a = g.join("Slowcoaches");
    g.show(0, 1).host({ type: "host.open" });
    const closesAt = questionState(g.state, "0.1").closesAt!;
    expect(closesAt).toBe(questionState(g.state, "0.1").openedAt! + 10_000);
    expect(nextDeadline(g.state)).toBe(closesAt);

    // Just in time.
    g.clock.now = closesAt - 20;
    g.as(team(a), { type: "team.answer", questionKey: "0.1", value: "Paris" });

    // A moment too late: refused and the stored answer is untouched.
    const result = reduce(g.state, team(a), { type: "team.answer", questionKey: "0.1", value: "London" }, closesAt);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("late");
    expect(questionState(g.state, "0.1").answers[a]?.value).toBe("Paris");
  });

  it("expire() locks at the deadline and records the timer as the reason", () => {
    const g = new Game().loaded();
    g.show(0, 1).host({ type: "host.open" });
    const closesAt = questionState(g.state, "0.1").closesAt!;
    expect(expire(g.state, closesAt - 1)).toBe(g.state);
    const after = expire(g.state, closesAt + 5000);
    expect(questionState(after, "0.1")).toMatchObject({ phase: "locked", lockedBy: "timer", lockedAt: closesAt });
    expect(nextDeadline(after)).toBeNull();
  });

  it("questions without a time limit never expire", () => {
    const g = new Game().loaded();
    g.show(0, 0).host({ type: "host.open" });
    expect(questionState(g.state, "0.0").closesAt).toBeNull();
    expect(expire(g.state, g.clock.now + 10 * 60 * 60 * 1000)).toBe(g.state);
  });
});

describe("buzzers", () => {
  function buzzerGame() {
    const g = new Game().loaded();
    const ids = [g.join("Red"), g.join("Green"), g.join("Blue")] as const;
    g.show(1, 0).host({ type: "host.open" });
    return { g, ids };
  }

  it("orders buzzes by arrival at the room", () => {
    const { g, ids } = buzzerGame();
    const [red, green, blue] = ids;
    g.as(team(green), { type: "team.buzz", questionKey: "1.0" });
    g.as(team(blue), { type: "team.buzz", questionKey: "1.0" });
    g.as(team(red), { type: "team.buzz", questionKey: "1.0" });
    const buzzes = questionState(g.state, "1.0").buzzes;
    expect(buzzes.map((b) => b.teamId)).toEqual([green, blue, red]);
    expect(buzzes[0]!.at).toBeLessThan(buzzes[1]!.at);
  });

  it("refuses a second buzz from the same team", () => {
    const { g, ids } = buzzerGame();
    g.as(team(ids[0]), { type: "team.buzz", questionKey: "1.0" });
    expect(g.reject(team(ids[0]), { type: "team.buzz", questionKey: "1.0" }).code).toBe("already_buzzed");
  });

  it("passes to the next team on a wrong answer and closes on a right one", () => {
    const { g, ids } = buzzerGame();
    const [red, green, blue] = ids;
    for (const id of [red, green, blue]) g.as(team(id), { type: "team.buzz", questionKey: "1.0" });
    g.host({ type: "host.buzzVerdict", questionKey: "1.0", correct: false });
    g.host({ type: "host.buzzVerdict", questionKey: "1.0", correct: true });
    const qs = questionState(g.state, "1.0");
    expect(qs.buzzes.map((b) => b.outcome)).toEqual(["wrong", "correct", "skipped"]);
    expect(qs.phase).toBe("locked");
    expect(g.reject(HOST, { type: "host.buzzVerdict", questionKey: "1.0", correct: true }).code).toBe("wrong_phase");
    // Buzzer points count immediately: the room heard the answer.
    expect(teamScores(g.state)).toMatchObject({ [red]: 0, [green]: 3, [blue]: 0 });
  });

  it("refuses buzzes outside buzzer rounds and answers inside them", () => {
    const { g, ids } = buzzerGame();
    expect(g.reject(team(ids[0]), { type: "team.answer", questionKey: "1.0", value: "Pacific" }).code).toBe("not_answer_round");
    g.show(0, 0).host({ type: "host.open" });
    expect(g.reject(team(ids[0]), { type: "team.buzz", questionKey: "0.0" }).code).toBe("not_buzzer_round");
  });

  it("refuses a verdict when nobody is waiting", () => {
    const { g } = buzzerGame();
    expect(g.reject(HOST, { type: "host.buzzVerdict", questionKey: "1.0", correct: true }).code).toBe("wrong_phase");
  });
});

describe("marking and scoring", () => {
  it("auto-marks multiple choice at lock and only scores after reveal", () => {
    const g = new Game().loaded();
    const [a, b] = [g.join("Right"), g.join("Wrong")];
    g.show(0, 0).host({ type: "host.open" });
    g.as(team(a), { type: "team.answer", questionKey: "0.0", value: 1 });
    g.as(team(b), { type: "team.answer", questionKey: "0.0", value: 2 });
    g.host({ type: "host.lock" });
    expect(questionState(g.state, "0.0").verdicts).toEqual({ [a]: true, [b]: false });
    expect(teamScores(g.state)).toEqual({ [a]: 0, [b]: 0 });
    g.host({ type: "host.reveal" });
    expect(teamScores(g.state)).toEqual({ [a]: 1, [b]: 0 });
  });

  it("auto-marks exact text matches and leaves the rest to the host", () => {
    const g = new Game().loaded();
    const [a, b, c] = [g.join("Exact"), g.join("Typo"), g.join("Wild")];
    g.show(0, 1).host({ type: "host.open" });
    g.as(team(a), { type: "team.answer", questionKey: "0.1", value: "paris!" });
    g.as(team(b), { type: "team.answer", questionKey: "0.1", value: "Parris" });
    g.as(team(c), { type: "team.answer", questionKey: "0.1", value: "Lyon" });
    g.host({ type: "host.lock" });
    expect(questionState(g.state, "0.1").verdicts).toEqual({ [a]: true });
    g.host({ type: "host.mark", questionKey: "0.1", teamId: b, verdict: "correct" });
    g.host({ type: "host.mark", questionKey: "0.1", teamId: c, verdict: "wrong" });
    g.host({ type: "host.reveal" });
    expect(teamScores(g.state)).toEqual({ [a]: 2, [b]: 2, [c]: 0 });
    // Corrections after the reveal are allowed and flow straight into scores.
    g.host({ type: "host.mark", questionKey: "0.1", teamId: b, verdict: "clear" });
    expect(teamScores(g.state)[b]).toBe(0);
  });

  it("acceptExact marks matches right and non-matches wrong but leaves close ones", () => {
    const g = new Game().loaded();
    const [a, b, c] = [g.join("Exact"), g.join("Close"), g.join("Miss")];
    g.show(0, 1).host({ type: "host.open" });
    g.as(team(a), { type: "team.answer", questionKey: "0.1", value: "Paris" });
    g.as(team(b), { type: "team.answer", questionKey: "0.1", value: "Pariss" });
    g.as(team(c), { type: "team.answer", questionKey: "0.1", value: "Madrid" });
    g.host({ type: "host.lock" }).host({ type: "host.acceptExact", questionKey: "0.1" });
    expect(questionState(g.state, "0.1").verdicts).toEqual({ [a]: true, [c]: false });
  });

  it("refuses marking while open or for a team that did not answer", () => {
    const g = new Game().loaded();
    const [a, b] = [g.join("A"), g.join("Silent")];
    g.show(0, 1).host({ type: "host.open" }).as(team(a), { type: "team.answer", questionKey: "0.1", value: "Paris" });
    expect(g.reject(HOST, { type: "host.mark", questionKey: "0.1", teamId: a, verdict: "correct" }).code).toBe("wrong_phase");
    g.host({ type: "host.lock" });
    expect(g.reject(HOST, { type: "host.mark", questionKey: "0.1", teamId: b, verdict: "correct" }).code).toBe("unknown_team");
  });

  it("applies manual adjustments and ranks equal scores together", () => {
    const g = new Game().loaded();
    const [a, b, c] = [g.join("A"), g.join("B"), g.join("C")];
    g.host({ type: "host.adjust", teamId: a, delta: 3 });
    g.host({ type: "host.adjust", teamId: b, delta: 3 });
    g.host({ type: "host.adjust", teamId: c, delta: -1 });
    const rows = standings(g.state);
    expect(rows.map((r) => [r.team.id, r.score, r.rank])).toEqual([
      [a, 3, 1],
      [b, 3, 1],
      [c, -1, 3],
    ]);
  });

  it("drops a removed team's answers and keeps everyone else's", () => {
    const g = new Game().loaded();
    const [a, b] = [g.join("Stay"), g.join("Go")];
    g.show(0, 0).host({ type: "host.open" });
    g.as(team(a), { type: "team.answer", questionKey: "0.0", value: 1 });
    g.as(team(b), { type: "team.answer", questionKey: "0.0", value: 1 });
    g.host({ type: "host.kick", teamId: b }).host({ type: "host.reveal" });
    expect(Object.keys(questionState(g.state, "0.0").answers)).toEqual([a]);
    expect(teamScores(g.state)).toEqual({ [a]: 1 });
  });

  it("reset clears progress but keeps teams and the quiz", () => {
    const g = new Game().loaded();
    const a = g.join("A");
    g.as(team(a), { type: "team.joker", round: 0 });
    g.show(0, 0).host({ type: "host.open" }).as(team(a), { type: "team.answer", questionKey: "0.0", value: 1 }).host({ type: "host.reveal" });
    g.host({ type: "host.resetGame" });
    expect(g.state.teams).toHaveLength(1);
    expect(g.state.quiz?.title).toBe("Test quiz");
    expect(g.state.questions).toEqual({});
    expect(g.state.teams[0]!.jokerRound).toBeNull();
    expect(teamScores(g.state)[a]).toBe(0);
  });
});

describe("jokers", () => {
  it("doubles a team's points on the chosen round only", () => {
    const g = new Game().loaded();
    const [a, b] = [g.join("Joker"), g.join("Plain")];
    g.as(team(a), { type: "team.joker", round: 0 });
    g.show(0, 0).host({ type: "host.open" });
    g.as(team(a), { type: "team.answer", questionKey: "0.0", value: 1 });
    g.as(team(b), { type: "team.answer", questionKey: "0.0", value: 1 });
    g.host({ type: "host.reveal" });
    g.show(2, 0).host({ type: "host.open" });
    g.as(team(a), { type: "team.answer", questionKey: "2.0", value: "Au" });
    g.host({ type: "host.reveal" });
    expect(teamScores(g.state)).toEqual({ [a]: 2 + 1, [b]: 1 });
  });

  it("allows only one joker per team", () => {
    const g = new Game().loaded();
    const a = g.join("Greedy");
    g.as(team(a), { type: "team.joker", round: 0 });
    expect(g.reject(team(a), { type: "team.joker", round: 2 }).code).toBe("joker_used");
  });

  it("closes jokers once the round's first question opens", () => {
    const g = new Game().loaded();
    const a = g.join("Late");
    g.show(0, 0).host({ type: "host.open" });
    expect(g.reject(team(a), { type: "team.joker", round: 0 }).code).toBe("joker_too_late");
    // Later rounds are still fair game.
    g.as(team(a), { type: "team.joker", round: 2 });
    expect(g.state.teams[0]!.jokerRound).toBe(2);
  });

  it("respects rounds that do not allow jokers", () => {
    const g = new Game().loaded();
    const a = g.join("A");
    expect(g.reject(team(a), { type: "team.joker", round: 1 }).code).toBe("joker_not_allowed");
    expect(g.reject(team(a), { type: "team.joker", round: 9 }).code).toBe("no_quiz");
  });
});

describe("tie-breaker", () => {
  function tiedGame() {
    const g = new Game().loaded();
    const ids = [g.join("Alpha"), g.join("Bravo"), g.join("Charlie")] as const;
    g.host({ type: "host.adjust", teamId: ids[0], delta: 5 });
    g.host({ type: "host.adjust", teamId: ids[1], delta: 5 });
    g.host({ type: "host.adjust", teamId: ids[2], delta: 2 });
    return { g, ids };
  }

  it("defaults to the teams tied for first and settles by closest guess", () => {
    const { g, ids } = tiedGame();
    const [alpha, bravo, charlie] = ids;
    g.host({ type: "host.tiebreakStart" });
    expect(g.state.tiebreak?.teamIds).toEqual([alpha, bravo]);
    expect(g.reject(team(charlie), { type: "team.tiebreak", value: 100 }).code).toBe("not_in_tiebreak");
    g.as(team(alpha), { type: "team.tiebreak", value: 90 });
    g.as(team(bravo), { type: "team.tiebreak", value: 104 });
    g.host({ type: "host.tiebreakReveal" });
    const rows = standings(g.state);
    expect(rows.map((r) => [r.team.id, r.rank])).toEqual([
      [bravo, 1],
      [alpha, 2],
      [charlie, 3],
    ]);
    expect(g.reject(team(alpha), { type: "team.tiebreak", value: 100 }).code).toBe("locked");
  });

  it("breaks an exact distance tie by who answered first", () => {
    const { g, ids } = tiedGame();
    g.host({ type: "host.tiebreakStart" });
    g.as(team(ids[1]), { type: "team.tiebreak", value: 110 });
    g.as(team(ids[0]), { type: "team.tiebreak", value: 90 });
    g.host({ type: "host.tiebreakReveal" });
    expect(standings(g.state)[0]!.team.id).toBe(ids[1]);
  });

  it("refuses to start without a tie unless teams are chosen", () => {
    const g = new Game().loaded();
    const [a, b] = [g.join("A"), g.join("B")];
    g.host({ type: "host.adjust", teamId: a, delta: 1 });
    expect(g.reject(HOST, { type: "host.tiebreakStart" }).code).toBe("no_tie");
    g.host({ type: "host.tiebreakStart", teamIds: [a, b] });
    expect(g.state.stage).toEqual({ kind: "tiebreak" });
  });
});

describe("navigation", () => {
  it("refuses stages that do not exist", () => {
    const g = new Game();
    expect(g.reject(HOST, { type: "host.goto", stage: { kind: "roundIntro", round: 0 } }).code).toBe("no_quiz");
    g.loaded();
    expect(g.reject(HOST, { type: "host.goto", stage: { kind: "question", round: 0, question: 9 } }).code).toBe("bad_stage");
    expect(g.reject(HOST, { type: "host.open" }).code).toBe("bad_stage");
  });

  it("loading a new quiz restarts the game but keeps the teams", () => {
    const g = new Game().loaded();
    g.join("Stayers");
    g.show(0, 0).host({ type: "host.open" });
    g.loaded();
    expect(g.state.stage).toEqual({ kind: "lobby" });
    expect(g.state.questions).toEqual({});
    expect(g.state.teams).toHaveLength(1);
  });

  it("never mutates the previous state", () => {
    const g = new Game().loaded();
    const a = g.join("A");
    g.show(0, 0).host({ type: "host.open" });
    const before = structuredClone(g.state);
    const frozen = g.state;
    g.as(team(a), { type: "team.answer", questionKey: "0.0", value: 1 });
    expect(frozen).toEqual(before);
  });
});
