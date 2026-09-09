import sqlite3
import unittest
import test_store
from identities import apply_catalog, export_catalog
from migrations import migrate


class JobMigrationTests(unittest.TestCase):
    def setUp(self):
        self.fixture=test_store.StoreTests();self.fixture.setUp();self.fixture.ingest()
        self.db=sqlite3.connect(self.fixture.db);self.db.execute('PRAGMA foreign_keys=ON')
        self.catalog={'schema_version':'bw-forge-identities-v1','players':[
            {'key':'player','display_name':'Player','aliases':[{'namespace':'legacy-unknown','name':'Player'}]}],
            'groups':[{'key':'all','display_name':'All','players':['player']}],
            'scopes':[{'key':'mine','display_name':'Mine','self':{'players':['player']}}]}
        apply_catalog(self.db,self.catalog)
        self.exported=export_catalog(self.db)

    def tearDown(self):
        self.db.close();self.fixture.tearDown()

    def snapshot(self):
        return {r[0]:self.db.execute('SELECT * FROM '+r[0]).fetchall() for r in self.db.execute(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN ('replay_sources','analysis_jobs','analysis_job_attempts','corpus_migrations') ORDER BY name")}

    def test_pre_m5_migration_is_additive_idempotent_and_preserves_catalog_current_and_telemetry(self):
        self.db.execute('DELETE FROM corpus_migrations WHERE revision=2')
        for table in ('analysis_job_attempts','analysis_jobs','replay_sources'):
            self.db.execute('DROP TABLE '+table)
        self.db.commit()
        before=self.snapshot();catalog=export_catalog(self.db)
        migrate(self.db)
        first=list(self.db.iterdump())
        migrate(self.db)
        self.assertEqual(first,list(self.db.iterdump()))
        self.assertEqual(before,self.snapshot())
        self.assertEqual(catalog,export_catalog(self.db))
        self.assertEqual(self.db.execute('SELECT revision FROM corpus_migrations ORDER BY revision').fetchall(),[(1,),(2,)])
        self.assertEqual(self.db.execute('PRAGMA user_version').fetchone()[0],2)
        self.assertEqual(self.db.execute('SELECT schema_version FROM corpus_metadata').fetchone()[0],2)
        self.assertEqual(self.db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_pre_m5_database_remains_readable_before_queue_migration(self):
        current=self.db.execute('SELECT * FROM current_analyses').fetchall()
        self.db.execute('DELETE FROM corpus_migrations WHERE revision=2')
        for table in ('analysis_job_attempts','analysis_jobs','replay_sources'):
            self.db.execute('DROP TABLE '+table)
        self.db.commit()
        self.assertEqual(self.db.execute('SELECT count(*) FROM economy_changes').fetchone()[0],4)
        self.assertEqual(self.db.execute('SELECT * FROM current_analyses').fetchall(),current)
        self.assertEqual(export_catalog(self.db),self.exported)

    def test_queue_migration_failure_rolls_back_revision_and_tables(self):
        self.db.execute('DELETE FROM corpus_migrations WHERE revision=2')
        for table in ('analysis_job_attempts','analysis_jobs','replay_sources'):
            self.db.execute('DROP TABLE '+table)
        self.db.execute('CREATE TABLE analysis_jobs(bad INTEGER)')
        self.db.commit();before=list(self.db.iterdump())
        with self.assertRaises(sqlite3.OperationalError):migrate(self.db)
        self.assertEqual(before,list(self.db.iterdump()))


if __name__=='__main__':unittest.main()
