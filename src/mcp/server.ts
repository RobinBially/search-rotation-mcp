import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RouterError, type SearchRouter } from "../router.js";
import type { StatusRow } from "../status.js";
import type { PolyConfig } from "../config.js";
import { engineStatus } from "./engine-status.js";
import { applyEngineConfigPatch, engineRotationSummary } from "./engine-config.js";
import { dateSchema, timeRangeSchema, describeSearchTime } from "../search-time.js";
import { VERSION } from "../version.js";
import { readFileSync } from "node:fs";

// Inline packaged icons: clients need no dashboard connection or external image host.
const icons = (["light", "dark"] as const).map(theme => ({
  src: `data:image/png;base64,${readFileSync(new URL(`../../docs/assets/brand/icon-${theme}-128.png`, import.meta.url)).toString("base64")}`,
  mimeType: "image/png",
  sizes: ["128x128"],
  theme,
}));

export interface McpDeps {
  router: SearchRouter;
  /** Bound only to this HTTP request; stdio uses the MCP cancellation signal. */
  requestSignal?: AbortSignal;
  status(): Promise<StatusRow[]>;
  month(): string;
  /** null = Dashboard deaktiviert (--no-dashboard) */
  dashboardUrl(): string | null;
  openDashboard(): void;
  /** Vollständige lokale Konfiguration inklusive Keys; nur für die Engine-Konfiguration. */
  getConfig(): PolyConfig;
  saveConfig(config: PolyConfig): void;
}

async function withRouterDiagnostics<T>(operation: Promise<T>): Promise<T> {
  try { return await operation; }
  catch (error) {
    if (error instanceof RouterError && error.attempts.length) {
      throw new Error(`${error.message}\n${error.attempts.map(a => `${a.engine}: ${a.error ?? (a.ok ? "ok" : "fehlgeschlagen")}`).join("\n")}`);
    }
    throw error;
  }
}

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "search-rotation", version: VERSION, icons });

  server.registerTool(
    "search_web",
    {
      title: "Web Search",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Search the web through a rotating pool of search providers (Tavily, Firecrawl, Parallel, Exa, Google PSE, DuckDuckGo) with automatic failover when one errors, is rate-limited or has no local quota left. Use it when the answer depends on current web pages and no URL is known yet; use fetch_url to read a page whose URL is already known. Returns numbered results (title, URL, snippet, publication date when the provider supplies one) and names the provider that answered plus every failed attempt, so failover stays visible. Time filters keep rotation inside the providers that implement them and fail explicitly instead of searching without the filter; if every eligible provider fails, the tool returns an error listing each provider's reason. The engine parameter only prefers a provider and leaves failover active.",
      inputSchema: {
        query: z.string().describe("Search query"),
        numResults: z.number().int().min(1).max(20).optional().describe("Optional result count (1–20). Omit to use the dashboard setting: a custom count or the provider default."),
        timeRange: timeRangeSchema.optional().describe("Relative UTC date window: day=1, week=7, month=30, year=365 days through today. Cannot combine with startDate/endDate; day precision, not rolling hours."),
        startDate: dateSchema.optional().describe("Start date YYYY-MM-DD. May be used alone or with endDate; cannot combine with timeRange."),
        endDate: dateSchema.optional().describe("End date YYYY-MM-DD (through this date, subject to provider boundary semantics). Cannot combine with timeRange."),
        engine: z.string().optional().describe("Preferred engine id from get_engine_status; only moves that engine to the front, failover to the others stays active. Engines without implemented support for the time filter are skipped even when preferred."),
      },
    },
    async ({ query, numResults, engine, timeRange, startDate, endDate }, extra) => {
      const r = await withRouterDiagnostics(deps.router.search({ query, numResults, timeRange, startDate, endDate }, { preferEngine: engine, signal: deps.requestSignal ? AbortSignal.any([extra.signal, deps.requestSignal]) : extra.signal }));
      const lines = r.items.map((it, i) => {
        const snip = it.snippet ? `\n   ${it.snippet.replace(/\s+/g, " ").slice(0, 400)}` : "";
        return `${i + 1}. ${it.title}\n   ${it.url}${it.published ? `\n   Published: ${it.published}` : ""}${snip}`;
      });
      const failover = r.attempts.filter((a) => !a.ok).map((a) => `${a.engine}: ${a.error}`);
      const head = [`Search "${query}" via ${r.engine} (${r.items.length} results)`];
      const period = describeSearchTime({ query, timeRange, startDate, endDate });
      if (period) head.push(`Time filter: ${period} (provider date semantics apply)`);
      if (r.answer) head.push(`Answer: ${r.answer}`);
      if (failover.length) head.push(`Failover after: ${failover.join("; ")}`);
      return { content: [{ type: "text", text: [...head, lines.join("\n")].join("\n\n") }] };
    },
  );

  server.registerTool(
    "fetch_url",
    {
      title: "Fetch URL",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Fetch one web page and return its main content as Markdown, rotating across extraction providers (Jina Reader, Firecrawl, Parallel, Tavily, Exa) with failover. Use it to read a URL the user or a previous search_web result already names; it does not discover links or crawl a site. Only http and https URLs are accepted. The result names the provider that succeeded, lists failed attempts and truncates content beyond 50,000 characters with a marker; if every provider fails, the tool returns an error listing each provider's reason.",
      inputSchema: {
        url: z.string().url().describe("Absolute http(s) URL of the page to fetch, including scheme and host"),
      },
    },
    async ({ url }, extra) => {
      const r = await withRouterDiagnostics(deps.router.fetchUrl({ url }, { signal: deps.requestSignal ? AbortSignal.any([extra.signal, deps.requestSignal]) : extra.signal }));
      const MAX = 50_000;
      const text =
        r.markdown.length > MAX
          ? `${r.markdown.slice(0, MAX)}\n\n[… truncated, ${r.markdown.length} chars total]`
          : r.markdown;
      const failover = r.attempts.filter((a) => !a.ok).map((a) => `${a.engine}: ${a.error}`);
      const head =
        `Fetched ${url} via ${r.engine}` + (failover.length ? ` (failover after: ${failover.join("; ")})` : "");
      return { content: [{ type: "text", text: `${head}\n\n${text}` }] };
    },
  );

  server.registerTool(
    "get_engine_status",
    {
      title: "Engine Status",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Read this server's local engine configuration: enabled state, configured rotation order, per-capability access (keyless, configured key, or key/extra credentials still required), local usage counters and the quota source per engine. Use it before update_engine_config for valid engine ids, and as the machine-readable answer when you need to know which providers are active, how much quota is left or why a provider is skipped — the dashboard is the human-facing view of the same installation. The tool performs no search and no fetch: it is not a live health check, stored errors are historical observations, and a disabled engine is a configuration state, not proof that a key is missing. Provider balances can come from a cached lookup that the dashboard refreshes; unknown provider limits are reported as null rather than zero or unlimited.",
      inputSchema: {},
    },
    async () => {
      const status = engineStatus(await deps.status(), deps.month(), VERSION);
      return {
        structuredContent: status,
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    },
  );

  server.registerTool(
    "open_dashboard",
    {
      title: "Open Dashboard",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Open the local dashboard of this server in a browser on the machine running the server, for a human: it is the only place to enter API keys and provider credentials, strict-free mode, port and access token, and it shows the interactive usage, quota and request-history views. Use it for those credential and network settings and when a person should look at the data; read configuration with get_engine_status and change engines with update_engine_config instead, because their results are machine-readable and this call only launches a browser. The browser opens on the server host, not on the client's machine, and a server started with --no-dashboard returns an error.",
      inputSchema: {},
    },
    async () => {
      const url = deps.dashboardUrl();
      if (!url) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Dashboard ist deaktiviert (gestartet mit --no-dashboard). Ohne Dashboard-Flag neu starten, um Keys/Reihenfolge/Kontingente zu konfigurieren.",
            },
          ],
        };
      }
      deps.openDashboard();
      return { content: [{ type: "text", text: `Dashboard: ${url}` }] };
    },
  );

  server.registerTool(
    "update_engine_config",
    {
      title: "Update Engine Config",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Change the local engine configuration: enable or disable engines, set the search and fetch rotation order, and set monthly or daily call limits per engine. Use it when the user wants a provider switched on or off, reordered or capped; call get_engine_status first for valid ids, current order and access modes. The tool writes the shared configuration file of this installation, so the change applies to later searches of every client without a restart. API keys are not accepted here: an engine that still needs a key or extra credentials cannot be enabled until they are set in the dashboard (open_dashboard). Returns the effective per-engine configuration, or an error naming the offending ids — on error nothing is written.",
      inputSchema: {
        enabled: z.record(z.string(), z.boolean()).optional().describe("Per engine id (see get_engine_status): true enables, false disables. Enabling an engine whose access mode is api_key_required or extra_configuration_required fails until the credential exists in the dashboard."),
        searchOrder: z.array(z.string()).optional().describe("Complete search rotation: every search-capable engine id exactly once, the first entry is queried first. Fetch-only engines are not part of this order and keep their place behind it."),
        fetchOrder: z.array(z.string()).optional().describe("Complete fetch rotation: every fetch-capable engine id exactly once, the first entry is tried first."),
        monthlyLimits: z.record(z.string(), z.number().int().min(0).nullable()).optional().describe("Per engine id: cap for locally counted calls per month, or null to remove the override and fall back to the provider default. The cap drives rotation and strict-free ordering; it does not change the provider account."),
        dailyLimits: z.record(z.string(), z.number().int().min(0).nullable()).optional().describe("Per engine id: cap for locally counted calls per day, or null to remove the override. Applies to providers whose quota period is counted per day."),
      },
    },
    async ({ enabled, searchOrder, fetchOrder, monthlyLimits, dailyLimits }) => {
      const rows = await deps.status();
      const applied = applyEngineConfigPatch(deps.getConfig(), rows, {
        enabled,
        searchOrder,
        fetchOrder,
        monthlyLimits,
        dailyLimits,
      });
      if (!applied.ok) {
        return { isError: true, content: [{ type: "text", text: applied.error }] };
      }
      if (applied.changed.length) deps.saveConfig(applied.config);
      const engines = engineRotationSummary(rows, deps.getConfig());
      const head = applied.changed.length
        ? "Local engine configuration updated (applies to later searches, no restart needed):"
        : "No change: the requested values already match the local configuration.";
      const lines = engines.map(engine => {
        const parts = [engine.enabled ? "enabled" : "disabled"];
        for (const capability of ["search", "fetch"] as const) {
          const state = engine[capability];
          if (state.mode === "unsupported") continue;
          parts.push(`${capability} ${state.configuredOrder === null ? "not in rotation" : `#${state.configuredOrder}`} (${state.mode})`);
        }
        if (engine.monthlyLimitOverride !== null) parts.push(`monthly limit ${engine.monthlyLimitOverride}`);
        if (engine.dailyLimitOverride !== null) parts.push(`daily limit ${engine.dailyLimitOverride}`);
        return `- ${engine.id}: ${parts.join(", ")}`;
      });
      const text = [
        head,
        ...applied.changed.map(change => `- ${change}`),
        "",
        "Effective configuration:",
        ...lines,
      ].join("\n");
      return {
        structuredContent: { ok: true, changed: applied.changed, engines },
        content: [{ type: "text", text }],
      };
    },
  );

  return server;
}
