import importlib.util
from contextlib import closing
import json
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path

# Also works with Windows embedded Python's isolated sys.path.
spec = importlib.util.spec_from_file_location('prototype', Path(__file__).with_name('prototype.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class SparseTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        p.initialize(self.db)
        self.db.execute("INSERT INTO replays VALUES (1,?,0,NULL,0,NULL)", ('a'*64,))
        self.db.execute("INSERT INTO participations VALUES (1,1,0,'name','name','test','zerg')")
        self.db.execute('''INSERT INTO analysis_specs(spec_id,fingerprint_sha256,bw_forge_version,reducer_version,
            artifact_format,telemetry_contract,settings_json,frame_duration_num_ms,frame_duration_den,origin,created_at_ms)
            VALUES (1,'test','test','test','test','test','{}',42,1,'native',0)''')
        self.db.execute("INSERT INTO analysis_runs(analysis_id,analysis_key,replay_id,spec_id,status,outcome,queued_at_ms) VALUES (1,'test',1,1,'indexed','complete',0)")
        self.db.execute('INSERT INTO analysis_participations VALUES (1,1,1,1)')
        self.units = {'marine': 1, 'zergling': 2}
        for name, uid in self.units.items():
            self.db.execute('INSERT INTO unit_types VALUES (?,?,?)', (uid,name,name))
            self.db.execute('INSERT INTO analysis_unit_domain VALUES (1,?)', (uid,))

    def tearDown(self):
        self.db.close()

    def economy(self, frame, minerals=50, **kw):
        return dict(frame=frame, minerals=minerals, gas=0, workers=4, **kw)

    def test_economy_compaction_and_all_boundaries(self):
        samples = [self.economy(10),self.economy(11),self.economy(12,60),self.economy(13,60)]
        p.import_economy(self.db,1,samples)
        self.assertEqual(self.db.execute('SELECT count(*) FROM economy_changes').fetchone()[0],2)
        for frame, expected in [(9,None),(10,50),(11,50),(12,60),(13,60),(14,None)]:
            state = p.economy_at(self.db,1,frame)['state']
            self.assertEqual(state['minerals'] if state else None,expected)
        self.assertEqual(p.validate(self.db,1,samples,[])['economy_samples'],4)

    def test_nullable_full_tuple_not_patch(self):
        samples = [self.economy(1,gathered_gas=1),self.economy(2),self.economy(3)]
        p.import_economy(self.db,1,samples)
        self.assertEqual(self.db.execute('SELECT count(*) FROM economy_changes').fetchone()[0],2)
        self.assertIsNone(p.economy_at(self.db,1,2)['state']['gathered_gas'])

    def test_disappearance_reappearance_and_all_boundaries(self):
        samples = [{'frame':10,'counts':{'marine':4}}, {'frame':12,'counts':{}},
                   {'frame':14,'counts':{'marine':4}}]
        self.assertEqual(p.import_composition_segment(self.db,1,samples,self.units,end=16),1)
        for frame, count in [(9,None),(10,4),(11,4),(12,0),(13,0),(14,4),(16,4),(17,None)]:
            self.assertEqual(p.unit_at(self.db,1,'marine',frame)['count'],count)
        self.assertEqual(p.unit_at(self.db,1,'marine',12)['last_change_frame'],12)
        self.assertEqual(p.unit_at(self.db,1,'marine',14)['last_change_frame'],14)
        self.assertEqual(p.unit_at(self.db,1,'zergling',10)['count'],0)
        self.assertEqual(p.unit_at(self.db,1,'excluded',10)['availability'],'unobserved')
        self.assertEqual(p.validate(self.db,1,[],samples)['zero_transitions'],1)

    def test_no_state_crosses_gaps(self):
        p.import_economy(self.db,1,[self.economy(10),self.economy(11),self.economy(15,80)])
        self.assertEqual(p.economy_at(self.db,1,12)['availability'],'gap')
        self.assertEqual(p.economy_at(self.db,1,15)['state']['minerals'],80)
        p.import_composition_segment(self.db,1,[{'frame':10,'counts':{'marine':4}}],self.units,end=11)
        p.import_composition_segment(self.db,1,[{'frame':15,'counts':{}}],self.units,end=16)
        self.assertEqual(p.unit_at(self.db,1,'marine',12)['availability'],'gap')
        self.assertEqual(p.unit_at(self.db,1,'marine',15)['count'],0)
        self.assertEqual(p.composition_at(self.db,1,15)['counts'],{})

    def test_empty_stream_and_empty_initial_snapshot(self):
        p.import_economy(self.db,1,[])
        self.assertIsNone(p.economy_at(self.db,1,100)['state'])
        p.import_composition_segment(self.db,1,[{'frame':1,'counts':{}}],self.units)
        self.assertEqual(p.composition_at(self.db,1,1)['counts'],{})

    def test_duplicate_frames_invalid_clock_overlap(self):
        with self.assertRaises(ValueError):
            p.import_economy(self.db,1,[self.economy(1),self.economy(1)])
        with self.assertRaises(ValueError):
            p.import_economy(self.db,1,[self.economy(1,time_seconds=1)])
        p.add_coverage(self.db,1,'composition',1,10,'verified')
        with self.assertRaises(ValueError):
            p.add_coverage(self.db,1,'composition',10,20,'verified')

    def test_observations_only_does_not_imply_zero(self):
        p.add_coverage(self.db,1,'composition',1,10,'observations_only')
        self.assertEqual(p.unit_at(self.db,1,'marine',5)['availability'],'unobserved')

    def test_known_zergling_regression(self):
        samples = [{'frame':7150,'counts':{'zergling':1}}, {'frame':7275,'counts':{}}]
        p.import_composition_segment(self.db,1,samples,self.units)
        self.assertEqual(7275*.042,305.55)
        self.assertEqual(p.unit_at(self.db,1,'zergling',7275)['count'],0)

    def test_validation_detects_corrupt_state_and_missing_zero(self):
        economy = [self.economy(1),self.economy(2)]
        composition = [{'frame':1,'counts':{'marine':1}}, {'frame':2,'counts':{}}]
        p.import_economy(self.db,1,economy)
        p.import_composition_segment(self.db,1,composition,self.units)
        self.db.execute('UPDATE economy_changes SET workers=9')
        with self.assertRaises(ValueError):
            p.validate(self.db,1,economy,composition)
        self.db.execute('UPDATE economy_changes SET workers=4')
        self.db.execute('DELETE FROM unit_count_changes WHERE count=0')
        with self.assertRaises(ValueError):
            p.validate(self.db,1,economy,composition)

    def test_query_plans(self):
        p.import_economy(self.db,1,[self.economy(1)])
        p.import_composition_segment(self.db,1,[{'frame':1,'counts':{'marine':1}}],self.units)
        self.assertEqual(set(p.query_plans(self.db,1)), {'coverage','economy','workers','unit','composition'})

    def test_strict_keys_and_relations(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO economy_changes VALUES (1,1,'bad',0,4,NULL,NULL)")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('INSERT INTO economy_changes VALUES (999,1,50,0,4,NULL,NULL)')
        tables = {r['name']: (r['wr'],r['strict']) for r in self.db.execute('PRAGMA table_list')}
        self.assertEqual(tables['economy_changes'],(1,1))
        self.assertEqual(tables['unit_count_changes'],(1,1))

    def test_output_refuses_existing_file_and_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp)/'v1.sqlite'
            source.touch()
            with self.assertRaises(ValueError):
                p.run(source,source)
            candidate = Path(tmp)/'test.candidate.sqlite'
            candidate.touch()
            with self.assertRaises(ValueError):
                p.run(source,candidate)

    def test_repeatable_import_from_readonly_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact = root/'artifacts'
            artifact.mkdir()
            raw = artifact/'test.rep'
            raw.write_bytes(b'test replay bytes')
            sha = p.digest(raw)
            manifest = artifact/'manifest.json'
            manifest.write_text('{}')
            archive = artifact/'player.zip'
            economy = [self.economy(1),self.economy(2),self.economy(3,60)]
            composition = [{'frame':1,'counts':{'marine':1}}, {'frame':2,'counts':{}},
                           {'frame':3,'counts':{'marine':1}}]
            with zipfile.ZipFile(archive,'w') as z:
                z.writestr('player.json',json.dumps({'owner':0}))
                for name, samples in [('economy',economy),('unit_counts',composition)]:
                    z.writestr(name+'.json',json.dumps({'owner':0,'samples':samples,
                        'schema_version':'replay-analysis-'+name.replace('_','-')+'-v1'}))
            source = root/'v1.sqlite'
            with closing(sqlite3.connect(source)) as v1:
                v1.executescript('''CREATE TABLE replays(replay_id,source_replay_path,manifest_path,map);
                    CREATE TABLE players(replay_id,owner,name,race,zip_path);
                    CREATE TABLE economy_samples(frame);
                    CREATE TABLE unit_count_samples(frame);''')
                v1.execute('INSERT INTO replays VALUES (?,?,?,NULL)',(sha,str(raw),str(manifest)))
                v1.execute("INSERT INTO players VALUES (?,0,'name','zerg',?)",(sha,str(archive)))
                v1.executemany('INSERT INTO economy_samples VALUES (?)',[(1,),(2,),(3,)])
                v1.executemany('INSERT INTO unit_count_samples VALUES (?)',[(1,),(3,)])
                v1.commit()
            before = p.digest(source)
            results = [p.run(source,root/f'{n}.candidate.sqlite') for n in (1,2)]
            self.assertEqual(p.digest(source),before)
            self.assertEqual(results[0]['validation'],results[1]['validation'])
            self.assertEqual(results[0]['candidate_storage']['bytes'],results[1]['candidate_storage']['bytes'])
            self.assertEqual(results[0]['validation'],dict(economy_samples=3,composition_snapshots=3,zero_transitions=1))
            self.assertTrue(results[0]['source_files_unchanged'])
            for name in ('economy_changes','unit_count_changes','stream_coverage'):
                with closing(p.readonly(root/'1.candidate.sqlite')) as a, closing(p.readonly(root/'2.candidate.sqlite')) as b:
                    self.assertEqual([tuple(r) for r in a.execute('SELECT * FROM '+name)],
                                     [tuple(r) for r in b.execute('SELECT * FROM '+name)])


if __name__ == '__main__':
    unittest.main()
