import importlib.util
from contextlib import closing
import json
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('store', Path(__file__).parents[1]/'python/store.py')
store = importlib.util.module_from_spec(spec)
spec.loader.exec_module(store)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.artifacts = self.root/'replay'
        self.artifacts.mkdir()
        self.db = self.root/'v2.sqlite'
        self.manifest_path = self.artifacts/'replay-manifest.json'
        (self.artifacts/'raw.rep').write_bytes(b'replay')
        self.player = {'owner': 0, 'name': 'Player', 'race': 'zerg'}
        self.manifest = {'schema_version': 'bw-forge-replay-manifest-v1',
            'replay_id': store.sha(b'replay'), 'source': {'copied_path': 'raw.rep'},
            'legacy': {'manifest_path': 'manifest.json'},
            'replay_analysis': {'map': 'Map', 'duration_seconds': 10},
            'players': [{**self.player, 'legacy_zip_path': 'player.zip'}]}
        (self.artifacts/'manifest.json').write_text(json.dumps({
            'schema_version': 'replay-analysis-manifest-v1', 'replay_id': self.manifest['replay_id'],
            'players': [self.player]}))
        self.save_manifest()
        self.economy = [{'frame': n, 'minerals': 50 if n < 3 else 60, 'gas': 0,
                         'workers': 4 if n != 2 else None} for n in (1,2,3,5)]
        self.composition = [{'frame': 1, 'counts': {'zergling': 2}},
                            {'frame': 2, 'counts': {}}, {'frame': 5, 'counts': {'zergling': 1}}]
        self.supply = [{'frame': n, 'current': c, 'max': 18} for n,c in ((1,8),(2,8),(3,10))]
        self.deaths = [{'frame': 2, 'death': {'id': n, 'owner': 0, 'unit_type': 'zergling',
            'unit_type_id': 37, 'category': 'ground', 'pos_x': 12, 'pos_y': 34}} for n in (10,11)]
        self.builds = '00:01 spawning_pool\n00:01 spawning_pool\n00:02 zergling\n'
        self.save_bundle()

    def tearDown(self):
        self.tmp.cleanup()

    def save_manifest(self):
        self.manifest_path.write_text(json.dumps(self.manifest))

    def save_bundle(self, compression=zipfile.ZIP_STORED):
        with zipfile.ZipFile(self.artifacts/'player.zip', 'w', compression=compression) as z:
            z.writestr('player.json', json.dumps({**self.player, 'schema_version': 'replay-analysis-player-bundle-v1'}))
            z.writestr('build_order.txt', self.builds)
            for name, samples in [('economy',self.economy), ('unit_counts',self.composition),
                                  ('supply',self.supply), ('deaths',self.deaths)]:
                z.writestr(name+'.json', json.dumps({'schema_version': 'replay-analysis-'+name.replace('_','-')+'-v1',
                                                    'owner': 0, 'samples': samples}))

    def ingest(self):
        return store.ingest_replay_analysis(self.db,self.manifest_path)

    def rows(self, sql):
        with closing(sqlite3.connect(self.db)) as db:
            return db.execute(sql).fetchall()

    def test_first_ingestion_matches_sources_and_integrity(self):
        before = {p.name: store.sha(p.read_bytes()) for p in self.artifacts.iterdir()}
        result = self.ingest()
        self.assertEqual(result['status'], 'indexed')
        self.assertEqual(result['validation'], {'builds': 3, 'deaths': 2, 'supply_changes': 2,
            'economy_samples': 4, 'composition_snapshots': 3, 'zero_transitions': 1})
        self.assertEqual(self.rows('SELECT frame,count FROM unit_count_changes ORDER BY frame'), [(1,2),(2,0),(5,1)])
        self.assertEqual(self.rows('SELECT frame,current,max FROM supply_changes ORDER BY frame'), [(1,8,18),(3,10,18)])
        self.assertEqual(self.rows('SELECT frame,source_unit_id FROM death_events ORDER BY occurrence'), [(2,10),(2,11)])
        self.assertEqual(self.rows('SELECT frame,time_seconds,frame_min,frame_max FROM build_events ORDER BY occurrence'),
                         [(None,1,24,47),(None,1,24,47),(None,2,48,71)])
        self.assertEqual(self.rows('SELECT frame,minerals,gas,workers FROM economy_changes ORDER BY frame'),
                         [(1,50,0,4),(2,50,0,None),(3,60,0,4),(5,60,0,4)])
        self.assertEqual(self.rows("SELECT start_frame,end_frame FROM stream_coverage WHERE stream='economy' ORDER BY start_frame"), [(1,3),(5,5)])
        self.assertEqual(self.rows('PRAGMA foreign_key_check'), [])
        self.assertEqual(self.rows('PRAGMA integrity_check'), [('ok',)])
        self.assertEqual(before, {p.name: store.sha(p.read_bytes()) for p in self.artifacts.iterdir()})

    def test_idempotence_repack_and_stable_participations(self):
        first = self.ingest()
        ids = self.rows('SELECT * FROM participations')
        original_bytes = self.db.read_bytes()
        self.save_bundle(zipfile.ZIP_DEFLATED)
        same = self.ingest()
        self.assertEqual(same['status'],'no-op')
        self.assertEqual(same['analysisKey'],first['analysisKey'])
        self.assertEqual(original_bytes,self.db.read_bytes())
        self.economy[0]['minerals'] = 51
        self.save_bundle()
        second = self.ingest()
        self.assertNotEqual(second['analysisId'],first['analysisId'])
        self.assertEqual(self.rows('SELECT * FROM participations'),ids)
        self.assertEqual(self.rows('SELECT analysis_id FROM current_analyses'),[(second['analysisId'],)])
        self.assertEqual(self.rows('SELECT count(*) FROM analysis_specs'),[(1,)])
        self.assertEqual(self.rows('SELECT count(*) FROM analysis_runs'),[(2,)])
        # Reimporting a former run is a true no-op, not a current-pointer rollback.
        self.economy[0]['minerals'] = 50
        self.save_bundle()
        self.assertEqual(self.ingest()['status'],'no-op')
        self.assertEqual(self.rows('SELECT analysis_id FROM current_analyses'),[(second['analysisId'],)])

    def test_spec_inputs_and_unknown_history(self):
        self.ingest()
        settings = json.loads(self.rows('SELECT settings_json FROM analysis_specs')[0][0])
        self.assertEqual(settings['producer']['reducer_version'],'unknown')
        self.assertIsNone(settings['producer']['bwsim_wasm_sha256'])
        previous = store.prepare(self.manifest_path)[5]
        for key, value in [('bw_forge_version','1'),('reducer_version','2'),('bwsim_version','3'),
                           ('bwsim_wasm_sha256','a'*64),('asset_pack_sha256','b'*64),
                           ('telemetry_contract','telemetry-2'),('settings',{'speed': 2})]:
            self.manifest['analysis_spec'] = {key: value}
            self.save_manifest()
            self.assertNotEqual(store.prepare(self.manifest_path)[5],previous, key)
        self.ingest()
        self.assertEqual(self.rows('SELECT count(*) FROM analysis_specs'),[(2,)])

    def test_parse_failure_does_not_touch_database(self):
        self.ingest()
        before = self.db.read_bytes()
        self.economy[0]['minerals'] = -1
        self.save_bundle()
        with self.assertRaises(ValueError):
            self.ingest()
        self.assertEqual(self.db.read_bytes(),before)

    def test_transaction_failure_and_atomic_current(self):
        first = self.ingest()
        self.economy[0]['minerals'] = 51
        self.save_bundle()
        original = store.sparse.validate
        def inspect_current(*args):
            # Another connection sees only the prior committed run during validation.
            self.assertEqual(self.rows('SELECT analysis_id FROM current_analyses'),[(first['analysisId'],)])
            self.assertEqual(self.rows('SELECT count(*) FROM analysis_runs'),[(1,)])
            return original(*args)
        with patch.object(store.sparse, 'validate', side_effect=inspect_current):
            second = self.ingest()
        self.assertEqual(self.rows('SELECT analysis_id FROM current_analyses'),[(second['analysisId'],)])
        self.economy[0]['minerals'] = 52
        self.save_bundle()
        # Abort at the very last write, after all analytical validation and indexed status.
        with closing(sqlite3.connect(self.db)) as db:
            db.execute("CREATE TRIGGER fail_pointer BEFORE UPDATE ON current_analyses BEGIN SELECT RAISE(ABORT,'injected failure'); END")
        before = self.rows('SELECT * FROM analysis_runs')
        with self.assertRaisesRegex(sqlite3.IntegrityError,'injected failure'):
            self.ingest()
        self.assertEqual(self.rows('SELECT * FROM analysis_runs'),before)
        self.assertEqual(self.rows('SELECT analysis_id FROM current_analyses'),[(second['analysisId'],)])
        self.assertEqual(self.rows('PRAGMA foreign_key_check'),[])

    def test_v1_and_invalid_artifact_identity_rejected(self):
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('CREATE TABLE players(id)')
        before = self.db.read_bytes()
        with self.assertRaisesRegex(ValueError,'non-v2'):
            self.ingest()
        self.assertEqual(self.db.read_bytes(),before)
        self.manifest['replay_id'] = 'a'*64
        self.save_manifest()
        with self.assertRaisesRegex(ValueError,'SHA mismatch'):
            self.ingest()

    def test_validation_failure_rolls_back_artifacts_and_observations(self):
        self.ingest()
        self.builds += '00:03 hatchery\n'
        self.save_bundle()
        tables = ('analysis_runs', 'analysis_specs', 'participations', 'analysis_participations',
                  'analysis_artifacts', 'unit_types', 'build_events', 'current_analyses')
        before = {table: self.rows('SELECT * FROM '+table) for table in tables}
        with patch.object(store.sparse, 'validate', side_effect=ValueError('validation failure')):
            with self.assertRaisesRegex(ValueError,'validation failure'):
                self.ingest()
        self.assertEqual(before,{table: self.rows('SELECT * FROM '+table) for table in tables})

    def test_immutable_specs_and_foreign_keys(self):
        self.ingest()
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('PRAGMA foreign_keys=ON')
            with self.assertRaisesRegex(sqlite3.IntegrityError,'immutable'):
                db.execute("UPDATE analysis_specs SET reducer_version='changed'")
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute('INSERT INTO analysis_participations VALUES (999,1,999,1)')
            db.execute("INSERT INTO analysis_runs(analysis_id,analysis_key,replay_id,spec_id,status,outcome,queued_at_ms) VALUES (2,'other',1,1,'artifacts_ready','legacy_partial',0)")
            with self.assertRaisesRegex(sqlite3.IntegrityError,'indexed'):
                db.execute('UPDATE current_analyses SET analysis_id=2')

    def test_preparation_rejects_owner_path_and_clock_errors(self):
        self.supply[0]['time_seconds'] = 999
        self.save_bundle()
        with self.assertRaisesRegex(ValueError,'clock'):
            self.ingest()
        self.assertFalse(self.db.exists())
        self.manifest['players'][0]['legacy_zip_path'] = '../outside.zip'
        self.save_manifest()
        with self.assertRaisesRegex(ValueError,'escapes'):
            self.ingest()
        self.manifest['players'].append(self.manifest['players'][0])
        self.save_manifest()
        with self.assertRaisesRegex(ValueError,'duplicate owners'):
            self.ingest()


if __name__ == '__main__':
    unittest.main()
