import { useContext, useEffect } from "preact/hooks";
import type { PublicQuestion, ScreenView } from "../../shared/protocol";
import { ConnectionBanner, Countdown, Ended, LETTERS, MediaView, QrCode, Scoreboard } from "../components";
import { ConnContext, useNow, useRoom } from "../lib/useRoom";

// The pub TV. Read-only: it joins as a spectator and never sends commands.

export function ScreenPage({ code }: { code: string }) {
  const room = useRoom<ScreenView>(code, (conn) => conn.authenticate({ type: "auth.screen" }));

  useEffect(() => {
    document.title = `Big screen ${code} · Last Orders`;
  }, [code]);

  if (room.missing) return <Ended title="Room not found" message={`There is no room called ${code}.`} />;
  if (room.ended) return <Ended title="Thanks for playing" message={room.ended} />;
  return (
    <ConnContext.Provider value={room.conn}>
      <ConnectionBanner status={room.status} />
      {room.view ? <Screen view={room.view} /> : <main class="screen"><p class="lead">Connecting…</p></main>}
    </ConnContext.Provider>
  );
}

function Screen({ view }: { view: ScreenView }) {
  const joinUrl = `${location.origin}/play/${view.code}`;
  const host = location.host;
  return (
    <div class="screen">
      <div class="screen__top">
        <span class="brand">Last Orders</span>
        <span>{view.quizTitle}</span>
        <span class="spacer" />
        {view.stage.kind !== "lobby" && (
          <span>
            Join: {host}/play · code <strong style={{ color: "var(--accent)" }}>{view.code}</strong>
          </span>
        )}
      </div>
      <main class="screen__main" aria-live="polite">
        <StageView view={view} joinUrl={joinUrl} />
      </main>
    </div>
  );
}

function StageView({ view, joinUrl }: { view: ScreenView; joinUrl: string }) {
  const stage = view.stage;
  switch (stage.kind) {
    case "lobby":
      return (
        <div class="screen__lobby">
          <QrCode text={joinUrl} label={`QR code linking to ${joinUrl}`} />
          <div>
            <p class="muted" style={{ margin: 0 }}>
              Scan, or go to <strong>{joinUrl.replace(/^https?:\/\//, "")}</strong>
            </p>
            <div class="screen__code" aria-label={`Room code ${view.code.split("").join(" ")}`}>
              {view.code}
            </div>
            <p class="muted">{view.teams.length ? `${view.teams.length} team${view.teams.length === 1 ? "" : "s"} in` : "Waiting for teams…"}</p>
            <ul class="team-cloud" aria-label="Teams">
              {view.teams.map((t) => (
                <li key={t.id}>{t.name}</li>
              ))}
            </ul>
          </div>
        </div>
      );
    case "roundIntro": {
      const round = view.rounds[stage.round];
      const jokers = view.teams.filter((t) => t.jokerRound === stage.round);
      return (
        <div>
          <p class="muted">Round {stage.round + 1}</p>
          <h1>{round?.title}</h1>
          <p class="lead">
            {round?.questionCount} questions.{" "}
            {round?.mode === "buzzer" ? "Buzzer round: first to buzz answers out loud." : "Answer on your phones."}
          </p>
          {round?.jokerAllowed && (
            <p>
              {jokers.length ? `Jokers played: ${jokers.map((t) => t.name).join(", ")}.` : "Last chance to play your joker on this round."}
            </p>
          )}
        </div>
      );
    }
    case "question":
      return view.question ? <QuestionView view={view} q={view.question} /> : null;
    case "scoreboard":
      return (
        <div>
          <h1>Scores</h1>
          <Scoreboard teams={view.teams} limit={12} />
        </div>
      );
    case "tiebreak": {
      const tb = view.tiebreak;
      const name = (id: string) => view.teams.find((t) => t.id === id)?.name ?? "?";
      if (!tb) return <h1>Tie-breaker</h1>;
      return (
        <div>
          <p class="muted">Tie-breaker: {tb.teamIds.map(name).join(" v ")}</p>
          <p class="prompt">{tb.prompt}</p>
          {tb.phase === "open" ? (
            <p class="lead">
              {tb.answeredTeamIds.length} of {tb.teamIds.length} guesses in. Closest wins.
            </p>
          ) : (
            <>
              <p class="screen__code" style={{ fontSize: "clamp(3rem, 8vw, 7rem)" }}>
                {tb.answer} {tb.unit}
              </p>
              <ol class="scoreboard">
                {tb.results?.map((r) => (
                  <li key={r.teamId} class="scoreboard__row">
                    <span class="scoreboard__rank">{r.distance === null ? "-" : `±${r.distance}`}</span>
                    <span class="scoreboard__name">{name(r.teamId)}</span>
                    <span class="scoreboard__score">{r.value ?? "no guess"}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      );
    }
    case "final": {
      const winners = view.teams.filter((t) => t.rank === 1);
      return (
        <div>
          <p class="muted">Final results</p>
          <h1>{winners.length === 1 ? `${winners[0]!.name} win!` : winners.length > 1 ? "It's a tie at the top" : "That's the quiz"}</h1>
          <Scoreboard teams={view.teams} limit={12} />
        </div>
      );
    }
  }
}

function QuestionView({ view, q }: { view: ScreenView; q: PublicQuestion }) {
  const now = useNow(useContext(ConnContext));
  const roundTitle = view.rounds[q.round]?.title;
  if (q.phase === "ready") {
    return (
      <div>
        <p class="muted">{roundTitle}</p>
        <h1>Question {q.number}</h1>
        <p class="lead">{q.mode === "buzzer" ? "Fingers on buzzers." : "Get ready."}</p>
      </div>
    );
  }
  const name = (id: string) => view.teams.find((t) => t.id === id)?.name ?? "?";
  const active = q.buzzes.find((b) => b.outcome === "waiting");
  return (
    <div>
      <div class="row">
        <p class="muted" style={{ margin: 0 }}>
          {roundTitle} · Question {q.number} · {q.points} point{q.points === 1 ? "" : "s"}
        </p>
        <span class="spacer" />
        {q.phase === "open" && <Countdown closesAt={q.closesAt} now={now} big />}
      </div>
      <p class="prompt">{q.prompt}</p>
      <MediaView media={q.media} />
      {q.options && (
        <ul class="options">
          {q.options.map((opt, i) => (
            <li key={i} class={`option${q.reveal?.choiceIndex === i ? " option--correct" : ""}`}>
              <span class="option__letter">{LETTERS[i]}</span>
              {opt}
            </li>
          ))}
        </ul>
      )}
      {q.mode === "answers" && q.phase !== "revealed" && (
        <p class="lead" style={{ marginTop: "1em" }}>
          {q.phase === "open" ? `${q.answeredCount} of ${view.teams.length} teams answered` : "Answers locked"}
        </p>
      )}
      {q.mode === "buzzer" && q.buzzes.length > 0 && (
        <ol class="buzz-queue">
          {q.buzzes.map((b, i) => (
            <li key={b.teamId} class={b === active ? "is-active" : `is-${b.outcome}`}>
              <strong>{i + 1}.</strong> {b.name}
            </li>
          ))}
        </ol>
      )}
      {q.reveal && (
        <div style={{ marginTop: "1em" }}>
          {q.type === "text" && (
            <p class="screen__code" style={{ fontSize: "clamp(2.4rem, 6vw, 5rem)", letterSpacing: "0.02em" }}>
              {q.reveal.text}
            </p>
          )}
          <p class="lead">
            {q.reveal.correctTeamIds.length
              ? `Got it: ${q.reveal.correctTeamIds.map(name).join(", ")}`
              : "Nobody got that one."}
          </p>
        </div>
      )}
    </div>
  );
}
