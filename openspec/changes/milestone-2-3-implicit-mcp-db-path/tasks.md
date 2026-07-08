1. Make `db_path` optional for read-only MCP query tools.
2. Make `db_path` optional for read-only query-plan tools.
3. Reuse the existing server-side database resolution path instead of duplicating logic.
4. Keep `ingest_corpus` explicitly targeted by `db_path`.
5. Add regression coverage showing both an analytics tool and an older primitive query tool work without `db_path` when `BW_REPLAY_DB_PATH` is set.
