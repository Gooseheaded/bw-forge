# Milestone 2.1 MCP Text Summaries

## Summary

Make `bw-forge mcp` tool `content.text` materially informative for weak or local clients that underuse `structuredContent`.

## Motivation

The current MCP surface returns strong structured payloads, but some local browser-based MCP clients mostly expose the text channel to the model. Count-only summaries like `Listed 13 build items.` prevent those clients from answering straightforward replay-analysis questions even when the full structured data is present.

## Scope

- Keep `structuredContent` as the canonical machine-readable payload.
- Improve `content.text` for discovery, analytics, and older primitive query tools.
- Cap text output so responses stay compact and readable.
- Preserve stdio and HTTP MCP compatibility.

## Notes

- This change does not add SQL access, does not change ingestion, and does not alter the structured response schemas unless a bug fix requires it.
