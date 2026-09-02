import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initDb } from "./db";
import { missions } from "./routes/missions";
import { opportunities } from "./routes/opportunities";
import { bookmarks, taxonomies } from "./routes/bookmarks";
import { artifacts, missionArtifacts } from "./routes/artifacts";
import { chat } from "./routes/chat";
import { search } from "./routes/search";

export function createApp(): Hono {
  initDb();
  const app = new Hono();

  // CORS: allow all origins on /api/bookmarks POST/OPTIONS only (extension).
  app.use("/api/bookmarks", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }
    await next();
    if (c.req.method === "POST") c.res.headers.set("access-control-allow-origin", "*");
  });

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: err.message || "internal error" }, 500);
  });

  app.route("/api/missions", missions);
  app.route("/api/missions", missionArtifacts);
  app.route("/api/missions", chat);
  app.route("/api/opportunities", opportunities);
  app.route("/api/bookmarks", bookmarks);
  app.route("/api", taxonomies); // /api/tags, /api/lists
  app.route("/api/artifacts", artifacts);
  app.route("/api/search", search);

  app.get("/api/health", (c) => c.json({ ok: true }));

  // Static: serve ../web/dist with SPA fallback when it exists.
  const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (existsSync(webDist)) {
    app.use("/*", serveStatic({ root: webDist }));
    app.get("*", async (c) => {
      const index = Bun.file(`${webDist}/index.html`);
      if (await index.exists()) return c.html(await index.text());
      return c.json({ error: "not found" }, 404);
    });
  }

  return app;
}

if (import.meta.main) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  console.log(`Scout server listening on http://localhost:${port} (runtime: ${process.env.AGENT_RUNTIME || "mock"})`);
  Bun.serve({ port, fetch: app.fetch });
}
