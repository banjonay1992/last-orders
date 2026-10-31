import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { LIMITS } from "../../shared/limits";
import type { PublicQuestion, TeamView } from "../../shared/protocol";
import { ConnectionBanner, Countdown, Ended, LETTERS, MediaView, rankLabel, Scoreboard, Toast } from "../components";
import type { RoomConnection } from "../lib/connection";
import { teamToken } from "../lib/store";
import { ConnContext, useNow, useRoom } from "../lib/useRoom";

/** Asks the phone not to sleep mid-round. Silently does nothing where unsupported. */
function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const request = async () => {
      try {
        if (document.visibilityState === "visible") lock = await navigator.wakeLock.request("screen");
      } catch {
        // Battery saver or permissions; not worth bothering anyone about.
      }
    };
    void request();
    document.addEventListener("visibilitychange", request);
    return () => {
      document.removeEventListener("visibilitychange", request);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}

export function TeamPage({ code }: { code: string }) {
  const [hasToken, setHasToken] = useState(() => teamToken.get(code) !== null);
  const room = useRoom<TeamView>(code, (conn) => {
    const token = teamToken.get(code);
    if (token) conn.authenticate({ type: "auth.resume", token });
    const offs = [
      conn.on("welcome", (msg) => {
        if (msg.role !== "team" || !msg.token) return;
        teamToken.set(code, msg.token);
        setHasToken(true);
        // From now on, every reconnect resumes this seat instead of joining again.
        conn.authenticate({ type: "auth.resume", token: msg.token }, false);
      }),
      conn.on("error", (errCode) => {
        if (errCode === "unknown_token") {
          teamToken.set(code, null);
          conn.clearAuth();
          setHasToken(false);
        }
      }),
      conn.on("kicked", () => teamToken.set(code, null)),
      conn.on("closed", () => teamToken.set(code, null)),
    ];
    return () => offs.forEach((off) => off());
  });

  useWakeLock(hasToken && !room.ended);

  useEffect(() => {
    document.title = `Room ${code} · Last Orders`;
  }, [code]);

  if (room.missing) return <Ended title="Room not found" message={`There is no room called ${code}. Check the code on the big screen.`} />;
  if (room.ended) return <Ended title="That's time" message={room.ended} />;

  return (
    <ConnContext.Provider value={room.conn}>
      <ConnectionBanner status={room.status} />
      {!hasToken || !room.view ? (
        hasToken ? (
          <main class="page page--centre">
            <p class="lead">Finding your table…</p>
          </main>
        ) : (
          <JoinForm code={code} conn={room.conn} />
        )
      ) : (
        <TeamScreen view={room.view} conn={room.conn!} />
      )}
      <Toast notice={room.notice} onDismiss={room.dismiss} />
    </ConnContext.Provider>
  );
}

function JoinForm({ code, conn }: { code: string; conn: RoomConnection | null }) {
  const [name, setName] = useState("");
  const submit = (e: Event) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !conn) return;
    conn.authenticate({ type: "auth.join", name: trimmed });
  };
  return (
    <main class="page page--centre">
      <p class="muted">Room {code}</p>
      <h1>Pick a team name</h1>
      <form onSubmit={submit}>
        <div class="field">
          <label for="team-name">Team name</label>
          <input
            id="team-name"
            class="input--big"
            autoComplete="off"
            maxLength={LIMITS.teamNameChars}
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            placeholder="Quiz Team Aguilera"
            autoFocus
          />
          <p class="hint">Shown on the big screen. Keep it pub friendly. Nothing else about you is collected.</p>
        </div>
        <button class="btn btn--primary btn--huge btn--block" type="submit" disabled={!conn || !name.trim()}>
          {conn ? "Join the quiz" : "Connecting…"}
        </button>
      </form>
    </main>
  );
}

function TeamScreen({ view, conn }: { view: TeamView; conn: RoomConnection }) {
  const me = view.me;
  return (
    <div class="team">
      <header class="team__header">
        <span class="team__name">{me.name}</span>
        <span class="team__score" aria-label={`Score ${me.score}, ${rankLabel(me, view.teams)} place`}>
          <strong>{me.score}</strong> pts
          <br />
          <span class="muted">{rankLabel(me, view.teams)} of {view.teams.length}</span>
        </span>
      </header>
      <StageBody view={view} conn={conn} />
    </div>
  );
}

function StageBody({ view, conn }: { view: TeamView; conn: RoomConnection }) {
  const stage = view.stage;
  switch (stage.kind) {
    case "lobby":
      return (
        <main class="team__body">
          <div class="status-card">
            <p class="big">You're in.</p>
            <p class="lead">{view.quizTitle ? `Tonight: ${view.quizTitle}.` : ""} Waiting for the quizmaster to start.</p>
          </div>
          <JokerCard view={view} conn={conn} />
        </main>
      );
    case "roundIntro": {
      const round = view.rounds[stage.round];
      return (
        <main class="team__body">
          <div class="status-card">
            <p class="muted">Round {stage.round + 1}</p>
            <p class="big">{round?.title}</p>
            <p class="lead">{round?.mode === "buzzer" ? "Buzzer round. Fastest finger answers out loud." : `${round?.questionCount} questions. Answer on this phone.`}</p>
          </div>
          <JokerCard view={view} conn={conn} round={stage.round} />
        </main>
      );
    }
    case "question":
      return view.question ? <QuestionBody view={view} q={view.question} conn={conn} /> : null;
    case "tiebreak":
      return <TiebreakBody view={view} conn={conn} />;
    case "scoreboard":
    case "final":
      return (
        <main class="team__body">
          <div class="status-card">
            <p class="muted">{stage.kind === "final" ? "Final position" : "Current position"}</p>
            <p class="big">{rankLabel(view.me, view.teams)}</p>
          </div>
          <Scoreboard teams={view.teams} highlight={view.me.id} />
        </main>
      );
  }
}

function JokerCard({ view, conn, round }: { view: TeamView; conn: RoomConnection; round?: number }) {
  if (!view.rounds.length) return null;
  const me = view.me;
  if (me.jokerRound !== null) {
    return (
      <p class="card" style={{ textAlign: "center" }}>
        <span class="tag tag--joker">Joker</span> played on round {me.jokerRound + 1}: double points.
      </p>
    );
  }
  const play = (r: number) => {
    if (confirm(`Play your joker on round ${r + 1}, ${view.rounds[r]?.title}? You only get one.`)) conn.send({ type: "team.joker", round: r });
  };
  const options = round !== undefined ? view.jokerRounds.filter((r) => r === round) : view.jokerRounds;
  if (!options.length) {
    return round !== undefined && !view.rounds[round]?.jokerAllowed ? (
      <p class="muted" style={{ textAlign: "center" }}>
        Jokers cannot be played on this round.
      </p>
    ) : null;
  }
  return (
    <section class="card" aria-labelledby="joker-h">
      <h2 id="joker-h">Your joker</h2>
      <p class="muted">Double points on one round. Play it before that round's first question opens.</p>
      <div class="stack">
        {options.map((r) => (
          <button key={r} class="btn btn--huge btn--block" type="button" onClick={() => play(r)}>
            Play on round {r + 1}: {view.rounds[r]?.title}
          </button>
        ))}
      </div>
    </section>
  );
}

function answerLabel(q: PublicQuestion, value: string | number): string {
  if (typeof value === "number") return `${LETTERS[value] ?? "?"}. ${q.options?.[value] ?? ""}`;
  return value;
}

function QuestionBody({ view, q, conn }: { view: TeamView; q: PublicQuestion; conn: RoomConnection }) {
  const now = useNow(useContext(ConnContext));
  const expired = q.closesAt !== null && now >= q.closesAt;
  const live = q.phase === "open" && !expired;
  const header = (
    <p class="muted" style={{ display: "flex", alignItems: "center" }}>
      <span>
        Question {q.number} · {q.points} point{q.points === 1 ? "" : "s"}
        {view.me.jokerRound === q.round && <span class="tag tag--joker">×2</span>}
      </span>
      <span class="spacer" />
      {q.phase === "open" && <Countdown closesAt={q.closesAt} now={now} />}
    </p>
  );

  if (q.phase === "ready") {
    return (
      <main class="team__body">
        {header}
        <div class="status-card">
          <p class="big">Question {q.number}</p>
          <p class="lead">{q.mode === "buzzer" ? "Finger on the buzzer…" : "Coming up. Eyes on the quizmaster."}</p>
        </div>
      </main>
    );
  }

  return (
    <main class="team__body">
      {header}
      <h1 class="prompt">{q.prompt}</h1>
      <MediaView media={q.media} />
      {q.mode === "buzzer" ? (
        <BuzzerBody view={view} q={q} conn={conn} live={live} />
      ) : q.type === "choice" ? (
        <ChoiceBody view={view} q={q} conn={conn} live={live} />
      ) : (
        <TextBody view={view} q={q} conn={conn} live={live} />
      )}
      {!live && q.mode === "answers" && <Outcome view={view} q={q} expired={expired} />}
    </main>
  );
}

function Outcome({ view, q, expired }: { view: TeamView; q: PublicQuestion; expired: boolean }) {
  const mine = view.myAnswer;
  if (q.phase === "revealed") {
    return (
      <div class="status-card" role="status">
        <p class="muted">The answer was</p>
        <p class="big">{q.reveal?.text}</p>
        {!mine ? (
          <p class="lead">You did not answer this one.</p>
        ) : mine.verdict === true ? (
          <p class="lead verdict--good">
            Correct! +{q.points * (view.me.jokerRound === q.round ? 2 : 1)}
          </p>
        ) : mine.verdict === false ? (
          <p class="lead verdict--bad">Not this time. You said {answerLabel(q, mine.value)}.</p>
        ) : (
          <p class="lead">The quizmaster is still marking yours.</p>
        )}
      </div>
    );
  }
  return (
    <div class="status-card" role="status">
      <p class="big">{expired && q.phase === "open" ? "Time's up" : "Answers locked"}</p>
      <p class="lead">{mine ? `You said: ${answerLabel(q, mine.value)}` : "No answer from your team."}</p>
    </div>
  );
}

function ChoiceBody({ view, q, conn, live }: { view: TeamView; q: PublicQuestion; conn: RoomConnection; live: boolean }) {
  const chosen = view.myAnswer?.value;
  const correct = q.reveal?.choiceIndex;
  return (
    <>
      <ul class="options" role="list" aria-label="Answer options">
        {(q.options ?? []).map((opt, i) => (
          <li key={i}>
            <button
              type="button"
              class={`option${correct === i ? " option--correct" : ""}`}
              aria-pressed={chosen === i}
              disabled={!live}
              onClick={() => conn.send({ type: "team.answer", questionKey: q.key, value: i })}
            >
              <span class="option__letter">{LETTERS[i]}</span>
              <span>{opt}</span>
            </button>
          </li>
        ))}
      </ul>
      {live && (
        <p class="hint" role="status" style={{ textAlign: "center", marginTop: "12px" }}>
          {chosen === undefined ? "Tap an answer. You can change it until answers lock." : `Locked in ${LETTERS[chosen as number]}. Tap another to change.`}
        </p>
      )}
    </>
  );
}

function TextBody({ view, q, conn, live }: { view: TeamView; q: PublicQuestion; conn: RoomConnection; live: boolean }) {
  const saved = typeof view.myAnswer?.value === "string" ? view.myAnswer.value : "";
  const [draft, setDraft] = useState(saved);
  const lastKey = useRef(q.key);
  useEffect(() => {
    if (lastKey.current !== q.key) {
      lastKey.current = q.key;
      setDraft(saved);
    }
  }, [q.key, saved]);
  if (!live) return null;
  const dirty = draft.trim() !== saved;
  const submit = (e: Event) => {
    e.preventDefault();
    if (draft.trim()) conn.send({ type: "team.answer", questionKey: q.key, value: draft.trim() });
  };
  return (
    <form onSubmit={submit}>
      <label for="answer" class="visually-hidden">
        Your answer
      </label>
      <input
        id="answer"
        class="input--big"
        autoComplete="off"
        autoCorrect="off"
        maxLength={LIMITS.answerChars}
        value={draft}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        placeholder="Type your answer"
        enterKeyHint="send"
      />
      <p class="hint" role="status">
        {saved ? (dirty ? `Sent: "${saved}". Send again to change it.` : `Sent: "${saved}". You can change it until answers lock.`) : "Not sent yet."}
      </p>
      <div class="team__actions" style={{ padding: "12px 0" }}>
        <button class="btn btn--primary btn--huge btn--block" type="submit" disabled={!draft.trim() || !dirty}>
          {saved ? "Update answer" : "Send answer"}
        </button>
      </div>
    </form>
  );
}

function BuzzerBody({ view, q, conn, live }: { view: TeamView; q: PublicQuestion; conn: RoomConnection; live: boolean }) {
  const mine = view.myBuzz;
  const firstWaiting = q.buzzes.find((b) => b.outcome === "waiting");
  const myTurn = firstWaiting?.teamId === view.me.id;
  const pressed = useRef(false);
  const buzz = () => {
    navigator.vibrate?.(60);
    conn.send({ type: "team.buzz", questionKey: q.key });
  };
  let status: string;
  if (!mine) status = live ? "Buzz if you know it." : q.phase === "revealed" ? `The answer was ${q.reveal?.text}.` : "Buzzers are closed.";
  else if (mine.outcome === "correct") status = `Correct! +${q.points * (view.me.jokerRound === q.round ? 2 : 1)}`;
  else if (mine.outcome === "wrong") status = "Not quite. Over to the next team.";
  else if (myTurn) status = "Your turn! Answer out loud.";
  else status = `You buzzed ${mine.position === 1 ? "first" : `in position ${mine.position}`}. Hold on.`;
  return (
    <>
      <button
        class="buzzer"
        type="button"
        disabled={!live || mine !== null}
        // Buzz on touch-down rather than on release: it shaves off the time a
        // finger takes to lift. Clicks from keyboards and screen readers still
        // work through onClick.
        onPointerDown={(e) => {
          pressed.current = true;
          e.preventDefault();
          buzz();
        }}
        onClick={() => {
          if (pressed.current) pressed.current = false;
          else buzz();
        }}
      >
        {mine ? `#${mine.position}` : "BUZZ"}
      </button>
      <p class={`lead${mine?.outcome === "correct" ? " verdict--good" : mine?.outcome === "wrong" ? " verdict--bad" : ""}`} role="status" style={{ textAlign: "center" }}>
        {status}
      </p>
    </>
  );
}

function TiebreakBody({ view, conn }: { view: TeamView; conn: RoomConnection }) {
  const tb = view.tiebreak;
  const [draft, setDraft] = useState(view.myTiebreak !== null ? String(view.myTiebreak) : "");
  if (!tb) {
    return (
      <main class="team__body">
        <div class="status-card">
          <p class="big">Tie-breaker</p>
          <p class="lead">Hang on while the quizmaster sets it up.</p>
        </div>
      </main>
    );
  }
  const inIt = tb.teamIds.includes(view.me.id);
  const names = tb.teamIds.map((id) => view.teams.find((t) => t.id === id)?.name ?? "?");
  const value = Number(draft.replace(/,/g, ""));
  return (
    <main class="team__body">
      <p class="muted">Tie-breaker between {names.join(" and ")}</p>
      <h1 class="prompt">{tb.prompt}</h1>
      {inIt && tb.phase === "open" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim() && Number.isFinite(value)) conn.send({ type: "team.tiebreak", value });
          }}
        >
          <label for="tb" class="visually-hidden">
            Your guess
          </label>
          <input id="tb" class="input--big" inputMode="decimal" value={draft} onInput={(e) => setDraft((e.target as HTMLInputElement).value)} placeholder={`Your guess${tb.unit ? ` in ${tb.unit}` : ""}`} />
          <p class="hint" role="status">
            {view.myTiebreak !== null ? `Sent: ${view.myTiebreak}. Closest wins; on an exact tie, the earliest guess wins.` : "Closest wins. Earliest guess wins an exact tie."}
          </p>
          <button class="btn btn--primary btn--huge btn--block" type="submit" disabled={!draft.trim() || !Number.isFinite(value)}>
            Send guess
          </button>
        </form>
      )}
      {!inIt && tb.phase === "open" && <p class="lead">Your team is not in this one. Enjoy the drama.</p>}
      {tb.phase === "revealed" && (
        <div class="status-card">
          <p class="muted">The answer was</p>
          <p class="big">
            {tb.answer} {tb.unit ?? ""}
          </p>
          <ol class="scoreboard">
            {tb.results?.map((r) => (
              <li key={r.teamId} class={`scoreboard__row${r.teamId === view.me.id ? " scoreboard__row--me" : ""}`}>
                <span class="scoreboard__rank">{r.distance === null ? "-" : `±${r.distance}`}</span>
                <span class="scoreboard__name">{view.teams.find((t) => t.id === r.teamId)?.name}</span>
                <span class="scoreboard__score">{r.value ?? "-"}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </main>
  );
}
