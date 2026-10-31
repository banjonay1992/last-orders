// Gives `env` from "cloudflare:workers" the bindings declared in wrangler.jsonc.
import type { Env as WorkerEnv } from "../../src/worker/env";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

export {};
