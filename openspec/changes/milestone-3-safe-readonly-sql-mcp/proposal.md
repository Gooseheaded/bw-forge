# Milestone 3 Safe Read-Only SQL MCP Layer

## Summary

Add a safe, bounded, read-only SQL analytics layer to `bw-forge mcp` so replay research can ask arbitrary analytical questions without exposing unrestricted SQLite access.

## Motivation

The existing MCP analytics surface covers common replay questions well, but replay research often produces compositional queries that are more naturally expressed in SQL. Adding one bespoke tool for every variant would make the API brittle and unmaintainable.

## Scope

- Add schema introspection and semantic schema-note tools.
- Add curated SQL example tools for weak local models.
- Add a conservative read-only SQL validator.
- Add bounded read-only SQL execution over the corpus database.
- Keep all existing high-level analytics tools and keep `ingest_corpus` as the only write-oriented MCP tool.

## Notes

- Validation is intentionally conservative and may over-reject unusual queries.
- `WITH RECURSIVE` is rejected in this milestone.
- The validator is structured so it can be upgraded to a parser-backed implementation later without changing MCP tool contracts.
