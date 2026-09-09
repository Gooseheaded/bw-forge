import copy
import sqlite3
import json
import unittest
import test_store
from identities import apply_catalog, export_catalog
from migrations import migrate

IDENTITY_TABLES = ('scope_players','scope_groups','scope_replays','player_group_members',
                   'participation_identity_overrides','player_aliases','query_scopes','player_groups','canonical_players',
                   'analysis_job_attempts','analysis_jobs','replay_sources','corpus_migrations')


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_store.StoreTests()
        self.fixture.setUp()
        self.fixture.ingest()
        self.db = sqlite3.connect(self.fixture.db)
        self.db.execute('PRAGMA foreign_keys=ON')
        self.config = {'schema_version':'bw-forge-identities-v1',
            'players':[{'key':'player','display_name':'Canonical Player','aliases':[{'namespace':'legacy-unknown','name':'Player'}]},
                       {'key':'other','display_name':'Other','aliases':[]}],
            'overrides':[{'replay_sha256':self.fixture.manifest['replay_id'],'owner':0,'player':'other'}],
            'groups':[{'key':'friends','display_name':'Friends','players':['player','other']}],
            'scopes':[{'key':'mine','display_name':'Mine','self':{'groups':['friends']},'opponent':{'players':['other']},
                       'filters':{'race':'zerg','matchup':'ZvT','map':'Map'},'replay_sha256':[self.fixture.manifest['replay_id']]}]}

    def tearDown(self):
        self.db.close()
        self.fixture.tearDown()

    def evidence(self):
        tables = [r[0] for r in self.db.execute("SELECT name FROM sqlite_schema WHERE type='table'") if r[0] not in IDENTITY_TABLES]
        return {t:self.db.execute('SELECT * FROM '+t).fetchall() for t in tables}

    def test_additive_migration_idempotent_and_preserves_all_evidence(self):
        before = self.evidence()
        for table in IDENTITY_TABLES:
            self.db.execute('DROP TABLE '+table)
        self.db.commit()
        migrate(self.db)
        migrated = list(self.db.iterdump())
        migrate(self.db)
        self.assertEqual(migrated, list(self.db.iterdump()))
        self.assertEqual(before, self.evidence())
        self.assertEqual(self.db.execute('PRAGMA user_version').fetchone()[0],2)
        self.assertEqual(self.db.execute('SELECT schema_version FROM corpus_metadata').fetchone()[0],2)
        self.assertEqual(self.db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_migration_failure_rolls_back_all_ddl_and_ledger(self):
        for table in IDENTITY_TABLES:
            self.db.execute('DROP TABLE '+table)
        self.db.execute('CREATE TABLE scope_groups(bad INTEGER)')
        self.db.commit()
        before = list(self.db.iterdump())
        with self.assertRaises(sqlite3.OperationalError):
            migrate(self.db)
        self.assertEqual(before,list(self.db.iterdump()))

    def test_config_roundtrip_idempotence_and_stable_keys(self):
        evidence = self.evidence()
        self.assertEqual(apply_catalog(self.db,self.config)['status'],'applied')
        exported = export_catalog(self.db)
        before = list(self.db.iterdump())
        self.assertEqual(apply_catalog(self.db,exported)['status'],'no-op')
        self.assertEqual(before,list(self.db.iterdump()))
        self.assertEqual(exported,export_catalog(self.db))
        ids = self.db.execute('SELECT player_id,player_key FROM canonical_players').fetchall()
        updated = copy.deepcopy(exported)
        updated['players'][0]['display_name'] = 'Renamed'
        apply_catalog(self.db,updated)
        self.assertEqual(ids,self.db.execute('SELECT player_id,player_key FROM canonical_players').fetchall())
        self.assertEqual(evidence,self.evidence())

    def test_invalid_documents_rejected_before_any_mutation(self):
        apply_catalog(self.db,self.config)
        variants=[]
        c=copy.deepcopy(self.config);c['players'].append(c['players'][0]);variants.append(c)
        c=copy.deepcopy(self.config);c['players'][1]['aliases']=[{'namespace':'legacy-unknown','name':'PLAYER'}];variants.append(c)
        c=copy.deepcopy(self.config);c['groups'][0]['players']=['missing'];variants.append(c)
        c=copy.deepcopy(self.config);c['scopes'][0]['self']['groups']=['missing'];variants.append(c)
        c=copy.deepcopy(self.config);c['overrides'][0]['owner']=999;variants.append(c)
        c=copy.deepcopy(self.config);c['scopes'][0]['filters']['sql']='SELECT 1';variants.append(c)
        before=list(self.db.iterdump())
        for config in variants:
            with self.subTest(config=config), self.assertRaises(ValueError):
                apply_catalog(self.db,config)
            self.assertEqual(before,list(self.db.iterdump()))

    def test_catalog_replacement_removes_old_mappings_without_evidence_changes(self):
        before=self.evidence()
        apply_catalog(self.db,self.config)
        apply_catalog(self.db,{'schema_version':'bw-forge-identities-v1'})
        self.assertEqual(export_catalog(self.db),{'schema_version':'bw-forge-identities-v1','players':[],'groups':[],'scopes':[],'overrides':[]})
        self.assertEqual(before,self.evidence())

    def test_apply_write_failure_rolls_back_catalog_and_evidence(self):
        apply_catalog(self.db,self.config)
        self.db.execute("CREATE TRIGGER fail_identity BEFORE UPDATE ON canonical_players BEGIN SELECT RAISE(ABORT,'test rejection'); END")
        self.db.commit()
        before=list(self.db.iterdump())
        self.config['players'][0]['display_name']='Rejected rename'
        with self.assertRaisesRegex(sqlite3.IntegrityError,'test rejection'):
            apply_catalog(self.db,self.config)
        self.assertEqual(before,list(self.db.iterdump()))

    def test_unicode_casefold_and_namespace_alias_uniqueness(self):
        config={'schema_version':'bw-forge-identities-v1','players':[{'key':'one','display_name':'One','aliases':[
            {'namespace':'one','name':'Straße'},{'namespace':'two','name':'STRASSE'}]}]}
        apply_catalog(self.db,config)
        self.assertEqual(self.db.execute('SELECT name_namespace,observed_name_key FROM player_aliases ORDER BY name_namespace').fetchall(),[('one','strasse'),('two','strasse')])
        config['players'][0]['aliases'][1]['namespace']='one'
        with self.assertRaisesRegex(ValueError,'conflicting alias'):
            apply_catalog(self.db,config)

    def test_v1_and_unknown_normalizer_are_rejected(self):
        self.db.execute('PRAGMA user_version=1');self.db.commit()
        with self.assertRaisesRegex(ValueError,'v1 is never migrated'):migrate(self.db)
        self.db.execute('PRAGMA user_version=2')
        self.db.execute("UPDATE corpus_metadata SET name_normalizer='unknown'");self.db.commit()
        with self.assertRaisesRegex(ValueError,'normalizer'):apply_catalog(self.db,self.config)

    def test_future_ingest_automatically_uses_existing_alias_without_catalog_reapply(self):
        self.config['overrides']=[]
        apply_catalog(self.db,self.config)
        exported=export_catalog(self.db)
        f=self.fixture
        raw=b'future replay'
        (f.artifacts/'raw.rep').write_bytes(raw)
        f.manifest['replay_id']=test_store.store.sha(raw)
        f.save_manifest()
        (f.artifacts/'manifest.json').write_text(json.dumps({'schema_version':'replay-analysis-manifest-v1','replay_id':f.manifest['replay_id'],'players':[f.player]}))
        f.ingest()
        rows=self.db.execute('''SELECT count(DISTINCT p.replay_id) FROM participations p
            JOIN player_aliases a ON a.name_namespace=p.name_namespace AND a.observed_name_key=p.observed_name_key
            JOIN canonical_players c USING(player_id) WHERE c.player_key='player' ''').fetchone()[0]
        self.assertEqual(rows,2)
        self.assertEqual(exported,export_catalog(self.db))
