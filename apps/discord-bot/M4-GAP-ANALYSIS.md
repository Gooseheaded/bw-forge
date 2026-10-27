# M4 audit and implementation plan

Baseline: `6eb9ab0` (accepted M3), inspected 2026-10-27. This document records
gaps found before implementation, not a claim of milestone acceptance.

## Existing safeguards retained

- Discord guild/channel/role checks, fresh authorization before paid work,
  collaborative session ownership and durable event deduplication.
- Provider deadlines, safe failure categories, bounded response bodies, saved
  response reuse, session serialization and global turn concurrency.
- Narrow Discord analytical schemas, deterministic tool allowlisting, explicit
  registered corpus routing and session-local replay resolution.
- Bounded agent rounds, tool calls, parallel tools, tool result sizes, context
  construction and duplicate analytical-call caching.
- Corpus canonical-path isolation, read-only application APIs, validated CDN
  uploads, generated staging paths, durable job references, restart reconciliation
  and report-delivery checkpoints with persistent retries.

## Priority gaps

| Priority | Evidence at baseline | Planned independently testable change |
| --- | --- | --- |
| 1: isolation | Service units lack filesystem confinement; deployed bot uses the shared appliance account with `ProtectSystem=no` and no `ReadOnlyPaths`/`ReadWritePaths`. Application checks cannot establish OS protection. | Restrict bot/community service writes to validated state/community paths; verify effective permissions without writing professional data. Preserve primary worker behavior. |
| 1: privacy/correctness | Coordinator logs full replay hashes; adapter logs raw ingestion exception messages and acknowledges uploads before inspecting intake results. | Remove sensitive fields, classify failures safely and report actual durable acceptance counts. |
| 2: availability | Stdio request abort listeners survive completion; timeout/cancellation leaves outstanding child work; gateway shutdown races initialization. | Close and reap failed transports, clean listeners, bound safe reconnect and cover actual synthetic subprocess failures. |
| 2: provider recovery | Retryable turn failures are immediately requeued; startup recovery and runtime attempt limits differ. | Bounded cancellation-aware backoff and consistent durable recovery policy. |
| 3: diagnostics | Runtime logs are unstructured; provider rows represent a turn attempt and lack per-call duration/usage; lifecycle identifiers are inconsistent. | Correlate turn, provider, tool and delivery events; persist per-call outcome and usage without contents or arguments. |
| 4: spending | Existing round/output/concurrency limits bound individual work, but no turn/session token/cost budget or per-user request cap exists. | Conservative request admission, distinguish reported usage from estimates, optional configured pricing, user limits and restart-safe accounting. |
| 5: operations | No unified safe local health summary or M4 acceptance/recovery procedure. | Credential-free health diagnostics, configuration examples, reproducible fixture verification, explicit live checklist and rollback limitations. |

## Tracking and verification

Epic `bwf-bag` tracks MCP (`.1`), runtime/usage (`.2`), Discord/ingestion
(`.3`), deployment/operations (`.4`) and full/live verification (`.5`).

The initial bot suite passed 119 tests and failed one because `python` was not
available through this Windows shell's PATH. Resolve interpreter selection before
claiming a baseline regression. New tests must exercise the failure scenarios,
not merely assert implementation text. Run focused tests after each slice, then
root tests/typechecks and deployment bundle validation.

Initial SSH with the supplied identity confirmed both bot and community worker
active. Noninteractive sudo requires authentication. Deployment uses the existing
`Deploy-BwForge.ps1` against a tested committed revision. Live acceptance and
professional-corpus OS isolation remain unproven until verified on the appliance;
fixture tests are not substitutes.

## Known boundaries

Discord delivery and SQLite cannot share a transaction: markers/checkpoints and
reconciliation reduce duplicates but cannot guarantee exactly-once delivery after
long outages or deleted history. Provider requests interrupted before recording a
response can have unknown billing; estimates must remain distinct from reported
usage. Prompt instructions cannot enforce authorization; gateway/application
validation remains authoritative. No production corpus migration or mutation is
part of M4.
