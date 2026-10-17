import { Worker } from "node:worker_threads";

const MiB = 1024 * 1024;
const defaults = { maxRssBytes: 4096 * MiB, maxStallMs: 120_000 };

/**
 * Stops jg from a separate thread when the main thread stops answering or memory use runs
 * away. A runaway inside Node's HTTP/2 teardown once held the main thread in one synchronous
 * call while it grew to ~200 GB, so the check cannot run on the main thread. Normal searches
 * use a few hundred MiB and never block the event loop for long; parsing runs in workers.
 */
export function startWatchdog(limits: { maxRssBytes?: number; maxStallMs?: number } = {}) {
  const { maxRssBytes, maxStallMs } = { ...defaults, ...limits };
  const heartbeat = new BigInt64Array(new SharedArrayBuffer(8));
  const beat = () => Atomics.store(heartbeat, 0, BigInt(Date.now()));
  beat();
  setInterval(beat, 250).unref();
  // execArgv: [] keeps the worker a CommonJS script whatever flags started jg.
  const worker = new Worker(source, {
    eval: true,
    execArgv: [],
    workerData: { heartbeat, maxRssBytes, maxStallMs },
  });
  // A failed watchdog must never take a search down with it.
  worker.on("error", () => {});
  worker.unref();
}

// The worker writes synchronously and kills the whole process: the main thread may never
// run another callback, and a stuck process left running is what this exists to prevent.
const source = `
const { workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");
const { heartbeat, maxRssBytes, maxStallMs } = workerData;
function stop(reason) {
  try { writeSync(2, "jg: stopped: " + reason + ". Please report this with the query and repository size.\\n"); }
  finally { process.kill(process.pid, "SIGKILL"); }
}
// A late tick of this worker's own timer means every thread was paused (sleep, SIGSTOP, a
// clock jump), not that the main thread stuck: give it a full limit from the resume.
let lastTick = Date.now();
let resumedAt = 0;
setInterval(() => {
  const now = Date.now();
  if (now - lastTick > 1000) resumedAt = now;
  lastTick = now;
  const stalled = now - Math.max(Number(Atomics.load(heartbeat, 0)), resumedAt);
  if (stalled > maxStallMs)
    return stop("main thread unresponsive for " + Math.round(stalled / 1000) + " s");
  const rss = process.memoryUsage.rss();
  if (rss > maxRssBytes)
    stop("memory use reached " + Math.round(rss / ${MiB}) + " MiB (limit " + Math.round(maxRssBytes / ${MiB}) + " MiB)");
}, 250);
`;
