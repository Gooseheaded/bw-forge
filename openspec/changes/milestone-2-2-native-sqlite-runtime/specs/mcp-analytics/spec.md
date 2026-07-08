## MODIFIED Requirements

### Requirement: Replay Analytics Aggregate Tools

The `bw-forge mcp` analytics surface MUST support corpora that exceed the practical file-size limits of the previous `sql.js` runtime.

#### Scenario: Query a multi-gigabyte corpus

- **WHEN** a client opens a corpus database larger than 2 GiB through the MCP server, CLI, or query-plan tooling
- **THEN** the runtime uses native SQLite file access instead of loading the whole database into WASM memory
- **AND** the existing analytics tools and response schemas continue to work

### Requirement: Corpus Ingest Runtime

Corpus ingest MUST remain durable and replay-replacement-safe after the runtime swap.

#### Scenario: Ingest batches into a native SQLite database

- **WHEN** replay manifests are ingested into a corpus database
- **THEN** committed batches are durable on disk
- **AND** replay replacement still removes prior replay rows before reinserting updated rows
- **AND** the schema and ingest semantics remain unchanged
