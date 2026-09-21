# Vendored screp static replay parser

This directory contains the official prebuilt `screp` command-line runtime used
by BW Forge for static replay-file metadata. It is application-owned and works
offline; neither a Go toolchain nor a global `screp` installation is required.

- Upstream: <https://github.com/icza/screp>
- Version/tag: `v1.13.4`
- Upstream commit: `43654a45e6d1704a105f5f1ab54935e35454a58c`
- License: Apache-2.0 (see `LICENSE`)
- Linux amd64 release archive SHA-256:
  `5b6ca0f0b91faccc658b3114a6ac3923c4ec3d579a774bca5698955fa2fa5006`
- Windows amd64 release archive SHA-256:
  `26db40ef55bdb919470b17d4dde48a87fd5279d1a462be7227bd721b60ea0892`

`provenance.json` records both official archive hashes and the extracted
executable hashes. Metadata extraction verifies the selected executable before
first use in every BW Forge process. Debian deployment also validates version,
platform, executable permissions, and the Linux binary hash during systemd
installation.

The runtime JSON is invoked with header and basic map data enabled. BW Forge
prefers decoded `MapData.Name` when nonblank and falls back to decoded
`Header.Map`; this avoids the fixed-width header truncation observed in corpus
replays. Nonprinting StarCraft formatting controls are removed to preserve the
existing visible map-name contract. All other decoded text is preserved.

screp performs its own legacy replay string decoding. BW Forge does not retain
raw map-name bytes or add CP949/EUC-KR heuristics, so byte-for-byte fidelity for
every historical encoding remains outside the current metadata contract.

headless-bwsim remains separately vendored under `third_party/bwsim` and is the
authoritative simulation/frame-telemetry engine. It is not used for static
metadata extraction.
