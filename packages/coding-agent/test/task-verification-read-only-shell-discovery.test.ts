import { describe, expect, it } from "vitest";
import { resolvedTaskVerificationToolEffect } from "../src/core/task-verification/taskverificationcontroller-methods/tool-effect-resolution.ts";
import {
  isConfidentlyReadOnlyShellTool,
  isReadOnlyDiscoveryShellTool,
} from "../src/core/task-verification/tool-classification.ts";

function isReadOnly(command: string, toolName = "bash"): boolean {
  return isReadOnlyDiscoveryShellTool(toolName, { command });
}

describe("read-only shell discovery classification", () => {
  describe("commands a model ran and was blocked on before the checklist", () => {
    it.each([
      "cd /Users/dst/.agents 2>/dev/null && git rev-parse --show-toplevel 2>&1; git -C /Users/dst/.agents ls-files --error-unmatch skills/onepassword-cli/SKILL.md 2>&1",
      "ls -la 2>&1 | head",
      "git rev-parse --show-toplevel 2>&1",
      "cd /tmp && ls",
    ])("classifies %s as read-only and resolves it to a read effect", (command) => {
      expect(isReadOnly(command)).toBe(true);
      expect(resolvedTaskVerificationToolEffect({ toolCall: { name: "bash" }, args: { command } }).kind).toBe("read");
    });

    it("keeps a write redirect on a workspace_write effect", () => {
      const effect = resolvedTaskVerificationToolEffect({
        toolCall: { name: "bash" },
        args: { command: "ls 2>&1 > out.txt" },
      });
      expect(effect.kind).toBe("workspace_write");
    });
  });

  describe("file descriptor duplication", () => {
    it.each([
      "ls 2>&1",
      "ls -la 2>&1 | head",
      "ls >&2",
      "ls 1>&2",
      "ls >&1",
      "ls 2>&1 2>&1",
      "ls 2>/dev/null 2>&1",
      "ls 2>&1; pwd",
      "ls 2>&1|head",
      "ls 2>&1 && pwd",
      "git status 2>&1",
    ])("allows %s", (command) => {
      expect(isReadOnly(command)).toBe(true);
      expect(isReadOnly(command, "ctx_shell")).toBe(true);
    });

    it.each([
      "echo x > out.txt",
      "echo x >> out.txt",
      "ls &> out.txt",
      "ls &>out.txt",
      "ls >& out.txt",
      "ls >&out.txt",
      "ls 2>&1file",
      "ls >&2file",
      "ls 2>&1 > out.txt",
      "ls >&2 >out.txt",
      "ls >&1>out.txt",
      "ls 2>&1&>out.txt",
      "ls 2>&3",
      "ls 2>&10",
      "ls 10>&1",
      "ls 2>&-",
      "cat a 2> err.txt",
      "cat a 2>> err.txt",
      "cat < a",
      "ls 2>&$FD",
    ])("rejects %s", (command) => {
      expect(isReadOnly(command)).toBe(false);
    });

    it("does not let a descriptor duplication hide an unsafe segment", () => {
      expect(isReadOnly("ls 2>&1 | tee out.txt")).toBe(false);
      expect(isReadOnly("ls 2>&1; rm -rf build")).toBe(false);
      expect(isReadOnly("ls 2>&1 & rm out.txt")).toBe(false);
    });
  });

  describe("cd", () => {
    it.each(["cd /tmp", "cd", "cd -- /tmp", "cd /tmp && ls", "cd /tmp; pwd", "cd /tmp 2>/dev/null && git status"])(
      "allows %s",
      (command) => {
        expect(isReadOnly(command)).toBe(true);
      },
    );

    it.each([
      "cd x && rm y",
      "cd x; rm y",
      "cd $(pwd)",
      "cd $HOME",
      "cd `pwd`",
      "cd x > out.txt",
      "cd x && echo y > z",
      "FOO=1 cd x",
      "pushd /tmp",
    ])("rejects %s", (command) => {
      expect(isReadOnly(command)).toBe(false);
    });
  });

  describe("git subcommands", () => {
    it.each([
      "git rev-parse --show-toplevel",
      "git rev-parse HEAD",
      "git rev-parse --git-path HEAD",
      "git ls-files",
      "git ls-files --error-unmatch skills/onepassword-cli/SKILL.md",
      "git branch",
      "git branch --show-current",
      "git branch --list",
      "git branch --show-current 2>&1",
      "git status && git branch --show-current && git rev-parse HEAD",
    ])("allows %s", (command) => {
      expect(isReadOnly(command)).toBe(true);
    });

    it.each([
      "git branch feature",
      "git branch -D x",
      "git branch -d x",
      "git branch -m old new",
      "git branch -c old new",
      "git branch --set-upstream-to=origin/main",
      "git branch --list feature",
      "git branch --show-current extra",
      "git branch --show-current --list",
      "git branch ''",
      "git rev-parse --git-path x > f",
      "git ls-files > tracked.txt",
      "git ls-files --output=tracked.txt",
      "git branch --show-current >> branches.txt",
      "git remote add origin x",
      "git config user.name x",
      "git checkout main",
      "git commit -m x",
      "git",
      "git -C",
    ])("rejects %s", (command) => {
      expect(isReadOnly(command)).toBe(false);
    });

    it("keeps the existing git output and external-program option guards", () => {
      expect(isReadOnly("git diff --output=result.patch")).toBe(false);
      expect(isReadOnly("git diff --ext-diff")).toBe(false);
      expect(isReadOnly("git show --textconv HEAD:file")).toBe(false);
      expect(isReadOnly("git diff --stat")).toBe(true);
    });
  });

  describe("git global options", () => {
    it.each([
      "git -C /x status",
      "git -C /x rev-parse --show-toplevel",
      "git -C /x -C y status",
      "git --no-pager log --oneline -5",
      "git --no-optional-locks status",
      "git --no-pager -C /x diff",
      "git -C /x branch --show-current",
      "git -C /x ls-files",
    ])("allows %s", (command) => {
      expect(isReadOnly(command)).toBe(true);
    });

    it.each([
      "git -C /x branch feature",
      "git -C /x commit -m x",
      "git -C /x push",
      "git -C /x status --output=x",
      "git -C /x > out.txt",
      "git -c core.fsmonitor=touch status",
      "git -c core.pager=evil log",
      "git --git-dir=/x status",
      "git --work-tree=/x status",
      "git --exec-path status",
      "git --output=x status",
      "git --paginate log",
      "git -C status",
    ])("rejects %s", (command) => {
      expect(isReadOnly(command)).toBe(false);
    });
  });

  describe("project-rule trust boundary", () => {
    it.each([
      "cd /tmp && ls",
      "ls 2>&1",
      "git rev-parse --show-toplevel",
      "git ls-files",
      "git branch",
      "git -C /tmp status",
      "git --no-pager log",
    ])("keeps %s outside the narrow read-only allowlist", (command) => {
      expect(isConfidentlyReadOnlyShellTool("bash", { command })).toBe(false);
      expect(isReadOnly(command)).toBe(true);
    });

    it.each(["ls", "git status", "git log | head", "cat README.md 2>/dev/null"])("still trusts %s", (command) => {
      expect(isConfidentlyReadOnlyShellTool("bash", { command })).toBe(true);
    });
  });

  describe("unchanged guards", () => {
    it("still requires a shell tool and a non-empty command", () => {
      expect(isReadOnlyDiscoveryShellTool("read", { command: "ls" })).toBe(false);
      expect(isReadOnly("")).toBe(false);
      expect(isReadOnly("   ")).toBe(false);
      expect(isReadOnlyDiscoveryShellTool("bash", {})).toBe(false);
    });

    it.each(["ls $(pwd)", "ls `pwd`", "ls\nrm x", "cat <(ls)", "/bin/ls", "rm x", "ls | xargs rm"])(
      "still rejects %s",
      (command) => {
        expect(isReadOnly(command)).toBe(false);
      },
    );
  });
});
