# Codex Local llama.cpp Compatibility

When Codex is connected to a local `llama.cpp` provider, the model may see MCP resource functions like `read_mcp_resource(server, uri)` even when the server also exposes callable MCP tools.

`bw_replay` now includes a read-only resource compatibility layer so local Codex can still query a replay corpus through MCP resources.

## Why This Exists

- `/mcp` can show the full `bw_replay` tool surface.
- Some local-model integrations only expose MCP resource discovery and reads to the model.
- In that mode, the model cannot call `bw_replay.server_info` directly as a tool.
- It can still read resources from the same server.

## Resource Usage

Exact resource:

```text
Use MCP resource `bw_replay://server_info` from server `bw_replay`.
```

Replay lookup:

```text
Read MCP resource `bw_replay://find_replays?player=Gooseheaded` from server `bw_replay`.
```

If the server cannot infer a default corpus, add `db_path`:

```text
Read MCP resource `bw_replay://find_replays?db_path=./corpus.sqlite&player=Gooseheaded` from server `bw_replay`.
```

The compatibility layer also supports:

- `bw_replay://build_events?...`
- `bw_replay://deaths?...`
- `bw_replay://economy?...`
- `bw_replay://unit_count?...`
- `bw_replay://first_event?...`
- `bw_replay://nth_event?...`

## Default Corpus Resolution

For resource reads, `bw_replay` resolves the corpus in this order:

1. `db_path` query parameter
2. `BW_REPLAY_DB_PATH` environment variable
3. `./corpus.sqlite` in the server working directory

If none of those are available, the resource read returns a clear MCP invalid-params error instead of crashing.
