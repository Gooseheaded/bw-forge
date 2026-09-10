import { afterEach,expect,test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFile,mkdir,mkdtemp,rm,stat,utimes,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { backfillReplayPlayedAt } from "./chronology.js";
import { enqueueReplay } from "./jobs.js";
import { readReplayMetadata,readReplayMetadataBatch } from "./replay-metadata.js";
import { createReplayWatcher } from "./watcher.js";

const repo=fileURLToPath(new URL("../../../",import.meta.url));
const fixture=join(repo,"fixtures/replays/191104,(4)KnockOut1.4.rep");
const expected=1775408548,expectedIso="2026-04-05T17:02:28Z";
const temporary:string[]=[];
afterEach(async()=>{for(const path of temporary.splice(0))await rm(path,{recursive:true,force:true});});
async function temp(){const path=await mkdtemp(join(tmpdir(),"bw-chronology-"));temporary.push(path);return path;}
function rows(dbPath:string,sql:string){const db=new Database(dbPath,{readonly:true});try{return db.query(sql).all();}finally{db.close();}}

test("replay-declared timestamp is exact, deterministic, and independent of path and filesystem dates",async()=>{
  const root=await temp(),renamed=join(root,"totally-unrelated-name.rep"),second=join(root,"another.rep");
  await copyFile(fixture,renamed);
  await utimes(renamed,new Date("2001-01-01T00:00:00Z"),new Date("2001-01-01T00:00:00Z"));
  const firstStat=await stat(renamed);await Bun.sleep(50);await copyFile(fixture,second);
  await utimes(second,new Date("2031-12-31T23:59:59Z"),new Date("2031-12-31T23:59:59Z"));
  const before=[firstStat,await stat(second)];expect(before[0]!.mtimeMs).not.toBe(before[1]!.mtimeMs);expect(before[0]!.ctimeMs).not.toBe(before[1]!.ctimeMs);
  const values=await readReplayMetadataBatch([fixture,renamed,second]);
  expect(values.map(value=>value.playedAtUnixSeconds)).toEqual([expected,expected,expected]);
  expect(values.every(value=>value.error===null)).toBe(true);
  expect((await readReplayMetadata(fixture)).playedAtUnixSeconds).toBe(expected);
  expect(new Date(expected*1000).toISOString().replace(".000Z","Z")).toBe(expectedIso);
},{timeout:30000});

test("manual enqueue and watcher registration converge on one immutable replay timestamp",async()=>{
  const root=await temp(),manualRoot=join(root,"manual"),manualDb=join(manualRoot,"db/corpus.sqlite"),a=join(root,"a.rep"),b=join(root,"b.rep");
  await copyFile(fixture,a);await copyFile(fixture,b);
  const first=await enqueueReplay({replayPath:a,corpusRoot:manualRoot,dbPath:manualDb});
  expect(first.playedAtUnixSeconds).toBe(expected);expect(first.metadataError).toBeNull();
  expect((rows(manualDb,"SELECT first_seen_at_ms FROM replays")[0] as {first_seen_at_ms:number}).first_seen_at_ms).not.toBe(expected*1000);
  const missing=new Database(manualDb);missing.exec("UPDATE replays SET played_at_unix_s=NULL");missing.close();
  await Bun.sleep(10);const duplicate=await enqueueReplay({replayPath:b,corpusRoot:manualRoot,dbPath:manualDb});
  expect(duplicate.replaySha256).toBe(first.replaySha256);
  expect(rows(manualDb,"SELECT played_at_unix_s,count(*) AS n FROM replays")).toEqual([{played_at_unix_s:expected,n:1}]);
  const forced=await enqueueReplay({replayPath:b,corpusRoot:manualRoot,dbPath:manualDb,force:true});
  expect(forced.status).toBe("already-queued");expect(rows(manualDb,"SELECT played_at_unix_s FROM replays")).toEqual([{played_at_unix_s:expected}]);

  const watchRoot=join(root,"watched"),watchDb=join(watchRoot,"db/corpus.sqlite"),inbox=join(root,"inbox");await mkdir(inbox);await copyFile(fixture,join(inbox,"game.rep"));
  const watched=await createReplayWatcher().once({paths:[inbox],corpusRoot:watchRoot,dbPath:watchDb,stabilityMs:5,reconcileMs:1000});
  expect(watched.queued).toBe(1);expect(rows(watchDb,"SELECT played_at_unix_s FROM replays")).toEqual([{played_at_unix_s:expected}]);
},{timeout:30000});

test("backfill verifies canonical SHA, updates only NULL chronology, reports failures, and is idempotent through CLI",async()=>{
  const root=await temp(),corpusRoot=join(root,"corpus"),dbPath=join(corpusRoot,"db/corpus.sqlite"),real=join(root,"real.rep"),bad=join(root,"bad.rep");
  await copyFile(fixture,real);await writeFile(bad,"not a replay");
  const registered=await enqueueReplay({replayPath:real,corpusRoot,dbPath});
  const malformed=await enqueueReplay({replayPath:bad,corpusRoot,dbPath});expect(malformed.playedAtUnixSeconds).toBeNull();
  const mismatchSha="c".repeat(64),mismatchDir=join(corpusRoot,"replays","cc");await mkdir(mismatchDir,{recursive:true});await writeFile(join(mismatchDir,`${mismatchSha}.rep`),"wrong bytes");
  const db=new Database(dbPath);db.exec(`UPDATE replays SET played_at_unix_s=NULL WHERE sha256='${registered.replaySha256}';
    INSERT INTO replays(sha256,byte_size,raw_relative_path,first_seen_at_ms,map_name,played_at_unix_s) VALUES ('${"a".repeat(64)}',1,'replays/aa/${"a".repeat(64)}.rep',1,NULL,NULL);
    INSERT INTO replays(sha256,byte_size,raw_relative_path,first_seen_at_ms,map_name,played_at_unix_s) VALUES ('${mismatchSha}',11,'some/untrusted/path.rep',1,NULL,NULL);
    INSERT INTO replays(sha256,byte_size,raw_relative_path,first_seen_at_ms,map_name,played_at_unix_s) VALUES ('${"b".repeat(64)}',1,NULL,1,NULL,123);`);db.close();
  const analysesBefore=rows(dbPath,"SELECT count(*) AS n FROM analysis_runs");
  const result=await backfillReplayPlayedAt({corpusRoot,dbPath});
  expect(result).toMatchObject({examined:5,updated:1,alreadyPresent:1,unavailable:3});expect(result.errors).toHaveLength(3);
  expect(rows(dbPath,"SELECT played_at_unix_s FROM replays WHERE sha256='"+registered.replaySha256+"'")).toEqual([{played_at_unix_s:expected}]);
  expect(rows(dbPath,"SELECT played_at_unix_s FROM replays WHERE sha256='"+"b".repeat(64)+"'")).toEqual([{played_at_unix_s:123}]);
  expect(rows(dbPath,"SELECT count(*) AS n FROM analysis_runs")).toEqual(analysesBefore);
  const cli=await Bun.$`${process.execPath} ${join(repo,"apps/cli/src/main.ts")} replays backfill-played-at --corpus-root ${corpusRoot} --db ${dbPath}`.quiet();
  expect(JSON.parse(cli.stdout.toString())).toMatchObject({examined:5,updated:0,alreadyPresent:2,unavailable:3});
  expect(rows(dbPath,"PRAGMA integrity_check")).toEqual([{integrity_check:"ok"}]);expect(rows(dbPath,"PRAGMA foreign_key_check")).toEqual([]);
},{timeout:30000});
