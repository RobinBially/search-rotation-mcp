# Betrieb und Konfiguration

[Zurück zur README](../README.md)

## Wie die Rotation arbeitet

1. Suche und Fetch haben unabhängige Round-Robin-Zähler. Die Reihenfolge kommt aus dem Dashboard.
2. Die Priorität bleibt über alle Aufrufe erhalten: **gesund → höchstens 10 % übrig → erschöpft**. Rotiert wird jeweils innerhalb einer Klasse.
3. Fehler führen zur nächsten Engine und erscheinen als `Failover after: …`. HTTP 429 pausiert eine Engine gemäß `Retry-After` (Sekunden oder HTTP-Datum; ohne Header 30 s). 401/403 pausieren 60 s; ab zwei sonstigen Fehlern steigt die Pause von 30 s bis maximal 5 min. Ein Keywechsel hebt die bisherige Pause auf.
4. Ein Gesamtzeitlimit von standardmäßig **60 s** umfasst Quota-Abfragen und alle Failover-Versuche. MCP-Abbruch bzw. HTTP-Verbindungsabbruch wird an die Anbieter weitergereicht. Nach Abbruch startet kein weiterer Versuch.
5. `engine` bevorzugt eine Engine, umgeht aber weder Cooldown noch den strikten Gratis-Modus.
6. **Strikter Gratis-Modus** (optional, Dashboard → Engines): Bereits ausgeschöpfte bekannte Kontingente werden vollständig ausgeschlossen; auch ein einzelner oder bevorzugter Anbieter wird dann nicht mehr aufgerufen. Unbekannte IP-Kontingente bleiben verwendbar. Laufende Aufrufe reservieren ihre Einheiten innerhalb eines Routers. Die Diagnose-Buttons testen nur die gewählte Engine (auch wenn deaktiviert), unterliegen aber denselben Zeit-, Cooldown- und Kontingentregeln.

Die Cooldowns und Rotationspositionen gelten pro Serverprozess und werden beim Neustart zurückgesetzt. Im stateless HTTP-Modus beendet ein geschlossener Request die zugehörige Operation; eine separate `notifications/cancelled`-Nachricht besitzt keine langlebige Session-Zuordnung. Bei stdio wird die MCP-Cancellation direkt verarbeitet.

### Kontingente und Speicherung

Dashboard und `get_engine_status` zeigen **Zeitraum, Einheit, Quelle und Schätzstatus**. Google zählt pro Tag in `America/Los_Angeles` einschließlich Sommerzeit; Monatszähler verwenden UTC. Keyless Firecrawl/Exa sowie Jina und DuckDuckGo werden als unbekanntes IP-Kontingent angezeigt, nicht als kostenloses Monatsguthaben.

Tavily/Firecrawl verwenden, soweit vorhanden, den Remote-Kontostand mit fünf Minuten Cache. Eigene erfolgreiche Aufrufe reduzieren den gecachten Rest sofort. Die lokalen Credit-Schätzungen sind derzeit Tavily Search 1 / Fetch 0,2 sowie Firecrawl Search 2 je angefangene 10 angefragte Treffer / Fetch 1. Die Aufrufzahl wird davon unabhängig gespeichert. Andere Engines zählen lokal Requests; ein aus Geldguthaben abgeleitetes Exa-Limit bleibt eine Schätzung.

Der Gratis-Modus ist **keine Ausgabengarantie**: andere Anwendungen können dasselbe Konto belasten, Anbieter können Kosten ändern oder bereits gestartete/abgebrochene Requests abrechnen. Externe Nutzung und parallele Serverprozesse können einen Remote-Cache überholen. Für eine verbindliche Kostenobergrenze zusätzlich das Ausgabenlimit beim Anbieter setzen.

`usage.json` und `history.json` bleiben im bisherigen Verzeichnis. Prozessübergreifende Sperren serialisieren vollständige Schreibtransaktionen; atomarer Rename mit individuellen temporären Dateien verhindert halbe Snapshots. Leser sehen Änderungen anderer Prozesse. Monatsdaten bleiben kompatibel, Tagesdaten werden für 62 Tage gehalten. Nachweislich tote Lock-Owner werden automatisch bereinigt; langsame lebende Prozesse werden nicht verdrängt. Bei einer blockierten Sperre schlägt das Schreiben nach 10 s mit einer Diagnose fehl. Ein seltener PID-Reuse-Fall nach einem Crash kann die automatische Bereinigung verzögern. Bereits laufende ältere Versionen vor dem Update beenden, da diese die neuen Sperren nicht verwenden.

## Remote-Betrieb (Streamable HTTP)

```bash
npx -y search-rotation --http --host 0.0.0.0 --port 6277 --public-origin https://search.example.com --token <geheim>
```

Client-Config (Claude):

```json
{
  "mcpServers": {
    "search-rotation": {
      "url": "https://search.example.com/mcp",
      "headers": { "Authorization": "Bearer <geheim>" }
    }
  }
}
```

Für dieses Beispiel leitet ein HTTPS-Reverse-Proxy `search.example.com` an Port 6277 weiter. Ein Bind außerhalb von Loopback benötigt einen Token. `--public-origin` legt die erlaubte externe Origin und den Host für Browser und MCP fest; fremde Hosts/Origins werden abgewiesen. Ohne Proxy kann eine passende `http://HOST:6277`-Origin verwendet werden.

`/mcp` bleibt Bearer-authentifiziert. Im Browser führt die Dashboard-URL zu **`/login`**: Token einmal im Passwortformular eingeben, anschließend gilt ein acht Stunden gültiges `HttpOnly`-/`SameSite=Strict`-Session-Cookie (bei HTTPS zusätzlich `Secure`). Geheimnisfreie Skripte und Styles sind öffentlich, die Dashboard-API ist geschützt. API-Schreibzugriffe benötigen JSON und eine erlaubte Origin, sofern der Client eine sendet.

Langlebige Tokens erscheinen weder in Logs noch in Tool-Ergebnissen oder URLs. `open_dashboard` öffnet intern einen 60 s gültigen Einmallink; der zurückgegebene Text enthält nur die Basis-URL. Die frühere `?token=…`-Anmeldung entfällt. `--no-dashboard` schaltet Dashboard, Login und Admin-API vollständig ab; `get_engine_status` und `update_engine_config` arbeiten weiterhin auf der lokalen Konfigurationsdatei.

Ohne Keys verwenden Firecrawl/Exa die Server-Egress-IP; verfügbare IP-Kontingente hängen deshalb vom Hosting ab.

## Konfiguration

Datei: `~/.config/search-rotation/config.json` (0600, wird vom Dashboard gepflegt). Override: `SEARCH_ROTATION_HOME`. Reihenfolge = Array-Reihenfolge (`engines` = Suche, `fetchOrder` = Fetch). Token zusätzlich via `--token` oder `SEARCH_ROTATION_TOKEN`.

Zusätzliche `settings`-Felder (alte Configs erhalten Defaults):

| Feld | Default | Verhalten |
|---|---|---|
| `strictFreeMode` | `false` | Bekannte ausgeschöpfte Kontingente vollständig überspringen |
| `requestTimeoutMs` | `60000` | Gesamtbudget je Suche/Fetch, konfigurierbar von 1000 bis 300000 ms |
| `monthlyLimits` | `{}` | Lokales Monatslimit pro Engine, in deren angezeigter Einheit |
| `dailyLimits` | `{}` | Lokales Tageslimit pro Engine mit Tagesfenster, z. B. `{"google-cse": 100}` |

Ein Limit `0` bedeutet weiterhin „kein festes lokales Limit“; zum Abschalten den Engine-Toggle verwenden. Ein gültiger Remote-Kontostand hat Vorrang vor lokalen Limits. Änderungen an Token oder Port benötigen einen **Neustart**; die Config-API kennzeichnet sie mit `requiresRestart: true`. Gratis-Modus und Zeitlimit wirken sofort.
