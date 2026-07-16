import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  collectManifestReferences,
  extractLocalHtmlReferences,
  findHardcodedProviderSecrets,
  validateExtension
} from "../scripts/extension-utils.mjs";

test("collectManifestReferences returns extension entry points", () => {
  const refs = collectManifestReferences({
    background: { service_worker: "worker.js" },
    action: { default_popup: "popup.html", default_icon: { 16: "icon.png" } },
    content_scripts: [{ js: ["content.js"], css: ["content.css"] }],
    web_accessible_resources: [{ resources: ["shadow.css"], matches: ["https://example.com/*"] }]
  });
  assert.deepEqual(
    new Set(refs),
    new Set(["worker.js", "popup.html", "icon.png", "content.js", "content.css", "shadow.css"])
  );
});

test("extractLocalHtmlReferences ignores remote and fragment links", () => {
  const html = '<script src="offscreen-ex.js"></script><a href="#help"></a><a href="https://example.com"></a>';
  assert.deepEqual(extractLocalHtmlReferences(html), ["offscreen-ex.js"]);
});

test("hard-coded provider credential detection permits empty placeholders only", () => {
  assert.deepEqual(findHardcodedProviderSecrets('const DEEPGRAM_KEY = "";'), []);
  assert.deepEqual(findHardcodedProviderSecrets('const SERPER_KEY = "not-a-real-secret";'), ["not-a-real-secret"]);
});

test("checked-in extension has no dangling references or embedded provider credentials", async () => {
  const errors = await validateExtension(path.resolve("realtime-factcheck"));
  assert.deepEqual(errors, []);
});
