"""Authoritative, versioned identity catalog administration. No replay evidence writes."""
import json
import re
import sqlite3
import time
from pathlib import Path
from migrations import require_v2, migrate_in_transaction

FORMAT = 'bw-forge-identities-v1'


def normalize_name(name):
    # corpus_metadata.name_normalizer = python-casefold-v1 (no trimming/NFKC).
    return name.casefold()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def obj(value, allowed):
    if not isinstance(value, dict) or set(value) - set(allowed):
        raise ValueError('Invalid object or unknown fields: ' + str(value))
    return value


def text(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('Expected a nonempty string')
    return value


def key(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', value):
        raise ValueError('Stable keys must use lowercase ASCII letters, digits, _ or -')
    return value


def sha(value):
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{64}', value):
        raise ValueError('Expected lowercase replay SHA256')
    return value


def array(value):
    if not isinstance(value, list):
        raise ValueError('Expected array')
    return value


def references(values, known):
    result = sorted(set(key(v) for v in array(values)))
    if set(result) - known:
        raise ValueError('Dangling catalog references: ' + str(set(result) - known))
    return result


def validate(db, config):
    require_v2(db)
    obj(config, ('schema_version', 'players', 'overrides', 'groups', 'scopes'))
    if config.get('schema_version') != FORMAT:
        raise ValueError('Unsupported identity config schema_version')
    result = {'schema_version': FORMAT, 'players': [], 'overrides': [], 'groups': [], 'scopes': []}
    known = {}
    for section in ('players', 'groups', 'scopes'):
        values = array(config.get(section, []))
        keys = [key(obj(v, {'players': ('key','display_name','aliases'),
                           'groups': ('key','display_name','players'),
                           'scopes': ('key','display_name','self','opponent','filters','replay_sha256')}[section]).get('key')) for v in values]
        if len(keys) != len(set(keys)):
            raise ValueError('Duplicate stable keys in ' + section)
        known[section] = set(keys)
    aliases = set()
    for p in config.get('players', []):
        row = {'key': p['key'], 'display_name': text(p.get('display_name')), 'aliases': []}
        for a in array(p.get('aliases', [])):
            obj(a, ('namespace', 'name'))
            ns, name = text(a.get('namespace')), text(a.get('name'))
            alias = (ns, normalize_name(name))
            if alias in aliases:
                raise ValueError('Duplicate or conflicting alias: ' + str(alias))
            aliases.add(alias)
            row['aliases'].append({'namespace': ns, 'name': name})
        row['aliases'].sort(key=lambda a: (a['namespace'], normalize_name(a['name'])))
        result['players'].append(row)
    overrides = set()
    for o in array(config.get('overrides', [])):
        obj(o, ('replay_sha256','owner','player'))
        replay = sha(o.get('replay_sha256'))
        owner = o.get('owner')
        if type(owner) is not int or owner < 0:
            raise ValueError('Override owner must be a nonnegative integer')
        references([o.get('player')], known['players'])
        if (replay, owner) in overrides:
            raise ValueError('Duplicate participation override')
        overrides.add((replay, owner))
        if not db.execute('SELECT 1 FROM participations p JOIN replays r USING(replay_id) WHERE r.sha256=? AND p.owner=?', (replay,owner)).fetchone():
            raise ValueError('Override references nonexistent replay+owner')
        result['overrides'].append(dict(o))
    for g in config.get('groups', []):
        result['groups'].append({'key':g['key'], 'display_name':text(g.get('display_name')),
                                 'players':references(g.get('players', []), known['players'])})
    for s in config.get('scopes', []):
        row = {'key':s['key'], 'display_name':text(s.get('display_name'))}
        for role in ('self','opponent'):
            selector = obj(s.get(role, {}), ('players','groups'))
            row[role] = {kind:references(selector.get(kind, []), known[kind]) for kind in ('players','groups')}
        filters = obj(s.get('filters', {}), ('race','opponent_race','matchup','map'))
        row['filters'] = {k:text(v) for k,v in filters.items()}
        for k in ('race','opponent_race'):
            if k in filters and filters[k] not in ('zerg','terran','protoss','unknown'):
                raise ValueError('Invalid scope race')
        row['replay_sha256'] = sorted(set(sha(v) for v in array(s.get('replay_sha256', []))))
        result['scopes'].append(row)
    for section in ('players','groups','scopes'):
        result[section].sort(key=lambda v:v['key'])
    result['overrides'].sort(key=lambda o:(o['replay_sha256'],o['owner']))
    return result


def export_catalog(db):
    require_v2(db)
    result = {'schema_version':FORMAT, 'players':[], 'overrides':[], 'groups':[], 'scopes':[]}
    if not db.execute("SELECT 1 FROM sqlite_schema WHERE name='canonical_players'").fetchone():
        return result
    for pid, pkey, display in db.execute('SELECT player_id,player_key,display_name FROM canonical_players ORDER BY player_key'):
        aliases = [{'namespace':ns,'name':name} for ns,name in db.execute(
            'SELECT name_namespace,alias_name FROM player_aliases WHERE player_id=? ORDER BY name_namespace,observed_name_key', (pid,))]
        result['players'].append({'key':pkey,'display_name':display,'aliases':aliases})
    result['overrides'] = [{'replay_sha256':sha,'owner':owner,'player':player} for sha,owner,player in db.execute('''
        SELECT r.sha256,p.owner,c.player_key FROM participation_identity_overrides o
        JOIN participations p USING(participation_id) JOIN replays r USING(replay_id)
        JOIN canonical_players c USING(player_id) ORDER BY r.sha256,p.owner''')]
    for gid,gkey,display in db.execute('SELECT * FROM player_groups ORDER BY group_key'):
        players = [r[0] for r in db.execute('SELECT player_key FROM player_group_members JOIN canonical_players USING(player_id) WHERE group_id=? ORDER BY player_key', (gid,))]
        result['groups'].append({'key':gkey,'display_name':display,'players':players})
    for sid,skey,display,filters in db.execute('SELECT * FROM query_scopes ORDER BY scope_key'):
        row = {'key':skey,'display_name':display,'filters':json.loads(filters)}
        for role in ('self','opponent'):
            row[role] = {
                'players':[r[0] for r in db.execute('SELECT player_key FROM scope_players JOIN canonical_players USING(player_id) WHERE scope_id=? AND role=? ORDER BY player_key', (sid,role))],
                'groups':[r[0] for r in db.execute('SELECT group_key FROM scope_groups JOIN player_groups USING(group_id) WHERE scope_id=? AND role=? ORDER BY group_key', (sid,role))]}
        row['replay_sha256'] = [r[0] for r in db.execute('SELECT replay_sha256 FROM scope_replays WHERE scope_id=? ORDER BY replay_sha256', (sid,))]
        result['scopes'].append(row)
    return result


def apply_catalog(db, config):
    config = validate(db, config)  # Entire document and DB references before any writes.
    db.execute('BEGIN IMMEDIATE')
    try:
        migrate_in_transaction(db)
        if canonical(export_catalog(db)) == canonical(config):
            db.commit()
            return {'status':'no-op'}
        for table in ('scope_players','scope_groups','scope_replays','player_group_members','participation_identity_overrides','player_aliases'):
            db.execute('DELETE FROM ' + table)
        ids = {}
        now = int(time.time()*1000)
        for section, table, column, idcol in (
                ('players','canonical_players','player_key','player_id'),
                ('groups','player_groups','group_key','group_id'),
                ('scopes','query_scopes','scope_key','scope_id')):
            ids[section] = {}
            for row in config[section]:
                if section == 'players':
                    db.execute('''INSERT INTO canonical_players(player_key,display_name,created_at_ms,updated_at_ms) VALUES (?,?,?,?)
                        ON CONFLICT(player_key) DO UPDATE SET display_name=excluded.display_name,updated_at_ms=excluded.updated_at_ms
                        WHERE display_name<>excluded.display_name''', (row['key'],row['display_name'],now,now))
                else:
                    extra = ',filters_json' if section == 'scopes' else ''
                    values = [row['key'],row['display_name']] + ([canonical(row['filters'])] if extra else [])
                    update = ',filters_json=excluded.filters_json' if extra else ''
                    db.execute(f'INSERT INTO {table}({column},display_name{extra}) VALUES ({",".join("?" for _ in values)}) ON CONFLICT({column}) DO UPDATE SET display_name=excluded.display_name{update}', values)
                ids[section][row['key']] = db.execute(f'SELECT {idcol} FROM {table} WHERE {column}=?', (row['key'],)).fetchone()[0]
            keys = list(ids[section])
            db.execute(f'DELETE FROM {table} WHERE {column} NOT IN ({",".join("?" for _ in keys)})', keys)
        for p in config['players']:
            for a in p['aliases']:
                db.execute('INSERT INTO player_aliases VALUES (?,?,?,?)', (a['namespace'],normalize_name(a['name']),a['name'],ids['players'][p['key']]))
        for o in config['overrides']:
            db.execute('''INSERT INTO participation_identity_overrides SELECT p.participation_id,? FROM participations p
                JOIN replays r USING(replay_id) WHERE r.sha256=? AND p.owner=?''', (ids['players'][o['player']],o['replay_sha256'],o['owner']))
        for g in config['groups']:
            db.executemany('INSERT INTO player_group_members VALUES (?,?)', [(ids['groups'][g['key']],ids['players'][p]) for p in g['players']])
        for s in config['scopes']:
            sid = ids['scopes'][s['key']]
            for role in ('self','opponent'):
                for kind in ('players','groups'):
                    db.executemany(f'INSERT INTO scope_{kind} VALUES (?,?,?)', [(sid,role,ids[kind][k]) for k in s[role][kind]])
            db.executemany('INSERT INTO scope_replays VALUES (?,?)', [(sid,r) for r in s['replay_sha256']])
        if db.execute('PRAGMA foreign_key_check').fetchall():
            raise ValueError('Identity foreign key validation failed')
        db.commit()
        return {'status':'applied'}
    except BaseException:
        db.rollback()
        raise


def administer(db_path, config_path=None):
    uri = Path(db_path).resolve().as_uri() + ('?mode=rw' if config_path else '?mode=ro')
    with sqlite3.connect(uri, uri=True) as db:
        db.execute('PRAGMA foreign_keys=ON')
        return apply_catalog(db, json.loads(Path(config_path).read_text(encoding='utf-8-sig'))) if config_path else export_catalog(db)
