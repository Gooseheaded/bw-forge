import { watch as watchDirectory, type FSWatcher } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { enqueueReplay } from "./jobs.js";

export const WATCH_DEFAULTS = {
  stabilityMs: 1_500,
  reconcileMs: 60_000
} as const;

export interface ReplayWatchOptions {
  paths: string[];
  corpusRoot: string;
  dbPath: string;
  recursive?: boolean;
  stabilityMs?: number;
  reconcileMs?: number;
}

export interface ReplayWatchError { path: string; message: string; }
export interface ReplayWatchSummary {
  paths: string[];
  discovered: number;
  queued: number;
  alreadyActive: number;
  alreadyIndexed: number;
  deferred: number;
  errors: ReplayWatchError[];
}

type EnqueueResult = Awaited<ReturnType<typeof enqueueReplay>>;
export interface ReplayWatcherDependencies {
  enqueue: typeof enqueueReplay;
  log: (message: string) => void;
}

const defaults: ReplayWatcherDependencies = {
  enqueue: enqueueReplay,
  log: message => process.stderr.write(`${message}\n`)
};

type FileSnapshot = { signature: string };
type StabilityResult =
  | { status: "ready"; snapshot: FileSnapshot }
  | { status: "changed" }
  | { status: "disappeared" }
  | { status: "ignored" }
  | { status: "error"; error: unknown };

export function createReplayWatcher(dependencies: ReplayWatcherDependencies = defaults) {
  async function once(options: ReplayWatchOptions): Promise<ReplayWatchSummary> {
    const resolved = await validateOptions(options);
    const scan = await scanRoots(resolved.paths, resolved.recursive);
    const summary = emptySummary(resolved.paths);
    summary.discovered = scan.candidates.length;
    summary.errors.push(...scan.errors);
    const readiness = await Promise.all(scan.candidates.map(async path => ({
      path,
      result: await checkStability(path, resolved.stabilityMs)
    })));
    for (const candidate of readiness) {
      if (candidate.result.status === "ready") await register(candidate.path, resolved, summary);
      else if (candidate.result.status === "changed" || candidate.result.status === "disappeared") summary.deferred++;
      else if (candidate.result.status === "error") summary.errors.push(watchError(candidate.path, candidate.result.error));
    }
    return summary;
  }

  async function run(options: ReplayWatchOptions & { signal?: AbortSignal }): Promise<ReplayWatchSummary & { status: "stopped" }> {
    const resolved = await validateOptions(options);
    const summary = emptySummary(resolved.paths), watchers = new Map<string, FSWatcher>();
    const pending = new Map<string, Promise<void>>(), cache = new Map<string, string>(), seenCandidates = new Set<string>();
    const controller = new AbortController();
    let accepting = true, reconciling = false, reconcileAgain = false, activeReconciliation: Promise<void> | undefined;
    const stop = () => { accepting = false; controller.abort(); };
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();

    const processCandidate = async (path: string, reason: "scan" | "event") => {
      if (!accepting || !isReplayName(path)) return;
      if (reason === "event") dependencies.log(`[watcher] candidate detected source=${path}`);
      dependencies.log(`[watcher] candidate waiting for stability source=${path}`);
      while (accepting) {
        const first = await snapshot(path);
        if (first.status === "ready" && cache.get(path) === first.snapshot.signature) return;
        const stable = await checkStability(path, resolved.stabilityMs, controller.signal);
        if (stable.status === "changed") continue;
        if (stable.status === "disappeared" || stable.status === "ignored") return;
        if (stable.status === "error") {
          const item = watchError(path, stable.error); summary.errors.push(item);
          dependencies.log(`[watcher] registration error source=${path}: ${item.message}`); return;
        }
        if (!accepting) return;
        const before = stable.snapshot.signature;
        const registered = await register(path, resolved, summary, true);
        if (!registered) return;
        const after = await snapshot(path);
        if (after.status === "ready") {
          cache.set(path, after.snapshot.signature);
          if (after.snapshot.signature !== before) continue;
        }
        return;
      }
    };

    const schedule = (path: string, reason: "scan" | "event") => {
      const normalized = resolve(path);
      if (!resolved.paths.some(root => resolved.recursive ? normalized === root || contained(root, normalized) : dirname(normalized) === root)) return Promise.resolve();
      if (isReplayName(normalized) && !seenCandidates.has(normalized)) { seenCandidates.add(normalized); summary.discovered++; }
      const current = pending.get(normalized);
      if (current) return current;
      const task = processCandidate(normalized, reason).catch(error => {
        const item = watchError(normalized, error); summary.errors.push(item);
        dependencies.log(`[watcher] registration error source=${normalized}: ${item.message}`);
      }).finally(() => pending.delete(normalized));
      pending.set(normalized, task);
      return task;
    };

    const refreshWatchers = async () => {
      if (!accepting) return;
      const directories = resolved.recursive ? await listDirectories(resolved.paths) : resolved.paths;
      for (const directory of directories) {
        if (!accepting) break;
        if (watchers.has(directory)) continue;
        try {
          const watcher = watchDirectory(directory, { persistent: true }, (event, filename) => {
            if (!accepting) return;
            if (filename) void schedule(join(directory, filename.toString()), "event");
            else void reconcile("event");
            // Some backends report only the old name for a rename. Reconcile
            // this watched directory so an atomic .partial -> .rep publish is
            // discovered without waiting for the low-frequency safety scan.
            if (event === "rename") void reconcile("event");
            if (resolved.recursive && event === "rename") void refreshWatchers();
          });
          watcher.on("error", error => {
            watchers.delete(directory); watcher.close();
            dependencies.log(`[watcher] filesystem notification error path=${directory}: ${errorMessage(error)}`);
          });
          watchers.set(directory, watcher);
          dependencies.log(`[watcher] watching path=${directory}`);
        } catch (error) {
          const item = watchError(directory, error); summary.errors.push(item);
          dependencies.log(`[watcher] filesystem notification error path=${directory}: ${item.message}`);
        }
      }
    };

    const reconcile = (reason: "startup" | "periodic" | "event"): Promise<void> => {
      if (!accepting) return Promise.resolve();
      if (reconciling) { reconcileAgain = true; return activeReconciliation ?? Promise.resolve(); }
      reconciling = true;
      const task = (async () => {
        try {
          do {
            reconcileAgain = false;
            await refreshWatchers();
            const scan = await scanRoots(resolved.paths, resolved.recursive);
            summary.errors.push(...scan.errors);
            for (const error of scan.errors) dependencies.log(`[watcher] scan error path=${error.path}: ${error.message}`);
            const tasks = scan.candidates.map(path => schedule(path, reason === "startup" ? "scan" : "event"));
            await Promise.all(tasks);
          } while (accepting && reconcileAgain);
        } finally { reconciling = false; }
      })();
      activeReconciliation = task;
      return task;
    };

    dependencies.log(`[watcher] started paths=${resolved.paths.join(",")}`);
    await refreshWatchers();
    await reconcile("startup");
    dependencies.log(`[watcher] startup scan complete discovered=${summary.discovered} queued=${summary.queued} alreadyActive=${summary.alreadyActive} alreadyIndexed=${summary.alreadyIndexed} errors=${summary.errors.length}`);
    const interval = setInterval(() => void reconcile("periodic"), resolved.reconcileMs);
    try {
      if (!controller.signal.aborted) await new Promise<void>(done => controller.signal.addEventListener("abort", () => done(), { once: true }));
    } finally {
      accepting = false; controller.abort(); clearInterval(interval);
      for (const watcher of watchers.values()) watcher.close();
      dependencies.log("[watcher] shutting down");
      if (activeReconciliation) await activeReconciliation;
      await Promise.allSettled([...pending.values()]);
      options.signal?.removeEventListener("abort", stop);
    }
    return { ...summary, status: "stopped" };
  }

  async function register(path: string, options: ResolvedOptions, summary: ReplayWatchSummary, live = false): Promise<EnqueueResult | undefined> {
    try {
      const result = await dependencies.enqueue({ replayPath: path, corpusRoot: options.corpusRoot, dbPath: options.dbPath,
        sourceKind: "filesystem", sourceRef: path });
      const jobKey = result.job?.jobKey ? ` job=${result.job.jobKey}` : "";
      if (result.status === "queued") { summary.queued++; dependencies.log(`[watcher] replay queued source=${path} sha=${result.replaySha256}${jobKey}`); }
      else if (result.status === "already-queued") { summary.alreadyActive++; dependencies.log(`[watcher] already active source=${path} sha=${result.replaySha256}${jobKey}`); }
      else if (result.status === "already-indexed") { summary.alreadyIndexed++; dependencies.log(`[watcher] already indexed source=${path} sha=${result.replaySha256}`); }
      else dependencies.log(`[watcher] replay registered source=${path} sha=${result.replaySha256} status=${result.status}`);
      return result;
    } catch (error) {
      const item = watchError(path, error); summary.errors.push(item);
      if (live) dependencies.log(`[watcher] registration error source=${path}: ${item.message}`);
      return undefined;
    }
  }

  return { once, run };
}

export const watchReplayFilesOnce = (options: ReplayWatchOptions) => createReplayWatcher().once(options);
export const watchReplayFiles = (options: ReplayWatchOptions & { signal?: AbortSignal }) => createReplayWatcher().run(options);

type ResolvedOptions = Required<Omit<ReplayWatchOptions, "paths">> & { paths: string[] };
async function validateOptions(options: ReplayWatchOptions): Promise<ResolvedOptions> {
  if (!options.paths.length) throw new Error("At least one watched --path is required");
  const stabilityMs = options.stabilityMs ?? WATCH_DEFAULTS.stabilityMs;
  const reconcileMs = options.reconcileMs ?? WATCH_DEFAULTS.reconcileMs;
  if (!Number.isSafeInteger(stabilityMs) || stabilityMs < 0) throw new Error("stabilityMs must be a non-negative integer");
  if (!Number.isSafeInteger(reconcileMs) || reconcileMs < 100) throw new Error("reconcileMs must be at least 100");
  const corpusRoot = await resolvedExistingOrLexical(options.corpusRoot);
  const managed = ["replays", "analyses", "work", "db"].map(name => join(corpusRoot, name));
  const paths: string[] = [];
  for (const input of options.paths) {
    const path = await realpath(resolve(input));
    const info = await lstat(path);
    if (!info.isDirectory()) throw new Error(`Watched path is not a directory: ${path}`);
    if (path === corpusRoot || managed.some(item => overlaps(path, item))) throw new Error(`Watched path overlaps managed corpus storage: ${path}`);
    if (!paths.includes(path)) paths.push(path);
  }
  return { paths, corpusRoot, dbPath: resolve(options.dbPath), recursive: options.recursive ?? false, stabilityMs, reconcileMs };
}

async function resolvedExistingOrLexical(path: string) {
  try { return await realpath(resolve(path)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(path);
    throw error;
  }
}
function overlaps(a: string, b: string) { return a === b || contained(a, b) || contained(b, a); }
function contained(parent: string, child: string) { const value = relative(parent, child); return value !== "" && value !== ".." && !value.startsWith("..\\") && !value.startsWith("../") && !isAbsolute(value); }
function isReplayName(path: string) { return extname(path).toLowerCase() === ".rep"; }
function signature(info: Awaited<ReturnType<typeof lstat>>) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}
async function snapshot(path: string): Promise<StabilityResult> {
  if (!isReplayName(path)) return { status: "ignored" };
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return { status: "ignored" };
    return { status: "ready", snapshot: { signature: signature(info) } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "disappeared" };
    return { status: "error", error };
  }
}
async function checkStability(path: string, stabilityMs: number, signal?: AbortSignal): Promise<StabilityResult> {
  const first = await snapshot(path);
  if (first.status !== "ready") return first;
  if (!await delay(stabilityMs, signal)) return { status: "disappeared" };
  const second = await snapshot(path);
  if (second.status !== "ready") return second;
  return first.snapshot.signature === second.snapshot.signature ? second : { status: "changed" };
}
function delay(ms: number, signal?: AbortSignal) { return new Promise<boolean>(done => {
  if (signal?.aborted) return done(false);
  const timer = setTimeout(() => finish(true), ms);
  const abort = () => finish(false);
  function finish(value: boolean) { clearTimeout(timer); signal?.removeEventListener("abort", abort); done(value); }
  signal?.addEventListener("abort", abort, { once: true });
}); }
async function scanRoots(paths: string[], recursive: boolean) {
  const candidates = new Set<string>(), errors: ReplayWatchError[] = [];
  const visit = async (directory: string) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { errors.push(watchError(directory, error)); return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && isReplayName(entry.name)) candidates.add(path);
      else if (recursive && entry.isDirectory()) await visit(path);
    }
  };
  for (const path of paths) await visit(path);
  return { candidates: [...candidates].sort(), errors };
}
async function listDirectories(paths: string[]) {
  const directories = new Set<string>();
  const visit = async (directory: string) => {
    directories.add(directory);
    try { for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(join(directory, entry.name)); }
    catch { /* reconciliation reports inaccessible directories */ }
  };
  for (const path of paths) await visit(path);
  return [...directories];
}
function emptySummary(paths: string[]): ReplayWatchSummary {
  return { paths, discovered: 0, queued: 0, alreadyActive: 0, alreadyIndexed: 0, deferred: 0, errors: [] };
}
function watchError(path: string, error: unknown): ReplayWatchError { return { path, message: errorMessage(error) }; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
