import type { QuestionPhase, Stage } from "../../shared/protocol";
import { questionKey, type Quiz } from "../../shared/quiz";

/**
 * Where the host's "Next" button goes from the current stage. The host can
 * always jump anywhere with the navigator; this is just the usual running
 * order: lobby, round intro, its questions, scores, next round, and so on.
 */
export function nextStage(stage: Stage, quiz: Quiz | null, phases: Record<string, QuestionPhase>): Stage | null {
  if (!quiz) return null;
  switch (stage.kind) {
    case "lobby":
      return { kind: "roundIntro", round: 0 };
    case "roundIntro":
      return { kind: "question", round: stage.round, question: 0 };
    case "question": {
      const round = quiz.rounds[stage.round];
      if (round && stage.question + 1 < round.questions.length) {
        return { kind: "question", round: stage.round, question: stage.question + 1 };
      }
      return { kind: "scoreboard" };
    }
    case "scoreboard": {
      let lastPlayed = -1;
      quiz.rounds.forEach((r, ri) =>
        r.questions.forEach((_, qi) => {
          if ((phases[questionKey(ri, qi)] ?? "ready") !== "ready") lastPlayed = Math.max(lastPlayed, ri);
        }),
      );
      if (lastPlayed + 1 < quiz.rounds.length) return { kind: "roundIntro", round: lastPlayed + 1 };
      return { kind: "final" };
    }
    case "tiebreak":
      return { kind: "final" };
    case "final":
      return null;
  }
}

export function describeStage(stage: Stage, quiz: Quiz | null): string {
  switch (stage.kind) {
    case "lobby":
      return "Lobby";
    case "roundIntro":
      return `Round ${stage.round + 1}: ${quiz?.rounds[stage.round]?.title ?? ""}`;
    case "question":
      return `Round ${stage.round + 1}, question ${stage.question + 1}`;
    case "scoreboard":
      return "Scores";
    case "tiebreak":
      return "Tie-breaker";
    case "final":
      return "Final results";
  }
}
