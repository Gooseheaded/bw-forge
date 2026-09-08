"""Single-analysis importer. Python 3.11+, SQLite 3.37+; no third-party dependencies."""
import argparse
import hashlib
import importlib.util
import io
import json
import math
import re
import sqlite3
import time
import uuid
import zipfile
from pathlib import Path

# Embedded Python does not put the script directory on sys.path.
_spec = importlib.util.spec_from_file_location('sparse', Path(__file__).with_name('sparse.py'))
sparse = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sparse)
require = sparse.require


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def integer(value, label, minimum=0):
    require(type(value) is int and value >= minimum, 'Invalid ' + label)
    return value


def text(value, label):
    require(isinstance(value, str) and bool(value), 'Invalid ' + label)
    return value


def local_path(root, value):
    path = (root / text(value, 'artifact path')).resolve()
    require(path.is_relative_to(root), 'Artifact path escapes replay directory')
    return path


def frames(samples, duplicates=False):
    require(isinstance(samples, list), 'Samples must be an array')
    previous = -1
    for sample in samples:
        frame = integer(sample['frame'], 'frame')
        require(frame >= previous if duplicates else frame > previous, 'Unordered frames')
        previous = frame
        if 'time_seconds' in sample:
            require(type(sample['time_seconds']) in (int, float) and
                    math.isclose(sample['time_seconds'], frame * .042, abs_tol=1e-8), 'Invalid source clock')


def prepare(manifest_path):
    """Read/hash the same bytes we parse, entirely before opening the write transaction."""
    root = Path(manifest_path).resolve().parent
    manifest = json.loads(Path(manifest_path).read_bytes())
    require(manifest['schema_version'] == 'bw-forge-replay-manifest-v1', 'Unsupported replay manifest')
    if manifest.get('publication', {}).get('format') == 'bw-forge-publication-v1':
        replay_sha = manifest['replay_id']
        require(re.fullmatch('[0-9a-f]{64}', replay_sha) is not None, 'Invalid replay SHA')
        require(root.parent.name == replay_sha and root.parent.parent.name == 'analyses' and
                re.fullmatch('[0-9a-f]{64}', root.name), 'Invalid published analysis location')
        corpus = root.parent.parent.parent
        raw = (corpus / 'replays' / replay_sha[:2] / (replay_sha + '.rep')).resolve()
        require(raw.is_relative_to(corpus) and
                (root / manifest['source']['copied_path']).resolve() == raw, 'Invalid canonical replay path')
    else:
        raw = local_path(root, manifest['source']['copied_path'])
    raw_bytes = raw.read_bytes()
    replay_sha = sha(raw_bytes)
    require(replay_sha == manifest['replay_id'], 'Replay SHA mismatch')
    legacy = json.loads(local_path(root, manifest['legacy']['manifest_path']).read_bytes())
    require(legacy['schema_version'] == 'replay-analysis-manifest-v1' and
            legacy['replay_id'] == replay_sha, 'Legacy manifest identity mismatch')
    inventory = []

    def register(key, data):
        inventory.append((key, sha(data), len(data)))

    # Semantic manifests exclude machine-specific paths and array ordering.
    players = sorted(manifest['players'], key=lambda p: p['owner'])
    require(players and len({p['owner'] for p in players}) == len(players), 'Missing or duplicate owners')
    identity = lambda ps: sorted((p['owner'], p['name'], p['race'].lower()) for p in ps)
    require(identity(players) == identity(legacy['players']), 'Manifest participants disagree')
    register('replay', raw_bytes)
    register('manifest/analysis', canonical({'analysis': manifest['replay_analysis'],
             'players': identity(players), 'legacy_duration': legacy.get('duration_seconds'),
             'legacy_map': legacy.get('map')}).encode())
    bundles = []
    for player in players:
        owner = integer(player['owner'], 'owner')
        text(player['name'], 'player name')
        require(player['race'].lower() in ('zerg', 'terran', 'protoss', 'unknown'), 'Invalid race')
        data = local_path(root, player['legacy_zip_path']).read_bytes()
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = [i for i in archive.infolist() if not i.is_dir()]
            require(len({i.filename for i in members}) == len(members), 'Duplicate ZIP members')
            require(sum(i.file_size for i in members) <= 512 * 1024 * 1024, 'Player bundle exceeds 512 MiB')
            files = {i.filename: archive.read(i) for i in members}
        for name, content in sorted(files.items()):
            register(f'player/{owner}/{name}', content)
        info = json.loads(files['player.json'])
        require(info['schema_version'] == 'replay-analysis-player-bundle-v1' and
                info['owner'] == owner and info['name'] == player['name'] and
                info['race'].lower() == player['race'].lower(), 'Bundle player mismatch')
        bundle = {'player': player}
        for name, contract in [('economy', 'economy'), ('unit_counts', 'unit-counts'),
                               ('supply', 'supply'), ('deaths', 'deaths')]:
            # Old bundles may omit composition/deaths. Missing is not proven empty coverage.
            if name + '.json' not in files and name in ('unit_counts', 'deaths'):
                bundle[name] = []
                continue
            obj = json.loads(files[name + '.json'])
            require(obj['schema_version'] == f'replay-analysis-{contract}-v1' and
                    obj['owner'] == owner, 'Unsupported artifact contract or owner')
            samples = obj['samples']
            frames(samples, name == 'deaths')
            bundle[name] = samples
        sparse.check_samples(bundle['economy'])
        sparse.check_samples(bundle['unit_counts'], composition=True)
        for sample in bundle['supply']:
            integer(sample['current'], 'supply current')
            integer(sample['max'], 'supply max')
        for sample in bundle['deaths']:
            death = sample['death']
            require(death['owner'] == owner, 'Death owner mismatch')
            for key in ('id', 'unit_type_id', 'owner'):
                integer(death[key], 'death ' + key)
            for key in ('pos_x', 'pos_y'):
                integer(death[key], key, -2147483648)
            text(death['unit_type'], 'death unit type')
            text(death['category'], 'death category')
        builds = []
        for line in files['build_order.txt'].decode('utf8').splitlines():
            if not line.strip():
                continue
            match = re.fullmatch(r'(\d+):([0-5]\d)\s+(.+)', line)
            require(match is not None, 'Invalid build order line: ' + line)
            seconds = int(match[1]) * 60 + int(match[2])
            # Legacy renderer floors frame*42/1000; never invent an exact frame.
            builds.append((match[3], seconds, (seconds*1000+41)//42,
                           ((seconds+1)*1000+41)//42-1, line))
        bundle['builds'] = builds
        bundles.append(bundle)
    domain = sorted({name for b in bundles for s in b['unit_counts'] for name in s['counts']})
    # Never use today's installed producer version as historical provenance.
    provenance = {'bw_forge_version': 'unknown', 'reducer_version': 'unknown',
                  'bwsim_version': 'unknown', 'bwsim_wasm_sha256': None, 'asset_pack_sha256': None,
                  'telemetry_contract': 'legacy-complete-dictionaries-v1', 'settings': 'unknown'}
    for source in (legacy, manifest):
        supplied = source.get('analysis_spec', {})
        require(isinstance(supplied, dict), 'Invalid analysis_spec')
        provenance.update(supplied)
    for key in ('bw_forge_version', 'reducer_version', 'bwsim_version', 'telemetry_contract'):
        text(provenance[key], key)
    for key in ('bwsim_wasm_sha256', 'asset_pack_sha256'):
        require(provenance[key] is None or re.fullmatch('[0-9a-f]{64}', provenance[key]), 'Invalid ' + key)
    spec = {'producer': provenance, 'importer': 'corpus-store-2a-v1',
            'implementation_sha256': sha(canonical({name: Path(__file__).with_name(name).read_text(encoding='utf-8-sig')
                for name in ('sparse.py', 'store.py', 'schema.sql', 'events.sql')}).encode()),
            'artifact_format': 'player-bundle-v1', 'frame_duration_ms': [42, 1],
            'unit_domain': domain, 'composition_end': 'last_snapshot',
            'historical_excluded_unit_vocabulary': 'unknown',
            'build_timing': 'legacy_second_floor', 'supply_end': 'last_sample'}
    fingerprint = sha(canonical(spec).encode())
    inventory.sort()
    key = sha(canonical([replay_sha, fingerprint, inventory]).encode())
    if manifest.get('publication', {}).get('format') == 'bw-forge-publication-v1':
        require(root.name == key, 'Published analysis key mismatch')
    return manifest, raw, len(raw_bytes), bundles, spec, fingerprint, inventory, key


def register_publication(db, aid, manifest_path, manifest, raw, inventory):
    """Locations are additive metadata, never part of logical analysis identity."""
    if manifest.get('publication', {}).get('format') != 'bw-forge-publication-v1':
        return
    # execute individual DDL statements: executescript would commit the active transaction.
    for statement in Path(__file__).with_name('publication.sql').read_text().split(';'):
        if statement.strip():
            db.execute(statement)
    root = Path(manifest_path).resolve().parent
    db.execute('INSERT INTO analysis_publications VALUES (?,?,?) ON CONFLICT DO NOTHING',
               (aid,str(Path(manifest_path).resolve()),str(raw)))
    players = {str(p['owner']): p for p in manifest['players']}
    for key, _, _ in inventory:
        member = None
        if key == 'replay':
            path = raw
        elif key == 'manifest/analysis':
            path = Path(manifest_path).resolve()
        else:
            _, owner, member = key.split('/', 2)
            path = local_path(root, players[owner]['legacy_zip_path'])
        db.execute('INSERT INTO analysis_artifact_locations VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
                   (aid,key,str(path),member))


def initialize(db):
    tables = db.execute("SELECT name FROM sqlite_schema WHERE type='table'").fetchall()
    if tables:
        require(db.execute('PRAGMA user_version').fetchone()[0] == 2, 'Refusing non-v2 database (v1 is never migrated)')
        row = db.execute('SELECT purpose FROM corpus_metadata WHERE singleton=1').fetchone()
        require(row and row[0] == 'corpus-store', 'Not a corpus-store database')
        return
    require(db.execute('PRAGMA user_version').fetchone()[0] == 0, 'Refusing nonempty schema version')
    # executescript is deliberately confined to initialization, before the ingestion transaction.
    db.executescript('BEGIN IMMEDIATE;\n' + Path(__file__).with_name('schema.sql').read_text(encoding='utf-8-sig') +
                     '\n' + Path(__file__).with_name('events.sql').read_text(encoding='utf-8-sig'))
    db.execute('INSERT INTO corpus_metadata VALUES (1,2,?,?,?,?)',
               (str(uuid.uuid4()), int(time.time()*1000), 'python-casefold-v1', 'corpus-store'))
    db.commit()


def ingest_replay_analysis(db_path, replay_manifest_path):
    manifest, raw, size, bundles, spec, fingerprint, inventory, key = prepare(replay_manifest_path)
    db_path = Path(db_path).resolve()
    require(not db_path.is_relative_to(Path(replay_manifest_path).resolve().parent),
            'Database must be outside the replay artifact directory')
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(db_path, timeout=30)
    db.row_factory = sqlite3.Row
    try:
        db.execute('PRAGMA foreign_keys=ON')
        initialize(db)
        db.execute('BEGIN IMMEDIATE')
        existing = db.execute('SELECT analysis_id,status FROM analysis_runs WHERE analysis_key=?', (key,)).fetchone()
        if existing:
            require(existing['status'] == 'indexed', 'Existing analysis is not indexed')
            if manifest.get('publication', {}).get('format') == 'bw-forge-publication-v1':
                register_publication(db,existing['analysis_id'],replay_manifest_path,manifest,raw,inventory)
                db.commit()
            else:
                db.rollback()
            return {'status': 'no-op', 'analysisId': existing['analysis_id'], 'analysisKey': key,
                    'replaySha256': manifest['replay_id']}
        now = int(time.time()*1000)
        db.execute('INSERT INTO replays(sha256,byte_size,raw_relative_path,first_seen_at_ms,map_name) VALUES (?,?,?,?,?) ON CONFLICT(sha256) DO NOTHING',
                   (manifest['replay_id'], size, manifest['source']['copied_path'], now, manifest['replay_analysis'].get('map')))
        rid = db.execute('SELECT replay_id FROM replays WHERE sha256=?', (manifest['replay_id'],)).fetchone()[0]
        p = spec['producer']
        db.execute('''INSERT INTO analysis_specs(fingerprint_sha256,bw_forge_version,bwsim_version,bwsim_wasm_sha256,
            asset_pack_sha256,reducer_version,artifact_format,telemetry_contract,settings_json,
            frame_duration_num_ms,frame_duration_den,origin,created_at_ms)
            VALUES (?,?,?,?,?,?,?,?,?,42,1,'legacy_import',?) ON CONFLICT(fingerprint_sha256) DO NOTHING''',
            (fingerprint,p['bw_forge_version'],p['bwsim_version'],p['bwsim_wasm_sha256'],p['asset_pack_sha256'],
             p['reducer_version'],spec['artifact_format'],p['telemetry_contract'],canonical(spec),now))
        sid = db.execute('SELECT spec_id FROM analysis_specs WHERE fingerprint_sha256=?', (fingerprint,)).fetchone()[0]
        aid = db.execute("INSERT INTO analysis_runs(analysis_key,replay_id,spec_id,status,outcome,queued_at_ms) VALUES (?,?,?,'artifacts_ready','legacy_partial',?)",
                         (key,rid,sid,now)).lastrowid
        names = set(spec['unit_domain'])
        names.update(e[0] for b in bundles for e in b['builds'])
        names.update(s['death']['unit_type'] for b in bundles for s in b['deaths'])
        units = {}
        for name in sorted(names):
            db.execute('INSERT INTO unit_types(unit_key,display_name) VALUES (?,?) ON CONFLICT(unit_key) DO NOTHING', (name,name))
            units[name] = db.execute('SELECT unit_type_id FROM unit_types WHERE unit_key=?', (name,)).fetchone()[0]
        for name in spec['unit_domain']:
            db.execute('INSERT INTO analysis_unit_domain VALUES (?,?) ON CONFLICT DO NOTHING', (sid,units[name]))
        totals = {'economy_samples': 0, 'composition_snapshots': 0, 'zero_transitions': 0,
                  'builds': 0, 'supply_changes': 0, 'deaths': 0}
        for b in bundles:
            player = b['player']
            db.execute('''INSERT INTO participations(replay_id,owner,observed_name,observed_name_key,name_namespace,race)
                VALUES (?,?,?,?,'legacy-unknown',?) ON CONFLICT(replay_id,owner) DO NOTHING''',
                (rid,player['owner'],player['name'],player['name'].casefold(),player['race'].lower()))
            pid = db.execute('SELECT participation_id FROM participations WHERE replay_id=? AND owner=?', (rid,player['owner'])).fetchone()[0]
            obs = db.execute('INSERT INTO analysis_participations(analysis_id,participation_id,replay_id) VALUES (?,?,?)', (aid,pid,rid)).lastrowid
            sparse.import_economy(db,obs,b['economy'])
            sparse.import_composition_segment(db,obs,b['unit_counts'],units)
            for n, (name, seconds, low, high, line) in enumerate(b['builds']):
                db.execute("INSERT INTO build_events VALUES (?,?,?,NULL,?,?,?,'legacy_second_floor',?)", (obs,n,units[name],seconds,low,high,line))
            previous = None
            expected_supply = []
            for sample in b['supply']:
                state = sample['current'], sample['max']
                if state != previous:
                    expected_supply.append((sample['frame'],*state))
                    db.execute('INSERT INTO supply_changes VALUES (?,?,?,?)', (obs,sample['frame'],*state))
                previous = state
            if b['supply']:
                sparse.add_coverage(db,obs,'supply',b['supply'][0]['frame'],b['supply'][-1]['frame'],'legacy_inferred')
            for n, sample in enumerate(b['deaths']):
                d = sample['death']
                db.execute('INSERT INTO death_events VALUES (?,?,?,?,?,?,?,?,?,?)',
                           (obs,n,sample['frame'],units[d['unit_type']],d['id'],d['unit_type_id'],d['owner'],d['category'],d['pos_x'],d['pos_y']))
            # Events prove observations at these frames only, never absence between them.
            for frame in sorted({s['frame'] for s in b['deaths']}):
                sparse.add_coverage(db,obs,'deaths',frame,frame,'observations_only')
            checks = sparse.validate(db,obs,b['economy'],b['unit_counts'])
            for name, count in checks.items():
                totals[name] += count
            actual = [tuple(r) for r in db.execute('SELECT frame,current,max FROM supply_changes WHERE observation_id=? ORDER BY frame', (obs,))]
            require(actual == expected_supply, 'Supply validation failed')
            actual = [tuple(r) for r in db.execute('''SELECT u.unit_key,b.time_seconds,b.frame_min,b.frame_max,b.raw_line
                FROM build_events b JOIN unit_types u USING(unit_type_id) WHERE observation_id=? ORDER BY occurrence''', (obs,))]
            require(actual == b['builds'], 'Build validation failed')
            actual = [tuple(r) for r in db.execute('''SELECT frame,u.unit_key,source_unit_id,source_unit_type_id,dead_owner,category,pos_x,pos_y
                FROM death_events JOIN unit_types u USING(unit_type_id) WHERE observation_id=? ORDER BY occurrence''', (obs,))]
            expected = [(s['frame'],s['death']['unit_type'],s['death']['id'],s['death']['unit_type_id'],
                         s['death']['owner'],s['death']['category'],s['death']['pos_x'],s['death']['pos_y']) for s in b['deaths']]
            require(actual == expected, 'Death validation failed')
            totals['builds'] += len(b['builds'])
            totals['supply_changes'] += len(expected_supply)
            totals['deaths'] += len(b['deaths'])
        db.executemany('INSERT INTO analysis_artifacts VALUES (?,?,?,?)', [(aid,*entry) for entry in inventory])
        register_publication(db,aid,replay_manifest_path,manifest,raw,inventory)
        require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'Foreign key check failed')
        require(db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'Integrity check failed')
        observed_end = max((s['frame'] for b in bundles for stream in ('economy', 'unit_counts', 'supply', 'deaths')
                            for s in b[stream]), default=None)
        db.execute("UPDATE analysis_runs SET status='indexed',indexed_at_ms=?,validation_json=?,processed_end_frame=?,termination_reason='historical termination unknown' WHERE analysis_id=?",
                   (now,canonical(totals),observed_end,aid))
        db.execute('INSERT INTO current_analyses VALUES (?,?,?) ON CONFLICT(replay_id) DO UPDATE SET analysis_id=excluded.analysis_id,accepted_at_ms=excluded.accepted_at_ms', (rid,aid,now))
        db.commit()
        return {'status': 'indexed', 'analysisId': aid, 'analysisKey': key, 'replaySha256': manifest['replay_id'],
                'participations': len(bundles), 'validation': totals, 'integrity': 'ok', 'foreignKeyViolations': 0}
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('replay_manifest_path')
    parser.add_argument('--db')
    parser.add_argument('--prepare', action='store_true')
    args = parser.parse_args()
    if args.prepare:
        manifest, _, _, _, _, fingerprint, inventory, key = prepare(args.replay_manifest_path)
        print(canonical({'replaySha256': manifest['replay_id'], 'analysisKey': key,
                         'specificationFingerprint': fingerprint, 'artifacts': inventory}))
    else:
        if not args.db:
            parser.error('--db is required for ingestion')
        print(canonical(ingest_replay_analysis(args.db, args.replay_manifest_path)))
