// Projections of the room state for each kind of client. Each view carries
// only what that client is allowed to know: phones never see a correct
// answer before the reveal, other teams' answers, or the host token.

import { suggestMark } from "../shared/fuzzy";
import { LIMITS } from "../shared/limits";
import type {
  HostAnswerRow,
  HostQuestionDetail,
  HostView,
  PublicMedia,
  PublicQuestion,
  PublicTeam,
  QuestionPhase,
  RoundSummary,
  ScreenView,
  TeamView,
  TiebreakPublic,
} from "../shared/protocol";
import { answerText, questionKey, type Media } from "../shared/quiz";
import { currentQuestion, findTeam, questionState, roundStarted, standings, tiebreakResults, type RoomState } from "./game";

function publicMedia(media: Media | undefined): PublicMedia | null {
  if (!media) return null;
  // Audio is played from the host laptop, so its URL never leaves the host view.
  return media.kind === "image" ? { kind: "image", url: media.url, alt: media.alt } : { kind: "audio", label: media.label };
}

function publicTeams(state: RoomState, connected: ReadonlySet<string>): PublicTeam[] {
  return standings(state).map(({ team, score, rank }) => ({
    id: team.id,
    name: team.name,
    connected: connected.has(team.id),
    score,
    rank,
    jokerRound: team.jokerRound,
  }));
}

function roundSummaries(state: RoomState): RoundSummary[] {
  return (state.quiz?.rounds ?? []).map((r, i) => ({
    title: r.title,
    mode: r.mode,
    jokerAllowed: r.jokerAllowed,
    questionCount: r.questions.length,
    started: roundStarted(state, i),
  }));
}

function correctTeamIds(state: RoomState, key: string, mode: "answers" | "buzzer"): string[] {
  const qs = questionState(state, key);
  if (mode === "buzzer") return qs.buzzes.filter((b) => b.outcome === "correct").map((b) => b.teamId);
  return Object.entries(qs.verdicts)
    .filter(([, ok]) => ok)
    .map(([id]) => id);
}

function publicQuestion(state: RoomState, revealPrompt: boolean): PublicQuestion | null {
  const cq = currentQuestion(state);
  if (!cq) return null;
  const qs = questionState(state, cq.key);
  const q = cq.question;
  // Until the host opens the question, phones and the big screen only learn
  // that one is coming. The prompt appears for everyone at the same moment.
  const showPrompt = revealPrompt || qs.phase !== "ready";
  return {
    key: cq.key,
    round: cq.round,
    question: cq.index,
    number: cq.index + 1,
    mode: cq.roundInfo.mode,
    type: q.type,
    prompt: showPrompt ? q.prompt : "",
    options: showPrompt && q.type === "choice" ? q.options : null,
    media: showPrompt ? publicMedia(q.media) : null,
    points: q.points,
    timeLimitSeconds: q.timeLimitSeconds ?? null,
    phase: qs.phase,
    openedAt: qs.openedAt,
    closesAt: qs.closesAt,
    answeredCount: Object.keys(qs.answers).length,
    buzzes: qs.buzzes.map((b) => ({ teamId: b.teamId, name: findTeam(state, b.teamId)?.name ?? "?", at: b.at, outcome: b.outcome })),
    reveal:
      qs.phase === "revealed"
        ? {
            text: answerText(q),
            choiceIndex: q.type === "choice" ? q.answer : null,
            correctTeamIds: correctTeamIds(state, cq.key, cq.roundInfo.mode),
          }
        : null,
  };
}

function publicTiebreak(state: RoomState): TiebreakPublic | null {
  const tb = state.tiebreak;
  const def = state.quiz?.tiebreaker;
  if (!tb || !def) return null;
  const results = tiebreakResults(state);
  return {
    prompt: def.prompt,
    unit: def.unit ?? null,
    teamIds: tb.teamIds,
    phase: tb.phase,
    answeredTeamIds: Object.keys(tb.answers),
    results: results ? results.map(({ teamId, value, distance }) => ({ teamId, value, distance })) : null,
    answer: tb.phase === "revealed" ? def.answer : null,
  };
}

function baseView(state: RoomState, connected: ReadonlySet<string>, revealPrompt: boolean): Omit<ScreenView, "role"> {
  return {
    code: state.code,
    quizTitle: state.quiz?.title ?? null,
    stage: state.stage,
    rounds: roundSummaries(state),
    teams: publicTeams(state, connected),
    question: publicQuestion(state, revealPrompt),
    tiebreak: publicTiebreak(state),
  };
}

export function screenView(state: RoomState, connected: ReadonlySet<string>): ScreenView {
  return { role: "screen", ...baseView(state, connected, false) };
}

export function teamView(state: RoomState, connected: ReadonlySet<string>, teamId: string): TeamView | null {
  const base = baseView(state, connected, false);
  const me = base.teams.find((t) => t.id === teamId);
  const team = findTeam(state, teamId);
  if (!me || !team) return null;
  const cq = currentQuestion(state);
  let myAnswer: TeamView["myAnswer"] = null;
  let myBuzz: TeamView["myBuzz"] = null;
  if (cq) {
    const qs = questionState(state, cq.key);
    const a = qs.answers[teamId];
    if (a) {
      const verdict = qs.phase === "revealed" && teamId in qs.verdicts ? qs.verdicts[teamId]! : null;
      myAnswer = { value: a.value, at: a.at, verdict };
    }
    const pos = qs.buzzes.findIndex((b) => b.teamId === teamId);
    if (pos !== -1) myBuzz = { position: pos + 1, outcome: qs.buzzes[pos]!.outcome };
  }
  const jokerRounds =
    team.jokerRound === null ? base.rounds.flatMap((r, i) => (r.jokerAllowed && !r.started ? [i] : [])) : [];
  return {
    role: "team",
    ...base,
    me,
    myAnswer,
    myBuzz,
    myTiebreak: state.tiebreak?.answers[teamId]?.value ?? null,
    jokerRounds,
  };
}

function hostDetail(state: RoomState): HostQuestionDetail | null {
  const cq = currentQuestion(state);
  if (!cq) return null;
  const qs = questionState(state, cq.key);
  const q = cq.question;
  const answers: HostAnswerRow[] = state.teams.map((team) => {
    const a = qs.answers[team.id];
    const verdict = team.id in qs.verdicts ? qs.verdicts[team.id]! : null;
    if (!a) return { teamId: team.id, name: team.name, value: null, display: "", at: null, verdict, suggestion: null, closestTo: null };
    let display = String(a.value);
    let suggestion: HostAnswerRow["suggestion"] = null;
    let closestTo: string | null = null;
    if (q.type === "choice" && typeof a.value === "number") {
      display = `${String.fromCharCode(65 + a.value)}. ${q.options[a.value] ?? ""}`;
      suggestion = a.value === q.answer ? "exact" : "none";
    } else if (q.type === "text" && typeof a.value === "string") {
      const s = suggestMark(a.value, q.answers);
      suggestion = s.kind;
      closestTo = s.closestTo;
    }
    return { teamId: team.id, name: team.name, value: a.value, display, at: a.at, verdict, suggestion, closestTo };
  });
  const unmarked = cq.roundInfo.mode === "answers" ? answers.filter((r) => r.value !== null && r.verdict === null).length : 0;
  return {
    key: cq.key,
    answers,
    unmarked,
    activeBuzzTeamId: qs.buzzes.find((b) => b.outcome === "waiting")?.teamId ?? null,
  };
}

export function hostView(state: RoomState, connected: ReadonlySet<string>): HostView {
  const phases: Record<string, QuestionPhase> = {};
  state.quiz?.rounds.forEach((r, ri) =>
    r.questions.forEach((_, qi) => {
      const key = questionKey(ri, qi);
      phases[key] = questionState(state, key).phase;
    }),
  );
  return {
    role: "host",
    ...baseView(state, connected, true),
    quiz: state.quiz,
    phases,
    detail: hostDetail(state),
    adjustments: Object.fromEntries(state.teams.map((t) => [t.id, t.adjustment])),
    teamsMax: LIMITS.teamsPerRoom,
  };
}
