import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { basename } from "node:path";

export function certifiedGitExecutable(): string {
  if (process.platform !== "darwin") throw new Error("Certified Git requires macOS");
  const discovered = execFileSync("/usr/bin/xcrun", ["--find", "git"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", SYSTEM_VERSION_COMPAT: "0" },
  }).trim();
  const executable = realpathSync(discovered);
  if (
    basename(executable) !== "git" ||
    !(
      executable.startsWith("/Library/Developer/CommandLineTools/usr/bin/") ||
      executable.startsWith("/Applications/Xcode.app/Contents/Developer/usr/bin/")
    )
  ) {
    throw new Error("Certified Git must resolve to a trusted Apple developer toolchain");
  }
  accessSync(executable, constants.X_OK);
  return executable;
}
