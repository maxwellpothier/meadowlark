/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// In `npm run dev`, the API runs inside Vite's dev server, so there's one
// process and one address. `npm start` (server/main.ts) does the same for the build.
function meadowlarkApi(): Plugin {
  return {
    name: "meadowlark-api",
    // Vitest runs a dev server too; tests must never open the real database.
    apply: (_, env) => env.command === "serve" && !process.env.VITEST,
    async configureServer(server) {
      const [{ createApi }, { startBackups }, { openDb }, { Store }] = await Promise.all([
        import("./server/api.ts"),
        import("./server/backups.ts"),
        import("./server/db.ts"),
        import("./server/store.ts"),
      ]);
      const store = new Store(openDb());
      const api = createApi(store);
      const stopBackups = startBackups(store);
      server.middlewares.use((req, res, next) => {
        api.handle(req, res).then((handled) => handled || next(), next);
      });
      server.httpServer?.on("close", () => {
        api.close();
        stopBackups();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), meadowlarkApi()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  test: {
    environment: "node",
  },
});
