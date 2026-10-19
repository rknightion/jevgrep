import { spawn } from "node:child_process";
import type { Command } from "./args";
import { CliError } from "./errors";

const windowsCommandMetaCharacters = /([()[\]{}%!^"`<>&|;, *?])/g;

function escapeWindowsCommand(command: string): string {
  return command.replace(windowsCommandMetaCharacters, "^$1");
}

function escapeWindowsArgument(argument: string): string {
  let escaped = argument;
  // Preserve literal quotes and trailing backslashes when cmd.exe parses the
  // quoted argument. This follows the Windows command-line quoting rules.
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/g, "$1$1");
  return `"${escaped}"`.replace(windowsCommandMetaCharacters, "^$1");
}

function windowsInstallerCommand(args: string[]): string[] {
  const command = [
    escapeWindowsCommand("npx"),
    ...args.map((argument) => escapeWindowsArgument(argument)),
  ].join(" ");
  return ["/d", "/s", "/c", `"${command}"`];
}

export async function installSkill(
  command: Extract<Command, { kind: "skill" }>,
  signal: AbortSignal,
): Promise<number> {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major! < 22 || (major === 22 && minor! < 20))
    throw new CliError("jg skill requires Node 22.20 or newer (skills@1.7.0).");
  const args = [
    "--yes",
    "--ignore-scripts",
    "skills@1.7.0",
    "add",
    "dzhng/jevgrep@main",
    "--skill",
    "jevgrep",
  ];
  for (const agent of command.agents) args.push("--agent", agent);
  if (command.global) args.push("--global");
  if (command.yes) args.push("--yes");
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const child = spawn(
      windows ? (process.env.ComSpec ?? process.env.comspec ?? "cmd.exe") : "npx",
      windows ? windowsInstallerCommand(args) : args,
      {
        // Preserve installer prompts while keeping all CLI output on stdout.
        stdio: ["inherit", process.stdout, process.stdout],
        shell: false,
        windowsVerbatimArguments: windows,
        signal,
        killSignal: "SIGINT",
      },
    );
    child.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "ENOENT"
          ? new CliError("Skill installation requires npx. Install npm, then run jg skill again.")
          : error,
      ),
    );
    child.once("close", (code, childSignal) =>
      resolve(code ?? (childSignal === "SIGINT" ? 130 : 1)),
    );
  });
}
