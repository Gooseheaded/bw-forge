## MODIFIED Requirements

### Requirement: Replay Analytics Discovery Tools

`bw-forge mcp` MUST expose model-friendly schema and SQL discovery helpers in addition to replay-domain analytics tools.

#### Scenario: Client inspects the corpus schema

- **WHEN** a client calls `describe_schema`, `get_schema_notes`, or `list_query_examples`
- **THEN** the server returns compact, useful `content.text`
- **AND** structured schema, note, or example data remains available in `structuredContent`
- **AND** the response documents the actual corpus schema, joins, and replay-specific semantic gotchas

### Requirement: Replay Analytics Aggregate Tools

`bw-forge mcp` MUST provide a safe read-only SQL escape hatch for novel analytical questions.

#### Scenario: Client validates and executes read-only SQL

- **WHEN** a client calls `validate_readonly_sql` with a safe `SELECT` or `WITH ... SELECT` query
- **THEN** the server reports the query as allowed
- **AND** the server reports the effective row cap and any warnings

- **WHEN** a client calls `execute_readonly_sql` with an allowed query
- **THEN** the server executes it against the configured corpus database
- **AND** the result is bounded by server-enforced row caps
- **AND** the response includes useful `content.text` and structured rows/columns

#### Scenario: Client attempts unsafe SQL

- **WHEN** a client submits empty SQL, multiple statements, write SQL, schema-changing SQL, admin SQL, attached-database SQL, extension-loading SQL, or `WITH RECURSIVE`
- **THEN** `validate_readonly_sql` rejects the query
- **AND** `execute_readonly_sql` refuses to run it
- **AND** the server never mutates the corpus database through these tools

### Requirement: Corpus Ingest Runtime

`ingest_corpus` MUST remain the only write-oriented MCP tool.

#### Scenario: Read-only SQL tools open the corpus

- **WHEN** schema-description, schema-note, query-example, validation, or read-only SQL execution tools access the database
- **THEN** they open the corpus database in read-only mode
- **AND** they do not rely on schema-upsert behavior
- **AND** write-oriented schema initialization remains reserved for ingest flows
