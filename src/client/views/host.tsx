import { useContext, useEffect, useMemo, useState } from "preact/hooks";
import type { HostAnswerRow, HostView, Stage } from "../../shared/protocol";
import { parseQuiz, questionKey, type Question, type Quiz, type QuizInput } from "../../shared/quiz";
import sampleQuiz from "../../../quizzes/sample-quiz.json";
import { ConnectionBanner, Countdown, Ended, LETTERS, Scoreboard, Toast } from "../components";
import type { RoomConnection } from "../lib/connection";
import { describeStage, nextStage } from "../lib/flow";
import { hostToken, listDrafts } from "../lib/store";
import { ConnContext, useNow, useRoom } from "../lib/useRoom";

type Send = RoomConnection["send"];

function readHashToken(code: string): string | null {
  const m = /[#&]t=([A-Za-z0-9_-]{16,64})/.exec(location.hash);
  if (!m) return hostToken.get(code);
  hostToken.set(code, m[1]!);
  history.replaceState(null, "", location.pathname);
  return m[1]!;
}

export function HostPage({ code }: { code: string }) {
  const [token] = useState(() => readHashToken(code));
  const [denied, setDenied] = useState(false);
  const room = useRoom<HostView>(code, (conn) => {
    if (token) conn.authenticate({ type: "auth.host", hostToken: token });
    let authed = false;
    const offs = [
      conn.on("state", () => {
        authed = true;
      }),
      conn.on("error", (errCode) => {
        if (errCode === "not_authorised" && !authed) setDenied(true);
      }),
    ];
    return () => offs.forEach((off) => off());
  });

  useEffect(() => {
    document.title = `Hosting ${code} · Last Orders`;
  }, [code]);

  if (room.missing) return <Ended title="Room not found" message={`There is no room called ${code}. It may have closed after being idle.`} />;
  if (!token || denied) {
    return (
      <Ended
        title="This device is not the host"
        message={`To run room ${code} from this device, open the private host link from the device that created the room.`}
      />
    );
  }
  if (room.ended) return <Ended title="Room closed" message={room.ended} />;
  if (!room.view || !room.conn) {
    return (
      <main class="page page--centre">
        <p class="lead">Connecting to room {code}…</p>
      </main>
    );
  }
  return (
    <>
      <ConnectionBanner status={room.status} />
      <HostConsole view={room.view} conn={room.conn} token={token} />
      <Toast notice={room.notice} onDismiss={room.dismiss} />
    </>
  );
}

function HostConsole({ view, conn, token }: { view: HostView; conn: RoomConnection; token: string }) {
  const send: Send = (msg) => conn.send(msg);
  const next = nextStage(view.stage, view.quiz, view.phases);
  const q = view.question;

  // Keyboard shortcuts, ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "n" && next) send({ type: "host.goto", stage: next });
      else if (key === "o" && q?.phase === "ready") send({ type: "host.open" });
      else if (key === "l" && q?.phase === "open") send({ type: "host.lock" });
      else if (key === "r" && (q?.phase === "open" || q?.phase === "locked")) send({ type: "host.reveal" });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <ConnContext.Provider value={conn}>
    <div class="host">
      <TopBar view={view} send={send} token={token} />
      <nav class="card" aria-label="Running order">
        <Navigator view={view} send={send} />
      </nav>
      <main class="card" aria-live="polite">
        <div class="row">
          <h2 style={{ margin: 0 }}>{describeStage(view.stage, view.quiz)}</h2>
          <span class="spacer" />
          {next && (
            <button class="btn btn--primary" type="button" onClick={() => send({ type: "host.goto", stage: next })}>
              Next: {describeStage(next, view.quiz)} <kbd class="muted">N</kbd>
            </button>
          )}
        </div>
        <StagePanel view={view} send={send} />
      </main>
      <aside class="card" aria-label="Teams">
        <TeamsPanel view={view} send={send} />
      </aside>
    </div>
    </ConnContext.Provider>
  );
}

// ---------------------------------------------------------------------------

function TopBar({ view, send, token }: { view: HostView; send: Send; token: string }) {
  const joinUrl = `${location.origin}/play/${view.code}`;
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      window.prompt("Copy this:", text);
    }
  };
  return (
    <header class="host__topbar card">
      <a class="brand" href="/">
        Last Orders
      </a>
      <span class="code-chip" aria-label={`Room code ${view.code.split("").join(" ")}`}>
        {view.code}
      </span>
      <span class="muted">
        Teams join at <strong>{joinUrl.replace(/^https?:\/\//, "")}</strong>
      </span>
      <span class="spacer" />
      <a class="btn btn--small" href={`/screen/${view.code}`} target="_blank" rel="noopener">
        Open big screen
      </a>
      <button class="btn btn--small" type="button" onClick={() => copy(`${location.origin}/host/${view.code}#t=${token}`, "host")}>
        {copied === "host" ? "Copied" : "Copy private host link"}
      </button>
      <QuizLoader view={view} send={send} />
      <button
        class="btn btn--small btn--ghost"
        type="button"
        onClick={() => {
          if (confirm("Reset the game? Answers, scores and jokers are cleared. Teams stay in the room.")) send({ type: "host.resetGame" });
        }}
      >
        Reset game
      </button>
      <button
        class="btn btn--small btn--bad"
        type="button"
        onClick={() => {
          if (confirm("Close the room for everyone and delete everything it holds?")) {
            send({ type: "host.closeRoom" });
            hostToken.set(view.code, null);
          }
        }}
      >
        Close room
      </button>
    </header>
  );
}

function QuizLoader({ view, send }: { view: HostView; send: Send }) {
  const [errors, setErrors] = useState<string[] | null>(null);
  const drafts = useMemo(() => listDrafts(), []);
  const inProgress = Object.values(view.phases).some((p) => p !== "ready");

  const load = (quiz: unknown) => {
    const parsed = parseQuiz(quiz);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    if (inProgress && !confirm("Loading a quiz restarts the game. Teams stay, scores are cleared. Carry on?")) return;
    setErrors(null);
    send({ type: "host.loadQuiz", quiz: parsed.quiz });
  };

  const onChoose = (e: Event) => {
    const select = e.target as HTMLSelectElement;
    const value = select.value;
    select.value = "";
    if (value === "sample") load(sampleQuiz);
    else if (value === "file") document.getElementById("quiz-file")?.click();
    else {
      const draft = drafts.find((d) => d.id === value);
      if (draft) load(draft.quiz);
    }
  };

  const onFile = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) load(await file.text());
  };

  return (
    <>
      <label class="visually-hidden" for="quiz-load">
        Load a quiz
      </label>
      <select id="quiz-load" style={{ width: "auto", minHeight: "34px" }} onChange={onChoose} value="">
        <option value="">{view.quiz ? "Load a different quiz…" : "Load a quiz…"}</option>
        <option value="sample">Sample quiz</option>
        <option value="file">From a JSON file…</option>
        {drafts.length > 0 && (
          <optgroup label="Saved in the editor">
            {drafts.map((d) => (
              <option key={d.id} value={d.id}>
                {(d.quiz as QuizInput).title}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <input id="quiz-file" type="file" accept="application/json,.json" hidden onChange={onFile} />
      {errors && (
        <div class="errors" role="alert" style={{ flexBasis: "100%" }}>
          <strong>That quiz has problems:</strong>
          <ul>
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function Navigator({ view, send }: { view: HostView; send: Send }) {
  const go = (stage: Stage) => send({ type: "host.goto", stage });
  const s = view.stage;
  return (
    <>
      <button class="nav-round" type="button" aria-current={s.kind === "lobby"} onClick={() => go({ kind: "lobby" })}>
        Lobby
      </button>
      <ul class="nav-list">
        {view.quiz?.rounds.map((round, ri) => (
          <li key={ri}>
            <button
              class="nav-round"
              type="button"
              aria-current={s.kind === "roundIntro" && s.round === ri}
              onClick={() => go({ kind: "roundIntro", round: ri })}
            >
              {ri + 1}. {round.title}
              {round.mode === "buzzer" && <span class="tag tag--info">buzzer</span>}
            </button>
            <ol aria-label={`Questions in round ${ri + 1}`}>
              {round.questions.map((_, qi) => {
                const phase = view.phases[questionKey(ri, qi)] ?? "ready";
                const current = s.kind === "question" && s.round === ri && s.question === qi;
                return (
                  <li key={qi}>
                    <button
                      type="button"
                      class={`nav-q nav-q--${phase}`}
                      aria-current={current}
                      aria-label={`Question ${qi + 1}, ${phase}`}
                      onClick={() => go({ kind: "question", round: ri, question: qi })}
                    >
                      {qi + 1}
                    </button>
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ul>
      {view.quiz && (
        <>
          <button class="nav-round" type="button" aria-current={s.kind === "scoreboard"} onClick={() => go({ kind: "scoreboard" })}>
            Scores
          </button>
          {view.quiz.tiebreaker && (
            <button class="nav-round" type="button" aria-current={s.kind === "tiebreak"} onClick={() => go({ kind: "tiebreak" })}>
              Tie-breaker
            </button>
          )}
          <button class="nav-round" type="button" aria-current={s.kind === "final"} onClick={() => go({ kind: "final" })}>
            Final results
          </button>
        </>
      )}
      <p class="hint" style={{ marginTop: "16px" }}>
        Keys: N next, O open, L lock, R reveal.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------

function StagePanel({ view, send }: { view: HostView; send: Send }) {
  const stage = view.stage;
  if (!view.quiz) {
    return (
      <div class="stack" style={{ marginTop: "16px" }}>
        <p class="lead">Load a quiz to begin. Teams can join now: they only need the room code.</p>
        <button class="btn btn--primary" type="button" onClick={() => send({ type: "host.loadQuiz", quiz: sampleQuiz })}>
          Load the sample quiz
        </button>
      </div>
    );
  }
  switch (stage.kind) {
    case "lobby":
      return (
        <div class="stack" style={{ marginTop: "16px" }}>
          <p class="lead">
            <strong>{view.quiz.title}</strong> is loaded. {view.teams.length} team{view.teams.length === 1 ? "" : "s"} in the room.
          </p>
          <p class="muted">Put the big screen on the TV so teams can scan the code. Press Next when everyone is in.</p>
        </div>
      );
    case "roundIntro": {
      const round = view.quiz.rounds[stage.round]!;
      const jokers = view.teams.filter((t) => t.jokerRound === stage.round);
      return (
        <div class="stack" style={{ marginTop: "16px" }}>
          <p class="lead">
            {round.questions.length} questions. {round.mode === "buzzer" ? "Buzzer round: first to buzz answers out loud." : "Teams answer on their phones."}
          </p>
          <p>
            {round.jokerAllowed
              ? `Jokers are allowed until the first question opens. ${jokers.length ? `Played by: ${jokers.map((t) => t.name).join(", ")}.` : "None played yet."}`
              : "Jokers cannot be played on this round."}
          </p>
        </div>
      );
    }
    case "question":
      return <QuestionPanel view={view} send={send} />;
    case "scoreboard":
    case "final":
      return (
        <div style={{ marginTop: "16px" }}>
          {stage.kind === "final" && view.teams.length > 1 && view.teams[0]?.rank === view.teams[1]?.rank && (
            <p class="notes">There is a tie for first place. Use the tie-breaker to settle it.</p>
          )}
          <Scoreboard teams={view.teams} />
        </div>
      );
    case "tiebreak":
      return <TiebreakPanel view={view} send={send} />;
  }
}

function useLocalClips() {
  const [clips, setClips] = useState<Record<string, string>>({});
  useEffect(() => () => Object.values(clips).forEach((u) => URL.revokeObjectURL(u)), []);
  return [clips, (key: string, file: File) => setClips((c) => ({ ...c, [key]: URL.createObjectURL(file) }))] as const;
}

function QuestionPanel({ view, send }: { view: HostView; send: Send }) {
  const pq = view.question!;
  const quiz = view.quiz as Quiz;
  const question = quiz.rounds[pq.round]!.questions[pq.question]! as Question;
  const detail = view.detail;
  const now = useNow(useContext(ConnContext));
  const [clips, addClip] = useLocalClips();
  const media = question.media;
  const answeredTeams = detail?.answers.filter((a) => a.value !== null).length ?? 0;

  return (
    <div style={{ marginTop: "16px" }}>
      <p class="prompt">{question.prompt}</p>

      {question.type === "choice" ? (
        <ol class="options" style={{ marginBottom: "12px" }}>
          {question.options.map((opt, i) => (
            <li key={i} class={`option${i === question.answer ? " option--correct" : ""}`} style={{ minHeight: "48px", cursor: "default" }}>
              <span class="option__letter">{LETTERS[i]}</span>
              {opt}
            </li>
          ))}
        </ol>
      ) : (
        <p class="answer-key">
          <strong>Answer:</strong> {question.answers[0]}
          {question.answers.length > 1 && <span class="muted"> (also accepting {question.answers.slice(1).join(", ")})</span>}
        </p>
      )}
      {question.hostNotes && <p class="notes">{question.hostNotes}</p>}

      {media?.kind === "image" && (
        <figure class="media">
          <img src={media.url} alt={media.alt} style={{ maxHeight: "200px" }} />
        </figure>
      )}
      {media?.kind === "audio" && (
        <div class="card" style={{ marginBottom: "12px" }}>
          <p style={{ marginBottom: "8px" }}>
            <strong>{media.label}</strong> plays from this laptop only. Phones do not get the audio.
          </p>
          {(clips[pq.key] ?? media.url) && <audio controls preload="auto" src={clips[pq.key] ?? media.url} style={{ width: "100%" }} />}
          <label class="hint" style={{ display: "block", marginTop: "8px" }}>
            {media.url ? "Or play a file from this laptop instead:" : "Choose the clip from this laptop:"}
            <input
              type="file"
              accept="audio/*"
              onChange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0];
                if (f) addClip(pq.key, f);
              }}
            />
          </label>
        </div>
      )}

      <div class="controls">
        {pq.phase === "ready" && (
          <button class="btn btn--primary btn--huge" type="button" onClick={() => send({ type: "host.open" })}>
            {pq.mode === "buzzer" ? "Open buzzers" : "Open answers"} <kbd>O</kbd>
          </button>
        )}
        {pq.phase === "open" && (
          <button class="btn btn--huge" type="button" onClick={() => send({ type: "host.lock" })}>
            Lock {pq.mode === "buzzer" ? "buzzers" : "answers"} <kbd>L</kbd>
          </button>
        )}
        {pq.phase === "locked" && (
          <button class="btn btn--huge btn--ghost" type="button" onClick={() => send({ type: "host.reopen" })}>
            Reopen
          </button>
        )}
        {(pq.phase === "open" || pq.phase === "locked") && (
          <button class="btn btn--primary btn--huge" type="button" onClick={() => send({ type: "host.reveal" })}>
            Reveal answer <kbd>R</kbd>
          </button>
        )}
        {pq.phase === "revealed" && <span class="tag tag--good">Revealed. Answers are locked for good.</span>}
        <span class="spacer" />
        {pq.phase === "open" && <Countdown closesAt={pq.closesAt} now={now} />}
        {pq.mode === "answers" && (
          <span class="muted">
            {answeredTeams} of {view.teams.length} answered
          </span>
        )}
      </div>

      {pq.mode === "answers" ? <AnswersTable view={view} send={send} /> : <BuzzPanel view={view} send={send} />}
    </div>
  );
}

function SuggestionTag({ row }: { row: HostAnswerRow }) {
  if (!row.suggestion) return null;
  if (row.suggestion === "exact") return <span class="tag tag--good">match</span>;
  if (row.suggestion === "close") return <span class="tag tag--info" title={`Close to "${row.closestTo}"`}>close to {row.closestTo}</span>;
  return <span class="tag">no match</span>;
}

function AnswersTable({ view, send }: { view: HostView; send: Send }) {
  const detail = view.detail;
  const pq = view.question!;
  if (!detail) return null;
  const canMark = pq.phase === "locked" || pq.phase === "revealed";
  const mark = (row: HostAnswerRow, verdict: "correct" | "wrong" | "clear") =>
    send({ type: "host.mark", questionKey: detail.key, teamId: row.teamId, verdict });

  return (
    <section aria-label="Answers">
      <div class="row" style={{ marginBottom: "8px" }}>
        <h3 style={{ margin: 0 }}>Answers</h3>
        {canMark && pq.type === "text" && (
          <button class="btn btn--small" type="button" onClick={() => send({ type: "host.acceptExact", questionKey: detail.key })}>
            Mark matches right and non-matches wrong
          </button>
        )}
        <span class="spacer" />
        {canMark && detail.unmarked > 0 && <span class="tag tag--info">{detail.unmarked} to mark</span>}
      </div>
      {!canMark && pq.phase !== "ready" && <p class="hint">Answers stay hidden from everyone else. Lock to start marking.</p>}
      <table class="answers-table">
        <thead>
          <tr>
            <th scope="col">Team</th>
            <th scope="col">Answer</th>
            <th scope="col" class="visually-hidden">
              Marking
            </th>
          </tr>
        </thead>
        <tbody>
          {detail.answers.map((row) => (
            <tr key={row.teamId}>
              <td>{row.name}</td>
              <td>
                {row.value === null ? (
                  <span class="muted">no answer</span>
                ) : (
                  <>
                    <span class="answer-text">{row.display}</span>
                    <SuggestionTag row={row} />
                  </>
                )}
              </td>
              <td class="actions">
                {row.value !== null && canMark && (
                  <>
                    <button
                      class={`btn btn--small ${row.verdict === true ? "btn--good" : ""}`}
                      type="button"
                      aria-pressed={row.verdict === true}
                      aria-label={`Mark ${row.name} right`}
                      onClick={() => mark(row, row.verdict === true ? "clear" : "correct")}
                    >
                      ✓
                    </button>{" "}
                    <button
                      class={`btn btn--small ${row.verdict === false ? "btn--bad" : ""}`}
                      type="button"
                      aria-pressed={row.verdict === false}
                      aria-label={`Mark ${row.name} wrong`}
                      onClick={() => mark(row, row.verdict === false ? "clear" : "wrong")}
                    >
                      ✗
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function BuzzPanel({ view, send }: { view: HostView; send: Send }) {
  const pq = view.question!;
  const active = pq.buzzes.find((b) => b.outcome === "waiting");
  return (
    <section aria-label="Buzz queue">
      <h3>Buzz order</h3>
      {pq.buzzes.length === 0 && <p class="muted">{pq.phase === "open" ? "Waiting for the first buzz…" : "No buzzes."}</p>}
      <ol class="buzz-queue">
        {pq.buzzes.map((b, i) => (
          <li key={b.teamId} class={b.outcome === "waiting" && b === active ? "is-active" : `is-${b.outcome}`}>
            <strong>{i + 1}.</strong> {b.name}
            <span class="spacer" />
            {i > 0 && <span class="muted">+{((b.at - pq.buzzes[0]!.at) / 1000).toFixed(2)}s</span>}
          </li>
        ))}
      </ol>
      {active && pq.phase !== "revealed" && (
        <div class="controls">
          <button class="btn btn--good btn--huge" type="button" onClick={() => send({ type: "host.buzzVerdict", questionKey: pq.key, correct: true })}>
            {active.name}: right
          </button>
          <button class="btn btn--bad btn--huge" type="button" onClick={() => send({ type: "host.buzzVerdict", questionKey: pq.key, correct: false })}>
            Wrong, next in line
          </button>
        </div>
      )}
    </section>
  );
}

function TiebreakPanel({ view, send }: { view: HostView; send: Send }) {
  const tb = view.tiebreak;
  const def = view.quiz?.tiebreaker;
  const topScore = view.teams[0]?.score;
  const tied = view.teams.filter((t) => t.score === topScore).map((t) => t.id);
  const [chosen, setChosen] = useState<string[]>(tied.length >= 2 ? tied : []);
  const name = (id: string) => view.teams.find((t) => t.id === id)?.name ?? "?";
  if (!def) return <p>This quiz has no tie-breaker.</p>;

  return (
    <div class="stack" style={{ marginTop: "16px" }}>
      <p class="prompt">{def.prompt}</p>
      <p class="answer-key">
        <strong>Answer:</strong> {def.answer} {def.unit ?? ""}
      </p>
      {(!tb || tb.phase === "revealed") && (
        <fieldset class="card">
          <legend>Teams in the tie-breaker</legend>
          {view.teams.map((t) => (
            <label key={t.id} style={{ fontWeight: 400, display: "flex", gap: "8px", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={chosen.includes(t.id)}
                onChange={(e) => {
                  const on = (e.target as HTMLInputElement).checked;
                  setChosen((c) => (on ? [...c, t.id] : c.filter((x) => x !== t.id)));
                }}
              />
              {t.name} ({t.score})
            </label>
          ))}
          <button
            class="btn btn--primary"
            type="button"
            style={{ marginTop: "10px" }}
            disabled={chosen.length < 2}
            onClick={() => send({ type: "host.tiebreakStart", teamIds: chosen })}
          >
            {tb ? "Run it again" : "Start tie-breaker"}
          </button>
        </fieldset>
      )}
      {tb?.phase === "open" && (
        <>
          <p>
            Answered: {tb.answeredTeamIds.length} of {tb.teamIds.length} ({tb.teamIds.map((id) => `${name(id)}${tb.answeredTeamIds.includes(id) ? " ✓" : ""}`).join(", ")})
          </p>
          <button class="btn btn--primary btn--huge" type="button" onClick={() => send({ type: "host.tiebreakReveal" })}>
            Reveal and settle
          </button>
        </>
      )}
      {tb?.results && (
        <ol class="scoreboard">
          {tb.results.map((r) => (
            <li class="scoreboard__row" key={r.teamId}>
              <span class="scoreboard__rank">{r.distance === null ? "-" : `±${r.distance}`}</span>
              <span class="scoreboard__name">{name(r.teamId)}</span>
              <span class="scoreboard__score">{r.value ?? "no guess"}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TeamsPanel({ view, send }: { view: HostView; send: Send }) {
  return (
    <>
      <h2>
        Teams <span class="muted">({view.teams.length}/{view.teamsMax})</span>
      </h2>
      {view.teams.length === 0 && <p class="muted">Nobody yet. Share the room code.</p>}
      <ul class="teams-list">
        {view.teams.map((t) => (
          <li key={t.id}>
            <span>
              <span class={`dot${t.connected ? " dot--on" : ""}`} aria-label={t.connected ? "online" : "offline"} role="img" />
              <strong>{t.name}</strong>
              {t.jokerRound !== null && <span class="tag tag--joker">Joker R{t.jokerRound + 1}</span>}
            </span>
            <strong class="scoreboard__score">{t.score}</strong>
            <div class="team-actions">
              <button class="btn btn--small" type="button" aria-label={`Take a point from ${t.name}`} onClick={() => send({ type: "host.adjust", teamId: t.id, delta: -1 })}>
                −1
              </button>
              <button class="btn btn--small" type="button" aria-label={`Give ${t.name} a point`} onClick={() => send({ type: "host.adjust", teamId: t.id, delta: 1 })}>
                +1
              </button>
              {(view.adjustments[t.id] ?? 0) !== 0 && <span class="hint">adjusted {view.adjustments[t.id]! > 0 ? "+" : ""}{view.adjustments[t.id]}</span>}
              <span class="spacer" />
              <button
                class="btn btn--small btn--ghost"
                type="button"
                onClick={() => {
                  if (confirm(`Remove ${t.name} from the room? Their answers are deleted.`)) send({ type: "host.kick", teamId: t.id });
                }}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
