import { chmodSync, cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const packageRoot = process.cwd();
const dist = join(packageRoot, "dist");

function copyFiles(sources, destination) {
  mkdirSync(destination, { recursive: true });
  for (const source of sources) cpSync(join(packageRoot, source), join(destination, basename(source)));
}

function copyMatching(source, suffix, destination) {
  const directory = join(packageRoot, source);
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && entry.name.endsWith(suffix))
    .map((entry) => join(source, entry.name));
  if (files.length === 0) throw new Error(`No ${suffix} files in ${source}`);
  copyFiles(files, destination);
}

function copyAssets() {
  copyMatching("src/modes/interactive/theme", ".json", join(dist, "modes/interactive/theme"));
  copyMatching("src/modes/interactive/assets", ".png", join(dist, "modes/interactive/assets"));
  copyFiles(
    ["src/core/export-html/template.html", "src/core/export-html/template.css", "src/core/export-html/template.js"],
    join(dist, "core/export-html"),
  );
  copyMatching("src/core/export-html/vendor", ".js", join(dist, "core/export-html/vendor"));
  copyFiles(["src/voice-server-cli/voice-page.html"], join(dist, "voice-server-cli"));
}

function copyBinaryAssets() {
  copyFiles(["package.json", "README.md", "CHANGELOG.md"], dist);
  copyMatching("src/modes/interactive/theme", ".json", join(dist, "theme"));
  copyMatching("src/modes/interactive/assets", ".png", join(dist, "assets"));
  copyFiles(["src/core/export-html/template.html"], join(dist, "export-html"));
  copyMatching("src/core/export-html/vendor", ".js", join(dist, "export-html/vendor"));
  for (const directory of ["docs", "examples"]) {
    cpSync(join(packageRoot, directory), join(dist, directory), { recursive: true });
  }
  cpSync(
    join(packageRoot, "../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"),
    join(dist, "photon_rs_bg.wasm"),
  );
}

switch (process.argv[2]) {
  case "clean":
    rmSync(dist, { recursive: true, force: true });
    break;
  case "coverage-dir":
    mkdirSync(join(packageRoot, "coverage"), { recursive: true });
    break;
  case "chmod-cli":
    for (const name of ["cli.js", "voice-server-cli.js"]) {
      const file = join(dist, name);
      chmodSync(file, statSync(file).mode | 0o111);
    }
    break;
  case "copy-assets":
    copyAssets();
    break;
  case "copy-binary-assets":
    copyBinaryAssets();
    break;
  default:
    throw new Error(`Unknown workspace file operation: ${process.argv[2] ?? "<missing>"}`);
}
