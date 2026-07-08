## MODIFIED Requirements

### Requirement: Replay Analytics Discovery Tools

Read-only MCP discovery and analytics tools MUST use the MCP server's configured corpus database by default when the caller omits `db_path`.

#### Scenario: Read-only tool call without db_path

- **WHEN** a client calls a read-only discovery, analytics, query, or query-plan tool without `db_path`
- **THEN** the server resolves the database path from its configured environment or default lookup order
- **AND** the tool does not require the caller to repeat the same database path on every request

### Requirement: Corpus Ingest Runtime

Write-oriented corpus ingest MUST remain explicitly targeted.

#### Scenario: Ingest corpus into a database

- **WHEN** a client calls `ingest_corpus`
- **THEN** the caller still provides the target `db_path`
- **AND** ingest does not silently redirect writes to an implicit database
