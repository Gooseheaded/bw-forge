1. Add a read-only database open path and non-mutating schema verification path for query-time MCP tools.
2. Add conservative SQL validation helpers for bounded read-only execution.
3. Add schema description, schema notes, and curated query example helpers.
4. Expose `describe_schema`, `get_schema_notes`, `list_query_examples`, `validate_readonly_sql`, and `execute_readonly_sql` through the MCP server.
5. Ensure all new SQL-oriented tools return useful `content.text` as well as structured payloads.
6. Add tests for SQL validation, schema/example helpers, and MCP integration behavior.
7. Validate the OpenSpec change and run the corpus-query test suite.
