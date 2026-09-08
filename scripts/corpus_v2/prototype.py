"""Isolated, standard-library-only Corpus v2 experiment; never imported by BW Forge.

Run with Python >=3.11 and SQLite >=3.37 (STRICT and dbstat required).
The v1 database is only an inventory. State comes from complete ZIP members.
"""
import argparse
from contextlib import closing
import hashlib
import json
import math
import sqlite3
import subprocess
import sys
import time
import uuid
import zipfile
from pathlib import Path

FIELDS = ('minerals', 'gas', 'workers', 'gathered_minerals', 'gathered_gas')
REGRESSION = '02c781f766e9cdd345bcfd1fbd3ee88cc00a885b1f51e069818c141ffa26957a'
COVERAGE_SQL = """SELECT start_frame,end_frame,basis FROM stream_coverage
 WHERE observation_id=? AND stream=? AND start_frame<=?
 ORDER BY start_frame DESC LIMIT 1"""
ECONOMY_SQL = """SELECT frame,minerals,gas,workers,gathered_minerals,gathered_gas
 FROM economy_changes WHERE observation_id=? AND frame>=? AND frame<=?
 ORDER BY frame DESC LIMIT 1"""
UNIT_SQL = """SELECT frame,count FROM unit_count_changes
 WHERE observation_id=? AND unit_type_id=? AND frame>=? AND frame<=?
 ORDER BY frame DESC LIMIT 1"""
DOMAIN_SQL = """SELECT u.unit_type_id,u.unit_key FROM analysis_participations ap
 JOIN analysis_runs a ON a.analysis_id=ap.analysis_id
 JOIN analysis_unit_domain d ON d.spec_id=a.spec_id
 JOIN unit_types u ON u.unit_type_id=d.unit_type_id WHERE ap.observation_id=?"""
COMPOSITION_SQL = """SELECT u.unit_key, COALESCE((SELECT c.count
 FROM unit_count_changes c WHERE c.observation_id=? AND c.unit_type_id=u.unit_type_id
 AND c.frame>=? AND c.frame<=? ORDER BY c.frame DESC LIMIT 1),0) AS count
 FROM analysis_participations ap JOIN analysis_runs a ON a.analysis_id=ap.analysis_id
 JOIN analysis_unit_domain d ON d.spec_id=a.spec_id
 JOIN unit_types u ON u.unit_type_id=d.unit_type_id WHERE ap.observation_id=?"""


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    with Path(path).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def readonly(path):
    db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    return db


def initialize(db):
    db.row_factory = sqlite3.Row
    db.executescript(Path(__file__).with_name('schema.sql').read_text(encoding='utf8'))
    db.execute('INSERT INTO corpus_metadata VALUES (1,2,?,?,?,?)',
               (str(uuid.uuid4()), int(time.time()*1000), 'python-casefold-v1',
                'disposable-milestone-1'))


def check_samples(samples, composition=False):
    previous = -1
    for sample in samples:
        frame = sample['frame']
        require(type(frame) is int and frame > previous, 'Frames must be nonnegative and strictly increasing')
        previous = frame
        if 'time_seconds' in sample:
            require(math.isclose(sample['time_seconds'], frame * .042, abs_tol=1e-8),
                    'Source clock is not the verified 42ms frame convention')
        values = sample['counts'] if composition else {k: sample.get(k) for k in FIELDS}
        if not composition:
            require(sample.get('minerals') is not None and sample.get('gas') is not None,
                    'Required economy field missing')
        for key, value in values.items():
            require(isinstance(key, str) and key, 'Invalid field/unit key')
            require((value is None and not composition) or (type(value) is int and value >= 0),
                    'Noninteger or negative state value')


def add_coverage(db, observation, stream, start, end, basis):
    require(0 <= start <= end, 'Invalid coverage range')
    overlap = db.execute('''SELECT 1 FROM stream_coverage WHERE observation_id=?
        AND stream=? AND start_frame<=? AND end_frame>=?''',
        (observation, stream, end, start)).fetchone()
    require(overlap is None, 'Overlapping coverage segments')
    db.execute('INSERT INTO stream_coverage VALUES (?,?,?,?,?)',
               (observation, stream, start, end, basis))


def import_economy(db, observation, samples):
    """Per-frame legacy source: missing frames split coverage, never bridge gaps."""
    check_samples(samples)
    previous = None
    last_frame = None
    start = None
    rows = []
    for sample in samples:
        frame = sample['frame']
        state = tuple(sample.get(k) for k in FIELDS)
        new_segment = last_frame is None or frame != last_frame + 1
        if new_segment:
            if last_frame is not None:
                add_coverage(db, observation, 'economy', start, last_frame, 'verified')
            start = frame
        if new_segment or state != previous:
            rows.append((observation, frame, *state))
        previous, last_frame = state, frame
    if last_frame is not None:
        add_coverage(db, observation, 'economy', start, last_frame, 'verified')
    db.executemany('INSERT INTO economy_changes VALUES (?,?,?,?,?,?,?)', rows)


def import_composition_segment(db, observation, samples, unit_ids, end=None):
    """One complete, change-emitted stream segment; caller supplies gap boundaries."""
    check_samples(samples, composition=True)
    if not samples:
        return 0
    end = samples[-1]['frame'] if end is None else end
    require(end >= samples[-1]['frame'], 'Coverage ends before final snapshot')
    add_coverage(db, observation, 'composition', samples[0]['frame'], end, 'legacy_inferred')
    previous = {}
    rows, zeroes = [], 0
    for sample in samples:
        current = sample['counts']
        for name in sorted(previous.keys() | current.keys()):
            require(name in unit_ids, 'Unit outside declared observation domain')
            count = current.get(name, 0)
            if count != previous.get(name, 0):
                rows.append((observation, unit_ids[name], sample['frame'], count))
                zeroes += count == 0
        previous = current
    db.executemany('INSERT INTO unit_count_changes VALUES (?,?,?,?)', rows)
    return zeroes


def coverage(db, observation, stream, frame):
    require(type(frame) is int and frame >= 0, 'Query frame must be a nonnegative integer')
    row = db.execute(COVERAGE_SQL, (observation, stream, frame)).fetchone()
    if row and frame <= row['end_frame']:
        return 'known', row
    if row:
        later = db.execute('SELECT 1 FROM stream_coverage WHERE observation_id=? AND stream=? AND start_frame>?',
                           (observation, stream, frame)).fetchone()
        return ('gap' if later else 'after_coverage'), None
    return 'before_coverage', None


def economy_at(db, observation, frame):
    status, segment = coverage(db, observation, 'economy', frame)
    if status != 'known':
        return {'availability': status, 'state': None}
    row = db.execute(ECONOMY_SQL, (observation, segment['start_frame'], frame)).fetchone()
    require(row is not None, 'Covered economy segment lacks initial state')
    return {'availability': status, 'state': {k: row[k] for k in FIELDS},
            'last_change_frame': row['frame']}


def unit_at(db, observation, name, frame):
    status, segment = coverage(db, observation, 'composition', frame)
    if status != 'known':
        return {'availability': status, 'count': None}
    domain = dict((r['unit_key'], r['unit_type_id']) for r in db.execute(DOMAIN_SQL, (observation,)))
    if name not in domain or segment['basis'] == 'observations_only':
        return {'availability': 'unobserved', 'count': None}
    row = db.execute(UNIT_SQL, (observation, domain[name], segment['start_frame'], frame)).fetchone()
    return {'availability': 'known', 'count': row['count'] if row else 0,
            'last_change_frame': row['frame'] if row else None,
            'basis': 'explicit_change' if row else 'complete_baseline_absence'}


def composition_at(db, observation, frame):
    status, segment = coverage(db, observation, 'composition', frame)
    if status != 'known':
        return {'availability': status, 'counts': None}
    if segment['basis'] == 'observations_only':
        return {'availability': 'unobserved', 'counts': None}
    rows = db.execute(COMPOSITION_SQL, (observation, segment['start_frame'], frame, observation))
    return {'availability': 'known', 'counts': {r['unit_key']: r['count'] for r in rows if r['count'] > 0}}


def validate(db, observation, economy, composition):
    """Independent source oracle: execute public point queries at EVERY source frame."""
    for sample in economy:
        actual = economy_at(db, observation, sample['frame'])
        require(actual['availability'] == 'known' and
                actual['state'] == {k: sample.get(k) for k in FIELDS},
                f'Economy mismatch: observation={observation}, frame={sample["frame"]}')
    zeros = 0
    previous = {}
    for sample in composition:
        actual = composition_at(db, observation, sample['frame'])
        expected = {k: v for k, v in sample['counts'].items() if v > 0}
        require(actual['availability'] == 'known' and actual['counts'] == expected,
                f'Composition mismatch: observation={observation}, frame={sample["frame"]}')
        for name, count in previous.items():
            if count > 0 and sample['counts'].get(name, 0) == 0:
                result = unit_at(db, observation, name, sample['frame'])
                require(result['count'] == 0 and result['last_change_frame'] == sample['frame'],
                        'Disappearance lacks explicit zero')
                zeros += 1
        previous = sample['counts']
    for stream, lookup in [('economy', economy_at), ('composition', composition_at)]:
        segments = db.execute('SELECT * FROM stream_coverage WHERE observation_id=? AND stream=? ORDER BY start_frame',
                              (observation, stream)).fetchall()
        for segment in segments:
            require(lookup(db, observation, segment['start_frame'])['availability'] == 'known', 'Start not covered')
            require(lookup(db, observation, segment['end_frame'])['availability'] == 'known', 'End not covered')
        if segments:
            if segments[0]['start_frame'] > 0:
                require(lookup(db, observation, segments[0]['start_frame']-1)['availability'] != 'known', 'Before leak')
            require(lookup(db, observation, segments[-1]['end_frame']+1)['availability'] == 'after_coverage', 'After leak')
    return {'economy_samples': len(economy), 'composition_snapshots': len(composition), 'zero_transitions': zeros}


def bundle(path, owner):
    with zipfile.ZipFile(path) as archive:
        player = json.loads(archive.read('player.json'))
        require(player['owner'] == owner, 'Bundle owner mismatch')
        result = []
        for member, version in [('economy.json', 'replay-analysis-economy-v1'),
                                ('unit_counts.json', 'replay-analysis-unit-counts-v1')]:
            obj = json.loads(archive.read(member))
            require(obj['schema_version'] == version and obj['owner'] == owner, 'Unsupported artifact contract')
            result.append(obj['samples'])
        return result


def measure(db, path):
    try:
        sizes = {r['name']: r['bytes'] for r in db.execute('SELECT name,sum(pgsize) AS bytes FROM dbstat GROUP BY name')}
    except sqlite3.OperationalError as error:
        if 'no such table: dbstat' not in str(error):
            raise
        # The fallback opens only the committed candidate, never the source database.
        result = subprocess.run(['node', str(Path(__file__).with_name('dbstat.mjs')), str(path)],
                                check=True, capture_output=True, text=True)
        sizes = json.loads(result.stdout)
    objects = []
    total = Path(path).stat().st_size
    for obj in db.execute("SELECT name,type,tbl_name FROM sqlite_schema WHERE type IN ('table','index') ORDER BY type,name"):
        # All identifiers come from our static schema, never caller SQL.
        count = db.execute('SELECT count(*) FROM "' + obj['tbl_name'] + '"').fetchone()[0]
        size = sizes.get(obj['name'], 0)
        objects.append({**dict(obj), 'rows': count, 'bytes': size, 'MiB': size/2**20,
                        'percent': size/total*100, 'bytes_per_row': size/count if count else None})
    return {'bytes': total, 'MiB': total/2**20, 'page_size': db.execute('PRAGMA page_size').fetchone()[0],
            'page_count': db.execute('PRAGMA page_count').fetchone()[0],
            'freelist_pages': db.execute('PRAGMA freelist_count').fetchone()[0],
            'sqlite_schema_bytes': sizes.get('sqlite_schema', 0), 'objects': objects}


def query_plans(db, observation):
    c = db.execute("SELECT start_frame,end_frame FROM stream_coverage WHERE observation_id=? AND stream='composition' LIMIT 1",
                   (observation,)).fetchone()
    e = db.execute("SELECT start_frame,end_frame FROM stream_coverage WHERE observation_id=? AND stream='economy' LIMIT 1",
                   (observation,)).fetchone()
    unit = db.execute('''SELECT u.unit_type_id,u.unit_key FROM unit_count_changes c
        JOIN unit_types u USING(unit_type_id) WHERE c.observation_id=?
        ORDER BY c.unit_type_id,c.frame LIMIT 1''', (observation,)).fetchone()
    if unit is None:
        unit = db.execute(DOMAIN_SQL, (observation,)).fetchone()
    queries = {'coverage': (COVERAGE_SQL, (observation, 'economy', e['end_frame'])),
               'economy': (ECONOMY_SQL, (observation, e['start_frame'], e['end_frame'])),
               'workers': (ECONOMY_SQL.replace('frame,minerals,gas,workers,gathered_minerals,gathered_gas', 'workers'),
                           (observation, e['start_frame'], e['end_frame'])),
               'unit': (UNIT_SQL, (observation, unit['unit_type_id'], c['start_frame'], c['end_frame'])),
               'composition': (COMPOSITION_SQL, (observation, c['start_frame'], c['end_frame'], observation))}
    result = {}
    for key, (sql, args) in queries.items():
        plan = [r['detail'] for r in db.execute('EXPLAIN QUERY PLAN ' + sql, args)]
        require(any('PRIMARY KEY' in p for p in plan), f'{key} did not use primary key')
        require(not any('SCAN economy_changes' in p or 'SCAN unit_count_changes' in p or 'SCAN c' == p for p in plan),
                f'{key} unexpectedly scanned telemetry')
        result[key] = {'parameters': args, 'plan': plan, 'result': [dict(r) for r in db.execute(sql, args)]}
    result['unit']['state_at_time'] = unit_at(db, observation, unit['unit_key'], c['end_frame'])
    return result


def run(source, output):
    source, output = Path(source).resolve(), Path(output).resolve()
    require(output != source, 'Candidate cannot be the source database')
    require(output.name.endswith('.candidate.sqlite'), 'Output must end in .candidate.sqlite')
    require(not output.exists(), 'Refusing to overwrite an existing candidate')
    require(output.parent.is_dir(), 'Create a disposable output directory first')
    report_path = output.with_suffix('.report.json')
    require(not report_path.exists(), 'Refusing to overwrite a report')
    started = time.monotonic()
    with closing(readonly(source)) as v1:
        v1.execute('BEGIN')
        players = [dict(r) for r in v1.execute('SELECT * FROM players ORDER BY replay_id,owner')]
        replays = [dict(r) for r in v1.execute('SELECT * FROM replays ORDER BY replay_id')]
        require(replays and players, 'Empty source corpus')
        paths = {source}
        # Fingerprint all files in replay artifact directories, including redundant reports/raw copies.
        for replay in replays:
            root = Path(replay['manifest_path']).resolve().parent
            if root.name == 'legacy':
                root = root.parent
            require(not output.is_relative_to(root), 'Candidate must be outside source artifact directories')
            paths.update(p.resolve() for p in root.rglob('*') if p.is_file())
        paths.update(Path(p['zip_path']).resolve() for p in players)
        for replay in replays:
            raw = Path(replay['source_replay_path'])
            if not raw.is_file():
                candidates = list(Path(replay['manifest_path']).parent.parent.glob('raw/*.rep'))
                require(len(candidates) == 1, 'Cannot verify raw replay SHA: ' + replay['replay_id'])
                raw = candidates[0]
            require(digest(raw) == replay['replay_id'], 'Raw SHA mismatch')
            replay['verified_raw'] = raw.resolve()
            paths.add(raw.resolve())
        before = {str(p): digest(p) for p in sorted(paths)}
        v1_counts = {t: v1.execute('SELECT count(*) FROM '+t).fetchone()[0]
                     for t in ('replays','players','economy_samples','unit_count_samples')}
        # Exclusive creation prevents accidental reuse/overwrite, including a race after the checks.
        with output.open('xb'):
            pass
        db = sqlite3.connect(output)
        try:
            initialize(db)
            totals = {'economy_samples': 0, 'composition_snapshots': 0, 'zero_transitions': 0}
            source_unit_rows = 0
            now = int(time.time()*1000)
            for replay in replays:
                sha = replay['replay_id']
                group = [p for p in players if p['replay_id'] == sha]
                require(group, 'Replay without participation')
                bundles = [(p, *bundle(p['zip_path'], p['owner'])) for p in group]
                # Historical producer exclusions are unknown: expose only names demonstrated by this run.
                names = sorted({name for _, _, samples in bundles for s in samples for name in s['counts']})
                require(names, 'No composition observation domain')
                settings = json.dumps({'prototype': 1, 'source_sha': sha, 'unit_domain': names,
                    'producer_versions': 'unknown', 'composition_end': 'last_snapshot',
                    'artifact_sha256': [before[str(Path(p['zip_path']).resolve())] for p in group]}, sort_keys=True)
                fingerprint = hashlib.sha256(settings.encode()).hexdigest()
                rid = db.execute('INSERT INTO replays(sha256,byte_size,first_seen_at_ms,map_name) VALUES (?,?,?,?)',
                    (sha, replay['verified_raw'].stat().st_size, now, replay['map'])).lastrowid
                spec = db.execute('''INSERT INTO analysis_specs(fingerprint_sha256,bw_forge_version,reducer_version,
                    artifact_format,telemetry_contract,settings_json,frame_duration_num_ms,frame_duration_den,origin,created_at_ms)
                    VALUES (?,'unknown','unknown','player-bundle-v1','legacy-complete-dictionaries-v1',?,42,1,'legacy_import',?)''',
                    (fingerprint, settings, now)).lastrowid
                aid = db.execute('''INSERT INTO analysis_runs(analysis_key,replay_id,spec_id,status,outcome,queued_at_ms)
                    VALUES (?,?,?,'artifacts_ready','legacy_partial',?)''', (sha+':'+fingerprint, rid, spec, now)).lastrowid
                units = {}
                for name in names:
                    db.execute('INSERT INTO unit_types(unit_key,display_name) VALUES (?,?) ON CONFLICT(unit_key) DO NOTHING', (name,name))
                    units[name] = db.execute('SELECT unit_type_id FROM unit_types WHERE unit_key=?', (name,)).fetchone()[0]
                    db.execute('INSERT INTO analysis_unit_domain VALUES (?,?)', (spec,units[name]))
                for player, economy, composition in bundles:
                    source_unit_rows += sum(len(s['counts']) for s in composition)
                    pid = db.execute('''INSERT INTO participations(replay_id,owner,observed_name,observed_name_key,name_namespace,race)
                        VALUES (?,?,?,?,'legacy-unknown',?)''',
                        (rid,player['owner'],player['name'],player['name'].casefold(),player['race'].lower())).lastrowid
                    obs = db.execute('INSERT INTO analysis_participations(analysis_id,participation_id,replay_id) VALUES (?,?,?)',
                                     (aid,pid,rid)).lastrowid
                    import_economy(db, obs, economy)
                    zeros = import_composition_segment(db, obs, composition, units)
                    checks = validate(db, obs, economy, composition)
                    require(zeros == checks['zero_transitions'], 'Zero transition validation count differs')
                    for key in totals:
                        totals[key] += checks[key]
                db.execute("UPDATE analysis_runs SET status='indexed',indexed_at_ms=?,validation_json=? WHERE analysis_id=?",
                           (now,json.dumps({'all_source_samples_equal': True}),aid))
                db.execute('INSERT INTO current_analyses VALUES (?,?,?)', (rid,aid,now))
                db.commit()
                print(f'Validated {sha[:12]} ({len(group)} participations)', file=sys.stderr, flush=True)
            require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'Foreign key check failed')
            require(db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'Integrity check failed')
            require(db.execute('SELECT count(*) FROM replays').fetchone()[0] == v1_counts['replays'], 'Replay count differs')
            require(db.execute('SELECT count(*) FROM participations').fetchone()[0] == v1_counts['players'], 'Participation count differs')
            require(totals['economy_samples'] == v1_counts['economy_samples'], 'Economy inventory differs')
            require(source_unit_rows == v1_counts['unit_count_samples'], 'Composition inventory differs')
            reg = db.execute('''SELECT ap.observation_id FROM replays r JOIN participations p USING(replay_id)
                JOIN analysis_participations ap USING(participation_id) WHERE r.sha256=? AND p.owner=1''', (REGRESSION,)).fetchone()
            regression = {'availability': 'replay_not_in_source'}
            if reg:
                regression = unit_at(db, reg[0], 'zergling', 7275)
                require(regression['availability'] == 'known' and regression['count'] == 0, 'Known regression failed')
            observation = reg[0] if reg else 1
            plans = query_plans(db, observation)
            stats = measure(db, output)
            after = {str(p): digest(p) for p in sorted(paths)}
            require(before == after, 'Source DB/artifacts changed during prototype execution')
            report = {'candidate': str(output), 'source': str(source), 'v1_bytes': source.stat().st_size,
                'v1_rows': v1_counts, 'candidate_storage': stats, 'validation': totals,
                'regression': regression, 'lookups': plans,
                'reduction_percent': 100*(1-stats['bytes']/source.stat().st_size),
                'MB_per_replay': stats['bytes']/len(replays)/1e6,
                'source_files_unchanged': True, 'source_file_sha256': before,
                'elapsed_seconds': time.monotonic()-started,
                'scope_note': '12-table prototype only; excludes v1 build/supply/deaths. Not a full-v2 capacity measurement.',
                'coverage_note': 'Composition ends at last source snapshot; no inference to replay end. Domain limited to run-observed labels.'}
            with report_path.open('x', encoding='utf8') as f:
                json.dump(report, f, indent=2)
            return report
        finally:
            db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-v1', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = run(args.source_v1, args.output)
    print(json.dumps({k: result[k] for k in ('candidate','validation','regression','reduction_percent','MB_per_replay')}, indent=2))
