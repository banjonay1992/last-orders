import { z } from "zod";
import { LIMITS } from "./limits";

// The quiz file format. This schema is the single source of truth: the
// server validates uploads with it, the editor validates imports with it,
// and docs/quiz-format.md describes it for humans.

const trimmed = (max: number) => z.string().trim().min(1).max(max);

/**
 * Media may point at an https URL or a path on the same site (for files you
 * deploy alongside the app, such as /sample-media/clock.svg). Data URLs are
 * refused to keep quiz files small enough to store in a room.
 */
const mediaUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => /^https:\/\/[^\s]+$/i.test(v) || /^\/(?!\/)[^\s]*$/.test(v), {
    message: "must be an https:// URL or a path starting with /",
  });

export const MediaSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("image"),
    url: mediaUrl,
    /** Shown to screen readers and used if the image fails to load. */
    alt: trimmed(300),
  }),
  z.object({
    kind: z.literal("audio"),
    /** What the host should play, for example "Clip 3". Shown to everyone. */
    label: trimmed(120),
    /** Optional clip the host laptop can play. Never sent to phones. */
    url: mediaUrl.optional(),
  }),
]);

const questionBase = {
  prompt: trimmed(LIMITS.promptChars),
  points: z.number().int().min(1).max(LIMITS.pointsMax).default(1),
  timeLimitSeconds: z
    .number()
    .int()
    .min(LIMITS.timeLimitMinSeconds)
    .max(LIMITS.timeLimitMaxSeconds)
    .optional(),
  media: MediaSchema.optional(),
  /** Private notes for the quizmaster, never shown to teams. */
  hostNotes: z.string().trim().max(500).optional(),
};

export const ChoiceQuestionSchema = z
  .object({
    type: z.literal("choice"),
    ...questionBase,
    options: z.array(trimmed(LIMITS.optionChars)).min(LIMITS.choiceOptionsMin).max(LIMITS.choiceOptionsMax),
    /** Zero-based index into options. */
    answer: z.number().int().min(0),
  })
  .superRefine((q, ctx) => {
    if (q.answer >= q.options.length) {
      ctx.addIssue({ code: "custom", path: ["answer"], message: `must be between 0 and ${q.options.length - 1}` });
    }
    const seen = new Set<string>();
    q.options.forEach((opt, i) => {
      const key = opt.toLowerCase();
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["options", i], message: "duplicate option" });
      seen.add(key);
    });
  });

export const TextQuestionSchema = z.object({
  type: z.literal("text"),
  ...questionBase,
  /** Accepted answers. The first is shown on reveal; the rest help marking. */
  answers: z.array(trimmed(LIMITS.answerChars)).min(1).max(LIMITS.acceptedAnswersMax),
});

export const QuestionSchema = z.discriminatedUnion("type", [ChoiceQuestionSchema, TextQuestionSchema]);

export const RoundSchema = z.object({
  title: trimmed(80),
  /** "answers": every team submits from their phone. "buzzer": first to buzz answers out loud. */
  mode: z.enum(["answers", "buzzer"]).default("answers"),
  jokerAllowed: z.boolean().default(true),
  questions: z.array(QuestionSchema).min(1).max(LIMITS.questionsPerRound),
});

export const TiebreakerSchema = z.object({
  prompt: trimmed(LIMITS.promptChars),
  answer: z.number().finite(),
  unit: z.string().trim().max(30).optional(),
});

export const QuizSchema = z
  .object({
    format: z.literal("last-orders-quiz"),
    version: z.literal(1),
    title: trimmed(100),
    rounds: z.array(RoundSchema).min(1).max(LIMITS.rounds),
    tiebreaker: TiebreakerSchema.optional(),
  })
  .superRefine((quiz, ctx) => {
    const total = quiz.rounds.reduce((n, r) => n + r.questions.length, 0);
    if (total > LIMITS.questionsTotal) {
      ctx.addIssue({ code: "custom", path: ["rounds"], message: `has ${total} questions; the limit is ${LIMITS.questionsTotal}` });
    }
  });

export type Media = z.output<typeof MediaSchema>;
export type ChoiceQuestion = z.output<typeof ChoiceQuestionSchema>;
export type TextQuestion = z.output<typeof TextQuestionSchema>;
export type Question = z.output<typeof QuestionSchema>;
export type Round = z.output<typeof RoundSchema>;
export type Tiebreaker = z.output<typeof TiebreakerSchema>;
export type Quiz = z.output<typeof QuizSchema>;
/** What a person may write in a file: defaults can be left out. */
export type QuizInput = z.input<typeof QuizSchema>;

export type QuizParseResult = { ok: true; quiz: Quiz } | { ok: false; errors: string[] };

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out || "(quiz)";
}

/**
 * Validates a quiz given either as parsed JSON or as raw JSON text.
 * Errors are short, human-readable lines such as
 * `rounds[0].questions[2].answer: must be between 0 and 3`.
 */
export function parseQuiz(input: unknown): QuizParseResult {
  let value = input;
  if (typeof input === "string") {
    if (input.length > LIMITS.quizJsonChars) {
      return { ok: false, errors: [`Quiz file is too large (${input.length} characters; the limit is ${LIMITS.quizJsonChars}).`] };
    }
    try {
      value = JSON.parse(input);
    } catch (err) {
      return { ok: false, errors: [`Not valid JSON: ${(err as Error).message}`] };
    }
  } else {
    const size = JSON.stringify(input ?? null).length;
    if (size > LIMITS.quizJsonChars) {
      return { ok: false, errors: [`Quiz is too large (${size} characters; the limit is ${LIMITS.quizJsonChars}).`] };
    }
  }
  const result = QuizSchema.safeParse(value);
  if (result.success) return { ok: true, quiz: result.data };
  const errors = result.error.issues.slice(0, 20).map((issue) => `${formatPath(issue.path)}: ${issue.message}`);
  return { ok: false, errors };
}

/** Stable key for a question within a quiz, used in messages and storage. */
export function questionKey(round: number, question: number): string {
  return `${round}.${question}`;
}

export function parseQuestionKey(key: string): { round: number; question: number } | null {
  const m = /^(\d{1,3})\.(\d{1,3})$/.exec(key);
  if (!m) return null;
  return { round: Number(m[1]), question: Number(m[2]) };
}

export function getQuestion(quiz: Quiz, round: number, question: number): Question | undefined {
  return quiz.rounds[round]?.questions[question];
}

/** The text shown when a question's answer is revealed. */
export function answerText(q: Question): string {
  return q.type === "choice" ? (q.options[q.answer] ?? "") : (q.answers[0] ?? "");
}

export function emptyQuiz(): QuizInput {
  return {
    format: "last-orders-quiz",
    version: 1,
    title: "Untitled quiz",
    rounds: [
      {
        title: "Round 1",
        mode: "answers",
        jokerAllowed: true,
        questions: [{ type: "text", prompt: "Write your first question here", answers: ["Answer"], points: 1 }],
      },
    ],
  };
}
