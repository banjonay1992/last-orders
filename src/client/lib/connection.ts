// A WebSocket to one room that survives phones locking, Wi-Fi blips and
// laptop lids. It reconnects with backoff, re-authenticates with whatever
// credential last worked, and keeps a rough offset to the server clock so
// countdowns agree with the room's idea of time.

import type { AuthMessage, ClientMessageInput, ErrorCode, RoleView, ServerMessage } from "../../shared/protocol";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface ConnectionEvents {
  status: (status: ConnectionStatus) => void;
  state: (view: RoleView) => void;
  welcome: (msg: Extract<ServerMessage, { type: "welcome" }>) => void;
  error: (code: ErrorCode, message: string) => void;
  kicked: () => void;
  closed: (reason: string) => void;
}

type AuthInput = Extract<ClientMessageInput, { type: `auth.${string}` }> | AuthMessage;

const PING_MS = 25_000;
const MAX_BACKOFF_MS = 10_000;

export class RoomConnection {
  private ws: WebSocket | null = null;
  private auth: AuthInput | null = null;
  private attempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private listeners: Partial<{ [K in keyof ConnectionEvents]: ConnectionEvents[K][] }> = {};
  /** serverNow minus local now, in milliseconds. */
  clockOffset = 0;
  status: ConnectionStatus = "connecting";

  constructor(private readonly code: string) {}

  on<K extends keyof ConnectionEvents>(event: K, fn: ConnectionEvents[K]): () => void {
    const list = (this.listeners[event] ??= []) as ConnectionEvents[K][];
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    };
  }

  private emit<K extends keyof ConnectionEvents>(event: K, ...args: Parameters<ConnectionEvents[K]>): void {
    for (const fn of this.listeners[event] ?? []) (fn as (...a: Parameters<ConnectionEvents[K]>) => void)(...args);
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.emit("status", status);
  }

  /**
   * Sets the credential used on every reconnect. With `sendNow` it is also
   * sent straight away if the socket is open; without, it only applies to
   * the next connection (used to swap a one-off join for a resume token).
   */
  authenticate(auth: AuthInput, sendNow = true): void {
    this.auth = auth;
    if (sendNow && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(auth));
  }

  /** Forget the stored credential, for example after a resume token is refused. */
  clearAuth(): void {
    this.auth = null;
  }

  start(): void {
    this.stopped = false;
    this.open();
    document.addEventListener("visibilitychange", this.onVisible);
    window.addEventListener("online", this.onVisible);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    document.removeEventListener("visibilitychange", this.onVisible);
    window.removeEventListener("online", this.onVisible);
    this.ws?.close(1000, "leaving");
    this.ws = null;
  }

  send(msg: ClientMessageInput): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  /** A phone coming back from the lock screen should not wait out a long backoff. */
  private onVisible = (): void => {
    if (document.visibilityState !== "visible" || this.stopped) return;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      clearTimeout(this.retryTimer);
      this.attempts = 0;
      this.open();
    }
  };

  private open(): void {
    if (this.stopped) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/rooms/${encodeURIComponent(this.code)}/ws`);
    this.ws = ws;
    this.setStatus(this.attempts === 0 && this.status === "connecting" ? "connecting" : "reconnecting");

    ws.onopen = () => {
      this.attempts = 0;
      this.setStatus("open");
      if (this.auth) ws.send(JSON.stringify(this.auth));
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, PING_MS);
    };

    ws.onmessage = (event) => {
      if (event.data === "pong") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case "state":
          this.clockOffset = msg.serverNow - Date.now();
          this.emit("state", msg.view);
          break;
        case "welcome":
          this.emit("welcome", msg);
          break;
        case "error":
          this.emit("error", msg.code, msg.message);
          break;
        case "kicked":
          this.stopped = true;
          this.emit("kicked");
          break;
        case "closed":
          this.stopped = true;
          this.emit("closed", msg.reason);
          break;
      }
    };

    ws.onclose = (event) => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      // 4000 to 4003 are deliberate closes from the room: do not hammer it.
      if (this.stopped || (event.code >= 4000 && event.code <= 4003)) {
        this.stopped = true;
        this.setStatus("closed");
        return;
      }
      this.attempts++;
      this.setStatus("reconnecting");
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.attempts, 5)) * (0.75 + Math.random() * 0.5);
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
  }
}

export async function fetchRoomInfo(code: string): Promise<{ exists: boolean; quizTitle?: string | null; teams?: number }> {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`, { cache: "no-store" });
    if (res.status === 404 || res.status === 400) return { exists: false };
    // Rate limited: carry on, and the socket explains and retries with backoff.
    if (res.status === 429) return { exists: true };
    return (await res.json()) as { exists: boolean; quizTitle: string | null; teams: number };
  } catch {
    // Offline or the Worker is down; let the socket retry rather than claiming the room is gone.
    return { exists: true };
  }
}
