"""Persistent Corpus v2 analysis jobs. Transactions are short; analysis runs elsewhere."""
import json
import sqlite3
import time
import uuid
from pathlib import Path


def now_ms():
    return int(time.time() * 1000)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def connect(db_path, initialize):
    path = Path(db_path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA busy_timeout=30000')
    initialize(db)
    return db


def serialize_job(row, attempts=None):
    if not row:
        return None
    result = {
        'jobKey': row['job_key'], 'replaySha256': row['sha256'], 'status': row['status'],
        'priority': row['priority'], 'createdAtMs': row['created_at_ms'],
        'availableAtMs': row['available_at_ms'], 'startedAtMs': row['started_at_ms'],
        'finishedAtMs': row['finished_at_ms'], 'attemptCount': row['attempt_count'],
        'maxAttempts': row['max_attempts'], 'workerId': row['worker_id'],
        'leaseExpiresAtMs': row['lease_expires_at_ms'], 'lastHeartbeatAtMs': row['last_heartbeat_at_ms'],
        'resultAnalysisId': row['result_analysis_id'], 'resultAnalysisKey': row['analysis_key'],
        'lastError': json.loads(row['last_error_json']) if row['last_error_json'] else None,
        'canonicalRelativePath': 'replays/' + row['sha256'][:2] + '/' + row['sha256'] + '.rep'
    }
    if attempts is not None:
        result['attempts'] = [{
            'attemptNumber': a['attempt_number'], 'workerId': a['worker_id'],
            'claimedAtMs': a['claimed_at_ms'], 'recoveredExpiredLease': bool(a['recovered_expired_lease']),
            'completedAtMs': a['completed_at_ms'], 'outcome': a['outcome'],
            'error': json.loads(a['error_json']) if a['error_json'] else None
        } for a in attempts]
    return result


JOB_SELECT = '''SELECT j.*,r.sha256,r.raw_relative_path,a.analysis_key
 FROM analysis_jobs j JOIN replays r USING(replay_id)
 LEFT JOIN analysis_runs a ON a.analysis_id=j.result_analysis_id'''


def enqueue(db, args):
    now = now_ms()
    sha, size, rel = args['sha256'], args['byte_size'], args['raw_relative_path']
    played_at = args.get('played_at_unix_s')
    if len(sha) != 64 or any(c not in '0123456789abcdef' for c in sha):
        raise ValueError('Invalid replay SHA256')
    if type(size) is not int or size < 0 or not rel:
        raise ValueError('Invalid canonical replay metadata')
    if played_at is not None and (type(played_at) is not int or not 1 <= played_at <= 0xffffffff):
        raise ValueError('Invalid replay-declared timestamp')
    db.execute('BEGIN IMMEDIATE')
    try:
        db.execute('''INSERT INTO replays(sha256,byte_size,raw_relative_path,first_seen_at_ms,map_name,played_at_unix_s)
            VALUES (?,?,?,?,NULL,?) ON CONFLICT(sha256) DO NOTHING''', (sha,size,rel,now,played_at))
        replay = db.execute('SELECT replay_id,byte_size,raw_relative_path,played_at_unix_s FROM replays WHERE sha256=?', (sha,)).fetchone()
        if replay['byte_size'] != size:
            raise ValueError('Registered replay byte size mismatch')
        # Preserve an established publication path; otherwise fill the canonical queue path.
        if replay['raw_relative_path'] is None:
            db.execute('UPDATE replays SET raw_relative_path=? WHERE replay_id=?', (rel,replay['replay_id']))
        if replay['played_at_unix_s'] is None and played_at is not None:
            db.execute('UPDATE replays SET played_at_unix_s=? WHERE replay_id=? AND played_at_unix_s IS NULL', (played_at,replay['replay_id']))
        source_existed = db.execute('''SELECT 1 FROM replay_sources
            WHERE replay_id=? AND source_kind=? AND source_ref=?''',
            (replay['replay_id'],args['source_kind'],args['source_ref'])).fetchone() is not None
        db.execute('''INSERT INTO replay_sources(replay_id,source_kind,source_ref,first_seen_at_ms,last_seen_at_ms)
            VALUES (?,?,?,?,?) ON CONFLICT(replay_id,source_kind,source_ref)
            DO UPDATE SET last_seen_at_ms=excluded.last_seen_at_ms''',
            (replay['replay_id'],args['source_kind'],args['source_ref'],now,now))
        source_new = not source_existed
        active = db.execute(JOB_SELECT + " WHERE j.replay_id=? AND j.status IN ('queued','running')", (replay['replay_id'],)).fetchone()
        if active:
            db.commit()
            return {'status':'already-queued', 'sourceRecorded':source_new, 'job':serialize_job(active)}
        indexed = db.execute('SELECT analysis_id FROM current_analyses WHERE replay_id=?', (replay['replay_id'],)).fetchone()
        if indexed and not args['force']:
            db.commit()
            return {'status':'already-indexed','sourceRecorded':source_new,'replaySha256':sha,
                    'currentAnalysisId':indexed['analysis_id']}
        job_key = 'job_' + uuid.uuid4().hex
        db.execute('''INSERT INTO analysis_jobs(job_key,replay_id,status,priority,created_at_ms,available_at_ms,max_attempts)
            VALUES (?,?,'queued',?,?,?,?)''',
            (job_key,replay['replay_id'],args['priority'],now,now,args['max_attempts']))
        row = db.execute(JOB_SELECT+' WHERE j.job_key=?',(job_key,)).fetchone()
        db.commit()
        return {'status':'queued','sourceRecorded':bool(source_new),'job':serialize_job(row)}
    except BaseException:
        db.rollback()
        raise


def expire_exhausted(db, now):
    error = canonical({'code':'LEASE_EXPIRED_MAX_ATTEMPTS','message':'Worker lease expired after maximum attempts'})
    rows = db.execute("SELECT job_id,attempt_count FROM analysis_jobs WHERE status='running' AND lease_expires_at_ms<=? AND attempt_count>=max_attempts", (now,)).fetchall()
    for row in rows:
        db.execute("UPDATE analysis_job_attempts SET outcome='abandoned',completed_at_ms=?,error_json=? WHERE job_id=? AND attempt_number=? AND outcome='running'",
                   (now,error,row['job_id'],row['attempt_count']))
        db.execute("UPDATE analysis_jobs SET status='failed',finished_at_ms=?,worker_id=NULL,lease_expires_at_ms=NULL,last_heartbeat_at_ms=NULL,last_error_json=? WHERE job_id=?",
                   (now,error,row['job_id']))


def claim(db, args):
    now, lease_ms = now_ms(), args['lease_ms']
    db.execute('BEGIN IMMEDIATE')
    try:
        expire_exhausted(db,now)
        row = db.execute(JOB_SELECT + ''' WHERE
          (j.status='queued' AND j.available_at_ms<=? AND j.attempt_count<j.max_attempts)
          OR (j.status='running' AND j.lease_expires_at_ms<=? AND j.attempt_count<j.max_attempts)
          ORDER BY j.priority DESC,j.available_at_ms,j.job_id LIMIT 1''', (now,now)).fetchone()
        if not row:
            db.commit(); return {'status':'idle'}
        recovered = row['status'] == 'running'
        if recovered:
            abandoned = canonical({'code':'LEASE_EXPIRED','message':'Previous worker lease expired'})
            db.execute("UPDATE analysis_job_attempts SET outcome='abandoned',completed_at_ms=?,error_json=? WHERE job_id=? AND attempt_number=? AND outcome='running'",
                       (now,abandoned,row['job_id'],row['attempt_count']))
        attempt = row['attempt_count'] + 1
        db.execute('''UPDATE analysis_jobs SET status='running',started_at_ms=coalesce(started_at_ms,?),finished_at_ms=NULL,
            attempt_count=?,worker_id=?,lease_expires_at_ms=?,last_heartbeat_at_ms=?,last_error_json=NULL
            WHERE job_id=?''', (now,attempt,args['worker_id'],now+lease_ms,now,row['job_id']))
        db.execute("INSERT INTO analysis_job_attempts(job_id,attempt_number,worker_id,claimed_at_ms,recovered_expired_lease,outcome) VALUES (?,?,?,?,?,'running')",
                   (row['job_id'],attempt,args['worker_id'],now,int(recovered)))
        claimed = db.execute(JOB_SELECT+' WHERE j.job_id=?',(row['job_id'],)).fetchone()
        db.commit()
        return {'status':'claimed','recoveredExpiredLease':recovered,'job':serialize_job(claimed)}
    except BaseException:
        db.rollback(); raise


def heartbeat(db, args):
    now = now_ms()
    db.execute('BEGIN IMMEDIATE')
    try:
        cursor=db.execute("UPDATE analysis_jobs SET lease_expires_at_ms=?,last_heartbeat_at_ms=? WHERE job_key=? AND status='running' AND worker_id=?",
                          (now+args['lease_ms'],now,args['job_key'],args['worker_id']))
        if cursor.rowcount != 1:
            raise ValueError('Job lease is no longer owned by this worker')
        db.commit(); return {'status':'renewed','leaseExpiresAtMs':now+args['lease_ms']}
    except BaseException:
        db.rollback(); raise


def finish(db, args, succeeded):
    now=now_ms()
    db.execute('BEGIN IMMEDIATE')
    try:
        row=db.execute("SELECT job_id,attempt_count,replay_id FROM analysis_jobs WHERE job_key=? AND status='running' AND worker_id=?",
                       (args['job_key'],args['worker_id'])).fetchone()
        if not row: raise ValueError('Job lease is no longer owned by this worker')
        if succeeded:
            analysis=db.execute("SELECT analysis_id FROM analysis_runs WHERE analysis_id=? AND replay_id=? AND status='indexed'",
                                (args['analysis_id'],row['replay_id'])).fetchone()
            if not analysis: raise ValueError('Successful job result is not an indexed analysis for its replay')
            db.execute("UPDATE analysis_jobs SET status='succeeded',finished_at_ms=?,worker_id=NULL,lease_expires_at_ms=NULL,last_heartbeat_at_ms=NULL,result_analysis_id=?,last_error_json=NULL WHERE job_id=?",
                       (now,args['analysis_id'],row['job_id']))
            db.execute("UPDATE analysis_job_attempts SET outcome='succeeded',completed_at_ms=? WHERE job_id=? AND attempt_number=?",
                       (now,row['job_id'],row['attempt_count']))
        else:
            error=canonical(args['error'])
            db.execute("UPDATE analysis_jobs SET status='failed',finished_at_ms=?,worker_id=NULL,lease_expires_at_ms=NULL,last_heartbeat_at_ms=NULL,result_analysis_id=NULL,last_error_json=? WHERE job_id=?",
                       (now,error,row['job_id']))
            db.execute("UPDATE analysis_job_attempts SET outcome='failed',completed_at_ms=?,error_json=? WHERE job_id=? AND attempt_number=?",
                       (now,error,row['job_id'],row['attempt_count']))
        result=db.execute(JOB_SELECT+' WHERE j.job_id=?',(row['job_id'],)).fetchone()
        db.commit(); return {'status':result['status'],'job':serialize_job(result)}
    except BaseException:
        db.rollback(); raise


def retry(db,args):
    now=now_ms(); db.execute('BEGIN IMMEDIATE')
    try:
        row=db.execute("SELECT job_id,attempt_count,max_attempts FROM analysis_jobs WHERE job_key=? AND status='failed'",(args['job_key'],)).fetchone()
        if not row: raise ValueError('Retry requires an existing failed job')
        db.execute("UPDATE analysis_jobs SET status='queued',available_at_ms=?,started_at_ms=NULL,finished_at_ms=NULL,worker_id=NULL,lease_expires_at_ms=NULL,last_heartbeat_at_ms=NULL,result_analysis_id=NULL,last_error_json=NULL,max_attempts=max(max_attempts,attempt_count+1) WHERE job_id=?",(now,row['job_id']))
        result=db.execute(JOB_SELECT+' WHERE j.job_id=?',(row['job_id'],)).fetchone()
        db.commit(); return {'status':'queued','job':serialize_job(result)}
    except BaseException:
        db.rollback(); raise


def list_jobs(db,args):
    where=[]; params=[]
    if args.get('status'):
        where.append('j.status=?');params.append(args['status'])
    params.append(args['limit'])
    rows=db.execute(JOB_SELECT+(' WHERE '+' AND '.join(where) if where else '')+' ORDER BY j.created_at_ms DESC,j.job_id DESC LIMIT ?',params).fetchall()
    return {'jobs':[serialize_job(r) for r in rows]}


def show(db,args):
    row=db.execute(JOB_SELECT+' WHERE j.job_key=?',(args['job_key'],)).fetchone()
    if not row: raise ValueError('Job not found: '+args['job_key'])
    attempts=db.execute('SELECT * FROM analysis_job_attempts WHERE job_id=? ORDER BY attempt_number',(row['job_id'],)).fetchall()
    sources=db.execute('SELECT source_kind,source_ref,first_seen_at_ms,last_seen_at_ms FROM replay_sources WHERE replay_id=? ORDER BY source_kind,source_ref',(row['replay_id'],)).fetchall()
    result=serialize_job(row,attempts)
    result['sources']=[{'sourceKind':s[0],'sourceRef':s[1],'firstSeenAtMs':s[2],'lastSeenAtMs':s[3]} for s in sources]
    return {'job':result}


def administer(db_path, operation, args, initialize):
    with connect(db_path,initialize) as db:
        if operation=='enqueue': return enqueue(db,args)
        if operation=='claim': return claim(db,args)
        if operation=='heartbeat': return heartbeat(db,args)
        if operation=='succeed': return finish(db,args,True)
        if operation=='fail': return finish(db,args,False)
        if operation=='retry': return retry(db,args)
        if operation=='list': return list_jobs(db,args)
        if operation=='show': return show(db,args)
        raise ValueError('Unknown job operation: '+operation)
