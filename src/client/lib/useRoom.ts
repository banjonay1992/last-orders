import { createContext } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ErrorCode, RoleView } from "../../shared/protocol";
import { fetchRoomInfo, RoomConnection, type ConnectionStatus } from "./connection";

export interface Notice {
  id: number;
  code: ErrorCode | "info";
  message: string;
}

export interface RoomHandle<V extends RoleView> {
  conn: RoomConnection | null;
  status: ConnectionStatus;
  view: V | null;
  notice: Notice | null;
  dismiss: () => void;
  /** Set when the room is gone or this device was removed. */
  ended: string | null;
  missing: boolean;
}

let noticeId = 0;

/** The live connection, for components deep in a view that need the server clock. */
export const ConnContext = createContext<RoomConnection | null>(null);

/**
 * Connects to a room for the lifetime of the component. `setup` runs once
 * with the connection so the caller can authenticate and subscribe to
 * welcome or error events.
 */
export function useRoom<V extends RoleView>(code: string, setup: (conn: RoomConnection) => void | (() => void)): RoomHandle<V> {
  const [conn, setConn] = useState<RoomConnection | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [view, setView] = useState<V | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const setupRef = useRef(setup);
  setupRef.current = setup;

  useEffect(() => {
    let cancelled = false;
    let cleanup: void | (() => void);
    const c = new RoomConnection(code);
    const offs = [
      c.on("status", setStatus),
      c.on("state", (v) => setView(v as V)),
      c.on("error", (errCode, message) => setNotice({ id: ++noticeId, code: errCode, message })),
      c.on("kicked", () => setEnded("The quizmaster removed this team from the room.")),
      c.on("closed", (reason) => setEnded(reason)),
    ];
    void fetchRoomInfo(code).then((info) => {
      if (cancelled) return;
      if (!info.exists) {
        setMissing(true);
        return;
      }
      cleanup = setupRef.current(c);
      c.start();
      setConn(c);
    });
    return () => {
      cancelled = true;
      offs.forEach((off) => off());
      if (cleanup) cleanup();
      c.stop();
    };
  }, [code]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice((n) => (n?.id === notice.id ? null : n)), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  return { conn, status, view, notice, dismiss: () => setNotice(null), ended, missing };
}

/** Ticks once a second (or faster) so countdowns re-render. */
export function useNow(conn: RoomConnection | null, intervalMs = 250): number {
  const [now, setNow] = useState(() => conn?.serverNow() ?? Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(conn?.serverNow() ?? Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [conn, intervalMs]);
  return now;
}
