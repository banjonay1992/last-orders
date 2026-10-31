// The game itself, as a pure and deterministic state machine.
//
// Nothing in this file touches the network, storage, randomness or the
// clock. Callers pass in the current time and any freshly generated ids, and
// get back a new state (the old one is never mutated) or an error. That keeps
// the Durable Object thin and lets the tests drive whole games quickly.

import { suggestMark } from "../shared/fuzzy";
import { LIMITS } from "../shared/limits";
import type { AnswerValue, BuzzOutcome, ErrorCode, HostCommand, QuestionPhase, Stage, TeamCommand } from "../shared/protocol";
import { getQuestion, parseQuestionKey, parseQuiz, questionKey, type Question, type Quiz, type Round } from "../shared/quiz";

export interface Team {
  id: string;
  name: string;
  /** Secret that lets a phone take its seat back after a dropped connection. */
  token: string;
  joinedAt: number;
  jokerRound: number | null;
  adjustment: number;
}

export interface Buzz {
  teamId: string;
  at: number;
  outcome: BuzzOutcome;
}

export interface QuestionState {
  phase: QuestionPhase;
  openedAt: number | null;
  closesAt: number | null;
  lockedAt: number | null;
  /** Why answers closed: the host pressed lock or reveal, or the timer ran out. */
  lockedBy: "host" | "timer" | null;
  answers: Record<string, { value: AnswerValue; at: number }>;
  verdicts: Record<string, boolean>;
  buzzes: Buzz[];
}

export interface TiebreakState {
  teamIds: string[];
  phase: "open" | "revealed";
  openedAt: number;
  answers: Record<string, { value: number; at: number }>;
}

export interface RoomState {
  code: string;
  hostToken: string;
  createdAt: number;
  updatedAt: number;
  quiz: Quiz | null;
  stage: Stage;
  teams: Team[];
  questions: Record<string, QuestionState>;
  tiebreak: TiebreakState | null;
}

export type Actor = { role: "host" } | { role: "team"; teamId: string };

export interface GameError {
  code: ErrorCode;
  message: string;
}

export type Result<T = RoomState> = { ok: true; state: T } | { ok: false; error: GameError };

const fail = (code: ErrorCode, message: string): { ok: false; error: GameError } => ({ ok: false, error: { code, message } });
const done = (state: RoomState): Result => ({ ok: true, state });

// ---------------------------------------------------------------------------
// Creating rooms and seating teams

export function createRoom(code: string, hostToken: string, now: number): RoomState {
  return {
    code,
    hostToken,
    createdAt: now,
    updatedAt: now,
    quiz: null,
    stage: { kind: "lobby" },
    teams: [],
    questions: {},
    tiebreak: null,
  };
}

/** Constant-time comparison so response timing never hints at the host token. */
export function isHostToken(state: RoomState, candidate: string): boolean {
  const a = state.hostToken;
  if (a.length !== candidate.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ candidate.charCodeAt(i);
  return diff === 0;
}

export function findTeamByToken(state: RoomState, token: string): Team | undefined {
  return state.teams.find((t) => t.token === token);
}

export function findTeam(state: RoomState, teamId: string): Team | undefined {
  return state.teams.find((t) => t.id === teamId);
}

const nameKey = (name: string) => name.toLocaleLowerCase("en-GB");

/**
 * Seats a new team. `name` must already have been through TeamNameSchema.
 * The caller supplies a fresh random id and token.
 */
export function joinTeam(
  state: RoomState,
  name: string,
  ids: { teamId: string; token: string },
  now: number,
): Result<{ room: RoomState; team: Team }> {
  if (state.teams.length >= LIMITS.teamsPerRoom) {
    return fail("room_full", `This room already has ${LIMITS.teamsPerRoom} teams.`);
  }
  if (state.teams.some((t) => nameKey(t.name) === nameKey(name))) {
    return fail("name_taken", `There is already a team called "${name}". Try another name.`);
  }
  const team: Team = { id: ids.teamId, name, token: ids.token, joinedAt: now, jokerRound: null, adjustment: 0 };
  return { ok: true, state: { room: { ...state, teams: [...state.teams, team], updatedAt: now }, team } };
}

// ---------------------------------------------------------------------------
// Question helpers

export function emptyQuestionState(): QuestionState {
  return { phase: "ready", openedAt: null, closesAt: null, lockedAt: null, lockedBy: null, answers: {}, verdicts: {}, buzzes: [] };
}

export function questionState(state: RoomState, key: string): QuestionState {
  return state.questions[key] ?? emptyQuestionState();
}

function withQuestion(state: RoomState, key: string, qs: QuestionState): RoomState {
  return { ...state, questions: { ...state.questions, [key]: qs } };
}

export interface CurrentQuestion {
  key: string;
  round: number;
  index: number;
  question: Question;
  roundInfo: Round;
}

export function currentQuestion(state: RoomState): CurrentQuestion | null {
  if (state.stage.kind !== "question" || !state.quiz) return null;
  const { round, question } = state.stage;
  const q = getQuestion(state.quiz, round, question);
  const r = state.quiz.rounds[round];
  if (!q || !r) return null;
  return { key: questionKey(round, question), round, index: question, question: q, roundInfo: r };
}

export function roundStarted(state: RoomState, round: number): boolean {
  const r = state.quiz?.rounds[round];
  if (!r) return false;
  return r.questions.some((_, i) => questionState(state, questionKey(round, i)).openedAt !== null);
}

/** Sets verdicts the machine can be sure of: every multiple-choice answer and exact text matches. */
function autoMark(question: Question, qs: QuestionState): Record<string, boolean> {
  const verdicts = { ...qs.verdicts };
  for (const [teamId, answer] of Object.entries(qs.answers)) {
    if (teamId in verdicts) continue;
    if (question.type === "choice") {
      verdicts[teamId] = answer.value === question.answer;
    } else if (typeof answer.value === "string" && suggestMark(answer.value, question.answers).kind === "exact") {
      verdicts[teamId] = true;
    }
  }
  return verdicts;
}

function lockQuestion(state: RoomState, key: string, now: number, by: "host" | "timer"): RoomState {
  const qs = questionState(state, key);
  if (qs.phase !== "open") return state;
  const pos = parseQuestionKey(key);
  const question = pos && state.quiz ? getQuestion(state.quiz, pos.round, pos.question) : undefined;
  const mode = pos ? state.quiz?.rounds[pos.round]?.mode : undefined;
  const lockedAt = by === "timer" && qs.closesAt !== null ? qs.closesAt : now;
  const verdicts = question && mode === "answers" ? autoMark(question, qs) : qs.verdicts;
  return withQuestion(state, key, { ...qs, phase: "locked", lockedAt, lockedBy: by, verdicts });
}

/**
 * Applies the passage of time: any open question whose deadline has passed
 * is locked. Every command runs this first, so a late answer is refused even
 * if the alarm that would have locked the question has not fired yet.
 */
export function expire(state: RoomState, now: number): RoomState {
  let next = state;
  for (const [key, qs] of Object.entries(state.questions)) {
    if (qs.phase === "open" && qs.closesAt !== null && now >= qs.closesAt) {
      next = lockQuestion(next, key, now, "timer");
    }
  }
  return next;
}

/** The earliest moment something will change on its own, for scheduling an alarm. */
export function nextDeadline(state: RoomState): number | null {
  let soonest: number | null = null;
  for (const qs of Object.values(state.questions)) {
    if (qs.phase === "open" && qs.closesAt !== null && (soonest === null || qs.closesAt < soonest)) soonest = qs.closesAt;
  }
  return soonest;
}

// ---------------------------------------------------------------------------
// Scoring

/**
 * Scores are derived from the record of play rather than stored, so a
 * corrected mark or a kicked team can never leave totals out of step.
 * Answer-round points count once the question is revealed, which stops the
 * big screen leaking who got it right while the host is still marking.
 * Buzzer points count as soon as the host accepts the answer, because the
 * whole room heard it.
 */
export function teamScores(state: RoomState): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const team of state.teams) scores[team.id] = team.adjustment;
  const quiz = state.quiz;
  if (!quiz) return scores;
  const multiplier = (teamId: string, round: number) => (findTeam(state, teamId)?.jokerRound === round ? 2 : 1);
  for (const [key, qs] of Object.entries(state.questions)) {
    const pos = parseQuestionKey(key);
    if (!pos) continue;
    const round = quiz.rounds[pos.round];
    const question = round?.questions[pos.question];
    if (!round || !question) continue;
    if (round.mode === "answers") {
      if (qs.phase !== "revealed") continue;
      for (const [teamId, ok] of Object.entries(qs.verdicts)) {
        if (ok && teamId in scores) scores[teamId]! += question.points * multiplier(teamId, pos.round);
      }
    } else {
      for (const buzz of qs.buzzes) {
        if (buzz.outcome === "correct" && buzz.teamId in scores) {
          scores[buzz.teamId]! += question.points * multiplier(buzz.teamId, pos.round);
        }
      }
    }
  }
  return scores;
}

export interface TiebreakResult {
  teamId: string;
  value: number | null;
  distance: number | null;
  at: number | null;
}

/** Closest guess first; equal distances go to whoever locked in first; no guess comes last. */
export function tiebreakResults(state: RoomState): TiebreakResult[] | null {
  const tb = state.tiebreak;
  const target = state.quiz?.tiebreaker?.answer;
  if (!tb || tb.phase !== "revealed" || target === undefined) return null;
  const rows = tb.teamIds.map((teamId) => {
    const a = tb.answers[teamId];
    return a
      ? { teamId, value: a.value, distance: Math.abs(a.value - target), at: a.at }
      : { teamId, value: null, distance: null, at: null };
  });
  return rows.sort((x, y) => {
    if (x.distance === null || y.distance === null) return x.distance === null ? (y.distance === null ? 0 : 1) : -1;
    return x.distance - y.distance || (x.at ?? 0) - (y.at ?? 0);
  });
}

export interface Standing {
  team: Team;
  score: number;
  rank: number;
}

export function standings(state: RoomState): Standing[] {
  const scores = teamScores(state);
  const tb = tiebreakResults(state);
  const tbPos = new Map(tb?.map((r, i) => [r.teamId, i]) ?? []);
  const better = (a: Team, b: Team): boolean => {
    const sa = scores[a.id] ?? 0;
    const sb = scores[b.id] ?? 0;
    if (sa !== sb) return sa > sb;
    const pa = tbPos.get(a.id);
    const pb = tbPos.get(b.id);
    return pa !== undefined && pb !== undefined && pa < pb;
  };
  const rows = state.teams.map((team) => ({
    team,
    score: scores[team.id] ?? 0,
    rank: 1 + state.teams.filter((other) => other !== team && better(other, team)).length,
  }));
  // Rank order, then join order for a stable display.
  return rows.sort((a, b) => a.rank - b.rank || a.team.joinedAt - b.team.joinedAt);
}

/** Teams sharing the top score, used as the default line-up for a tie-breaker. */
export function teamsTiedForFirst(state: RoomState): string[] {
  const rows = standings(state);
  const top = rows[0]?.score;
  if (top === undefined) return [];
  const tied = rows.filter((r) => r.score === top).map((r) => r.team.id);
  return tied.length >= 2 ? tied : [];
}

// ---------------------------------------------------------------------------
// The reducer

export function reduce(state: RoomState, actor: Actor, cmd: HostCommand | TeamCommand, now: number): Result {
  const current = expire(state, now);
  let result: Result;
  if (cmd.type.startsWith("host.")) {
    if (actor.role !== "host") return fail("not_authorised", "Only the quizmaster can do that.");
    result = reduceHost(current, cmd as HostCommand, now);
  } else {
    if (actor.role !== "team") return fail("not_authorised", "Only teams can do that.");
    const team = findTeam(current, actor.teamId);
    if (!team) return fail("unknown_team", "Your team is no longer in this room.");
    result = reduceTeam(current, team, cmd as TeamCommand, now);
  }
  return result.ok ? done({ ...result.state, updatedAt: now }) : result;
}

function validateStage(state: RoomState, stage: Stage): GameError | null {
  const quiz = state.quiz;
  switch (stage.kind) {
    case "lobby":
    case "scoreboard":
    case "final":
      return null;
    case "roundIntro":
      if (!quiz) return { code: "no_quiz", message: "Load a quiz first." };
      return quiz.rounds[stage.round] ? null : { code: "bad_stage", message: "That round does not exist." };
    case "question":
      if (!quiz) return { code: "no_quiz", message: "Load a quiz first." };
      return getQuestion(quiz, stage.round, stage.question) ? null : { code: "bad_stage", message: "That question does not exist." };
    case "tiebreak":
      if (!quiz?.tiebreaker) return { code: "bad_stage", message: "This quiz has no tie-breaker question." };
      return null;
  }
}

function reduceHost(state: RoomState, cmd: HostCommand, now: number): Result {
  switch (cmd.type) {
    case "host.loadQuiz": {
      const parsed = parseQuiz(cmd.quiz);
      if (!parsed.ok) return fail("invalid_quiz", parsed.errors.join("\n"));
      // A new quiz starts a fresh game. Teams keep their seats.
      return done({
        ...state,
        quiz: parsed.quiz,
        stage: { kind: "lobby" },
        questions: {},
        tiebreak: null,
        teams: state.teams.map((t) => ({ ...t, jokerRound: null, adjustment: 0 })),
      });
    }

    case "host.resetGame":
      return done({
        ...state,
        stage: { kind: "lobby" },
        questions: {},
        tiebreak: null,
        teams: state.teams.map((t) => ({ ...t, jokerRound: null, adjustment: 0 })),
      });

    case "host.goto": {
      const err = validateStage(state, cmd.stage);
      if (err) return { ok: false, error: err };
      // Moving away from a question closes it, so nobody can keep answering
      // something that is no longer on the screen.
      const cq = currentQuestion(state);
      let next = state;
      if (cq) {
        const leaving = !(cmd.stage.kind === "question" && cmd.stage.round === cq.round && cmd.stage.question === cq.index);
        if (leaving) next = lockQuestion(next, cq.key, now, "host");
      }
      return done({ ...next, stage: cmd.stage });
    }

    case "host.open": {
      const cq = currentQuestion(state);
      if (!cq) return fail("bad_stage", "Show a question before opening it.");
      const qs = questionState(state, cq.key);
      if (qs.phase !== "ready") return fail("wrong_phase", "This question has already been opened.");
      const limit = cq.question.timeLimitSeconds;
      return done(withQuestion(state, cq.key, { ...qs, phase: "open", openedAt: now, closesAt: limit ? now + limit * 1000 : null }));
    }

    case "host.lock": {
      const cq = currentQuestion(state);
      if (!cq) return fail("bad_stage", "There is no question on screen.");
      if (questionState(state, cq.key).phase !== "open") return fail("wrong_phase", "This question is not open.");
      return done(lockQuestion(state, cq.key, now, "host"));
    }

    case "host.reopen": {
      const cq = currentQuestion(state);
      if (!cq) return fail("bad_stage", "There is no question on screen.");
      const qs = questionState(state, cq.key);
      if (qs.phase === "revealed") return fail("wrong_phase", "The answer has been revealed, so this question cannot reopen.");
      if (qs.phase !== "locked") return fail("wrong_phase", "Only a locked question can be reopened.");
      const limit = cq.question.timeLimitSeconds;
      // Answers may change after reopening, so automatic marks are recalculated at the next lock.
      return done(
        withQuestion(state, cq.key, {
          ...qs,
          phase: "open",
          closesAt: limit ? now + limit * 1000 : null,
          lockedAt: null,
          lockedBy: null,
          verdicts: cq.roundInfo.mode === "answers" ? {} : qs.verdicts,
        }),
      );
    }

    case "host.reveal": {
      const cq = currentQuestion(state);
      if (!cq) return fail("bad_stage", "There is no question on screen.");
      const locked = lockQuestion(state, cq.key, now, "host");
      const qs = questionState(locked, cq.key);
      if (qs.phase !== "locked") return fail("wrong_phase", qs.phase === "ready" ? "Open the question first." : "Already revealed.");
      return done(withQuestion(locked, cq.key, { ...qs, phase: "revealed" }));
    }

    case "host.mark": {
      const pos = parseQuestionKey(cmd.questionKey);
      const round = pos ? state.quiz?.rounds[pos.round] : undefined;
      if (!pos || !round?.questions[pos.question]) return fail("bad_stage", "That question does not exist.");
      if (round.mode !== "answers") return fail("not_answer_round", "Buzzer questions are marked with the buzzer controls.");
      const qs = questionState(state, cmd.questionKey);
      if (qs.phase !== "locked" && qs.phase !== "revealed") return fail("wrong_phase", "Lock the question before marking.");
      if (!(cmd.teamId in qs.answers)) return fail("unknown_team", "That team did not answer this question.");
      const verdicts = { ...qs.verdicts };
      if (cmd.verdict === "clear") delete verdicts[cmd.teamId];
      else verdicts[cmd.teamId] = cmd.verdict === "correct";
      return done(withQuestion(state, cmd.questionKey, { ...qs, verdicts }));
    }

    case "host.acceptExact": {
      const pos = parseQuestionKey(cmd.questionKey);
      const question = pos && state.quiz ? getQuestion(state.quiz, pos.round, pos.question) : undefined;
      if (!pos || !question) return fail("bad_stage", "That question does not exist.");
      const qs = questionState(state, cmd.questionKey);
      if (qs.phase !== "locked" && qs.phase !== "revealed") return fail("wrong_phase", "Lock the question before marking.");
      const verdicts = { ...qs.verdicts };
      for (const [teamId, answer] of Object.entries(qs.answers)) {
        if (question.type === "text" && typeof answer.value === "string") {
          const kind = suggestMark(answer.value, question.answers).kind;
          if (kind === "exact") verdicts[teamId] = true;
          else if (kind === "none" && !(teamId in verdicts)) verdicts[teamId] = false;
        }
      }
      return done(withQuestion(state, cmd.questionKey, { ...qs, verdicts }));
    }

    case "host.buzzVerdict": {
      const pos = parseQuestionKey(cmd.questionKey);
      const round = pos ? state.quiz?.rounds[pos.round] : undefined;
      if (!pos || !round?.questions[pos.question]) return fail("bad_stage", "That question does not exist.");
      if (round.mode !== "buzzer") return fail("not_buzzer_round", "This is not a buzzer round.");
      const qs = questionState(state, cmd.questionKey);
      if (qs.phase !== "open" && qs.phase !== "locked") return fail("wrong_phase", "This question is not live.");
      const idx = qs.buzzes.findIndex((b) => b.outcome === "waiting");
      if (idx === -1) return fail("wrong_phase", "Nobody is waiting to answer.");
      const buzzes = qs.buzzes.map((b, i) => (i === idx ? { ...b, outcome: (cmd.correct ? "correct" : "wrong") as BuzzOutcome } : b));
      if (cmd.correct) {
        // A correct answer ends the question; anyone still queued loses their turn.
        return done(withQuestion(state, cmd.questionKey, { ...qs, buzzes, phase: "locked", lockedAt: now, lockedBy: "host" }));
      }
      return done(withQuestion(state, cmd.questionKey, { ...qs, buzzes }));
    }

    case "host.adjust": {
      const team = findTeam(state, cmd.teamId);
      if (!team) return fail("unknown_team", "That team is not in the room.");
      return done({ ...state, teams: state.teams.map((t) => (t.id === team.id ? { ...t, adjustment: t.adjustment + cmd.delta } : t)) });
    }

    case "host.kick": {
      if (!findTeam(state, cmd.teamId)) return fail("unknown_team", "That team is not in the room.");
      const questions: Record<string, QuestionState> = {};
      for (const [key, qs] of Object.entries(state.questions)) {
        const answers = { ...qs.answers };
        const verdicts = { ...qs.verdicts };
        delete answers[cmd.teamId];
        delete verdicts[cmd.teamId];
        questions[key] = { ...qs, answers, verdicts, buzzes: qs.buzzes.filter((b) => b.teamId !== cmd.teamId) };
      }
      const tiebreak = state.tiebreak
        ? {
            ...state.tiebreak,
            teamIds: state.tiebreak.teamIds.filter((id) => id !== cmd.teamId),
            answers: Object.fromEntries(Object.entries(state.tiebreak.answers).filter(([id]) => id !== cmd.teamId)),
          }
        : null;
      return done({ ...state, teams: state.teams.filter((t) => t.id !== cmd.teamId), questions, tiebreak });
    }

    case "host.tiebreakStart": {
      if (!state.quiz?.tiebreaker) return fail("bad_stage", "This quiz has no tie-breaker question.");
      let teamIds: string[];
      if (cmd.teamIds && cmd.teamIds.length) {
        teamIds = [...new Set(cmd.teamIds)];
        if (teamIds.some((id) => !findTeam(state, id))) return fail("unknown_team", "One of those teams is not in the room.");
        if (teamIds.length < 2) return fail("no_tie", "A tie-breaker needs at least two teams.");
      } else {
        teamIds = teamsTiedForFirst(state);
        if (!teamIds.length) return fail("no_tie", "Nobody is tied for first place. Pick the teams yourself if you still want a tie-breaker.");
      }
      return done({ ...state, stage: { kind: "tiebreak" }, tiebreak: { teamIds, phase: "open", openedAt: now, answers: {} } });
    }

    case "host.closeRoom":
      // Handled by the Durable Object, which owns storage and sockets.
      return fail("bad_message", "Closing a room is not a game action.");

    case "host.tiebreakReveal": {
      if (!state.tiebreak) return fail("wrong_phase", "Start the tie-breaker first.");
      if (state.tiebreak.phase === "revealed") return fail("wrong_phase", "Already revealed.");
      return done({ ...state, tiebreak: { ...state.tiebreak, phase: "revealed" } });
    }
  }
}

function checkLive(state: RoomState, key: string): { ok: true; cq: CurrentQuestion; qs: QuestionState } | { ok: false; error: GameError } {
  const cq = currentQuestion(state);
  const qs = questionState(state, key);
  if (!cq || cq.key !== key) {
    if (qs.phase === "locked" || qs.phase === "revealed") return fail("locked", "Answers for that question are closed.");
    return fail("stale_question", "That question is not on screen any more.");
  }
  switch (qs.phase) {
    case "ready":
      return fail("wrong_phase", "This question is not open yet.");
    case "locked":
      return qs.lockedBy === "timer"
        ? fail("late", "Too late. Time ran out before your answer reached the quizmaster.")
        : fail("locked", "Answers are locked for this question.");
    case "revealed":
      return fail("locked", "The answer has been revealed, so answers are locked.");
    case "open":
      return { ok: true, cq, qs };
  }
}

function reduceTeam(state: RoomState, team: Team, cmd: TeamCommand, now: number): Result {
  switch (cmd.type) {
    case "team.answer": {
      const live = checkLive(state, cmd.questionKey);
      if (!live.ok) return live;
      const { cq, qs } = live;
      if (cq.roundInfo.mode !== "answers") return fail("not_answer_round", "This is a buzzer round. Hit the buzzer instead.");
      let value: AnswerValue;
      if (cq.question.type === "choice") {
        if (typeof cmd.value !== "number" || cmd.value >= cq.question.options.length) {
          return fail("invalid_answer", "Pick one of the options.");
        }
        value = cmd.value;
      } else {
        const text = typeof cmd.value === "string" ? cmd.value.normalize("NFC").replace(/\s+/g, " ").trim() : "";
        if (!text) return fail("invalid_answer", "Type an answer first.");
        if (text.length > LIMITS.answerChars) return fail("invalid_answer", `Answers can be up to ${LIMITS.answerChars} characters.`);
        value = text;
      }
      return done(withQuestion(state, cq.key, { ...qs, answers: { ...qs.answers, [team.id]: { value, at: now } } }));
    }

    case "team.buzz": {
      const live = checkLive(state, cmd.questionKey);
      if (!live.ok) return live;
      const { cq, qs } = live;
      if (cq.roundInfo.mode !== "buzzer") return fail("not_buzzer_round", "This is not a buzzer round.");
      if (qs.buzzes.some((b) => b.teamId === team.id)) return fail("already_buzzed", "You have already buzzed on this question.");
      // Arrival order at the room is the order. One Durable Object handles
      // one message at a time, so there is no race to settle.
      return done(withQuestion(state, cq.key, { ...qs, buzzes: [...qs.buzzes, { teamId: team.id, at: now, outcome: "waiting" }] }));
    }

    case "team.joker": {
      const round = state.quiz?.rounds[cmd.round];
      if (!round) return fail("no_quiz", "That round does not exist.");
      if (!round.jokerAllowed) return fail("joker_not_allowed", "Jokers cannot be played on this round.");
      if (team.jokerRound !== null) return fail("joker_used", "You have already played your joker.");
      if (roundStarted(state, cmd.round)) return fail("joker_too_late", "That round has already started. Jokers must be played before the first question opens.");
      return done({ ...state, teams: state.teams.map((t) => (t.id === team.id ? { ...t, jokerRound: cmd.round } : t)) });
    }

    case "team.tiebreak": {
      const tb = state.tiebreak;
      if (!tb) return fail("wrong_phase", "There is no tie-breaker running.");
      if (!tb.teamIds.includes(team.id)) return fail("not_in_tiebreak", "Your team is not in this tie-breaker.");
      if (tb.phase !== "open") return fail("locked", "The tie-breaker answer has been revealed.");
      return done({ ...state, tiebreak: { ...tb, answers: { ...tb.answers, [team.id]: { value: cmd.value, at: now } } } });
    }
  }
}
