import type { Room } from "./room";

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<Room>;
  /**
   * Cloudflare rate limiting bindings, declared in wrangler.jsonc. Optional:
   * without them the Worker falls back to an in-memory limiter per isolate.
   */
  CREATE_LIMITER?: RateLimit;
  CONNECT_LIMITER?: RateLimit;
}
