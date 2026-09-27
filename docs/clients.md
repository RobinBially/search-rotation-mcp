# MCP client setup

[← Back to README](../README.md)

## Homebrew installation

```sh
brew install robin-bially/tap/search-rotation
```

Homebrew installs Node.js automatically. Set your MCP client's command to
`search-rotation` and leave its arguments empty. GUI clients may need the absolute
path printed by `echo "$(brew --prefix)/bin/search-rotation"`.

For example, a client using `mcpServers` accepts:

```json
{
  "mcpServers": {
    "search-rotation": {
      "command": "search-rotation",
      "args": []
    }
  }
}
```

The client-specific examples below are the GitHub/npx alternative. They require
Node.js 20.3+ and Git; no npm account is needed. The version tag keeps installations
reproducible.

## Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.search-rotation]
command = "npx"
args = ["-y", "search-rotation"]
```

## Claude Desktop and Cursor

Add to Claude Desktop's MCP configuration or Cursor's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "search-rotation": {
      "command": "npx",
      "args": ["-y", "search-rotation"]
    }
  }
}
```

## Claude Code

```sh
claude mcp add search-rotation -- npx -y search-rotation
```

## OpenCode V2

Add this entry under `mcp.servers`:

```json
"search-rotation": {
  "type": "local",
  "command": ["npx", "-y", "search-rotation"],
  "codemode": true
}
```

## Local install or release archive

If installed locally, use `search-rotation` as the command. A prebuilt archive is also available under [GitHub Releases](https://github.com/robin-bially/search-rotation-mcp/releases/latest):

```sh
npm install -g ./search-rotation-0.5.0.tgz
```

npx installs the package from the npm registry, so no Git access is required. The pinned
`github:robin-bially/search-rotation-mcp#vX` form from the README needs `--allow-git=all`
instead, because npm 12 resolves Git dependencies only when explicitly allowed.

For remote HTTP access, authentication and advanced settings, see the [operations guide (German)](operations.md).

## Multiple harnesses and updates

Each stdio client starts its own server process. Its dashboard binds to the configured port (6277 by default), or the next free port up to 20 ports higher. `open_dashboard` opens the dashboard belonging to that process; it does not attach to another harness's process. Configuration is shared, though: every process reads `~/.config/search-rotation/config.json`, so an `update_engine_config` call in one harness applies to the others as soon as they read the file for their next search.

Processes using the same `SEARCH_ROTATION_HOME` share configuration and counters. Engine settings reload before requests; port and authentication changes require a restart. Rotation cursors, cooldowns and in-flight reservations are per process, so strict-free mode is not a global spending lock across harnesses.

After updating the package, reconnect the MCP server in every harness. An existing process continues to run its old code and report its old version until restarted. For `MCP error -32000: Connection closed`, inspect the child process's stderr and verify Node.js, executable permissions and the configured command. A successful build alone does not update an already running process.
