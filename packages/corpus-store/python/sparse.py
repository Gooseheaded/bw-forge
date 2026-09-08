"""Shared sparse Corpus v2 storage and source reconstruction, promoted from Milestone 1.

Requires Python >=3.11 and SQLite >=3.37 (STRICT tables).
State reconstruction is constrained to each stream coverage segment.
"""
import math
import sqlite3
import time
import uuid
from pathlib import Path

FIELDS = ('minerals', 'gas', 'workers', 'gathered_minerals', 'gathered_gas')
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
                'corpus-store'))


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
