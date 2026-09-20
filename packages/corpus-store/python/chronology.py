"""Replay metadata administration; extraction and SHA verification happen in TypeScript."""


def serialize(row):
    return {'replaySha256': row['sha256'], 'playedAtUnixSeconds': row['played_at_unix_s'],
            'mapName': row['map_name']}


def list_replays(db):
    rows = db.execute('SELECT sha256,played_at_unix_s,map_name FROM replays ORDER BY sha256').fetchall()
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


def update_missing_map_names(db, args):
    values = args.get('values')
    if not isinstance(values, list):
        raise ValueError('Map-name values must be an array')
    normalized = []
    seen = set()
    for value in values:
        if not isinstance(value, dict) or set(value) != {'replaySha256', 'mapName'}:
            raise ValueError('Invalid map-name value')
        sha, map_name = value['replaySha256'], value['mapName']
        if not isinstance(sha, str) or len(sha) != 64 or any(c not in '0123456789abcdef' for c in sha):
            raise ValueError('Invalid replay SHA256')
        if not isinstance(map_name, str) or not map_name.strip():
            raise ValueError('Invalid replay-declared map name')
        if sha in seen:
            raise ValueError('Duplicate map-name update')
        seen.add(sha)
        normalized.append((map_name, sha))
    db.execute('BEGIN IMMEDIATE')
    try:
        updated = 0
        preserved = 0
        for map_name, sha in normalized:
            cursor = db.execute("UPDATE replays SET map_name=? WHERE sha256=? AND (map_name IS NULL OR trim(map_name)='')", (map_name, sha))
            updated += cursor.rowcount
            if cursor.rowcount == 0:
                row = db.execute('SELECT map_name FROM replays WHERE sha256=?', (sha,)).fetchone()
                if row is not None and row['map_name'] is not None and row['map_name'].strip():
                    preserved += 1
        db.commit()
        return {'updated': updated, 'preserved': preserved}
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
        if operation == 'update-missing-map-names':
            return update_missing_map_names(db, args)
        raise ValueError('Unknown replay chronology operation: ' + operation)
