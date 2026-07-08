# Milestone 2 MCP Analytics Surface

## Summary

Expand `bw-forge mcp` from a mostly primitive replay/event lookup API into a read-only Brood War replay analytics surface that weaker local models can use directly.

## Motivation

The existing MCP server exposes deterministic primitives, but common questions like "which players exist?", "when does Soulkey usually get Spire?", and "what does this player have at 7:00?" still require the client to understand the schema and compose low-level calls. Milestone 2 adds explicit discovery and analytics tools so the MCP surface speaks in Brood War replay-analysis concepts instead of database mechanics.

## Scope

- Keep `ingest_corpus` as the only write-oriented MCP tool.
- Preserve existing primitive MCP tools and query-plan tooling.
- Add discovery, timing, composition, economy, death-summary, and replay-card tools.
- Keep both stdio and HTTP MCP transports working.
- Avoid generic SQL execution or arbitrary database mutation.

## Notes

- Death summaries are derived from existing perspective-specific death bundles. The new API labels self-bundle deaths as `lost` and enemy-bundle deaths as `killed`, matching the current corpus semantics without changing ingestion.
