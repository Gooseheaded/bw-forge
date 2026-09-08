# Corpus v2 Milestone 1 (disposable prototype)

Standalone Python 3.11+ / SQLite 3.37+ experiment. No production imports,
configuration changes, migrations, or new package dependencies. For Python SQLite
builds without `dbstat` (including bundled Windows Python), measurement falls back
to a read-only Node `node:sqlite` helper; Node must be available on PATH.
Windows can use BW Forge's bundled embedded Python; Linux can use `python3`.

```powershell
& ./apps/desktop/.runtime-build/python/cpython-3.14.6-embed-amd64/python.exe scripts/corpus_v2/test_prototype.py
New-Item -ItemType Directory -Force tmp/corpus-v2
& ./apps/desktop/.runtime-build/python/cpython-3.14.6-embed-amd64/python.exe scripts/corpus_v2/prototype.py --source-v1 'C:/Users/gctri/Documents/BW Forge/corpus.sqlite' --output tmp/corpus-v2/run-1.candidate.sqlite
```

Each invocation requires a **new** `.candidate.sqlite` path and creates a sibling
`.candidate.report.json`. Existing outputs are never overwritten. Failed candidates
are disposable and must not be used; rerun with a new name. Databases under `tmp/`
are ignored by Git. Do not point production at these files.

The v1 connection is read-only/query-only and used as the replay/ZIP inventory.
Raw SHA-256 is verified. Source database, ZIPs, manifests, raw files, and other
files in the replay artifact directories are SHA-256 fingerprinted before/after.
Run while external ingestion is idle: a changed source aborts the verification.
Artifacts are opened read-only. Paths currently come from the existing v1 inventory;
relocating a Windows inventory to Linux is not this prototype's responsibility.

Economy preserves every tuple change, including changes to/from nullable counters.
Missing per-frame samples create coverage gaps. Composition compares complete
dictionaries and writes explicit zeros, including subsequent reappearances.
Composition coverage conservatively ends at its final snapshot, not replay end.
The legacy producer's exact excluded-type vocabulary is unknown; each imported
specification declares only the unit labels demonstrated in that replay's bundles.
Queries for other labels are unobserved, not zero. This is deliberately conservative
legacy metadata, not a new analyzer-domain design.

Validation executes SQL reconstruction at **every** economy source frame and
complete composition snapshot. It independently checks disappearing types for an
explicit zero. The report includes the known 305.55-second regression when present,
coverage boundary checks, source fingerprints, dbstat table/index sizes and row
counts, and EXPLAIN QUERY PLAN plus representative query results.

The total-size comparison is **not apples-to-apples with a complete v2 corpus**:
this milestone excludes build, supply, deaths, identity curation and future indexes.
Report both the measured prototype result and that qualification. Future production
code must not call this importer or treat its schema as a released migration.
