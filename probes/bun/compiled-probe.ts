import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import html from "./assets/probe.html";

// 可写数据由调用方显式选择，不能写入编译包内的 bunfs。
const dataRoot = resolve(process.env.P0_DATA_ROOT ?? "./p0-data");
mkdirSync(dataRoot, { recursive: true });
const dbPath = join(dataRoot, "probe.sqlite");
const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
db.query("INSERT OR REPLACE INTO probe (id, value) VALUES (1, ?)").run("compiled-bun-sqlite-ok");
const resourcePath = join(import.meta.dir, "assets", "resource.txt");
const resourceText = readFileSync(resourcePath, "utf8").trim();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 0),
  routes: {
    "/": html,
    "/api/health": () => Response.json({ ok: true, name: "FrameBaker P0 Bun probe", bun: Bun.version, platform: process.platform, execPath: process.execPath, moduleDir: import.meta.dir, dbPath, sqlite: db.query("SELECT value FROM probe WHERE id=1").get(), resourcePath, resourceText }),
    "/resource.txt": () => new Response(Bun.file(resourcePath), { headers: { "Content-Type": "text/plain; charset=utf-8" } }),
  },
  fetch: () => new Response("Not found", { status: 404 }),
});
console.log(JSON.stringify({ event: "ready", url: server.url.href, pid: process.pid, dbPath, resourcePath }));
function stop() { server.stop(true); db.close(); process.exit(0); }
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
