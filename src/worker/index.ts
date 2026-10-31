// The Worker in front of the rooms. It creates rooms, routes WebSocket
// connections to the right Durable Object and leaves everything else to
// the static assets (the front end).

import { isRoomCode, normaliseRoomCode } from "../shared/limits";
import type { ServerMessage } from "../shared/protocol";
import type { Env } from "./env";
import { randomId, randomRoomCode } from "./ids";
import { allowed, clientKey, CLOSE_RATE_LIMITED, limiterFor } from "./ratelimit";

export { Room } from "./room";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

// Only handlers and Durable Object classes may be exported from this module:
// the runtime refuses to start if the entry point exports anything else.

const TOO_MANY = "Too many requests from this network. Please wait a minute and try again.";

/**
 * A browser cannot read the status of a refused WebSocket upgrade, so a
 * rate-limited socket is accepted just long enough to say why, then closed.
 */
function refuseSocket(message: string): Response {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  server.send(JSON.stringify({ type: "error", code: "rate_limited", message } satisfies ServerMessage));
  server.close(CLOSE_RATE_LIMITED, "rate limited");
  return new Response(null, { status: 101, webSocket: client });
}

function roomStub(env: Env, code: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(code));
}

async function createRoom(env: Env): Promise<Response> {
  // Codes are short, so a clash with a live room is possible. Try a few.
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomRoomCode();
    const hostToken = randomId(24);
    const res = await roomStub(env, code).fetch("https://room/init", {
      method: "POST",
      body: JSON.stringify({ code, hostToken }),
    });
    if (res.status === 201) return json({ code, hostToken }, 201);
    if (res.status !== 409) return json({ error: "Could not create a room" }, 500);
  }
  return json({ error: "Could not find a free room code. Please try again." }, 503);
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

  if (parts.length === 2 && parts[1] === "health") return json({ ok: true });

  if (parts.length === 2 && parts[1] === "rooms") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (!(await allowed(limiterFor(env.CREATE_LIMITER, "createRoom"), `create:${clientKey(request)}`))) {
      return json({ error: "Too many new rooms from this network. Please wait a minute and try again." }, 429);
    }
    return createRoom(env);
  }

  if (parts[1] === "rooms" && parts[2]) {
    const code = normaliseRoomCode(parts[2]);
    if (!isRoomCode(code)) return json({ error: "Room codes are four letters" }, 400);
    const stub = roomStub(env, code);
    const connect = limiterFor(env.CONNECT_LIMITER, "connect");
    if (parts.length === 3 && request.method === "GET") {
      if (!(await allowed(connect, `lookup:${clientKey(request)}`))) return json({ error: TOO_MANY }, 429);
      const res = await stub.fetch("https://room/info");
      return json(await res.json(), res.status);
    }
    if (parts.length === 4 && parts[3] === "ws") {
      const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
      if (upgrade && !(await allowed(connect, `ws:${clientKey(request)}`))) return refuseSocket(TOO_MANY);
      // Forward the upgrade with its original headers so the room can accept it.
      return stub.fetch(new Request("https://room/ws", request));
    }
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
