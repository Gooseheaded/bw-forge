"""Deterministic current/publication fixture for the static report index."""
import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

store_path=Path(__file__).resolve().parents[3]/'corpus-store/python/store.py'
spec=importlib.util.spec_from_file_location('corpus_store',store_path)
store=importlib.util.module_from_spec(spec);spec.loader.exec_module(store)
root=Path(sys.argv[1]).resolve();count=int(sys.argv[2]);root.mkdir(parents=True,exist_ok=True)
analyses=root/'analyses';analyses.mkdir();database=root/'corpus.sqlite'
db=sqlite3.connect(database);db.execute('PRAGMA foreign_keys=ON');store.initialize(db)
for statement in (store_path.parent/'publication.sql').read_text().split(';'):
    if statement.strip():db.execute(statement)
db.execute("""INSERT INTO analysis_specs(spec_id,fingerprint_sha256,bw_forge_version,bwsim_version,reducer_version,
 artifact_format,telemetry_contract,settings_json,frame_duration_num_ms,frame_duration_den,origin,created_at_ms)
 VALUES(1,?,'fixture',NULL,'fixture','fixture','fixture','{}',42,1,'native',1)""",('f'*64,))

first_replay=None;first_current=None;historical_id=None;historical_key=None
outside=root/'outside';outside.mkdir();(outside/'unsafe.html').write_text('unsafe',encoding='utf8')
for index in range(count):
    replay_sha=f'{index+1:064x}';analysis_id=index*2+1;analysis_key=f'{1000+index:064x}'
    first_replay=first_replay or replay_sha;first_current=first_current or analysis_id
    played=None if index==count-1 and count>2 else (1767225600+index*60 if index%2==0 else 1735689600+index*60)
    map_name='Map </script><img src=x onerror="boom"> & \'quoted\'' if index==0 else f'Map {index%4}'
    db.execute('INSERT INTO replays(replay_id,sha256,byte_size,first_seen_at_ms,map_name,played_at_unix_s) VALUES(?,?,?,?,?,?)',(index+1,replay_sha,1,9999999999999,map_name,played))
    db.execute("INSERT INTO analysis_runs(analysis_id,analysis_key,replay_id,spec_id,status,outcome,queued_at_ms,indexed_at_ms) VALUES(?,?,?,1,'indexed','complete',9999999999999,9999999999999)",(analysis_id,analysis_key,index+1))
    db.execute('INSERT INTO current_analyses VALUES(?,?,9999999999999)',(index+1,analysis_id))
    participant_count=0 if index==3 else (3 if index==2 else 2)
    for owner in range(participant_count):
        participation_id=index*10+owner+1;observed=('Raw </script><svg onload="boom"> & \'name\'' if index==0 and owner==0 else f'Player {index}-{owner}')
        race=('zerg','terran','protoss')[owner%3]
        db.execute('INSERT INTO participations VALUES(?,?,?,?,?,?,?)',(participation_id,index+1,owner,observed,observed.casefold(),'legacy-unknown',race))
        db.execute('INSERT INTO analysis_participations VALUES(?,?,?,?)',(index*10+owner+1,analysis_id,participation_id,index+1))
    if index==0:db.execute('INSERT INTO economy_changes(observation_id,frame,minerals,gas,workers) VALUES(1,1,50,0,4)')
    directory=analyses/replay_sha/analysis_key;directory.mkdir(parents=True);report=directory/'legacy'/f'Report {index}.html';report.parent.mkdir()
    if index!=4:report.write_text(f'<html>report {index}</html>',encoding='utf8')
    manifest=directory/'replay-manifest.json';manifest.write_text(json.dumps({'schema_version':'bw-forge-replay-manifest-v1','replay_id':replay_sha,'publication':{'format':'bw-forge-publication-v1'},'legacy':{'html_files':[f'legacy/Report {index}.html']}}),encoding='utf8')
    publication_manifest=outside/'replay-manifest.json' if index==5 else manifest
    if index==5:publication_manifest.write_text(json.dumps({'replay_id':replay_sha,'publication':{'format':'bw-forge-publication-v1'},'legacy':{'html_files':['unsafe.html']}}),encoding='utf8')
    db.execute('INSERT INTO analysis_publications VALUES(?,?,?)',(analysis_id,str(publication_manifest),str(root/'raw.rep')))
    if index==0:
        db.execute("INSERT INTO canonical_players VALUES(1,'canonical','Canonical </script> & <b>',1,1)")
        db.execute('INSERT INTO participation_identity_overrides VALUES(1,1)')
        historical_id=2;historical_key='a'*64;old=analyses/replay_sha/historical_key;old.mkdir(parents=True);old_report=old/'old report.html';old_report.write_text('<html>old</html>',encoding='utf8')
        old_manifest=old/'replay-manifest.json';old_manifest.write_text(json.dumps({'replay_id':replay_sha,'publication':{'format':'bw-forge-publication-v1'},'legacy':{'html_files':['old report.html']}}),encoding='utf8')
        db.execute("INSERT INTO analysis_runs VALUES(?,?,?,1,'indexed','complete',1,1,NULL,NULL,NULL)",(historical_id,historical_key,index+1))
        db.execute('INSERT INTO analysis_participations VALUES(?,?,?,?)',(10001,historical_id,1,index+1));db.execute('INSERT INTO analysis_participations VALUES(?,?,?,?)',(10002,historical_id,2,index+1))
        db.execute('INSERT INTO analysis_publications VALUES(?,?,?)',(historical_id,str(old_manifest),str(root/'raw.rep')))
if count:
    db.execute("INSERT INTO analysis_jobs(job_key,replay_id,status,priority,created_at_ms,available_at_ms,attempt_count,max_attempts) VALUES('queued',1,'queued',0,1,1,0,3)")
db.commit()
print(json.dumps({'dbPath':str(database),'analysesRoot':str(analyses),'firstReplay':first_replay,'firstCurrent':first_current,'historicalId':historical_id,'historicalKey':historical_key}))
