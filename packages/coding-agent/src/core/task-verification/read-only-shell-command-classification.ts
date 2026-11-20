import { tokenizeShellCommands } from "./shell-command-tokenization.ts";

// The narrow set is also the project-rule tool trust boundary, so discovery-only widening lives in separate sets.
const CONFIDENTLY_READ_ONLY_SHELL_COMMANDS = new Set([
  "cat",
  "cmp",
  "df",
  "diff",
  "echo",
  "file",
  "grep",
  "head",
  "ioreg",
  "ls",
  "pwd",
  "rg",
  "shasum",
  "stat",
  "sw_vers",
  "system_profiler",
  "tail",
  "test",
  "wc",
  "which",
]);
const DISCOVERY_ONLY_SHELL_COMMANDS = new Set(["cd"]);
// Discovery-only toolchain probes: `<tool> <flag>` with exactly that one argument prints a version and exits.
// Short flags are listed only where the tool documents them as version flags (`python -v` is verbose). yarn, pnpm,
// cargo and rustc are deliberately absent: `.yarnrc.yml` yarnPath, packageManager self-switching and
// rust-toolchain.toml path toolchains let the workspace choose which program `--version` runs.
const LONG_VERSION = ["--version"];
const DISCOVERY_VERSION_PROBE_FLAGS = new Map<string, ReadonlySet<string>>([
  ["node", new Set([...LONG_VERSION, "-v"])],
  ["npm", new Set([...LONG_VERSION, "-v"])],
  ["npx", new Set(LONG_VERSION)],
  ["bun", new Set([...LONG_VERSION, "-v"])],
  ["deno", new Set([...LONG_VERSION, "-V"])],
  ["python", new Set([...LONG_VERSION, "-V"])],
  ["python3", new Set([...LONG_VERSION, "-V"])],
  ["pip", new Set([...LONG_VERSION, "-V"])],
  ["pip3", new Set([...LONG_VERSION, "-V"])],
  ["uv", new Set([...LONG_VERSION, "-V"])],
  ["go", new Set(["version"])],
  ["git", new Set(LONG_VERSION)],
  ["tsc", new Set([...LONG_VERSION, "-v"])],
]);
const CONFIDENTLY_READ_ONLY_GIT_SUBCOMMANDS = new Set(["diff", "log", "show", "status"]);
const DISCOVERY_ONLY_GIT_SUBCOMMANDS = new Set(["ls-files", "rev-parse"]);
// Global git options that cannot change what the subcommand reads or writes. `-c`, `--git-dir`, `--work-tree`,
// `--exec-path` and friends are deliberately absent: `-c core.fsmonitor=...` and similar run arbitrary programs.
const READ_ONLY_GIT_FLAG_OPTIONS = new Set(["--no-pager", "--no-optional-locks"]);
const SAFE_NULL_REDIRECT_PATTERN = /(?:^|\s)(?:[012]?>>|[012]?>)\s*\/dev\/null(?=\s|$)/gu;
// Pure descriptor duplication between the standard streams (`2>&1`, `>&2`). The lookahead rejects `2>&1file`, which
// bash parses as a redirect into a file named `1file`. `&>file`, `>& file` and `>&3` never match.
const SAFE_FD_DUPLICATION_PATTERN = /(?:^|\s)[012]?>&[012](?=[\s;&|]|$)/gu;

function isReadOnlyGitBranchArguments(args: readonly string[]): boolean {
  return args.length === 0 || (args.length === 1 && (args[0] === "--show-current" || args[0] === "--list"));
}

function isConfidentlyReadOnlyGitInvocation(words: readonly string[], discovery: boolean): boolean {
  let index = 1;
  while (discovery && index < words.length) {
    const option = words[index]!;
    if (option === "-C" && words[index + 1] !== undefined) {
      index += 2;
    } else if (READ_ONLY_GIT_FLAG_OPTIONS.has(option)) {
      index += 1;
    } else {
      break;
    }
  }
  const subcommand = words[index]?.toLocaleLowerCase("en-US");
  if (subcommand === undefined) return false;
  const args = words.slice(index + 1);
  if (
    args.some(
      (word) => word === "--output" || word.startsWith("--output=") || word === "--ext-diff" || word === "--textconv",
    )
  ) {
    return false;
  }
  if (subcommand === "branch") return discovery && isReadOnlyGitBranchArguments(args);
  return (
    CONFIDENTLY_READ_ONLY_GIT_SUBCOMMANDS.has(subcommand) ||
    (discovery && DISCOVERY_ONLY_GIT_SUBCOMMANDS.has(subcommand))
  );
}

function isConfidentlyReadOnlyShellWords(words: readonly string[], discovery: boolean): boolean {
  const executable = words[0];
  if (!executable || executable.includes("/") || executable.includes("\\")) return false;
  const name = executable.toLocaleLowerCase("en-US");
  if (
    name === "find" &&
    words.some((word) => /^-(?:delete|exec|execdir|fls|fprint|fprint0|fprintf|ok|okdir)$/u.test(word))
  ) {
    return false;
  }
  if (name === "rg" && words.some((word) => word === "--pre" || word.startsWith("--pre="))) return false;
  if (
    name === "file" &&
    words.slice(1).some((word) => word === "--compile" || (/^-[^-]*C/u.test(word) && word !== "-"))
  ) {
    return false;
  }
  if (name === "diff" && words.slice(1).some((word) => word === "--output" || word.startsWith("--output="))) {
    return false;
  }
  if (name === "diskutil") {
    const subcommand = words[1]?.toLocaleLowerCase("en-US");
    return subcommand === "list" || subcommand === "info";
  }
  if (name === "mount") return words.length === 1;
  if (discovery && words.length === 2 && DISCOVERY_VERSION_PROBE_FLAGS.get(name)?.has(words[1]!)) return true;
  if (name === "git") return isConfidentlyReadOnlyGitInvocation(words, discovery);
  return CONFIDENTLY_READ_ONLY_SHELL_COMMANDS.has(name) || (discovery && DISCOVERY_ONLY_SHELL_COMMANDS.has(name));
}

/** Narrow allowlist: also decides which shell commands project rules may run without trust. */
export function isConfidentlyReadOnlyShellCommand(command: string): boolean {
  return classify(command, false);
}

/**
 * Wider allowlist for the verification gate only: `cd`, standard-stream duplication (`2>&1`), `git rev-parse`,
 * `git ls-files`, `git branch` without arguments, and `git -C <dir>` forms of the read-only subcommands.
 */
export function isReadOnlyDiscoveryShellCommand(command: string): boolean {
  return classify(command, true);
}

function classify(command: string, discovery: boolean): boolean {
  const withoutNullRedirects = command.replace(SAFE_NULL_REDIRECT_PATTERN, " ");
  const commandWithoutSafeRedirects = discovery
    ? withoutNullRedirects.replace(SAFE_FD_DUPLICATION_PATTERN, " ")
    : withoutNullRedirects;
  if (!command || /[\n\r`$()<>]/u.test(commandWithoutSafeRedirects)) return false;
  const commands = tokenizeShellCommands(commandWithoutSafeRedirects);
  return commands.length > 0 && commands.every((words) => isConfidentlyReadOnlyShellWords(words, discovery));
}
