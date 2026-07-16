import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { validateExtension } from "./extension-utils.mjs";

const source = path.resolve("realtime-factcheck");
const destination = path.resolve("dist/intruth");
const sourceErrors = await validateExtension(source);

if (sourceErrors.length > 0) {
  throw new Error(`Refusing to build an invalid extension:\n${sourceErrors.map((error) => `- ${error}`).join("\n")}`);
}

await rm(destination, { recursive: true, force: true });
await mkdir(path.dirname(destination), { recursive: true });
await cp(source, destination, {
  recursive: true,
  filter: (entry) => path.basename(entry) !== ".gitignore"
});

const builtErrors = await validateExtension(destination);
if (builtErrors.length > 0) throw new Error(`Built extension is invalid:\n${builtErrors.join("\n")}`);
console.log(`Built unpacked extension at ${destination}`);
