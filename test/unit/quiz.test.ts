import { describe, expect, it } from "vitest";
import { LIMITS } from "../../src/shared/limits";
import { answerText, parseQuestionKey, parseQuiz, questionKey, emptyQuiz } from "../../src/shared/quiz";
import { TEST_QUIZ } from "./helpers";
import sample from "../../quizzes/sample-quiz.json";

const clone = <T>(v: T): T => structuredClone(v);

function errorsFor(input: unknown): string[] {
  const result = parseQuiz(input);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

describe("quiz import validation", () => {
  it("accepts the bundled sample quiz from its raw JSON text", () => {
    const result = parseQuiz(JSON.stringify(sample, null, 2));
    expect(result.ok ? null : result.errors).toBeNull();
    if (result.ok) {
      expect(result.quiz.rounds.length).toBeGreaterThanOrEqual(3);
      expect(result.quiz.rounds.some((r) => r.mode === "buzzer")).toBe(true);
    }
  });

  it("accepts the editor's empty quiz", () => {
    expect(parseQuiz(emptyQuiz()).ok).toBe(true);
  });

  it("fills in defaults", () => {
    const result = parseQuiz(TEST_QUIZ);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quiz.rounds[0]!.mode).toBe("answers");
    expect(result.quiz.rounds[0]!.jokerAllowed).toBe(true);
  });

  it("reports bad JSON and the wrong format clearly", () => {
    expect(errorsFor("{nope")[0]).toMatch(/^Not valid JSON/);
    expect(errorsFor({ ...TEST_QUIZ, format: "something-else" })[0]).toMatch(/^format:/);
    expect(errorsFor({ ...TEST_QUIZ, version: 2 })[0]).toMatch(/^version:/);
  });

  it("points at the exact question when a multiple-choice answer is out of range", () => {
    const quiz = clone(TEST_QUIZ);
    (quiz.rounds[0]!.questions[0] as { answer: number }).answer = 5;
    expect(errorsFor(quiz)).toContain("rounds[0].questions[0].answer: must be between 0 and 2");
  });

  it("refuses duplicate options, too few options and empty accepted answers", () => {
    const quiz = clone(TEST_QUIZ);
    (quiz.rounds[0]!.questions[0] as { options: string[] }).options = ["Yes", "yes", "No"];
    expect(errorsFor(quiz).join("\n")).toContain("rounds[0].questions[0].options[1]: duplicate option");
    (quiz.rounds[0]!.questions[0] as { options: string[] }).options = ["Only one"];
    expect(errorsFor(quiz).join("\n")).toContain("rounds[0].questions[0].options");
    const q2 = clone(TEST_QUIZ);
    (q2.rounds[0]!.questions[1] as { answers: string[] }).answers = [];
    expect(errorsFor(q2).join("\n")).toContain("rounds[0].questions[1].answers");
  });

  it("refuses data URLs and javascript URLs for media", () => {
    for (const url of ["data:image/png;base64,AAAA", "javascript:alert(1)", "//evil.example/x.png", "http://plain.example/x.png"]) {
      const quiz = clone(TEST_QUIZ);
      quiz.rounds[0]!.questions[0]!.media = { kind: "image", url, alt: "x" };
      expect(errorsFor(quiz).join("\n")).toContain("media.url");
    }
    const ok = clone(TEST_QUIZ);
    ok.rounds[0]!.questions[0]!.media = { kind: "image", url: "https://example.com/a.png", alt: "x" };
    expect(parseQuiz(ok).ok).toBe(true);
  });

  it("enforces time limit, points and size limits", () => {
    const quiz = clone(TEST_QUIZ);
    quiz.rounds[0]!.questions[0]!.timeLimitSeconds = 1;
    quiz.rounds[0]!.questions[1]!.points = 0;
    const errors = errorsFor(quiz).join("\n");
    expect(errors).toContain("timeLimitSeconds");
    expect(errors).toContain("points");

    const huge = clone(TEST_QUIZ);
    huge.title = "x".repeat(50);
    (huge as Record<string, unknown>).padding = "y".repeat(LIMITS.quizJsonChars);
    expect(errorsFor(huge)[0]).toMatch(/too large/);
    expect(errorsFor(JSON.stringify(huge))[0]).toMatch(/too large/);
  });

  it("caps the total number of questions", () => {
    const quiz = clone(TEST_QUIZ);
    const q = { type: "text" as const, prompt: "Q", answers: ["A"] };
    quiz.rounds = Array.from({ length: 5 }, (_, i) => ({ title: `R${i}`, questions: Array.from({ length: 30 }, () => q) }));
    expect(errorsFor(quiz).join("\n")).toMatch(/rounds: has 150 questions/);
  });

  it("rejects a quiz that is not an object at all", () => {
    expect(errorsFor(null).length).toBeGreaterThan(0);
    expect(errorsFor([1, 2, 3]).length).toBeGreaterThan(0);
  });
});

describe("quiz helpers", () => {
  it("round-trips question keys", () => {
    expect(questionKey(2, 11)).toBe("2.11");
    expect(parseQuestionKey("2.11")).toEqual({ round: 2, question: 11 });
    expect(parseQuestionKey("2")).toBeNull();
    expect(parseQuestionKey("a.b")).toBeNull();
  });

  it("shows the right answer text for each type", () => {
    const result = parseQuiz(TEST_QUIZ);
    if (!result.ok) throw new Error("bad fixture");
    expect(answerText(result.quiz.rounds[0]!.questions[0]!)).toBe("B");
    expect(answerText(result.quiz.rounds[0]!.questions[1]!)).toBe("Paris");
  });
});
