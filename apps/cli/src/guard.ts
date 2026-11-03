import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { storageDirectory } from "@repo/core/storage";
import { parseCommand, type Command } from "./args";
import { CliError } from "./errors";

/**
 * Local guards applied around parseCommand: a search uploads source to a model provider, so
 * roots that hold agent state or credentials are refused, secret repositories never send their
 * credentials directory, and searches default to bounded excludes, requests and concurrency.
 * Full mode (--full, or JG_FULL / JEVGREP_FULL set) lifts the defaults, never the guard.
 */
export type GuardConfig = {
  /** Absolute paths; a trailing * matches any name with that prefix. A root inside one is refused. */
  protectedPaths: string[];
  /** Repositories that commit secrets: a credentials directory in one is never searched. */
  secretRepositories: string[];
  defaultExcludes: string[];
  /** Added to the defaults unless the question mentions tests; files always adds them. */
  testExcludes: string[];
  maxRequests: number;
  concurrency: number;
};

const secretDirectory = "credentials";

export function defaultGuardConfig(env: NodeJS.ProcessEnv = process.env): GuardConfig {
  const home = homeOf(env);
  return {
    protectedPaths: [
      join(home, ".claude*"),
      join(home, ".codex*"),
      join(home, ".config"),
      join(home, ".ssh"),
      join(home, ".local/state/jevgrep"),
      storage("config", env),
      storage("cache", env),
    ],
    secretRepositories: [join(home, "repos/chat-personal"), join(home, "repos/chat-work")],
    defaultExcludes: [
      "backlog/",
      "docs/",
      "public/",
      "backups/",
      "codex/",
      "testdata/",
      "fixtures/",
      "__snapshots__/",
      "migrations/",
      "*.lock",
      "package-lock.json",
      "*.min.js",
      "*.map",
      "*.svg",
      "*.csv",
      "*.tsv",
      "*.golden",
      "*.pb.go",
      "*_gen.go",
      "*.gen.go",
      "*.sql.go",
      "zz_generated*",
    ],
    testExcludes: ["*_test.go", "*.test.ts", "*.test.tsx", "*.spec.ts", "*.spec.tsx"],
    maxRequests: 250,
    concurrency: 8,
  };
}

export function guardConfigPath(env: NodeJS.ProcessEnv = process.env) {
  return join(storage("config", env), "guard.json");
}

/** Defaults, then guard.json keys replace theirs, then JEVGREP_PROTECTED_PATHS / JEVGREP_SECRET_REPOSITORIES replace those lists. */
export async function loadGuardConfig(env: NodeJS.ProcessEnv = process.env): Promise<GuardConfig> {
  const config = defaultGuardConfig(env);
  const path = guardConfigPath(env);
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new CliError(`Could not read ${path}.`);
  }
  if (text !== undefined) {
    let saved: unknown;
    try {
      saved = JSON.parse(text);
    } catch {
      throw new CliError(`${path} is not valid JSON.`);
    }
    if (!saved || typeof saved !== "object" || Array.isArray(saved))
      throw new CliError(`${path} must hold a JSON object.`);
    for (const [key, value] of Object.entries(saved)) {
      if (key === "maxRequests" || key === "concurrency") {
        if (!Number.isSafeInteger(value) || (value as number) < 1)
          throw new CliError(`${path}: ${key} must be a positive integer.`);
        config[key] = value as number;
      } else if (key in config) {
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item))
          throw new CliError(`${path}: ${key} must be an array of strings.`);
        (config as Record<string, unknown>)[key] = value;
      } else throw new CliError(`${path}: unknown key ${key}.`);
    }
  }
  if (env.JEVGREP_PROTECTED_PATHS !== undefined)
    config.protectedPaths = env.JEVGREP_PROTECTED_PATHS.split(delimiter).filter(Boolean);
  if (env.JEVGREP_SECRET_REPOSITORIES !== undefined)
    config.secretRepositories = env.JEVGREP_SECRET_REPOSITORIES.split(delimiter).filter(Boolean);
  const home = homeOf(env);
  for (const key of ["protectedPaths", "secretRepositories"] as const)
    config[key] = config[key].map((entry) => {
      const expanded =
        entry === "~" ? home : entry.startsWith("~/") ? join(home, entry.slice(2)) : entry;
      if (!isAbsolute(expanded))
        throw new CliError(`Guard paths must be absolute or start with ~/, not ${entry}.`);
      return expanded;
    });
  return config;
}

export const guardHelp = `
Local guards:
  A root that resolves to your home (or above it) or inside a protected path is
  refused: ~/.claude*, ~/.codex*, ~/.config, ~/.ssh, ~/.local/state/jevgrep and
  Jevgrep's config and cache. Protected paths under a root are skipped. In
  ~/repos/chat-personal and ~/repos/chat-work a credentials/ directory is never
  read and a root inside one is refused.
  Defaults: generated, tracker, docs and lock files are excluded, tests too unless
  the question mentions tests, and searches use --max-requests 250 and
  --concurrency 8 unless you pass them.
  --full (or JG_FULL=1) lifts the defaults, never the guard.
  Configure in $XDG_CONFIG_HOME/jevgrep/guard.json (protectedPaths,
  secretRepositories, defaultExcludes, testExcludes, maxRequests, concurrency);
  each key replaces its default. JEVGREP_PROTECTED_PATHS and
  JEVGREP_SECRET_REPOSITORIES (path lists) replace those two again.
`;

/** Parse the arguments and apply the local guards. Throws CliError for a refused root. */
export async function prepareCommand(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ command: Command; protectedPaths: string[] }> {
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  const flagged = options.includes("--full");
  const full = flagged || Boolean(env.JG_FULL || env.JEVGREP_FULL);
  const command = parseCommand(
    flagged ? [...options.filter((arg) => arg !== "--full"), ...args.slice(options.length)] : args,
  );
  if (command.kind !== "search" && command.kind !== "files") return { command, protectedPaths: [] };
  const config = await loadGuardConfig(env);
  const root = await realpath(resolve(command.root)).catch(() => undefined);
  // A missing root is reported by the command itself; there is nothing to send.
  if (!root) return { command, protectedPaths: [] };
  const home = await resolved(homeOf(env));
  const refuse = () => {
    throw new CliError(
      `jg: refusing to search ${root} (agent home or credential store). ` +
        `Searches upload source to a model provider; see ${guardConfigPath(env)}.`,
    );
  };
  if (within(root, home)) refuse();
  const protectedPaths: string[] = [];
  for (const entry of config.protectedPaths) {
    for (const path of await expand(entry, root)) {
      if (within(path, root)) refuse();
      if (within(root, path)) protectedPaths.push(path);
    }
  }
  const excludes: string[] = [];
  for (const repository of await Promise.all(config.secretRepositories.map(resolved))) {
    if (within(repository, root)) {
      if (relative(repository, root).split(sep).includes(secretDirectory)) refuse();
      excludes.push(`${secretDirectory}/`);
    } else if (within(root, repository)) {
      excludes.push(
        `/${escapeGlob(relative(root, repository).split(sep).join("/"))}/**/${secretDirectory}/`,
      );
    }
  }
  if (!full) {
    excludes.push(...config.defaultExcludes);
    if (command.kind === "files" || !/test/i.test(command.query))
      excludes.push(...config.testExcludes);
    if (command.kind === "search") {
      if (!options.some((arg) => arg === "--max-requests" || arg.startsWith("--max-requests=")))
        command.maxRequests = config.maxRequests;
      command.concurrency ??= config.concurrency;
    }
  }
  if (excludes.length)
    command.policy.exclude = [...new Set([...(command.policy.exclude ?? []), ...excludes])].sort();
  return { command, protectedPaths };
}

/** storageDirectory, with the home taken from env like every other guard path. */
function storage(kind: "config" | "cache", env: NodeJS.ProcessEnv) {
  const xdg = kind === "config" ? env.XDG_CONFIG_HOME : env.XDG_CACHE_HOME;
  if (process.platform === "win32" || (xdg && isAbsolute(xdg))) return storageDirectory(kind, env);
  return join(homeOf(env), kind === "config" ? ".config" : ".cache", "jevgrep");
}

function homeOf(env: NodeJS.ProcessEnv) {
  return env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir();
}

async function resolved(path: string) {
  return realpath(path).catch(() => resolve(path));
}

/** True when path is base or inside it. */
function within(base: string, path: string) {
  const rel = relative(base, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The real paths an entry names; a trailing * matches every sibling name with that prefix. */
async function expand(entry: string, root: string) {
  if (!entry.endsWith("*")) return [await resolved(entry)];
  const parent = await resolved(dirname(entry));
  const prefix = basename(entry).slice(0, -1);
  const matches: string[] = [];
  // The root itself or an ancestor of it may match without being listed (it can be unreadable).
  const step = relative(parent, root).split(sep)[0];
  if (within(parent, root) && step && step !== ".." && step.startsWith(prefix))
    matches.push(join(parent, step));
  // Listed siblings resolve symlinks, so a linked agent home is judged by where it points.
  for (const name of await readdir(parent).catch(() => [] as string[]))
    if (name.startsWith(prefix)) matches.push(await resolved(join(parent, name)));
  return [...new Set(matches)];
}

function escapeGlob(path: string) {
  return path.replace(/[\\*?[\]]/g, "\\$&");
}
