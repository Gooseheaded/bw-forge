"""Deterministic, database-free community alias catalog merge."""
import csv
import io
import json
import os
import re
import uuid
from pathlib import Path

from identities import FORMAT, chronology_boundary, normalize_name


KEY = re.compile(r'[a-z0-9][a-z0-9_-]*')
SHA = re.compile(r'[0-9a-f]{64}')


def object_value(value, allowed, label):
    if not isinstance(value, dict) or set(value) - set(allowed):
        raise ValueError('Invalid ' + label + ' object or unknown fields')
    return value


def text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('Expected a nonempty ' + label)
    return value


def stable_key(value, label='key'):
    value = text(value, label)
    if not KEY.fullmatch(value):
        raise ValueError('Stable keys must use lowercase ASCII letters, digits, _ or -')
    return value


def array(value, label):
    if not isinstance(value, list):
        raise ValueError(label + ' must be an array')
    return value


def references(values, known, label):
    result = sorted(set(stable_key(value, label) for value in array(values, label)))
    missing = set(result) - known
    if missing:
        raise ValueError('Dangling catalog references: ' + str(missing))
    return result


def normalize_catalog(value):
    """Validate and deterministically order an exported-style catalog without a DB."""
    catalog = object_value(value, ('schema_version', 'players', 'overrides', 'groups', 'scopes'), 'catalog')
    if catalog.get('schema_version') != FORMAT:
        raise ValueError('Unsupported identity config schema_version')
    result = {'schema_version': FORMAT, 'players': [], 'overrides': [], 'groups': [], 'scopes': []}
    known = {}
    for section in ('players', 'groups', 'scopes'):
        rows = array(catalog.get(section, []), section)
        allowed = {'players': ('key', 'display_name', 'aliases'),
                   'groups': ('key', 'display_name', 'players'),
                   'scopes': ('key', 'display_name', 'self', 'opponent', 'filters', 'replay_sha256')}[section]
        keys = [stable_key(object_value(row, allowed, section).get('key')) for row in rows]
        if len(keys) != len(set(keys)):
            raise ValueError('Duplicate stable keys in ' + section)
        known[section] = set(keys)
    aliases = set()
    for player in catalog.get('players', []):
        row = {'key': player['key'], 'display_name': text(player.get('display_name'), 'display name'), 'aliases': []}
        for alias in array(player.get('aliases', []), 'aliases'):
            alias = object_value(alias, ('namespace', 'name'), 'alias')
            namespace, name = text(alias.get('namespace'), 'namespace'), text(alias.get('name'), 'alias')
            identity = namespace, normalize_name(name)
            if identity in aliases:
                raise ValueError('Duplicate or conflicting alias: ' + str(identity))
            aliases.add(identity)
            row['aliases'].append({'namespace': namespace, 'name': name})
        row['aliases'].sort(key=lambda alias: (alias['namespace'], normalize_name(alias['name']), alias['name']))
        result['players'].append(row)
    overrides = set()
    for override in array(catalog.get('overrides', []), 'overrides'):
        override = object_value(override, ('replay_sha256', 'owner', 'player'), 'override')
        replay, owner, player = override.get('replay_sha256'), override.get('owner'), override.get('player')
        if not isinstance(replay, str) or not SHA.fullmatch(replay):
            raise ValueError('Expected lowercase replay SHA256')
        if type(owner) is not int or owner < 0:
            raise ValueError('Override owner must be a nonnegative integer')
        player = stable_key(player, 'player key')
        if player not in known['players']:
            raise ValueError('Dangling catalog references: ' + player)
        if (replay, owner) in overrides:
            raise ValueError('Duplicate participation override')
        overrides.add((replay, owner))
        result['overrides'].append({'replay_sha256': replay, 'owner': owner, 'player': player})
    for group in catalog.get('groups', []):
        result['groups'].append({'key': group['key'], 'display_name': text(group.get('display_name'), 'display name'),
                                 'players': references(group.get('players', []), known['players'], 'player key')})
    for scope in catalog.get('scopes', []):
        row = {'key': scope['key'], 'display_name': text(scope.get('display_name'), 'display name')}
        for role in ('self', 'opponent'):
            selector = object_value(scope.get(role, {}), ('players', 'groups'), role)
            row[role] = {'players': references(selector.get('players', []), known['players'], 'player key'),
                         'groups': references(selector.get('groups', []), known['groups'], 'group key')}
        filters = object_value(scope.get('filters', {}),
                               ('race', 'opponent_race', 'matchup', 'map', 'played_from', 'played_before'), 'filters')
        row['filters'] = {name: text(value, 'filter') for name, value in filters.items()}
        for name in ('race', 'opponent_race'):
            if name in filters and filters[name] not in ('zerg', 'terran', 'protoss', 'unknown'):
                raise ValueError('Invalid scope race')
        for name in ('played_from', 'played_before'):
            if name in filters:
                chronology_boundary(filters[name])
        if ('played_from' in filters and 'played_before' in filters and
                chronology_boundary(filters['played_from']) >= chronology_boundary(filters['played_before'])):
            raise ValueError('Scope played_from must be earlier than played_before')
        replays = array(scope.get('replay_sha256', []), 'replay_sha256')
        if any(not isinstance(replay, str) or not SHA.fullmatch(replay) for replay in replays):
            raise ValueError('Expected lowercase replay SHA256')
        row['replay_sha256'] = sorted(set(replays))
        result['scopes'].append(row)
    for section in ('players', 'groups', 'scopes'):
        result[section].sort(key=lambda row: row['key'])
    result['overrides'].sort(key=lambda row: (row['replay_sha256'], row['owner']))
    return result


def parse_rows(path, requested_format=None):
    source = Path(path)
    format_name = requested_format or source.suffix.lower().removeprefix('.')
    if format_name not in ('csv', 'json'):
        raise ValueError('Import format must be csv or json')
    raw = source.read_text(encoding='utf-8-sig')
    if format_name == 'csv':
        reader = csv.DictReader(io.StringIO(raw, newline=''))
        if reader.fieldnames is None:
            raise ValueError('CSV header is required')
        fields = [field.strip() for field in reader.fieldnames]
        if len(fields) != len(set(fields)) or set(fields) - {'player_key', 'display_name', 'namespace', 'alias'}:
            raise ValueError('CSV contains duplicate or unknown columns')
        if not {'player_key', 'namespace', 'alias'} <= set(fields):
            raise ValueError('CSV requires player_key, namespace, and alias columns')
        rows = []
        for number, raw_row in enumerate(reader, 2):
            if None in raw_row:
                raise ValueError('CSV row has extra columns at line ' + str(number))
            row = {fields[index]: value for index, value in enumerate(raw_row.values())}
            rows.append(row)
    else:
        value = json.loads(raw)
        if isinstance(value, dict):
            value = object_value(value, ('aliases',), 'JSON import').get('aliases')
        rows = array(value, 'JSON aliases')
    result = []
    for number, value in enumerate(rows, 1):
        row = object_value(value, ('player_key', 'display_name', 'namespace', 'alias'), 'import row')
        normalized = {'player_key': stable_key(row.get('player_key'), 'player_key'),
                      'namespace': text(row.get('namespace'), 'namespace'),
                      'alias': text(row.get('alias'), 'alias')}
        if row.get('display_name') not in (None, ''):
            normalized['display_name'] = text(row.get('display_name'), 'display_name')
        normalized['row'] = number
        result.append(normalized)
    return result


def merge_catalog(base, rows):
    catalog = normalize_catalog(base)
    players = {player['key']: player for player in catalog['players']}
    existing = {(alias['namespace'], normalize_name(alias['name'])): player['key']
                for player in catalog['players'] for alias in player['aliases']}
    conflicts = []
    eligible = []
    for row in rows:
        player = players.get(row['player_key'])
        if player is None:
            conflicts.append({'type': 'unknown_player', 'row': row['row'], 'playerKey': row['player_key'],
                              'message': 'Unknown canonical player_key: ' + row['player_key']})
        elif 'display_name' in row and row['display_name'] != player['display_name']:
            conflicts.append({'type': 'display_name_mismatch', 'row': row['row'], 'playerKey': row['player_key'],
                              'expected': player['display_name'], 'actual': row['display_name'],
                              'message': 'display_name conflicts with canonical metadata for ' + row['player_key']})
        else:
            eligible.append(row)
    grouped = {}
    for row in eligible:
        identity = row['namespace'], normalize_name(row['alias'])
        grouped.setdefault(identity, []).append(row)
    aliases_added = aliases_unchanged = 0
    for identity in sorted(grouped):
        group = sorted(grouped[identity], key=lambda row: (row['player_key'], row['alias'], row['row']))
        targets = sorted(set(row['player_key'] for row in group))
        if len(targets) > 1:
            conflicts.append({'type': 'input_alias_collision', 'namespace': identity[0], 'normalizedAlias': identity[1],
                              'playerKeys': targets, 'message': 'Imported alias maps to multiple canonical players'})
            continue
        target = targets[0]
        current = existing.get(identity)
        if current is not None and current != target:
            conflicts.append({'type': 'alias_collision', 'namespace': identity[0], 'normalizedAlias': identity[1],
                              'existingPlayerKey': current, 'importedPlayerKey': target,
                              'message': 'Alias already maps to a different canonical player'})
        elif current == target:
            aliases_unchanged += 1
        else:
            chosen = group[0]
            players[target]['aliases'].append({'namespace': chosen['namespace'], 'name': chosen['alias']})
            existing[identity] = target
            aliases_added += 1
    merged = normalize_catalog(catalog)
    conflicts.sort(key=lambda conflict: (str(conflict.get('type')), str(conflict.get('namespace', '')),
                                         str(conflict.get('normalizedAlias', '')), int(conflict.get('row', 0))))
    return merged, aliases_added, aliases_unchanged, conflicts


def encoded(catalog):
    return (json.dumps(catalog, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def atomic_write(path, content, before_replace=None):
    target = Path(path).resolve()
    if not target.parent.is_dir():
        raise ValueError('Output directory does not exist: ' + str(target.parent))
    temporary = target.parent / ('.' + target.name + '.' + str(uuid.uuid4()) + '.tmp')
    try:
        with temporary.open('xb') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        if target.exists():
            os.chmod(temporary, target.stat().st_mode)
        if before_replace:
            before_replace(temporary, target)
        os.replace(temporary, target)
        if os.name != 'nt':
            descriptor = os.open(target.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def administer(input_path, base_path, output_path, requested_format=None, dry_run=False, before_replace=None):
    base = normalize_catalog(json.loads(Path(base_path).read_text(encoding='utf-8-sig')))
    merged, added, unchanged, conflicts = merge_catalog(base, parse_rows(input_path, requested_format))
    content = encoded(merged)
    output = Path(output_path).resolve()
    current = output.read_bytes() if output.is_file() else None
    would_change = current != content
    result = {'status': 'dry-run' if dry_run else ('conflict' if conflicts else ('no-op' if not would_change else 'written')),
              'playersAdded': 0, 'aliasesAdded': added, 'aliasesUnchanged': unchanged,
              'conflicts': len(conflicts), 'outputWouldChange': would_change,
              'conflictDetails': conflicts, 'output': str(output)}
    if not dry_run and not conflicts and would_change:
        atomic_write(output, content, before_replace)
    return result
