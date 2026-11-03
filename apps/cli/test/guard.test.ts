import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCommand } from "../src/guard";

async function withHome(
  runTest: (context: { home: string; env: NodeJS.ProcessEnv }) => Promise<void>,
) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "jevgrep-guard-")));
  const env: NodeJS.ProcessEnv = { HOME: home };
  try {
    await runTest({ home, env });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function dirs(home: string, ...paths: string[]) {
  for (const path of paths) await mkdir(join(home, path), { recursive: true });
}

test("refuses roots that resolve to the home, agent homes, config, ssh, storage or credentials", async () => {
  await withHome(async ({ home, env }) => {
    await dirs(
      home,
      ".claude/projects",
      ".claude-work",
      ".codex",
      ".config/gh",
      ".ssh",
      ".local/state/jevgrep",
      ".cache/jevgrep",
      "repos/chat-personal/credentials/grafana",
      "repos/chat-work/customers/acme/credentials",
      "repos/app/src",
    );
    for (const root of [
      home,
      join(home, ".."),
      join(home, ".claude/projects"),
      join(home, ".claude-work"),
      join(home, ".codex"),
      join(home, ".config"),
      join(home, ".config/gh"),
      join(home, ".ssh"),
      join(home, ".local/state/jevgrep"),
      join(home, ".cache/jevgrep"),
      join(home, "repos/chat-personal/credentials"),
      join(home, "repos/chat-personal/credentials/grafana"),
      join(home, "repos/chat-work/customers/acme/credentials"),
      // A symlink or relative spelling is judged by where it resolves.
      join(home, "repos/app/../../.ssh"),
    ]) {
      await expect(prepareCommand(["question", root], env)).rejects.toThrow("refusing to search");
      await expect(prepareCommand(["files", root], env)).rejects.toThrow("refusing to search");
    }
    // Full mode lifts the defaults, never the guard.
    await expect(prepareCommand(["question", join(home, ".ssh"), "--full"], env)).rejects.toThrow(
      "refusing to search",
    );
    await expect(
      prepareCommand(["question", join(home, ".ssh")], { ...env, JG_FULL: "1" }),
    ).rejects.toThrow("refusing to search");
    await expect(prepareCommand(["question", join(home, "repos/app")], env)).resolves.toBeDefined();
  });
});

test("secret repositories always exclude credentials, and protected paths under a root stay protected", async () => {
  await withHome(async ({ home, env }) => {
    await dirs(home, "repos/chat-personal/notes", "repos/chat-work", ".local/state/jevgrep");
    const inside = await prepareCommand(
      ["question", join(home, "repos/chat-personal/notes"), "--full"],
      env,
    );
    expect(inside.command).toMatchObject({ policy: { exclude: ["credentials/"] } });
    const above = await prepareCommand(["question", join(home, "repos"), "--full"], env);
    expect(above.command).toMatchObject({
      policy: { exclude: ["/chat-personal/**/credentials/", "/chat-work/**/credentials/"] },
    });
    const local = await prepareCommand(["files", join(home, ".local"), "--full"], env);
    expect(local.protectedPaths).toContain(join(home, ".local/state/jevgrep"));
  });
});

test("protected paths and secret repositories are configurable by file and environment", async () => {
  await withHome(async ({ home, env }) => {
    await dirs(home, "vault/keys", ".ssh", "secrets-repo/sub", "jevgrep-config");
    const configured = { ...env, XDG_CONFIG_HOME: join(home, "jevgrep-config") };
    await mkdir(join(home, "jevgrep-config/jevgrep"), { recursive: true });
    await writeFile(
      join(home, "jevgrep-config/jevgrep/guard.json"),
      JSON.stringify({ protectedPaths: ["~/vault"], secretRepositories: ["~/secrets-repo"] }),
    );
    await expect(
      prepareCommand(["question", join(home, "vault/keys")], configured),
    ).rejects.toThrow("refusing to search");
    // The file replaces the default list.
    await expect(
      prepareCommand(["question", join(home, ".ssh")], configured),
    ).resolves.toBeDefined();
    const repo = await prepareCommand(
      ["question", join(home, "secrets-repo/sub"), "--full"],
      configured,
    );
    expect(repo.command).toMatchObject({ policy: { exclude: ["credentials/"] } });
    // The environment replaces the file.
    await expect(
      prepareCommand(["question", join(home, "vault/keys")], {
        ...configured,
        JEVGREP_PROTECTED_PATHS: join(home, ".ssh"),
      }),
    ).resolves.toBeDefined();
    await writeFile(join(home, "jevgrep-config/jevgrep/guard.json"), "{not json");
    await expect(prepareCommand(["question", join(home, "vault")], configured)).rejects.toThrow(
      "guard.json",
    );
  });
});

test("defaults exclude generated content and tests, and bound requests and concurrency", async () => {
  await withHome(async ({ home, env }) => {
    await dirs(home, "app");
    const root = join(home, "app");
    const { command } = await prepareCommand(["how are events recorded", root], env);
    if (command.kind !== "search") throw new Error("Expected search");
    expect(command.maxRequests).toBe(250);
    expect(command.concurrency).toBe(8);
    for (const pattern of ["backlog/", "docs/", "codex/", "*.lock", "zz_generated*", "*_test.go"])
      expect(command.policy.exclude).toContain(pattern);

    const tests = await prepareCommand(["how are the TESTS wired", root], env);
    expect(tests.command).toMatchObject({ kind: "search" });
    if (tests.command.kind !== "search") throw new Error("Expected search");
    expect(tests.command.policy.exclude).toContain("backlog/");
    expect(tests.command.policy.exclude).not.toContain("*_test.go");

    const explicit = await prepareCommand(
      ["question", root, "--max-requests=40", "--concurrency", "2", "--exclude", "src/"],
      env,
    );
    expect(explicit.command).toMatchObject({ maxRequests: 40, concurrency: 2 });
    if (explicit.command.kind !== "search") throw new Error("Expected search");
    expect(explicit.command.policy.exclude).toContain("src/");
    expect(explicit.command.policy.exclude).toContain("docs/");

    const files = await prepareCommand(["files", root], env);
    expect(files.command).toMatchObject({ kind: "files" });
    if (files.command.kind !== "files") throw new Error("Expected files");
    expect(files.command.policy.exclude).toContain("*.spec.tsx");
    expect(files.command).not.toHaveProperty("maxRequests");

    for (const full of [
      await prepareCommand(["question", root, "--full"], env),
      await prepareCommand(["question", root], { ...env, JG_FULL: "1" }),
    ]) {
      expect(full.command).toMatchObject({ kind: "search", maxRequests: 1000 });
      expect(full.command).not.toHaveProperty("concurrency");
      expect(full.command).not.toHaveProperty("policy.exclude");
    }
    // A literal --full after -- is a positional, not the flag.
    await expect(prepareCommand(["question", "--", "--full"], env)).resolves.toMatchObject({
      command: { root: "--full" },
    });
  });
});

test("the CLI refuses a protected root and reports default exclusions without a provider", async () => {
  await withHome(async ({ home }) => {
    await dirs(home, ".ssh", "app/src", "app/docs");
    await writeFile(join(home, "app/src/index.ts"), "export const x = 1;\n");
    await writeFile(join(home, "app/docs/guide.md"), "# Guide\n");
    const run = async (args: string[]) => {
      const child = Bun.spawn(
        ["bun", fileURLToPath(new URL("../src/index.ts", import.meta.url)), ...args],
        {
          cwd: home,
          env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "", XDG_CACHE_HOME: "", JG_FULL: "" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return { stdout, code };
    };
    const refused = await run(["files", join(home, ".ssh")]);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain(`refusing to search ${join(home, ".ssh")}`);
    const counted = await run(["files", join(home, "app")]);
    expect(counted.code).toBe(0);
    expect(counted.stdout).toContain("1 file eligible");
    expect(counted.stdout).toContain('"exclude_pattern" 1');
    const full = await run(["files", join(home, "app"), "--full"]);
    expect(full.stdout).toContain("2 files eligible");
  });
});
