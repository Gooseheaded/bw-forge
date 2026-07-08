# Milestone 2.3 Implicit MCP DB Path

## Summary

Make read-only `bw-forge mcp` tools resolve the configured corpus database implicitly instead of requiring `db_path` to be passed on every tool call.

## Motivation

The MCP server is already started with a specific corpus database path. Requiring the model or client to repeat the same `db_path` argument on every read-only call adds noise, wastes context, and creates unnecessary failure modes.

## Scope

- Keep `ingest_corpus` explicitly targeted by `db_path`.
- Allow read-only query, discovery, analytics, and query-plan tools to omit `db_path`.
- Resolve omitted database paths through the existing server-side lookup order.

## Notes

- Resolution order remains: explicit `db_path`, then `BW_REPLAY_DB_PATH`, then `./corpus.sqlite`.
