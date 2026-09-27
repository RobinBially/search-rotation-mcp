import type { EngineConfig, PolyConfig } from "../config.js";
import type { StatusRow } from "../status.js";
import {
  capabilityAccess,
  capabilityRotation,
  missingExtraConfiguration,
} from "./engine-status.js";

/** Teiländerung der lokalen Engine-Konfiguration. Fehlende Felder bleiben unverändert. */
export interface EngineConfigPatch {
  enabled?: Record<string, boolean>;
  searchOrder?: string[];
  fetchOrder?: string[];
  monthlyLimits?: Record<string, number | null>;
  dailyLimits?: Record<string, number | null>;
}

export type EngineConfigPatchResult =
  | { ok: true; config: PolyConfig; changed: string[] }
  | { ok: false; error: string };

const CAPABILITIES = ["search", "fetch"] as const;

function capableIds(rows: StatusRow[], capability: "search" | "fetch"): string[] {
  return rows.filter(row => capabilityAccess(row, capability) !== "unsupported").map(row => row.id);
}

function checkOrder(
  field: "searchOrder" | "fetchOrder",
  value: unknown,
  capable: string[],
): { error: string } | { order: string[] } {
  if (!Array.isArray(value) || value.some(id => typeof id !== "string")) {
    return { error: `${field} must be an array of engine ids` };
  }
  const order = value as string[];
  const unknown = order.filter(id => !capable.includes(id));
  if (unknown.length) {
    return { error: `${field}: unknown or unsupported engine ids: ${[...new Set(unknown)].join(", ")}. Supported ids: ${capable.join(", ")}` };
  }
  if (new Set(order).size !== order.length) {
    return { error: `${field} contains duplicate engine ids` };
  }
  const missing = capable.filter(id => !order.includes(id));
  if (missing.length) {
    return { error: `${field} must list every capable engine exactly once; missing: ${missing.join(", ")}` };
  }
  return { order };
}

function checkLimits(
  field: "monthlyLimits" | "dailyLimits",
  value: unknown,
  known: string[],
): { error: string } | { limits: Record<string, number | null> } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: `${field} must be an object mapping engine ids to integers or null` };
  }
  const limits: Record<string, number | null> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!known.includes(id)) {
      return { error: `${field}: unknown engine id "${id}". Known ids: ${known.join(", ")}` };
    }
    if (raw === null) {
      limits[id] = null;
      continue;
    }
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      return { error: `${field}.${id} must be a non-negative integer or null (null removes the override), got ${JSON.stringify(raw)}` };
    }
    limits[id] = raw;
  }
  return { limits };
}

/**
 * Wendet eine Teiländerung auf eine Kopie der Konfiguration an. Bei Fehlern wird
 * nichts zurückgegeben, was geschrieben werden dürfte: die Prüfungen laufen
 * vollständig, bevor der Aufrufer speichert.
 */
export function applyEngineConfigPatch(
  cfg: PolyConfig,
  rows: StatusRow[],
  patch: EngineConfigPatch,
): EngineConfigPatchResult {
  const known = rows.map(row => row.id);
  const byId = new Map(rows.map(row => [row.id, row] as const));
  const searchCapable = capableIds(rows, "search");
  const fetchCapable = capableIds(rows, "fetch");

  const enabledEntries = Object.entries(patch.enabled ?? {});
  const empty =
    enabledEntries.length === 0 &&
    patch.searchOrder === undefined &&
    patch.fetchOrder === undefined &&
    Object.keys(patch.monthlyLimits ?? {}).length === 0 &&
    Object.keys(patch.dailyLimits ?? {}).length === 0;
  if (empty) {
    return {
      ok: false,
      error:
        "Nothing to change: pass at least one of enabled, searchOrder, fetchOrder, monthlyLimits or dailyLimits.",
    };
  }

  let engines: EngineConfig[] = cfg.engines.map(engine => ({
    ...engine,
    extra: engine.extra ? { ...engine.extra } : undefined,
  }));
  const limits: Record<"monthlyLimits" | "dailyLimits", Record<string, number>> = {
    monthlyLimits: { ...cfg.settings.monthlyLimits },
    dailyLimits: { ...(cfg.settings.dailyLimits ?? {}) },
  };
  const changed: string[] = [];

  for (const [id, enabled] of enabledEntries) {
    const row = byId.get(id);
    if (!row) {
      return { ok: false, error: `enabled: unknown engine id "${id}". Known ids: ${known.join(", ")}` };
    }
    const engine = engines.find(candidate => candidate.id === id);
    if (!engine) {
      return { ok: false, error: `enabled: unknown engine id "${id}". Known ids: ${known.join(", ")}` };
    }
    // Nur ein tatsächlicher Wechsel auf "enabled" braucht Credentials; ein
    // wiederholtes enabled=true auf einer laufenden Engine bleibt idempotent.
    if (enabled && !engine.enabled) {
      const modes = CAPABILITIES.map(capability => capabilityAccess(row, capability));
      if (modes.every(mode => mode === "unsupported" || mode === "api_key_required" || mode === "extra_configuration_required")) {
        const fields = missingExtraConfiguration(row);
        const reason = modes.includes("extra_configuration_required")
          ? `required extra configuration is missing (${fields.join(", ")})`
          : "no API key is configured and this engine does not work keyless";
        return {
          ok: false,
          error: `cannot enable "${id}": ${reason}. Set it in the dashboard (open_dashboard) first; nothing was changed.`,
        };
      }
    }
    if (engine.enabled !== enabled) {
      changed.push(`${id}: enabled ${engine.enabled} -> ${enabled}`);
      engine.enabled = enabled;
    }
  }

  if (patch.searchOrder !== undefined) {
    const checked = checkOrder("searchOrder", patch.searchOrder, searchCapable);
    if ("error" in checked) return { ok: false, error: checked.error };
    const searchSet = new Set(searchCapable);
    const byConfigId = new Map(engines.map(engine => [engine.id, engine] as const));
    // Such-Engines in der gewünschten Reihenfolge, alles andere (z. B. reine
    // Fetch-Engines wie Jina) unverändert dahinter — wie in normalizeConfig.
    const others = engines.filter(engine => !searchSet.has(engine.id)).map(engine => engine.id);
    const ordered = [...checked.order, ...others]
      .map(id => byConfigId.get(id))
      .filter((engine): engine is EngineConfig => Boolean(engine));
    const before = engines.map(engine => engine.id).join(", ");
    const after = ordered.map(engine => engine.id).join(", ");
    if (before !== after) changed.push(`search order: ${before} -> ${after}`);
    engines = ordered;
  }

  let fetchOrder = cfg.fetchOrder;
  if (patch.fetchOrder !== undefined) {
    const checked = checkOrder("fetchOrder", patch.fetchOrder, fetchCapable);
    if ("error" in checked) return { ok: false, error: checked.error };
    if (fetchOrder.join(", ") !== checked.order.join(", ")) {
      changed.push(`fetch order: ${fetchOrder.join(", ")} -> ${checked.order.join(", ")}`);
    }
    fetchOrder = checked.order;
  }

  for (const field of ["monthlyLimits", "dailyLimits"] as const) {
    const raw = patch[field];
    if (raw === undefined) continue;
    const checked = checkLimits(field, raw, known);
    if ("error" in checked) return { ok: false, error: checked.error };
    const label = field === "monthlyLimits" ? "monthly" : "daily";
    for (const [id, limit] of Object.entries(checked.limits)) {
      const current = limits[field][id] ?? null;
      if (limit === null) delete limits[field][id];
      else limits[field][id] = limit;
      if (current !== limit) {
        changed.push(`${id}: ${label} limit ${current ?? "provider default"} -> ${limit ?? "provider default"}`);
      }
    }
  }

  return {
    ok: true,
    changed,
    config: {
      version: 1,
      engines,
      fetchOrder,
      settings: { ...cfg.settings, monthlyLimits: limits.monthlyLimits, dailyLimits: limits.dailyLimits },
    },
  };
}

/** Kompakte, rosterweite Sicht auf die effektive Konfiguration für Tool-Antworten. */
export function engineRotationSummary(rows: StatusRow[], cfg: PolyConfig) {
  const searchPos = new Map(cfg.engines.map((engine, index) => [engine.id, index] as const));
  const fetchPos = new Map(cfg.fetchOrder.map((id, index) => [id, index] as const));
  return rows.map(row => {
    const engine = cfg.engines.find(candidate => candidate.id === row.id);
    const enabled = engine?.enabled ?? false;
    return {
      id: row.id,
      name: row.label,
      enabled,
      search: capabilityRotation(capabilityAccess(row, "search"), enabled, searchPos.get(row.id) ?? -1),
      fetch: capabilityRotation(capabilityAccess(row, "fetch"), enabled, fetchPos.get(row.id) ?? -1),
      monthlyLimitOverride: cfg.settings.monthlyLimits[row.id] ?? null,
      dailyLimitOverride: cfg.settings.dailyLimits?.[row.id] ?? null,
    };
  });
}
