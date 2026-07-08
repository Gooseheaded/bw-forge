# Migration Notes

Milestone 1 moves the active working layout into `bw-forge` without rewriting reducer logic.

## Imported Sources

- `packages/legacy-replay-analysis` from `replay-analysis`
- `third_party/shieldbattery` from `ShieldBattery`
- `apps/sc-forge` from `sc-forge`
- `packages/corpus-query` from `replay-corpus-query`
- `packages/replay-analysis-summarizer` from `replay-analysis-summarizer`

## Milestone 1 Scope

- Add a root Bun/TypeScript CLI that orchestrates imported tools.
- Remove runtime dependence on the old sibling directories.
- Keep legacy replay-analysis outputs intact under each canonical replay directory.
- Generate canonical replay and corpus manifests from legacy outputs.

## Explicit Non-Goals

- No reducer port to TypeScript.
- No ShieldBattery carve-down.
- No schema rewrite of legacy ZIP contents.
- No browser-automation removal yet beyond keeping the summarizer imported for preservation.

