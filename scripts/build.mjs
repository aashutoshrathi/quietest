import { cpSync, rmSync } from "node:fs";

const EXTENSION_FILES = ["manifest.json", "src", "options", "icons"];

rmSync("dist", { recursive: true, force: true });
for (const file of EXTENSION_FILES) {
  cpSync(file, `dist/${file}`, { recursive: true, filter: (source) => !source.endsWith(".DS_Store") });
}
