# Milestone 2.2 Native SQLite Runtime

## Summary

Replace the `packages/corpus-query` `sql.js` WASM/in-memory database runtime with a native SQLite runtime based on Node's built-in `node:sqlite`.

## Motivation

The current `sql.js` adapter loads the entire corpus database into WASM memory and fails once the database grows past roughly 2 GiB. That prevents larger replay corpora from being queried through `bw-forge ingest`, `bw-forge mcp`, and the MCP analytics surface.

## Scope

- Replace `sql.js` file loading/export with direct native SQLite file access.
- Preserve the existing query, ingest, CLI, and MCP tool behavior.
- Preserve the current schema and replay analytics semantics.
- Keep the migration low-risk by providing a compatibility wrapper over `node:sqlite`.

## Notes

- `node:sqlite` is available in the current Node 24 runtime used by the monorepo.
- Native SQLite writes through per committed transaction, so the old end-of-run "export database" step becomes unnecessary.
