import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// The front end is a plain static bundle. In production (and under
// `npm run dev`) the Worker serves it from dist/client. `npm run dev:ui`
// runs Vite's own dev server with hot reload and proxies the API and
// WebSocket traffic to a separately running `wrangler dev` on port 8787.
export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", ws: true },
    },
  },
});
