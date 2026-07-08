# Milestone 1 Artifact Model

Milestone 1 adds a canonical wrapper layout around the existing replay-analysis outputs.

```text
out/
  corpus-manifest.json
  replays/
    <replay-id>/
      replay-manifest.json
      raw/
        <original replay>.rep
      debug/
        snapshots.sbtl            # only when --keep-snapshots is used
      legacy/
        manifest.json
        player_<owner>.zip
        <legacy-name>.zip
        build-order.embedded.html
```

## Rules

- `legacy/` is treated as the unmodified output surface of `replay_analysis.py`.
- `replay-manifest.json` is the new normalized wrapper manifest for milestone 1.
- `corpus-manifest.json` indexes normalized replay manifests across the output root.
- The existing corpus ingester still consumes `legacy/manifest.json` files.

