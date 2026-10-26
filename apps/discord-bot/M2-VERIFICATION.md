# M2 verification and handoff

## Implemented boundaries

| Requirement | Implementation and verification |
| --- | --- |
| Named corpora, stable qualified identity, one writable destination | `src/config/index.ts`, `src/corpus/registry.ts`; corpus/config/boundary tests cover duplicate IDs, missing/read-only targets, unsafe/canonical aliases, existing bot DB rejection and qualified equal-SHA references |
| Professional corpus protection | Registry write guard, SQLite read-only observation and canonical layout checks; real pipeline test compares professional DB bytes and modification time; API-boundary test denies registration into read-only corpus |
| Discord uploads from registered threads | Adapter retains guild/parent/thread/current-role checks; adapter regression covers two attachments, another participant, revocation and ordinary conversation routing |
| Safe bounded attachment handling | Exact HTTPS Discord CDN hosts, attachment path only, no redirects/credentials/custom port, streamed size/deadline bounds, generated private files, pinned metadata parser; ingestion tests cover real replay, malformed bytes, traversal names, size, stalled body and URL policy |
| Existing core owns replay analysis | `CorpusCore.registerAndEnqueue` calls Corpus v2 `enqueueReplay`; existing worker runs simulation/publication; no second analysis queue or deterministic algorithm changes |
| Independent resource limits | Separate coordinator and LLM turn runtime; per-session/process intake caps, bounded download tasks and bounded due-work polling; tests prove excess accepted downloads defer and revoked uploads never enqueue |
| Durable session inventory and provenance | Bot schema migrations through v4, unique message/attachment events, session/corpus/SHA association; M1 migration regression retains sessions/messages/pending turns |
| Content dedup without dropping notifications | Real integration test reuses indexed work in a second session and sends that session's own report; registration retry reuses an existing core job |
| Registration crash boundary | Real integration deliberately loses the successful core enqueue result before bot checkpoint, reopens bot SQLite and recovers the original job from persisted staged bytes/hash |
| Independent restart recovery | Real integration restarts bot again while worker analysis is leased/running, then completes publication/delivery; core tests exercise worker lease recovery separately |
| Authoritative HTML delivery | Core reads `analysis_publications` and immutable manifest, enforces artifact-root/symlink containment; core tests use an intentionally nonconventional publication path and reject escape |
| Delivery reliability and failures | Persistent intent/backoff/count, stable marker+nonce and bot-only history reconciliation; tests cover send-before-checkpoint, forged markers, transient failure across DB reopen, permission/size failures and safe notices preserving succeeded analysis |
| Configuration/deployment | Existing M1 environment remains usable with M2 disabled; optional independent community systemd worker, preserved persistent roots, repo-root helper resolution; PowerShell/Bash/offline-bundle tests and relocated Python/screp/enqueue probe |
| Operation and limitations | `M2-OPERATIONS.md` documents migration, provisioning, authorization policy, service filesystem access, recovery SQL, Discord HTML limits and live smoke procedure |
| M3 exclusions | No LLM tools, MCP client, query agent, coaching, public hosting, RAG or simulation changes; prompt explicitly explains replay-aware chat remains unavailable |

## Automated results

Verification ran on Windows with Bun 1.3.11. Python-dependent tests need `BW_FORGE_PYTHON` pointing to an actual executable. The workstation's `py` launcher is absent, and Windows execution aliases do not work with Bun's synchronous process API. The executable inside the installed Python package works; see Bead `bwf-7nj` for the discovery follow-up.

| Gate | Result |
| --- | --- |
| `bun run discord:test` | 84 passed, 0 failed, including real replay → core queue → fixture worker publication → mocked Discord HTML delivery |
| `bun run typecheck` | Passed root, desktop, corpus-query and Discord checks |
| `bun run discord:build` | Passed both production entrypoints |
| `bun run desktop:test` | 52 passed |
| `npm --prefix packages/corpus-query test` with Python override | 142 passed |
| `bun test apps/cli/src packages/corpus-store/src` with Python override | 93 passed, 1 pre-existing failure described below |
| Relocated bundle helper probe | Passed real Python preparation, pinned replay metadata extraction and Corpus v2 enqueue from a bundle outside the source tree |
| Deployment tests | Passed PowerShell parse, remote Bash syntax, offline dependency-inclusive bundle installation/import and community-worker configuration checks |

The sole remaining CLI/corpus test failure is `vendored headless-bwsim > loads the tracked golden replay with the patched runtime`: it references the already user-deleted `howdidilosethis/.../raw/LastReplay.rep`. That unrelated deletion was preserved. Follow-up is `bwf-65i`. Default test invocation without the Python override also exposes the existing launcher issue `bwf-7nj`; it is not a replay-ingestion regression.

## Scope of the integration test

`tests/m2-integration.test.ts` downloads the tracked replay fixture through mocked Discord CDN responses. A second parser-valid payload adds ignored padding so both byte identities traverse separate core jobs. The existing simulator is injected as a deterministic analytical fixture producer; registration, hashing, parsing, SQLite jobs/leases, immutable publication and bot report transport are real. The test restarts at both the registration/checkpoint boundary and during leased analysis, then checks reports in two sessions and unchanged professional data. This verifies orchestration without live credentials or running expensive deterministic simulation for every test.

No live Discord upload, real appliance deployment or live hosted-provider request was performed. The principal live two-distinct-game replay acceptance remains an operator smoke procedure in `M2-OPERATIONS.md`, as requested for environments without deployment credentials.

## Known limitations and M3 preparation

Discord and SQLite cannot guarantee exactly-once sending; reconciliation examines the latest 100 messages and uses Discord's nonce support. Reports conservatively cap at 10 MiB and remain preserved if they cannot be attached. Professional OS-level write isolation requires a dedicated bot account/ACL or read-only mount; the default deployer preserves the current shared unprivileged appliance account. Read-only application APIs enforce the corpus boundary regardless.

Before M3, complete the live smoke procedure, retain stable corpus IDs and session inventory, and expose read-only corpus-qualified queries. Keep deterministic ingestion and filesystem writes outside the hosted agent.

Tracking: milestone `bwf-f78` and implementation tasks `bwf-f78.1` (registry/core), `.2` (durable orchestration), `.3` (Discord delivery/regressions), `.4` (offline deployment/operations) are closed. Live appliance/Discord acceptance is tracked separately in open task `bwf-yi8`. Commit and push status are reported in the final handoff rather than embedded here.
