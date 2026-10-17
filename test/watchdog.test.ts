import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const watchdog = fileURLToPath(new URL("../apps/cli/src/watchdog.ts", import.meta.url));

// Runs a child that starts the watchdog and then misbehaves, and reports how it ended.
function run(limits: object, misbehave: string, pauseMs?: [number, number]) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import { startWatchdog } from ${JSON.stringify(watchdog)};
       startWatchdog(${JSON.stringify(limits)});
       setTimeout(() => { ${misbehave} }, 50);`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  if (pauseMs) {
    setTimeout(() => child.kill("SIGSTOP"), pauseMs[0]);
    setTimeout(() => child.kill("SIGCONT"), pauseMs[1]);
  }
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const started = Date.now();
  // Backstop so a broken watchdog fails the test instead of hanging it.
  const backstop = setTimeout(() => child.kill("SIGKILL"), 15_000);
  return new Promise<{ signal: NodeJS.Signals | null; stderr: string; ms: number }>((resolve) =>
    child.on("exit", (_code, signal) => {
      clearTimeout(backstop);
      resolve({ signal, stderr, ms: Date.now() - started });
    }),
  );
}

test("a main thread stuck in a synchronous loop is stopped with a reason", async () => {
  const result = await run({ maxStallMs: 1_000 }, "for (;;) {}");
  assert.equal(result.signal, "SIGKILL");
  assert.match(result.stderr, /jg: stopped: main thread unresponsive for \d+ s/);
  assert.ok(result.ms < 8_000, `took ${result.ms} ms`);
});

test("native memory growth past the limit is stopped with a reason", async () => {
  const result = await run(
    { maxRssBytes: 512 * 1024 * 1024 },
    "const keep = []; setInterval(() => keep.push(Buffer.alloc(16 * 1024 * 1024, 1)), 20);",
  );
  assert.equal(result.signal, "SIGKILL");
  assert.match(result.stderr, /jg: stopped: memory use reached \d+ MiB \(limit 512 MiB\)/);
});

test("a healthy run exits normally without a watchdog message", async () => {
  const result = await run({ maxStallMs: 1_000 }, "setTimeout(() => process.exit(0), 2_500);");
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
});

// A suspended or sleeping machine pauses every thread at once; that is not a stuck search.
test("a whole-process pause longer than the stall limit is not a stall", async () => {
  const result = await run(
    { maxStallMs: 1_000 },
    "setTimeout(() => process.exit(0), 4_000);",
    [500, 3_000],
  );
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
});
