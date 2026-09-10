import sqlite3
import unittest
import test_store
from migrations import migrate


class ChronologyMigrationTests(unittest.TestCase):
    def setUp(self):
        self.fixture=test_store.StoreTests();self.fixture.setUp();self.fixture.ingest()
        self.db=sqlite3.connect(self.fixture.db);self.db.execute('PRAGMA foreign_keys=ON')
        replay_id,analysis_id=self.db.execute('SELECT replay_id,analysis_id FROM current_analyses').fetchone()
        self.db.execute("INSERT INTO canonical_players VALUES (1,'player','Player',1,1)")
        self.db.execute("INSERT INTO player_aliases VALUES ('legacy-unknown','player','Player',1)")
        self.db.execute("INSERT INTO player_groups VALUES (1,'mine','Mine')")
        self.db.execute("INSERT INTO player_group_members VALUES (1,1)")
        self.db.execute("INSERT INTO query_scopes VALUES (1,'mine','Mine','{}')")
        self.db.execute("INSERT INTO scope_groups VALUES (1,'self',1)")
        self.db.execute("INSERT INTO replay_sources VALUES (1,?,'manual','fixture.rep',1,2)",(replay_id,))
        self.db.execute("INSERT INTO analysis_jobs VALUES (1,'job',?,'succeeded',0,1,1,1,2,1,3,NULL,NULL,NULL,?,NULL)",(replay_id,analysis_id))
        self.db.execute("INSERT INTO analysis_job_attempts VALUES (1,1,1,'worker',1,0,2,'succeeded',NULL)")
        self.db.commit()

    def tearDown(self):
        self.db.close();self.fixture.tearDown()

    def evidence(self):
        tables=[row[0] for row in self.db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN ('corpus_migrations','sqlite_sequence') ORDER BY name")]
        result={}
        for table in tables:
            if table=='replays':
                result[table]=self.db.execute('SELECT replay_id,sha256,byte_size,raw_relative_path,first_seen_at_ms,map_name FROM replays').fetchall()
            else:result[table]=self.db.execute('SELECT * FROM '+table).fetchall()
        return result

    def make_pre_m8(self):
        self.db.execute('DROP INDEX replays_by_played_at')
        self.db.execute('ALTER TABLE replays DROP COLUMN played_at_unix_s')
        self.db.execute('DELETE FROM corpus_migrations WHERE revision=3')
        self.db.commit()

    def test_pre_m8_migration_is_transactional_idempotent_and_preserves_everything(self):
        self.make_pre_m8();before=self.evidence()
        migrate(self.db);migrated=list(self.db.iterdump());migrate(self.db)
        self.assertEqual(migrated,list(self.db.iterdump()))
        self.assertEqual(before,self.evidence())
        self.assertIn('played_at_unix_s',[row[1] for row in self.db.execute('PRAGMA table_info(replays)')])
        self.assertEqual(self.db.execute("SELECT name FROM sqlite_schema WHERE type='index' AND name='replays_by_played_at'").fetchall(),[('replays_by_played_at',)])
        self.assertEqual(self.db.execute('SELECT revision,name FROM corpus_migrations WHERE revision=3').fetchall(),[(3,'replay-played-at-v1')])
        self.assertEqual(self.db.execute('PRAGMA user_version').fetchone()[0],2)
        self.assertEqual(self.db.execute('SELECT schema_version FROM corpus_metadata').fetchone()[0],2)
        self.assertEqual(self.db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_migration_failure_rolls_back_column_index_and_ledger(self):
        self.make_pre_m8()
        self.db.execute("CREATE TRIGGER reject_chronology BEFORE INSERT ON corpus_migrations WHEN NEW.revision=3 BEGIN SELECT RAISE(ABORT,'reject chronology'); END")
        self.db.commit();before=list(self.db.iterdump())
        with self.assertRaisesRegex(sqlite3.IntegrityError,'reject chronology'):migrate(self.db)
        self.assertEqual(before,list(self.db.iterdump()))


if __name__=='__main__':unittest.main()
