import path from "node:path";
import { validateExtension } from "./extension-utils.mjs";

const extensionRoot = path.resolve(process.argv[2] ?? "realtime-factcheck");
const errors = await validateExtension(extensionRoot);

if (errors.length > 0) {
  console.error(`Extension validation failed (${errors.length}):`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(`Extension validation passed: ${extensionRoot}`);
}
