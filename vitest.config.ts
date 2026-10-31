import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Two projects: fast unit tests of the pure game logic in Node, and
// integration tests that run the real Worker and Durable Object inside
// the Workers runtime (workerd) via Cloudflare's Vitest plugin.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
        test: {
          name: "worker",
          include: ["test/worker/**/*.test.ts"],
        },
      },
    ],
  },
});
