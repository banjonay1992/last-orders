import { useEffect, useMemo, useState } from "preact/hooks";
import { LIMITS } from "../../shared/limits";
import { emptyQuiz, parseQuiz, type QuizInput } from "../../shared/quiz";
import sampleQuiz from "../../../quizzes/sample-quiz.json";
import { deleteDraft, listDrafts, newDraftId, saveDraft, type Draft } from "../lib/store";
import { linkTo } from "../router";

type RoundInput = QuizInput["rounds"][number];
type QuestionInput = RoundInput["questions"][number];
type MediaInput = NonNullable<QuestionInput["media"]>;

const numberOrUndefined = (value: string): number | undefined => {
  if (value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

function blankQuestion(type: "choice" | "text"): QuestionInput {
  return type === "choice"
    ? { type: "choice", prompt: "", options: ["", "", "", ""], answer: 0, points: 1 }
    : { type: "text", prompt: "", answers: [""], points: 1 };
}

function move<T>(list: T[], from: number, to: number): void {
  if (to < 0 || to >= list.length) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item!);
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "quiz";
}

export function EditorPage() {
  const [drafts, setDrafts] = useState<Draft[]>(() => listDrafts());
  const [draftId, setDraftId] = useState(() => drafts[0]?.id ?? newDraftId());
  const [quiz, setQuiz] = useState<QuizInput>(() => drafts[0]?.quiz ?? emptyQuiz());
  const [importErrors, setImportErrors] = useState<string[] | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    document.title = "Quiz editor · Last Orders";
  }, []);

  const result = useMemo(() => parseQuiz(quiz), [quiz]);
  const size = useMemo(() => JSON.stringify(quiz).length, [quiz]);

  // Drafts save themselves to this browser as you type.
  useEffect(() => {
    const t = setTimeout(() => {
      saveDraft({ id: draftId, savedAt: Date.now(), quiz });
      setDrafts(listDrafts());
      setSavedAt(Date.now());
    }, 600);
    return () => clearTimeout(t);
  }, [quiz, draftId]);

  const update = (fn: (q: QuizInput) => void) => {
    setQuiz((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  };

  const startNew = (q: QuizInput) => {
    setDraftId(newDraftId());
    setQuiz(structuredClone(q));
    setImportErrors(null);
  };

  const onImport = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const text = await file.text();
    const parsed = parseQuiz(text);
    if (!parsed.ok) {
      setImportErrors(parsed.errors);
      return;
    }
    startNew(parsed.quiz);
  };

  const totalQuestions = quiz.rounds.reduce((n, r) => n + r.questions.length, 0);

  return (
    <main class="page">
      <header class="row" style={{ marginBottom: "16px" }}>
        <a class="brand" href="/" onClick={linkTo("/")}>
          Last Orders
        </a>
        <h1 style={{ margin: 0, fontSize: "1.5rem" }}>Quiz editor</h1>
      </header>

      <section class="card row" aria-label="File">
        <button class="btn btn--small" type="button" onClick={() => startNew(emptyQuiz())}>
          New quiz
        </button>
        <button class="btn btn--small" type="button" onClick={() => startNew(sampleQuiz as QuizInput)}>
          Copy the sample
        </button>
        <label class="btn btn--small" style={{ margin: 0 }}>
          Import JSON
          <input type="file" accept="application/json,.json" hidden onChange={onImport} />
        </label>
        <button
          class="btn btn--small"
          type="button"
          disabled={!result.ok}
          title={result.ok ? "" : "Fix the problems listed below first"}
          onClick={() => result.ok && download(`${slug(result.quiz.title)}.json`, JSON.stringify(result.quiz, null, 2) + "\n")}
        >
          Export JSON
        </button>
        <span class="spacer" />
        {drafts.length > 1 && (
          <>
            <label class="visually-hidden" for="drafts">
              Open a saved draft
            </label>
            <select
              id="drafts"
              style={{ width: "auto", minHeight: "34px" }}
              value={draftId}
              onChange={(e) => {
                const d = drafts.find((x) => x.id === (e.target as HTMLSelectElement).value);
                if (d) {
                  setDraftId(d.id);
                  setQuiz(d.quiz);
                }
              }}
            >
              {drafts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.quiz.title || "Untitled"}
                </option>
              ))}
            </select>
          </>
        )}
        <button
          class="btn btn--small btn--ghost"
          type="button"
          onClick={() => {
            if (!confirm("Delete this draft from this browser?")) return;
            deleteDraft(draftId);
            const rest = listDrafts();
            setDrafts(rest);
            if (rest[0]) {
              setDraftId(rest[0].id);
              setQuiz(rest[0].quiz);
            } else startNew(emptyQuiz());
          }}
        >
          Delete draft
        </button>
      </section>

      <p class="hint" style={{ margin: "8px 0 16px" }}>
        Drafts are saved in this browser only{savedAt ? " (saved)" : ""}. They appear in the host's "Load a quiz" menu on this device. Export a JSON file to move a quiz elsewhere.
      </p>

      {importErrors && (
        <div class="errors" role="alert" style={{ marginBottom: "16px" }}>
          <strong>That file could not be imported:</strong>
          <ul>
            {importErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div class={result.ok ? "ok-box" : "errors"} role="status" style={{ marginBottom: "16px" }}>
        {result.ok ? (
          <span>
            Ready to host: {quiz.rounds.length} round{quiz.rounds.length === 1 ? "" : "s"}, {totalQuestions} question{totalQuestions === 1 ? "" : "s"}. Size{" "}
            {Math.round((size / LIMITS.quizJsonChars) * 100)}% of the limit.
          </span>
        ) : (
          <>
            <strong>Not ready yet:</strong>
            <ul>
              {result.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </>
        )}
      </div>

      <section class="card" style={{ marginBottom: "18px" }}>
        <div class="field">
          <label for="quiz-title">Quiz title</label>
          <input id="quiz-title" value={quiz.title} maxLength={100} onInput={(e) => update((q) => void (q.title = (e.target as HTMLInputElement).value))} />
        </div>
      </section>

      {quiz.rounds.map((round, ri) => (
        <RoundEditor key={ri} round={round} index={ri} count={quiz.rounds.length} update={update} />
      ))}

      <button
        class="btn btn--block"
        type="button"
        disabled={quiz.rounds.length >= LIMITS.rounds}
        onClick={() => update((q) => void q.rounds.push({ title: `Round ${q.rounds.length + 1}`, mode: "answers", jokerAllowed: true, questions: [blankQuestion("text")] }))}
      >
        Add a round
      </button>

      <TiebreakEditor quiz={quiz} update={update} />
    </main>
  );
}

type Update = (fn: (q: QuizInput) => void) => void;

function RoundEditor({ round, index: ri, count, update }: { round: RoundInput; index: number; count: number; update: Update }) {
  const id = `r${ri}`;
  return (
    <section class="editor-round" aria-labelledby={`${id}-h`}>
      <div class="row">
        <h2 id={`${id}-h`} style={{ margin: 0 }}>
          Round {ri + 1}
        </h2>
        <span class="spacer" />
        <button class="btn btn--small" type="button" disabled={ri === 0} onClick={() => update((q) => move(q.rounds, ri, ri - 1))} aria-label={`Move round ${ri + 1} up`}>
          ↑
        </button>
        <button class="btn btn--small" type="button" disabled={ri === count - 1} onClick={() => update((q) => move(q.rounds, ri, ri + 1))} aria-label={`Move round ${ri + 1} down`}>
          ↓
        </button>
        <button
          class="btn btn--small btn--ghost"
          type="button"
          disabled={count === 1}
          onClick={() => confirm(`Delete round ${ri + 1} and its questions?`) && update((q) => void q.rounds.splice(ri, 1))}
        >
          Delete round
        </button>
      </div>
      <div class="grid-2" style={{ marginTop: "12px" }}>
        <div class="field">
          <label for={`${id}-title`}>Round title</label>
          <input id={`${id}-title`} value={round.title} maxLength={80} onInput={(e) => update((q) => void (q.rounds[ri]!.title = (e.target as HTMLInputElement).value))} />
        </div>
        <div class="field">
          <label for={`${id}-mode`}>How teams answer</label>
          <select
            id={`${id}-mode`}
            value={round.mode ?? "answers"}
            onChange={(e) => update((q) => void (q.rounds[ri]!.mode = (e.target as HTMLSelectElement).value as "answers" | "buzzer"))}
          >
            <option value="answers">On their phones (everyone answers)</option>
            <option value="buzzer">Buzzer (first to buzz answers out loud)</option>
          </select>
        </div>
      </div>
      <label style={{ fontWeight: 400, display: "flex", gap: "8px", alignItems: "center" }}>
        <input
          type="checkbox"
          checked={round.jokerAllowed ?? true}
          onChange={(e) => update((q) => void (q.rounds[ri]!.jokerAllowed = (e.target as HTMLInputElement).checked))}
        />
        Teams may play their joker on this round
      </label>

      {round.questions.map((question, qi) => (
        <QuestionEditor key={qi} question={question} ri={ri} qi={qi} count={round.questions.length} update={update} />
      ))}

      <div class="row" style={{ marginTop: "14px" }}>
        <button class="btn btn--small" type="button" disabled={round.questions.length >= LIMITS.questionsPerRound} onClick={() => update((q) => void q.rounds[ri]!.questions.push(blankQuestion("text")))}>
          Add free-text question
        </button>
        <button class="btn btn--small" type="button" disabled={round.questions.length >= LIMITS.questionsPerRound} onClick={() => update((q) => void q.rounds[ri]!.questions.push(blankQuestion("choice")))}>
          Add multiple-choice question
        </button>
      </div>
    </section>
  );
}

function QuestionEditor({ question, ri, qi, count, update }: { question: QuestionInput; ri: number; qi: number; count: number; update: Update }) {
  const id = `r${ri}q${qi}`;
  const edit = (fn: (q: QuestionInput) => void) => update((quiz) => fn(quiz.rounds[ri]!.questions[qi]!));
  const media = question.media;

  const setMediaKind = (kind: string) =>
    edit((q) => {
      if (kind === "none") delete q.media;
      else if (kind === "image") q.media = { kind: "image", url: "", alt: "" };
      else q.media = { kind: "audio", label: `Clip ${qi + 1}` };
    });

  return (
    <div class="editor-question" role="group" aria-labelledby={`${id}-h`}>
      <div class="row">
        <h3 id={`${id}-h`} style={{ margin: 0 }}>
          Question {qi + 1} <span class="tag">{question.type === "choice" ? "multiple choice" : "free text"}</span>
        </h3>
        <span class="spacer" />
        <button class="btn btn--small" type="button" disabled={qi === 0} aria-label={`Move question ${qi + 1} up`} onClick={() => update((q) => move(q.rounds[ri]!.questions, qi, qi - 1))}>
          ↑
        </button>
        <button class="btn btn--small" type="button" disabled={qi === count - 1} aria-label={`Move question ${qi + 1} down`} onClick={() => update((q) => move(q.rounds[ri]!.questions, qi, qi + 1))}>
          ↓
        </button>
        <button class="btn btn--small btn--ghost" type="button" disabled={count === 1} onClick={() => update((q) => void q.rounds[ri]!.questions.splice(qi, 1))}>
          Delete
        </button>
      </div>

      <div class="field" style={{ marginTop: "10px" }}>
        <label for={`${id}-prompt`}>Question</label>
        <textarea id={`${id}-prompt`} maxLength={LIMITS.promptChars} value={question.prompt} onInput={(e) => edit((q) => void (q.prompt = (e.target as HTMLTextAreaElement).value))} />
      </div>

      {question.type === "choice" ? (
        <fieldset class="field" style={{ border: 0, padding: 0, margin: "0 0 14px" }}>
          <legend style={{ fontWeight: 600, marginBottom: "6px" }}>Options (select the right one)</legend>
          {question.options.map((opt, oi) => (
            <div class="option-edit" key={oi}>
              <input
                type="radio"
                name={`${id}-answer`}
                checked={question.answer === oi}
                aria-label={`Option ${oi + 1} is correct`}
                onChange={() => edit((q) => void (q.type === "choice" && (q.answer = oi)))}
              />
              <input
                aria-label={`Option ${oi + 1}`}
                value={opt}
                maxLength={LIMITS.optionChars}
                onInput={(e) => edit((q) => void (q.type === "choice" && (q.options[oi] = (e.target as HTMLInputElement).value)))}
              />
              <button
                class="btn btn--small btn--ghost"
                type="button"
                aria-label={`Remove option ${oi + 1}`}
                disabled={question.options.length <= LIMITS.choiceOptionsMin}
                onClick={() =>
                  edit((q) => {
                    if (q.type !== "choice") return;
                    q.options.splice(oi, 1);
                    if (q.answer >= oi && q.answer > 0) q.answer -= 1;
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            class="btn btn--small"
            type="button"
            disabled={question.options.length >= LIMITS.choiceOptionsMax}
            onClick={() => edit((q) => void (q.type === "choice" && q.options.push("")))}
          >
            Add option
          </button>
        </fieldset>
      ) : (
        <div class="field">
          <label for={`${id}-answers`}>Accepted answers, one per line</label>
          <textarea
            id={`${id}-answers`}
            value={question.answers.join("\n")}
            onInput={(e) => edit((q) => void (q.type === "text" && (q.answers = (e.target as HTMLTextAreaElement).value.split("\n"))))}
          />
          <p class="hint">The first line is shown on reveal. Exact matches are marked automatically (ignoring case, accents, punctuation and a leading "the"). You confirm the rest.</p>
        </div>
      )}

      <div class="grid-2">
        <div class="field">
          <label for={`${id}-points`}>Points</label>
          <input
            id={`${id}-points`}
            type="number"
            min={1}
            max={LIMITS.pointsMax}
            value={question.points ?? 1}
            onInput={(e) => edit((q) => void (q.points = numberOrUndefined((e.target as HTMLInputElement).value) ?? 1))}
          />
        </div>
        <div class="field">
          <label for={`${id}-time`}>Time limit in seconds (optional)</label>
          <input
            id={`${id}-time`}
            type="number"
            min={LIMITS.timeLimitMinSeconds}
            max={LIMITS.timeLimitMaxSeconds}
            value={question.timeLimitSeconds ?? ""}
            onInput={(e) =>
              edit((q) => {
                const n = numberOrUndefined((e.target as HTMLInputElement).value);
                if (n === undefined) delete q.timeLimitSeconds;
                else q.timeLimitSeconds = n;
              })
            }
          />
        </div>
      </div>

      <div class="grid-2">
        <div class="field">
          <label for={`${id}-media`}>Picture or audio</label>
          <select id={`${id}-media`} value={media?.kind ?? "none"} onChange={(e) => setMediaKind((e.target as HTMLSelectElement).value)}>
            <option value="none">None</option>
            <option value="image">Picture (shown on the big screen and phones)</option>
            <option value="audio">Audio clip (played from the host laptop)</option>
          </select>
        </div>
        <div class="field">
          <label for={`${id}-notes`}>Notes for the quizmaster (optional)</label>
          <input id={`${id}-notes`} value={question.hostNotes ?? ""} maxLength={500} onInput={(e) => edit((q) => void (q.hostNotes = (e.target as HTMLInputElement).value || undefined))} />
        </div>
      </div>
      {media && <MediaFields media={media} id={id} edit={edit} />}
    </div>
  );
}

function MediaFields({ media, id, edit }: { media: MediaInput; id: string; edit: (fn: (q: QuestionInput) => void) => void }) {
  const set = (field: "url" | "alt" | "label", value: string) =>
    edit((q) => {
      if (!q.media) return;
      const m = q.media as Record<string, unknown>;
      if (value === "" && field === "url" && q.media.kind === "audio") delete m.url;
      else m[field] = value;
    });
  return (
    <div class="grid-2">
      <div class="field">
        <label for={`${id}-url`}>{media.kind === "image" ? "Picture URL" : "Clip URL (optional)"}</label>
        <input id={`${id}-url`} type="url" value={media.url ?? ""} placeholder="https://… or /path/on/this/site" onInput={(e) => set("url", (e.target as HTMLInputElement).value)} />
        <p class="hint">
          {media.kind === "image"
            ? "Use images you have the right to show. Data URLs are not accepted."
            : "Leave blank to pick a file on the host laptop during the quiz. Phones never receive audio."}
        </p>
      </div>
      <div class="field">
        {media.kind === "image" ? (
          <>
            <label for={`${id}-alt`}>Description for screen readers</label>
            <input id={`${id}-alt`} value={media.alt} onInput={(e) => set("alt", (e.target as HTMLInputElement).value)} />
          </>
        ) : (
          <>
            <label for={`${id}-label`}>Clip label shown to teams</label>
            <input id={`${id}-label`} value={media.label} onInput={(e) => set("label", (e.target as HTMLInputElement).value)} />
          </>
        )}
      </div>
    </div>
  );
}

function TiebreakEditor({ quiz, update }: { quiz: QuizInput; update: Update }) {
  const tb = quiz.tiebreaker;
  return (
    <section class="card" style={{ marginTop: "18px" }} aria-labelledby="tb-h">
      <h2 id="tb-h">Tie-breaker</h2>
      <label style={{ fontWeight: 400, display: "flex", gap: "8px", alignItems: "center" }}>
        <input
          type="checkbox"
          checked={!!tb}
          onChange={(e) =>
            update((q) => {
              if ((e.target as HTMLInputElement).checked) q.tiebreaker = { prompt: "", answer: 0 };
              else delete q.tiebreaker;
            })
          }
        />
        Include a numeric tie-breaker (closest guess wins)
      </label>
      {tb && (
        <div class="grid-2" style={{ marginTop: "12px" }}>
          <div class="field" style={{ gridColumn: "1 / -1" }}>
            <label for="tb-prompt">Question</label>
            <input id="tb-prompt" value={tb.prompt} onInput={(e) => update((q) => void (q.tiebreaker!.prompt = (e.target as HTMLInputElement).value))} />
          </div>
          <div class="field">
            <label for="tb-answer">Answer (a number)</label>
            <input
              id="tb-answer"
              type="number"
              value={tb.answer}
              onInput={(e) => update((q) => void (q.tiebreaker!.answer = numberOrUndefined((e.target as HTMLInputElement).value) ?? 0))}
            />
          </div>
          <div class="field">
            <label for="tb-unit">Unit (optional)</label>
            <input id="tb-unit" value={tb.unit ?? ""} onInput={(e) => update((q) => void (q.tiebreaker!.unit = (e.target as HTMLInputElement).value || undefined))} />
          </div>
        </div>
      )}
    </section>
  );
}
