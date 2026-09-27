#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigStore, configDir, type PolyConfig } from "./config.js";
import { ADAPTERS, SEARCH_ORDER, FETCH_ORDER, DEFAULT_ENABLED, KNOWN_IDS } from "./engines/index.js";
import { UsageStore } from "./usage.js";
import { HistoryStore } from "./history.js";
import { SearchRouter, RouterError } from "./router.js";
import { buildStatus, clearRemoteQuotaCache } from "./status.js";
import { buildMcpServer } from "./mcp/server.js";
import { mountMcpHttp } from "./mcp/http.js";
import { buildWebApp } from "./web/app.js";
import type { TestResult } from "./types.js";
import { VERSION } from "./version.js";
import { mountSecurity } from "./web/security.js";

function findFreePort(start: number, host: string, tries = 20): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (port: number) => {
      if (port > start + tries) {
        reject(new Error(`Kein freier Port ab ${start} gefunden`));
        return;
      }
      const srv = createServer();
      srv.unref();
      srv.on("error", () => attempt(port + 1));
      srv.listen(port, host, () => {
        srv.close(() => resolve(port));
      });
    };
    attempt(start);
  });
}

function openBrowser(url: string): void {
  try {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    // spawn failures arrive asynchronously; never log the one-time login URL.
    child.on("error", () => console.error("[search-rotation] Browser konnte nicht geöffnet werden; Dashboard-URL manuell öffnen."));
    child.unref();
  } catch {
    console.error("[search-rotation] Browser konnte nicht geöffnet werden; Dashboard-URL manuell öffnen.");
  }
}

async function main(): Promise<void> {
  const args = parseArgs({
    options: {
      http: { type: "boolean", default: false },
      port: { type: "string" },
      host: { type: "string" },
      "public-origin": { type: "string" },
      token: { type: "string" },
      open: { type: "boolean", default: false },
      "no-dashboard": { type: "boolean", default: false },
    },
  }).values;

  const store = new ConfigStore();
  const defaults = {
    knownIds: KNOWN_IDS,
    searchOrder: SEARCH_ORDER,
    fetchOrder: FETCH_ORDER,
    defaultEnabled: DEFAULT_ENABLED,
    requiredKeyIds: ADAPTERS.filter(a => a.meta.keyless === "no").map(a => a.meta.id),
  };
  let cfg = store.load(defaults);
  const getConfig = () => (cfg = store.load(defaults));
  const usage = new UsageStore(configDir());
  const history = new HistoryStore(path.join(configDir(), "history.json"));
  const router = new SearchRouter({ getConfig, usage, adapters: ADAPTERS, history });

  const month = () => usage.monthKey();
  const status = () => buildStatus(getConfig(), usage, ADAPTERS);
  const saveConfig = (next: PolyConfig): void => {
    store.save(next);
    cfg = next;
    // Neuer Key? Dann Remote-Quota sofort frisch ziehen statt 5 Min Cache.
    clearRemoteQuotaCache();
  };

  const testEngine = async (id: string, kind: "search" | "fetch", arg: string, signal?: AbortSignal): Promise<TestResult> => {
    const adapter = ADAPTERS.find(a => a.meta.id === id);
    if (!adapter) return { ok: false, ms: 0, error: "unbekannte Engine" };
    if (kind === "search" && !adapter.search) return { ok: false, ms: 0, error: "Engine kann nicht suchen" };
    if (kind === "fetch" && !adapter.fetchUrl) return { ok: false, ms: 0, error: "Engine kann nicht fetchen" };
    const start = Date.now();
    try {
      if (kind === "search") {
        const out = await router.search({ query: arg || "model context protocol", numResults: 3 }, { onlyEngine: id, signal });
        return { ok: true, ms: Date.now() - start, count: out.items.length,
          preview: out.items.slice(0, 3).map(item => `${item.title} — ${item.url}`).join("\n") };
      }
      const out = await router.fetchUrl({ url: arg || "https://example.com" }, { onlyEngine: id, signal });
      return { ok: true, ms: Date.now() - start, chars: out.markdown.length, preview: out.markdown.slice(0, 400) };
    } catch (err) {
      const detail = err instanceof RouterError ? err.attempts.map(a => a.error).filter(Boolean).join("; ") : "";
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, ms: Date.now() - start, error: detail || message };
    }
  };

  const token = args.token ?? process.env.SEARCH_ROTATION_TOKEN ?? cfg.settings.token;
  const host = args.host ?? "127.0.0.1";
  const dashboardEnabled = !args["no-dashboard"];
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (!loopback && !token) throw new Error("Remote-Bind benötigt --token oder SEARCH_ROTATION_TOKEN");
  // HTTP-Server nötig für das Dashboard UND für --http — sonst hat der Prozess
  // kein Keep-Alive-Handle und beendet sich sofort (--http --no-dashboard-Fix).
  const httpNeeded = dashboardEnabled || args.http;
  const wantedPort = args.port !== undefined ? Number(args.port) : cfg.settings.port;
  const basePort =
    Number.isInteger(wantedPort) && wantedPort >= 1024 && wantedPort <= 65535
      ? wantedPort
      : cfg.settings.port;
  const port = httpNeeded ? await findFreePort(basePort, host) : 0;

  const browserHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const localOrigin = `http://${browserHost.includes(":") ? `[${browserHost}]` : browserHost}:${port}`;
  const publicOrigin = args["public-origin"] ? new URL(args["public-origin"]) : new URL(localOrigin);
  if (!["http:", "https:"].includes(publicOrigin.protocol) || publicOrigin.username || publicOrigin.password || publicOrigin.search || publicOrigin.hash || publicOrigin.pathname !== "/") {
    throw new Error("--public-origin muss eine HTTP(S)-Origin ohne Pfad, Zugangsdaten oder Query sein");
  }
  const origin = publicOrigin.origin;
  const dashboardUrl = (): string | null => dashboardEnabled ? `${origin}/` : null;
  const app = new Hono();
  const security = mountSecurity(app, { token, origin, additionalOrigins: [localOrigin], dashboardEnabled });
  const mcpDeps = {
    router, status, month, dashboardUrl,
    getConfig, saveConfig,
    openDashboard: () => {
      if (dashboardEnabled) openBrowser(security.browserUrl());
    },
  };

  app.route(
    "/",
    buildWebApp({
      configPath: store.file,
      getConfig,
      saveConfig,
      adapters: ADAPTERS,
      status,
      month,
      testEngine,
      historyList: (limit) => history.list(limit),
      historyClear: () => history.clear(),
    }),
  );
  mountMcpHttp(app, mcpDeps, security);

  if (httpNeeded) {
    const srv = serve({ fetch: app.fetch, port, hostname: host });
    // TOCTOU-Restrisiko: wird der Port zwischen findFreePort und Binden doch
    // belegt, laut statt still mit Stacktrace sterben.
    srv.on("error", (err: NodeJS.ErrnoException) => {
      console.error(
        `[search-rotation] fatal: HTTP-Server auf ${host}:${port} fehlgeschlagen (${err.code ?? err.message})`,
      );
      process.exit(1);
    });
    if (dashboardEnabled) console.error(`[search-rotation] Dashboard: ${dashboardUrl()}`);
  }

  if (args.http) {
    console.error(
      `[search-rotation] v${VERSION} — MCP (Streamable HTTP): http://${host}:${port}/mcp` +
        (token ? " (Bearer-Token nötig)" : ""),
    );
  } else {
    // Exit, sobald der MCP-Client stdin schließt — vor connect registrieren,
    // damit kein Fenster bleibt, in dem der Prozess hängen bleibt.
    const exit = () => process.exit(0);
    process.stdin.on("end", exit);
    process.stdin.on("close", exit);
    process.stdin.on("error", exit);
    const mcp = buildMcpServer(mcpDeps);
    await mcp.connect(new StdioServerTransport());
    console.error(
      `[search-rotation] v${VERSION} — MCP stdio aktiv.` +
        (dashboardEnabled ? ` Dashboard: ${dashboardUrl()}` : ""),
    );
  }

  if (args.open && dashboardEnabled) mcpDeps.openDashboard();
}

main().catch((err: unknown) => {
  console.error(`[search-rotation] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
