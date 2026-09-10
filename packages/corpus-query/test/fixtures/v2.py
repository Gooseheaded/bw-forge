"""Real v2 ingestion fixtures, sharing corpus-store's artifact oracle (no handwritten schema)."""
import importlib.util
import json
import sqlite3
import sys
import zipfile
from pathlib import Path

source = Path(__file__).resolve().parents[3] / 'corpus-store/tests/test_store.py'
spec = importlib.util.spec_from_file_location('store_tests', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
target = Path(sys.argv[1])
target.mkdir(parents=True, exist_ok=True)
database = target / 'v2.sqlite'
ids = []

for index in range(2):
    fixture = module.StoreTests()
    fixture.setUp()
    try:
        raw = b'query-fixture-' + str(index).encode()
        replay_sha = module.store.sha(raw)
        ids.append(replay_sha)
        (fixture.artifacts/'raw.rep').write_bytes(raw)
        fixture.manifest['replay_id'] = replay_sha
        fixture.manifest['replay_analysis']['map'] = 'Map' + str(index)
        identity_fixture = '--identities' in sys.argv
        if identity_fixture:
            fixture.player['name'] = ['Gooseheaded', 'G00se'][index]
            fixture.manifest['players'][0]['name'] = fixture.player['name']
        enemy_name = ['FirstLaw', 'Dex'][index] if identity_fixture else 'Enemy'
        fixture.manifest['players'].append({'owner': 1, 'name': enemy_name, 'race': 'terran', 'legacy_zip_path': 'enemy.zip'})
        (fixture.artifacts/'manifest.json').write_text(json.dumps({
            'schema_version': 'replay-analysis-manifest-v1', 'replay_id': replay_sha,
            'players': fixture.manifest['players']}))
        fixture.save_manifest()
        with zipfile.ZipFile(fixture.artifacts/'player.zip') as archive:
            members = {name: archive.read(name) for name in archive.namelist()}
        with zipfile.ZipFile(fixture.artifacts/'enemy.zip', 'w') as archive:
            for name, data in members.items():
                if name.endswith('.json'):
                    obj = json.loads(data)
                    obj['owner'] = 1
                    if name == 'player.json':
                        obj.update(name=enemy_name, race='terran')
                    if name == 'deaths.json':
                        for sample in obj['samples']:
                            sample['death'].update(owner=1,unit_type='marine')
                    if name == 'unit_counts.json':
                        for sample in obj['samples']:
                            sample['counts'] = {'marine': sum(sample['counts'].values())}
                    data = json.dumps(obj).encode()
                archive.writestr(name, data)
        if index == 0:
            original = fixture.composition
            fixture.composition = [{'frame': 1, 'counts': {'obsolete': 999}}]
            fixture.economy[0]['minerals'] = 999
            fixture.builds += '00:00 old_marker\n'
            fixture.save_bundle()
            module.store.ingest_replay_analysis(database, fixture.manifest_path)
            fixture.composition = original
            fixture.builds = '00:01 spawning_pool\n00:01 spawning_pool\n00:02 zergling\n'
        fixture.economy[0]['minerals'] = 77 + index*20
        fixture.save_bundle()
        module.store.ingest_replay_analysis(database, fixture.manifest_path)
    finally:
        fixture.tearDown()

with sqlite3.connect(database) as connection:
    connection.execute('UPDATE replays SET played_at_unix_s=? WHERE sha256=?', (1735689600, ids[0]))
    if '--unknown-second' not in sys.argv:
        connection.execute('UPDATE replays SET played_at_unix_s=? WHERE sha256=?', (1767225600, ids[1]))
    if '--pre-m8' in sys.argv:
        connection.execute('DROP INDEX IF EXISTS replays_by_played_at')
        connection.execute('ALTER TABLE replays DROP COLUMN played_at_unix_s')
        connection.execute("DELETE FROM corpus_migrations WHERE revision=3")
print(json.dumps({'dbPath': str(database), 'replayIds': ids}))
