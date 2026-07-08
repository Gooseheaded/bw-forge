1. Add a native SQLite compatibility adapter in `packages/corpus-query/src/db/sqlite.ts` backed by `node:sqlite`.
2. Redirect `Database` and `Statement` type imports from `sql.js` to the local adapter.
3. Preserve the existing `run`, `prepare`, `bind`, `step`, `getAsObject`, `reset`, and `free` call patterns so query logic does not need a broad rewrite.
4. Keep ingest, MCP, and query-plan flows behaviorally compatible with the previous runtime.
5. Ensure the adapter does not emit noisy experimental SQLite warnings during normal CLI or MCP usage.
6. Run the full corpus-query test suite against the new backend.
7. Verify that the native runtime can open and query a corpus database larger than 2 GiB.
