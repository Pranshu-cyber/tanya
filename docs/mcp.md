# MCP integration

Tanya uses the official TypeScript MCP SDK pinned at
`@modelcontextprotocol/sdk@1.29.0`.

MCP support is bidirectional:

- Tanya as an MCP client consumes external servers and exposes their tools to the
  model as `mcp:<server>:<tool>`.
- Tanya as an MCP server exposes verifier, golden-task, run, and skill-pack
  primitives to IDEs and other MCP clients.

MCP servers are untrusted code. Tanya only loads servers declared in config,
routes every MCP tool call through the permission engine, audits decisions with
`source: "mcp:<server>"`, and rejects schema-invalid responses before they reach
model history.

## Client config

User-global config is read from `~/.tanya/mcp.json`, with a migration fallback
to `~/.tanya/mcp.json`. Project config is read from `.tanya/mcp.json`.
Project servers prepend user servers; if both define the same `name`, the
project server wins entirely.

```json
{
  "version": 1,
  "servers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": {},
      "enabled": true
    }
  ]
}
```

Schema:

```ts
type McpConfig = {
  version: 1;
  servers: Array<{
    name: string;
    transport: "stdio" | "sse" | "http";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    enabled?: boolean;
  }>;
};
```

`stdio` servers require `command`. `sse` and `http` servers require `url`.
Server names may contain letters, numbers, `.`, `_`, and `-`.

## Client behavior

Connected MCP tools are ordinary Tanya tools:

```text
mcp:filesystem:read_file
mcp:github:list_issues
mcp:linear:create_issue
```

That means they use the same runner path as native tools:

- permission decision before execution
- audit log entry in `.tanya/audit.jsonl`
- model-visible tool result truncation when needed
- full verifier-visible result when available
- JSONL and human event sinks

Use `/mcp` in interactive chat to list configured servers, connection status,
restart count, and exposed tools.

## Permission rules

MCP namespace rules use the `mcp:` prefix. The regex after `mcp:` matches the
server/tool namespace and then the stable JSON input shape.

Examples:

```json
{
  "version": 1,
  "mode": "default",
  "alwaysDeny": ["mcp:github:.*"],
  "alwaysAsk": ["mcp:linear:create_.*"]
}
```

`mcp:github:.*` denies every configured GitHub MCP tool. A model-invented MCP
tool that was not loaded from `mcp.json` is rejected as not allowlisted.

## Transports

`stdio` servers are spawned as child processes. Tanya captures their stderr to:

```text
.tanya/mcp/logs/<server>.log
```

Logs rotate at 10 MB. If a server exits, Tanya restarts it with exponential
backoff up to three attempts, then marks it failed. Tool lists are refreshed on
restart, so server version changes can add or remove tools.

`sse` and `http` transports use the SDK transports. Tanya pings connected
servers every 30 seconds. Individual MCP calls time out after 30 seconds by
default. Override with:

```bash
TANYA_MCP_CALL_TIMEOUT_MS=10000
```

The legacy `TANYA_MCP_CALL_TIMEOUT_MS` alias is also accepted.

## Tanya as an MCP server

Start the stdio server:

```bash
tanya mcp serve
```

Exposed tools:

| Tool | Input | Output |
|------|-------|--------|
| `tanya.verify` | `{ path?: string }` | `{ verdict, blockers, manifest }` plus the verifier report text |
| `tanya.golden_task_search` | `{ query: string, limit?: number }` | matching golden-task records |
| `tanya.run` | `{ prompt: string, cwd?: string, max_turns?: number }` | one-shot run result, manifest, metrics, and subtask events |
| `tanya.skills_list` | `{ cwd?: string }` | loaded skill packs with source paths and token estimates |

`tanya.verify` is the strategic surface: other MCP-speaking agents can call
Tanya as a deterministic verification authority.

## Recursion guard

If Tanya-as-client calls Tanya-as-server recursively with MCP depth greater
than one, `tanya.run` refuses the inner call with a structured error. This
prevents accidental loops between agents that both load Tanya's MCP server.

## Schema validation

Tanya validates MCP tool results against the server's declared `outputSchema`
before passing the result to the model. A bad response becomes:

```json
{
  "ok": false,
  "error": "mcp schema violation: ..."
}
```

The malformed content is not propagated into the next model turn.
