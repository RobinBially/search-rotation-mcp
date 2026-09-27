import type { StatusRow } from "../status.js";

export type AccessMode =
  | "unsupported"
  | "api_key_required"
  | "extra_configuration_required"
  | "configured_key"
  | "keyless";

/** Zusatzfelder (z. B. Google `cx`), die konfiguriert sein müssen, aber leer sind. */
export function missingExtraConfiguration(row: StatusRow): string[] {
  return (row.extraFields ?? []).filter(field => !row.extrasSet?.[field.key]).map(field => field.key);
}

/**
 * Zugriffsmodus einer Engine für eine Fähigkeit — gemeinsame Wahrheit für
 * `engine_status` und die Engine-Konfiguration, damit beide nie auseinanderlaufen.
 */
export function capabilityAccess(row: StatusRow, capability: "search" | "fetch"): AccessMode {
  const supported = row.supportedCapabilities ?? row.capabilities ?? [];
  if (!supported.includes(capability)) return "unsupported";
  const keyless = row.keylessCapabilities ?? (row.keyless === "ip" ? row.capabilities ?? [] : []);
  if (!row.hasKey && !keyless.includes(capability)) return "api_key_required";
  if (missingExtraConfiguration(row).length) return "extra_configuration_required";
  return row.hasKey ? "configured_key" : "keyless";
}

/** Rotationsplatz einer Fähigkeit; -1 bedeutet: nicht in der konfigurierten Reihenfolge. */
export function capabilityRotation(mode: AccessMode, enabled: boolean, position: number) {
  return {
    mode,
    includedInRotation: enabled && (mode === "keyless" || mode === "configured_key") && position >= 0,
    configuredOrder: position >= 0 ? position + 1 : null,
  };
}

/** Model-facing facts. Configuration and stored diagnostics are not live health checks. */
export function engineStatus(rows: StatusRow[], month: string, version: string) {
  return {
    version,
    localUsageMonth: month,
    interpretation: [
      "enabled is a configuration toggle, not a health check. Disabled does not mean an API key is missing; the original reason for disabling is not recorded.",
      "Access is capability-specific. keyless search does not imply keyless fetch. Recommend a key only for a capability marked api_key_required, or when the user explicitly wants authenticated access.",
      "Historical errors are stored observations, not evidence of a current failure or the current authentication requirements. No live search or fetch is performed by this tool.",
      "includedInRotation describes configuration eligibility only. Runtime cooldowns, quota checks and failover may skip an engine.",
      "Local usage counts successful calls from this installation, separately from errors. Unknown provider limits and total usage are null, not zero or unlimited. Provider account balances must not be described as monthly consumption.",
    ],
    engines: rows.map(row => {
      const missing = missingExtraConfiguration(row);
      const access = Object.fromEntries((["search", "fetch"] as const).map(capability => {
        const position = capability === "search" ? row.searchPosition : row.fetchPosition;
        return [capability, capabilityRotation(capabilityAccess(row, capability), row.enabled, position)];
      }));
      const q = row.quota;
      const anonymous = !row.hasKey;
      const remote = !anonymous && q?.source === "remote";
      return {
        id: row.id,
        name: row.label,
        enabled: row.enabled,
        disabledReason: row.enabled ? null : "disabled_in_configuration; original reason not recorded",
        apiKeyConfigured: row.hasKey,
        missingExtraConfiguration: missing,
        access,
        localUsage: { successfulSearches: row.used.search, successfulFetches: row.used.fetch, failedAttempts: row.used.errors ?? 0 },
        quota: {
          scope: anonymous ? "provider_limit_unknown" : remote ? "provider_account_balance" : "local_allowance",
          period: anonymous || remote ? null : q?.period ?? null,
          unit: anonymous ? "requests" : q?.unit ?? "requests",
          limit: anonymous ? null : q?.limit ?? null,
          used: anonymous ? null : q?.used ?? null,
          providerTotalUsed: remote ? q.used : null,
          source: anonymous ? "unknown" : q?.source ?? "unknown",
          estimated: anonymous ? false : q?.estimated ?? true,
          timeZone: q?.timeZone ?? null,
        },
        diagnostics: {
          currentHealth: "not_tested",
          lastRecordedError: row.lastError ?? null,
          lastSuccessfulCallAt: row.used.lastUsed ?? null,
          quotaLookupError: row.remoteError ?? null,
        },
      };
    }),
  };
}
