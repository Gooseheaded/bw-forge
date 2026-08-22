# Vendored headless-bwsim runtime

This directory is an unchanged runtime snapshot of the upstream
[`Gooseheaded/headless-bwsim`](https://github.com/Gooseheaded/headless-bwsim)
release. The upstream repository is the source of truth; do not patch this copy
independently.

- Upstream version/tag: `v0.1.3`
- Upstream commit: `68ebdfd70d8d7a58d55c2ad206cc08da5697e7fa`
- License declared upstream: MIT
- Original Wasm SHA-256: `b321eb4f274d2602be1ccdf3cefa72b0ba934e2025d76d7c25379a18af4d1226`
- Patched Wasm SHA-256: `aec4109937e4d1efefa921cf4fef8bfd2febc772809a026510ff1a6e88ca9a7d`
- `sim.pack.gz` SHA-256: `32f8cc3561e11d2756a579dc54675e0758e94c15b9f767a66a1ba533a9856a44`

BW Forge uses `bwsim_wasm.bwforge.wasm`, whose only binary patch adds the
generation-bearing `bw_unit_instance_id(index) -> i32` export. Release v0.1.3
also exposes the engine's existing five-slot production queue and applies the
generation-aware SCR replay-local UnitId conversion, including extended unload
opcode `0x62`, during REP-to-DRPL conversion through the upstream JavaScript
API. The original Wasm is retained for provenance only.

To refresh this directory, make and test required engine/wrapper changes in the
upstream project, publish a new tag, copy its built `dist`, `package.json`,
`provenance.json`, Wasm artifacts, and `sim.pack.gz`, then update and verify all
hashes here.
