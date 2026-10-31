import { z } from "zod";
import { LIMITS } from "./limits";
import type { Media, Quiz } from "./quiz";

// The WebSocket protocol between the room (a Durable Object) and its three
// kinds of client. Messages are JSON objects with a "type" field.
//
// Client to server messages are validated with zod because they arrive from
// the open internet. Server to client messages are plain TypeScript types:
// the clients trust the room.

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Shared value types

export type Stage =
  | { kind: "lobby" }
  | { kind: "roundIntro"; round: number }
  | { kind: "question"; round: number; question: number }
  | { kind: "scoreboard" }
  | { kind: "tiebreak" }
  | { kind: "final" };

export type QuestionPhase = "ready" | "open" | "locked" | "revealed";

/** "skipped": still queued when another team answered correctly. */
export type BuzzOutcome = "waiting" | "correct" | "wrong" | "skipped";

export type AnswerValue = string | number;

// ---------------------------------------------------------------------------
// Client to server

const token = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "malformed token");
const teamId = z.string().regex(/^[A-Za-z0-9_-]{4,32}$/, "malformed team id");
const qKey = z.string().regex(/^\d{1,3}\.\d{1,3}$/, "malformed question key");
const index = z.number().int().min(0).max(999);

export const TeamNameSchema = z
  .string()
  .transform((s) => s.normalize("NFC").replace(/\s+/g, " ").trim())
  .pipe(
    z
      .string()
      .min(1, "Team name can't be empty")
      .max(LIMITS.teamNameChars, `Team name must be ${LIMITS.teamNameChars} characters or fewer`)
      // Control characters and zero-width tricks make names impossible to read on the big screen.
      .refine((s) => !/[\p{Cc}\p{Cf}]/u.test(s), "Team name contains invisible characters"),
  );

export const StageSchema: z.ZodType<Stage> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("lobby") }),
  z.object({ kind: z.literal("roundIntro"), round: index }),
  z.object({ kind: z.literal("question"), round: index, question: index }),
  z.object({ kind: z.literal("scoreboard") }),
  z.object({ kind: z.literal("tiebreak") }),
  z.object({ kind: z.literal("final") }),
]);

/** First message on every socket. Nothing else is accepted until one succeeds. */
export const AuthMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth.host"), hostToken: token }),
  z.object({ type: z.literal("auth.screen") }),
  z.object({ type: z.literal("auth.join"), name: TeamNameSchema }),
  z.object({ type: z.literal("auth.resume"), token }),
]);

export const HostCommandSchema = z.discriminatedUnion("type", [
  /** The quiz is validated separately with QuizSchema so errors can be reported precisely. */
  z.object({ type: z.literal("host.loadQuiz"), quiz: z.unknown() }),
  z.object({ type: z.literal("host.goto"), stage: StageSchema }),
  z.object({ type: z.literal("host.open") }),
  z.object({ type: z.literal("host.lock") }),
  z.object({ type: z.literal("host.reopen") }),
  z.object({ type: z.literal("host.reveal") }),
  z.object({
    type: z.literal("host.mark"),
    questionKey: qKey,
    teamId,
    verdict: z.enum(["correct", "wrong", "clear"]),
  }),
  z.object({ type: z.literal("host.acceptExact"), questionKey: qKey }),
  z.object({ type: z.literal("host.buzzVerdict"), questionKey: qKey, correct: z.boolean() }),
  z.object({
    type: z.literal("host.adjust"),
    teamId,
    delta: z.number().int().min(-LIMITS.scoreAdjustMax).max(LIMITS.scoreAdjustMax),
  }),
  z.object({ type: z.literal("host.kick"), teamId }),
  z.object({ type: z.literal("host.tiebreakStart"), teamIds: z.array(teamId).max(LIMITS.teamsPerRoom).optional() }),
  z.object({ type: z.literal("host.tiebreakReveal") }),
  z.object({ type: z.literal("host.resetGame") }),
  /** Ends the room for everyone and deletes everything it held. */
  z.object({ type: z.literal("host.closeRoom") }),
]);

export const TeamCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("team.answer"),
    questionKey: qKey,
    /** Option index for multiple choice, text for free-text questions. */
    value: z.union([index, z.string().max(LIMITS.answerChars * 2)]),
  }),
  z.object({ type: z.literal("team.buzz"), questionKey: qKey }),
  z.object({ type: z.literal("team.joker"), round: index }),
  z.object({ type: z.literal("team.tiebreak"), value: z.number().finite() }),
]);

export const ClientMessageSchema = z.discriminatedUnion("type", [AuthMessageSchema, HostCommandSchema, TeamCommandSchema]);

export type AuthMessage = z.output<typeof AuthMessageSchema>;
export type HostCommand = z.output<typeof HostCommandSchema>;
export type TeamCommand = z.output<typeof TeamCommandSchema>;
export type ClientMessage = z.output<typeof ClientMessageSchema>;
/** What a client may send, before transforms such as name trimming. */
export type ClientMessageInput = z.input<typeof ClientMessageSchema>;

export type ParsedMessage = { ok: true; message: ClientMessage } | { ok: false; error: string };

export function parseClientMessage(raw: string | ArrayBuffer): ParsedMessage {
  if (typeof raw !== "string") return { ok: false, error: "Binary messages are not supported" };
  if (raw.length > LIMITS.messageChars) return { ok: false, error: "Message too large" };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Message is not valid JSON" };
  }
  const result = ClientMessageSchema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    if (first && first.path.length === 1 && first.path[0] === "type") return { ok: false, error: "Unknown message type" };
    return { ok: false, error: first ? `${first.path.join(".") || "message"}: ${first.message}` : "Invalid message" };
  }
  return { ok: true, message: result.data };
}

// ---------------------------------------------------------------------------
// Server to client

export type ErrorCode =
  | "bad_message"
  | "not_authorised"
  | "room_not_found"
  | "room_full"
  | "name_taken"
  | "unknown_token"
  | "no_quiz"
  | "invalid_quiz"
  | "bad_stage"
  | "wrong_phase"
  | "stale_question"
  | "late"
  | "locked"
  | "already_buzzed"
  | "not_buzzer_round"
  | "not_answer_round"
  | "invalid_answer"
  | "joker_used"
  | "joker_not_allowed"
  | "joker_too_late"
  | "unknown_team"
  | "no_tie"
  | "not_in_tiebreak"
  | "rate_limited";

export interface PublicTeam {
  id: string;
  name: string;
  connected: boolean;
  score: number;
  /** 1-based; equal scores share a rank. */
  rank: number;
  jokerRound: number | null;
}

export interface RoundSummary {
  title: string;
  mode: "answers" | "buzzer";
  jokerAllowed: boolean;
  questionCount: number;
  /** True once any question in the round has been opened. Jokers close at that point. */
  started: boolean;
}

/** Media as shown to phones and the big screen. Audio URLs stay on the host. */
export type PublicMedia = { kind: "image"; url: string; alt: string } | { kind: "audio"; label: string };

export interface PublicQuestion {
  key: string;
  round: number;
  question: number;
  /** 1-based position in the round, for display. */
  number: number;
  mode: "answers" | "buzzer";
  type: "choice" | "text";
  prompt: string;
  options: string[] | null;
  media: PublicMedia | null;
  points: number;
  timeLimitSeconds: number | null;
  phase: QuestionPhase;
  openedAt: number | null;
  closesAt: number | null;
  answeredCount: number;
  buzzes: { teamId: string; name: string; at: number; outcome: BuzzOutcome }[];
  /** Present only once revealed. */
  reveal: { text: string; choiceIndex: number | null; correctTeamIds: string[] } | null;
}

export interface TiebreakPublic {
  prompt: string;
  unit: string | null;
  teamIds: string[];
  phase: "open" | "revealed";
  answeredTeamIds: string[];
  /** Present only once revealed: closest first. */
  results: { teamId: string; value: number | null; distance: number | null }[] | null;
  answer: number | null;
}

export interface ScreenView {
  role: "screen";
  code: string;
  quizTitle: string | null;
  stage: Stage;
  rounds: RoundSummary[];
  teams: PublicTeam[];
  question: PublicQuestion | null;
  tiebreak: TiebreakPublic | null;
}

export interface TeamView extends Omit<ScreenView, "role"> {
  role: "team";
  me: PublicTeam;
  /** This team's answer to the current question, with the verdict once revealed. */
  myAnswer: { value: AnswerValue; at: number; verdict: boolean | null } | null;
  /** Position in the buzz queue (1-based) for the current question. */
  myBuzz: { position: number; outcome: BuzzOutcome } | null;
  myTiebreak: number | null;
  /** Rounds this team could still play its joker on. */
  jokerRounds: number[];
}

export interface HostAnswerRow {
  teamId: string;
  name: string;
  value: AnswerValue | null;
  display: string;
  at: number | null;
  verdict: boolean | null;
  suggestion: "exact" | "close" | "none" | null;
  closestTo: string | null;
}

export interface HostQuestionDetail {
  key: string;
  answers: HostAnswerRow[];
  unmarked: number;
  activeBuzzTeamId: string | null;
}

export interface HostView extends Omit<ScreenView, "role"> {
  role: "host";
  quiz: Quiz | null;
  /** Phase of every question, keyed by question key, for the progress map. */
  phases: Record<string, QuestionPhase>;
  detail: HostQuestionDetail | null;
  /** Per-team manual adjustments. */
  adjustments: Record<string, number>;
  teamsMax: number;
}

export type RoleView = HostView | TeamView | ScreenView;

export type Role = "host" | "team" | "screen";

export type ServerMessage =
  | { type: "welcome"; role: Role; protocol: number; teamId?: string; token?: string; name?: string }
  | { type: "state"; view: RoleView; serverNow: number }
  | { type: "error"; code: ErrorCode; message: string }
  | { type: "kicked" }
  | { type: "closed"; reason: string };

/** Re-exported so clients can import everything protocol-shaped from one module. */
export type { Media };
