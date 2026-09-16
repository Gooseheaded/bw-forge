import sqlite3
import threading
import time
import unittest
from pathlib import Path
import tempfile

import test_store
import jobs

store = test_store.store


class JobLeaseTimingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / 'corpus.sqlite'
        db = sqlite3.connect(self.db_path)
        try:
            db.row_factory = sqlite3.Row
            store.initialize(db)
            now = int(time.time() * 1000)
            replay_id = db.execute("INSERT INTO replays(sha256,byte_size,raw_relative_path,first_seen_at_ms) VALUES (?,?,?,?)",
                ('a' * 64, 1, 'replays/aa/' + 'a' * 64 + '.rep', now)).lastrowid
            db.execute("INSERT INTO analysis_jobs(job_key,replay_id,status,created_at_ms,available_at_ms,max_attempts) VALUES (?,?,'queued',?,?,3)",
                ('job_timing', replay_id, now, now))
            db.commit()
        finally:
            db.close()

    def tearDown(self):
        self.tmp.cleanup()

    def connection(self):
        db = sqlite3.connect(self.db_path, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        return db

    def locked_call(self, operation):
        holder = self.connection()
        holder.execute('BEGIN IMMEDIATE')
        result, error = [], []
        started = threading.Event()
        thread = threading.Thread(target=lambda: self._run(operation, result, error, started))
        thread.start()
        self.assertTrue(started.wait(2))
        time.sleep(.2)
        released_at = int(time.time() * 1000)
        holder.commit()
        holder.close()
        thread.join(5)
        self.assertFalse(thread.is_alive())
        if error:
            raise error[0]
        return result[0], released_at

    def _run(self, operation, result, error, started):
        db = self.connection()
        try:
            started.set()
            result.append(operation(db))
        except BaseException as exc:
            error.append(exc)
        finally:
            db.close()

    def test_claim_and_heartbeat_timestamps_start_after_writer_lock(self):
        claimed, released = self.locked_call(lambda db: jobs.claim(db, {'worker_id':'worker','lease_ms':1000}))
        self.assertEqual(claimed['status'], 'claimed')
        self.assertGreaterEqual(claimed['job']['lastHeartbeatAtMs'], released - 30)
        self.assertEqual(claimed['job']['leaseExpiresAtMs'] - claimed['job']['lastHeartbeatAtMs'], 1000)
        renewed, released = self.locked_call(lambda db: jobs.heartbeat(db, {'job_key':'job_timing','worker_id':'worker',
            'attempt_number':1,'lease_ms':1000}))
        self.assertGreaterEqual(renewed['leaseExpiresAtMs'] - 1000, released - 30)

    def test_reclaim_evaluates_expiry_after_writer_lock(self):
        db = self.connection()
        jobs.claim(db, {'worker_id':'worker-a','lease_ms':150})
        db.close()
        reclaimed, _ = self.locked_call(lambda db: jobs.claim(db, {'worker_id':'worker-b','lease_ms':1000}))
        self.assertEqual(reclaimed['status'], 'claimed')
        self.assertTrue(reclaimed['recoveredExpiredLease'])
        self.assertEqual(reclaimed['job']['attemptCount'], 2)


if __name__ == '__main__':
    unittest.main()
