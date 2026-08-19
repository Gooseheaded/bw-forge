# Early-disconnect replay fixtures

## Result

Three existing, small replay fixtures genuinely exercise ShieldBattery's `all human players disconnected after at least one was connected` export cutoff. Each was rerun through the current BW Forge `--keep-snapshots` path using frame units and stride 1. Fresh terminal frames exactly matched the older ShieldBattery-derived manifests.

These files currently live in the local `packages/legacy-replay-analysis/26-04/` corpus, which that package's `.gitignore` excludes. They are existing validation inputs in this workspace but are not portable, version-controlled CI fixtures yet. Promoting one later would be an artifact-management step; none was copied or modified in this pass.

Replay headers were read with ShieldBattery's installed `jssuh` parser. SHA-256 values were independently calculated from the replay bytes. Final emitted frames were read directly from the fresh `.sbtl` traces with the current Python snapshot iterator, not inferred only from rounded report duration.

| Replay | SHA-256 | Size | Header end | Shield final | Gap | Human slots / owners |
|---|---|---:|---:|---:|---:|---|
| `packages/legacy-replay-analysis/26-04/20260412/173432,(4)Pole Star 1.1.rep` | `af10cb48aa30f22416f1a56ad63ab48fb3f108d6f819ec402bbf7a88ee7940d1` | 57,393 B | 66 | 6 | 60 | owner 0 `IIIIllIIllII` (Zerg); owner 2 `Gooseheaded` (Zerg) |
| `packages/legacy-replay-analysis/26-04/20260411/130754,(4)KnockOut1.4.rep` | `6dc182c3ed881271b22d54d51fe34c3ca30a35da462e983d00b99631e81b178e` | 47,674 B | 224 | 197 | 27 | owner 0 `CPL-Harry` (Protoss); owner 3 `Gooseheaded` (Zerg) |
| `packages/legacy-replay-analysis/26-04/20260427/015542,(4)Octagon1.0.rep` | `82e32ff5f71a9bdb0a0e400503e6d551847a554a705c0c45f9ebb93e597ae9c6` | 49,555 B | 677 | 622 | 55 | owner 1 `llllllGglllllll` (Protoss); owner 2 `Gooseheaded` (Zerg) |

All listed replay-header players are human (`isComputer: false`). Their numeric header IDs are the BW player-slot/owner IDs used by the cutoff's scan of slots 0 through 7.

## Fresh trace evidence

| SHA-256 prefix | Captured frames | Last five frames | Owners present in first snapshot | Owners present in final snapshot |
|---|---:|---|---|---|
| `af10cb48` | 6 | 2, 3, 4, 5, 6 | 0, 2 | 2 |
| `6dc182c3` | 197 | 193, 194, 195, 196, 197 | 0, 3 | 3 |
| `82e32ff5` | 622 | 618, 619, 620, 621, 622 | 1, 2 | 2 |

Owner presence in unit telemetry is not a connection signal and is included only to document the raw trace. In particular, the remaining owner record at the final frame does not imply that player is connected.

## Why these are disconnect cutoffs

For replay export, `third_party/shieldbattery/game/src/bw_scr.rs:2717-2735` computes the effective end from only:

1. the nonzero replay-header end, limited to 43,200;
2. the 43,200 safety cutoff; and
3. `replay_export_cutoff_frame`.

BW Forge supplies no custom timeline end. Every fixture above has a nonzero header end below 43,200, yet its fresh trace ends earlier. Therefore neither header end nor the safety cap caused the stop; the effective end was `replay_export_cutoff_frame`.

The cutoff predicate in `bw_scr.rs:2743-2791` scans BW player slots 0 through 7. A participating slot is one whose `player_type` is `PLAYER_TYPE_HUMAN`. A human is connected when its Storm ID is in range and its Storm flag is nonzero. Once any human has been observed connected, the first checked frame with human slots present and no connected human stores the current frame as the cutoff.

The timeline does not serialize the per-frame Storm connection mask, so it cannot show which player disconnected last or the individual transition order. The exact expected state at each fresh final frame is nevertheless determined by the code and endpoint:

```text
replay_export_seen_connected_players == true
at least one PLAYER_TYPE_HUMAN slot exists
all participating human slots have a zero/invalid connected Storm flag
replay_export_cutoff_frame = current frame
```

Thus the exporter determines all humans disconnected at frame 6, 197, and 622 respectively. It must have observed at least one connected human at an earlier frame; the raw format cannot identify that earlier mask.

The cutoff is updated after game logic advances and before timeline emission (`bw_scr.rs:4378-4386`). Emission is allowed when `frame <= cutoff` (`bw_scr.rs:2738-2741`), so the disconnect frame itself is emitted. The consecutive final-frame tails above confirm this in each fresh trace.

## Validation answers

1. **Did we find a genuine all-human-disconnect replay?** Yes—three current, reproducible fixtures.
2. **Header end frames:** 66, 224, and 677.
3. **ShieldBattery final emitted frames:** 6, 197, and 622.
4. **Participating slots:** `(0, 2)`, `(0, 3)`, and `(1, 2)` respectively; all are human replay-header players.
5. **Is the terminal disconnect frame emitted?** Yes. Each fresh trace contains its cutoff frame as its final snapshot.
6. **Suitable for a future bwsim connection-state hook?** Semantically, yes. The 66/6 replay is the smallest primary fixture; the 224/197 and 677/622 replays provide two independent short confirmations with different owner-slot layouts. A hook passes this contract when it reports a prior connected human state, transitions to no connected human at the listed frame, includes that frame, and lets the host stop before the nominal header end. For portable/CI use, at least one replay must later be promoted out of the ignored local corpus.
