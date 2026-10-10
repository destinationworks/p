import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverFilesWithOptions } from "../src/discover.ts";

describe("file discovery and security boundary filtering", () => {
  it("filters out directories, special files, and files exceeding max size", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p-disc-filter-"));
    try {
      const subDir = path.join(tmpDir, "subfolder");
      fs.mkdirSync(subDir);
      const oversized = path.join(tmpDir, "oversized.ts");
      fs.writeFileSync(oversized, "x".repeat(5000));
      const valid = path.join(tmpDir, "valid.ts");
      fs.writeFileSync(valid, "export const ok = 1;\n");

      const found = discoverFilesWithOptions(tmpDir, { maxFileSize: 1000 });
      expect(found).toEqual([valid]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters private keys, credentials, and non-sample environment files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p-disc-sec-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "server.pem"), "cert");
      fs.writeFileSync(path.join(tmpDir, "private.key"), "key");
      fs.writeFileSync(path.join(tmpDir, ".env"), "secret=1");
      fs.writeFileSync(path.join(tmpDir, ".env.local"), "secret=2");
      fs.writeFileSync(path.join(tmpDir, ".env.production"), "secret=3");
      fs.writeFileSync(path.join(tmpDir, "id_rsa"), "ssh-key");
      fs.writeFileSync(path.join(tmpDir, ".npmrc"), "token=123");
      const secDir = path.join(tmpDir, "secrets");
      fs.mkdirSync(secDir);
      fs.writeFileSync(path.join(secDir, "key.txt"), "secret");

      fs.writeFileSync(path.join(tmpDir, ".env.example"), "PUBLIC=1");
      fs.writeFileSync(path.join(tmpDir, ".env.sample"), "VAR=sample");
      fs.writeFileSync(path.join(tmpDir, ".env.template"), "VAR=template");
      fs.writeFileSync(path.join(tmpDir, "index.ts"), "export const a = 1;\n");

      const found = discoverFilesWithOptions(tmpDir, { maxFileSize: 10000 });
      const basenames = found.map((f) => path.basename(f)).sort();
      expect(basenames).toEqual([".env.example", ".env.sample", ".env.template", "index.ts"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("prevents traversal from symlinks pointing outside workspace root", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p-disc-root-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "p-disc-outside-"));
    try {
      const outsideFile = path.join(outsideDir, "outside.ts");
      fs.writeFileSync(outsideFile, "export const secret = 42;\n");
      const symlinkPath = path.join(tmpRoot, "symlink_escape.ts");
      try {
        fs.symlinkSync(outsideFile, symlinkPath);
      } catch {
        // Ignored on environments without symlink capabilities
      }

      const discovered = discoverFilesWithOptions(tmpRoot, { maxFileSize: 10000 });
      expect(discovered).not.toContain(symlinkPath);
      expect(discovered).not.toContain(outsideFile);
      expect(discovered).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("does not index an internal file symlink twice", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p-disc-internal-"));
    try {
      const targetFile = path.join(tmpRoot, "target.ts");
      fs.writeFileSync(targetFile, "export const internal = true;\n");
      const symlinkPath = path.join(tmpRoot, "link_to_target.ts");
      try {
        fs.symlinkSync(targetFile, symlinkPath);
      } catch {
        // Ignored on environments without symlink capabilities
      }

      const discovered = discoverFilesWithOptions(tmpRoot, { maxFileSize: 10000 });
      expect(discovered).toEqual([targetFile]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("honors hidden files, built-in and user exclusions, and internal symlink rules", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p-disc-glob-contract-"));
    try {
      const hiddenDirectory = path.join(tmpRoot, ".hidden");
      fs.mkdirSync(hiddenDirectory);
      const hiddenSource = path.join(hiddenDirectory, "visible.ts");
      const deniedSource = path.join(hiddenDirectory, "excluded.custom");
      const excludedAsset = path.join(hiddenDirectory, "image.png");
      const excludedDirectory = path.join(tmpRoot, "node_modules");
      fs.mkdirSync(excludedDirectory);
      const excludedDependency = path.join(excludedDirectory, "dependency.ts");
      const lastSource = path.join(tmpRoot, "zeta.ts");
      const firstSource = path.join(tmpRoot, "alpha.ts");
      fs.writeFileSync(hiddenSource, "export const hidden = true;\n");
      fs.writeFileSync(deniedSource, "export const denied = true;\n");
      fs.writeFileSync(excludedAsset, "image contents");
      fs.writeFileSync(excludedDependency, "export const excluded = true;\n");
      fs.writeFileSync(lastSource, "export const last = true;\n");
      fs.writeFileSync(firstSource, "export const first = true;\n");

      const fileSymlink = path.join(tmpRoot, "linked.ts");
      const directorySymlink = path.join(tmpRoot, "linked-hidden");
      let hasFileSymlink = false;
      let hasDirectorySymlink = false;
      try {
        fs.symlinkSync(hiddenSource, fileSymlink);
        hasFileSymlink = true;
      } catch {
        // Symlinks may be unavailable in restricted environments.
      }
      try {
        fs.symlinkSync(hiddenDirectory, directorySymlink, "dir");
        hasDirectorySymlink = true;
      } catch {
        // Symlinks may be unavailable in restricted environments.
      }

      const discovered = discoverFilesWithOptions(tmpRoot, {
        maxFileSize: 1000,
        denyGlobs: ["**/*.custom"],
      });

      expect(discovered).toEqual([hiddenSource, firstSource, lastSource]);
      if (hasFileSymlink) expect(discovered).not.toContain(fileSymlink);
      if (hasDirectorySymlink) expect(discovered).not.toContain(path.join(directorySymlink, "visible.ts"));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
