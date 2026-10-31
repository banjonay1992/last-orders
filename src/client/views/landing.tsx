import { useEffect, useState } from "preact/hooks";
import { isRoomCode, normaliseRoomCode, ROOM_CODE_LENGTH } from "../../shared/limits";
import { hostToken } from "../lib/store";
import { linkTo, navigate } from "../router";

export function Landing() {
  const [code, setCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Last Orders";
  }, []);

  const join = (e: Event) => {
    e.preventDefault();
    const c = normaliseRoomCode(code);
    if (!isRoomCode(c)) {
      setError(`Room codes are ${ROOM_CODE_LENGTH} letters, shown on the big screen.`);
      return;
    }
    navigate(`/play/${c}`);
  };

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/rooms", { method: "POST" });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Could not create a room");
      const body = (await res.json()) as { code: string; hostToken: string };
      hostToken.set(body.code, body.hostToken);
      navigate(`/host/${body.code}`);
    } catch (err) {
      setError((err as Error).message);
      setCreating(false);
    }
  };

  return (
    <main class="page">
      <header class="stack" style={{ marginBottom: "28px" }}>
        <h1>
          <span class="brand">Last Orders</span>
        </h1>
        <p class="lead">A pub quiz kit where every phone is the buzzer. No accounts, no app to install.</p>
      </header>

      {error && (
        <p class="errors" role="alert">
          {error}
        </p>
      )}

      <div class="landing">
        <section class="card" aria-labelledby="join-h">
          <h2 id="join-h">Join a quiz</h2>
          <form onSubmit={join}>
            <div class="field">
              <label for="code">Room code</label>
              <input
                id="code"
                class="input--big input--code"
                autoComplete="off"
                autoCapitalize="characters"
                spellcheck={false}
                inputMode="text"
                maxLength={8}
                value={code}
                onInput={(e) => setCode((e.target as HTMLInputElement).value)}
                placeholder="ABCD"
              />
            </div>
            <button class="btn btn--primary btn--huge btn--block" type="submit">
              Join
            </button>
          </form>
        </section>

        <section class="card" aria-labelledby="host-h">
          <h2 id="host-h">Run a quiz</h2>
          <p class="muted">Open a room on your laptop, put the big screen on the pub TV and read the questions out.</p>
          <button class="btn btn--primary btn--huge btn--block" type="button" onClick={create} disabled={creating}>
            {creating ? "Opening a room…" : "Start a new room"}
          </button>
        </section>

        <section class="card" aria-labelledby="edit-h">
          <h2 id="edit-h">Write a quiz</h2>
          <p class="muted">Build rounds in the editor, or import and export quiz files as JSON.</p>
          <a class="btn btn--huge btn--block" href="/editor" onClick={linkTo("/editor")}>
            Open the editor
          </a>
        </section>
      </div>

      <p class="muted" style={{ marginTop: "32px", fontSize: "0.9rem" }}>
        Privacy: a room only holds team nicknames and answers, in memory and storage for that room, and deletes itself
        after 12 idle hours or when the quizmaster closes it. There is no tracking.
      </p>
    </main>
  );
}
