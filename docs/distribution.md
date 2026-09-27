# Distribution and listings

Where search-rotation is published or listed, who keeps each channel current, and
what still needs attention. Snapshot: 2026-09-27, after the 0.5.0 release that renamed
the MCP tools to `search_web`, `fetch_url`, `get_engine_status`, `update_engine_config`
and `open_dashboard`.

## Channels

| Channel | Entry | Kept current by | State |
| --- | --- | --- | --- |
| npm | `search-rotation` | release workflow, trusted publishing | 0.5.0 |
| Homebrew | `brew install robin-bially/tap/search-rotation` | release script writes the formula | 0.5.0 |
| Official MCP Registry | `io.github.robin-bially/search-rotation` | release workflow, GitHub OIDC | 0.5.0; the old `io.github.localfoundry/search-rotation` stays frozen at 0.4.10 because the registry has no unpublish |
| GitHub releases | tag, tarball and checksum | release script | v0.5.0 |
| Glama | [directory entry](https://glama.ai/mcp/servers/robin-bially/search-rotation-mcp), rated A | Glama indexes the repository on its own | listed under the current account name; Glama picked up the rename by itself, the previous `RobinBially` path still resolves |
| mcpservers.org | [submission](https://mcpservers.org/de/submit) from 2026-09-26 | reviewed by the site | in review, up to two weeks |
| PulseMCP | — | ingests the official registry | submissions paused, not listed yet |

Channels that build on the official registry follow a release by themselves, so a
release needs no manual work for them.

## What a release updates

`VERSION=x.y.z ./scripts/release.sh --publish` runs the checks, bumps the version,
commits and tags, creates the GitHub release, packs the tarball with its checksum,
writes the formula in `robin-bially/homebrew-tap`, and waits until npm serves the
new version. The published release triggers
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml), which pushes
the package to npm with provenance and then registers the same version in the
official MCP Registry from `server.json` and the `mcpName` field of
`package.json`.

Four details are easy to forget:

- `server.json` and `mcpName` must name the same server; `test/registry-manifest.test.ts` fails when they drift apart.
- The registry limits `description` to 100 characters.
- The registry verifies ownership through the published npm package, so a manifest can only be registered once that version exists on npm. The workflow skips an already published version, which makes a re-run safe.
- That ownership check also races npm propagation: with 0.5.0 the registry answered `version '0.5.0' was not found (status: 404)` seconds after the publish, and `gh run rerun <id> --failed` registered the version on the second attempt without republishing (the publish step sees the existing version and skips).
- The Homebrew formula carries a `test do` block that asserts the tool names from `tools/list`; it has to follow a rename like the one in 0.5.0, and `brew audit` does not catch a stale list.
- npm trusted publishing is bound to one repository, so an account rename has to be re-pointed by hand: `npm trust github search-rotation --file publish.yml --repo robin-bially/search-rotation-mcp --allow-publish` (one-time password in the browser). That was missed for 0.4.11, whose publish failed with `404 Not Found - PUT https://registry.npmjs.org/search-rotation`; the stale entry for `localfoundry/search-rotation-mcp` was revoked on 2026-09-26, because the freed owner name would otherwise let a stranger publish to this package.

## Recurring checks

- After a release: `npm view search-rotation version` and the [registry entry](https://registry.modelcontextprotocol.io/?q=io.github.robin-bially%2Fsearch-rotation) should both show the new version. The release script already waits for npm. A failed publish workflow leaves the release and the tap ahead of npm, which happened with 0.4.11; `gh workflow run publish.yml` then repairs npm and the registry in one run.
- Dependency and tap maintenance runs outside this repository on a biweekly schedule.
- The GitHub account moved from `localfoundry` to `robin-bially` on 2026-09-26. The registry has no unpublish, so the entry `io.github.localfoundry/search-rotation` stays frozen at 0.4.10 while the next release adds `io.github.robin-bially/search-rotation`. The old handle is free again, so anything still pointing there can end up at a different account.
- Open externally: mcpservers.org reviews the submission and PulseMCP is paused. Glama has re-crawled the repository after the rename.

## Deliberately not used

Directories that require a new account before a submission (Glama's own form,
mcp.so) are skipped. The Glama listing exists because Glama indexes public GitHub
repositories without a submission; it picked up the repository rename by itself.

Curated awesome lists are skipped too. The three merge requests opened on
2026-09-26 (punkpeye/awesome-mcp-servers#15171, YuzeHao2023/Awesome-MCP-Servers#550,
ever-works/awesome-mcp-servers#188) were closed on 2026-09-27 without waiting for a
reviewer: the official MCP Registry and Glama already carry the server, and neither
list adds discovery that the registry does not. PulseMCP and Glama derive their
entries from the registry and the public repository, so no manual list work is
needed to stay visible.
