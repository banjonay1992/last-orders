import { renderSVG } from "uqr";
import { useMemo } from "preact/hooks";
import type { PublicMedia, PublicTeam } from "../shared/protocol";
import type { ConnectionStatus } from "./lib/connection";
import type { Notice } from "./lib/useRoom";

export const LETTERS = ["A", "B", "C", "D", "E", "F"];

export function ordinal(n: number): string {
  const s = n % 100;
  if (s >= 11 && s <= 13) return `${n}th`;
  const suffix = n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

export function rankLabel(team: PublicTeam, all: PublicTeam[]): string {
  const shared = all.filter((t) => t.rank === team.rank).length > 1;
  return `${shared ? "=" : ""}${ordinal(team.rank)}`;
}

export function secondsLeft(closesAt: number | null, now: number): number | null {
  if (closesAt === null) return null;
  return Math.max(0, Math.ceil((closesAt - now) / 1000));
}

export function Countdown({ closesAt, now, big = false }: { closesAt: number | null; now: number; big?: boolean }) {
  const left = secondsLeft(closesAt, now);
  if (left === null) return null;
  const urgent = left <= 5;
  return (
    <div class={`countdown${big ? " countdown--big" : ""}${urgent ? " countdown--urgent" : ""}`} role="timer" aria-label={`${left} seconds left`}>
      {left}
      <span class="countdown__unit">s</span>
    </div>
  );
}

export function Scoreboard({ teams, highlight, limit }: { teams: PublicTeam[]; highlight?: string; limit?: number }) {
  const rows = limit ? teams.slice(0, limit) : teams;
  if (!teams.length) return <p class="muted">No teams yet.</p>;
  return (
    <ol class="scoreboard" aria-label="Scores">
      {rows.map((t) => (
        <li key={t.id} class={`scoreboard__row${t.id === highlight ? " scoreboard__row--me" : ""}`}>
          <span class="scoreboard__rank">{rankLabel(t, teams)}</span>
          <span class="scoreboard__name">
            {t.name}
            {t.jokerRound !== null && <span class="tag tag--joker" title={`Joker on round ${t.jokerRound + 1}`}>J{t.jokerRound + 1}</span>}
          </span>
          <span class="scoreboard__score">{t.score}</span>
        </li>
      ))}
    </ol>
  );
}

export function QrCode({ text, label }: { text: string; label: string }) {
  const svg = useMemo(() => renderSVG(text, { border: 2 }), [text]);
  return <div class="qr" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function MediaView({ media }: { media: PublicMedia | null }) {
  if (!media) return null;
  if (media.kind === "image") {
    return (
      <figure class="media">
        <img src={media.url} alt={media.alt} referrerpolicy="no-referrer" />
      </figure>
    );
  }
  return (
    <p class="media media--audio">
      <span aria-hidden="true">♪</span> Listen: {media.label}
    </p>
  );
}

export function ConnectionBanner({ status }: { status: ConnectionStatus }) {
  if (status === "open") return null;
  const text = status === "closed" ? "Disconnected." : status === "connecting" ? "Connecting…" : "Reconnecting… your place is kept.";
  return (
    <div class="banner" role="status" aria-live="polite">
      {text}
    </div>
  );
}

export function Toast({ notice, onDismiss }: { notice: Notice | null; onDismiss: () => void }) {
  return (
    <div class="toast-region" aria-live="assertive" aria-atomic="true">
      {notice && (
        <div class={`toast${notice.code === "info" ? " toast--info" : ""}`} role="alert">
          <span>{notice.message}</span>
          <button type="button" class="toast__close" onClick={onDismiss} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  );
}

export function Ended({ title, message }: { title: string; message: string }) {
  return (
    <main class="page page--centre">
      <h1>{title}</h1>
      <p class="lead">{message}</p>
      <p>
        <a class="btn" href="/">
          Back to the start
        </a>
      </p>
    </main>
  );
}
