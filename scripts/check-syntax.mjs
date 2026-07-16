import { spawnSync } from "node:child_process";
import path from "node:path";
import { walkFiles } from "./extension-utils.mjs";

const roots = ["realtime-factcheck/src", "scripts", "tests"];
let failed = false;

for (const root of roots) {
  const files = await walkFiles(path.resolve(root), (file) => file.endsWith(".js") || file.endsWith(".mjs"));
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
    if (result.status !== 0) failed = true;
  }
}

if (failed) process.exitCode = 1;
else console.log("JavaScript syntax checks passed.");
