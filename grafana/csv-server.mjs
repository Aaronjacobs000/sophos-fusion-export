#!/usr/bin/env node
/**
 * A small read-only file server for the exporter's CSV folder, so Grafana's
 * Infinity data source can read the tables by URL. It serves the table files
 * and _schema.json only: no directory listing, no _state, no other path, GET
 * and HEAD only. It listens on 127.0.0.1 by default, so only the Grafana on
 * the same host can read it.
 *
 *   node grafana/csv-server.mjs --dir ./export [--host 127.0.0.1] [--port 3301]
 *
 * FUSION_EXPORT_DIR, CSV_SERVER_HOST and CSV_SERVER_PORT work too.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dir = resolve(option("dir", process.env.FUSION_EXPORT_DIR ?? "./export"));
const host = option("host", process.env.CSV_SERVER_HOST ?? "127.0.0.1");
const port = Number(option("port", process.env.CSV_SERVER_PORT ?? "3301"));
const NAME = /^\/([a-z][a-z0-9_]{1,63}\.csv|_schema\.json)$/;

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const match = NAME.exec(path);
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  if (path === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok\n");
    return;
  }
  if (!match) {
    res.writeHead(404).end();
    return;
  }
  const file = join(dir, match[1]);
  try {
    const info = await stat(file);
    const body = req.method === "HEAD" ? null : await readFile(file);
    res.writeHead(200, {
      "Content-Type": file.endsWith(".json") ? "application/json" : "text/csv; charset=utf-8",
      "Content-Length": info.size,
      "Last-Modified": info.mtime.toUTCString(),
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});

server.listen(port, host, () => console.log(`Serving ${dir} on http://${host}:${port}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
