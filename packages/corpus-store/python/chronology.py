"""Replay chronology administration; extraction and SHA verification happen in TypeScript."""


def serialize(row):
    return {'replaySha256': row['sha256'], 'playedAtUnixSeconds': row['played_at_unix_s']}


def list_replays(db):
    rows = db.execute('SELECT sha256,played_at_unix_s FROM replays ORDER BY sha256').fetchall()
    return {'replays': [serialize(row) for row in rows]}


def update_missing(db, args):
    values = args.get('values')
    if not isinstance(values, list):
        raise ValueError('Chronology values must be an array')
    normalized = []
    seen = set()
    for value in values:
        if not isinstance(value, dict) or set(value) != {'replaySha256', 'playedAtUnixSeconds'}:
            raise ValueError('Invalid chronology value')
        sha, timestamp = value['replaySha256'], value['playedAtUnixSeconds']
        if not isinstance(sha, str) or len(sha) != 64 or any(c not in '0123456789abcdef' for c in sha):
            raise ValueError('Invalid replay SHA256')
        if type(timestamp) is not int or not 1 <= timestamp <= 0xffffffff:
            raise ValueError('Invalid replay-declared timestamp')
        if sha in seen:
            raise ValueError('Duplicate chronology update')
        seen.add(sha)
        normalized.append((timestamp, sha))
    db.execute('BEGIN IMMEDIATE')
    try:
        updated = 0
        for timestamp, sha in normalized:
            cursor = db.execute('UPDATE replays SET played_at_unix_s=? WHERE sha256=? AND played_at_unix_s IS NULL', (timestamp, sha))
            updated += cursor.rowcount
        db.commit()
        return {'updated': updated}
    except BaseException:
        db.rollback()
        raise


def administer(db_path, operation, args, initialize):
    from jobs import connect
    with connect(db_path, initialize) as db:
        if operation == 'list':
            return list_replays(db)
        if operation == 'update-missing':
            return update_missing(db, args)
        raise ValueError('Unknown replay chronology operation: ' + operation)
