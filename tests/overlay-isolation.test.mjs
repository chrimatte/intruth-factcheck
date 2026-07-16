import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const manifestPath = new URL("../realtime-factcheck/manifest.json", import.meta.url);
const overlayPath = new URL("../realtime-factcheck/src/content/overlay.js", import.meta.url);
const fixturePath = new URL("./fixtures/overlay-preview.html", import.meta.url);

test("shadow stylesheet is exposed only on the content-script origins", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const overlayResource = manifest.web_accessible_resources?.find((entry) =>
    entry.resources?.includes("src/content/overlay.css")
  );

  assert.ok(overlayResource, "overlay.css must be web accessible when loaded through runtime.getURL");
  assert.deepEqual(overlayResource.resources, ["src/content/overlay.css"]);
  assert.deepEqual(
    new Set(overlayResource.matches),
    new Set(manifest.content_scripts?.[0]?.matches),
    "the stylesheet exposure must not be broader than the content-script surface"
  );
});

test("overlay health fails closed until the closed shadow stylesheet loads", async () => {
  const source = await readFile(overlayPath, "utf8");
  const pingBlock = source.slice(source.indexOf("if (message?.type === 'PING')"));

  assert.match(source, /attachShadow\(\{ mode: 'closed' \}\)/);
  assert.match(source, /chrome\.runtime\.getURL\('src\/content\/overlay\.css'\)/);
  assert.match(source, /stylesheet\.addEventListener\('load',[\s\S]*?panelStylesheetReady = true/);
  assert.match(source, /stylesheet\.addEventListener\('error',[\s\S]*?stopForOverlayIntegrityFailure/);
  assert.match(pingBlock, /sessionIsLive && isOverlayHealthy\(\)/);
  assert.match(pingBlock, /ok: !sessionIsLive \|\| overlayIsHealthy/);
  assert.match(pingBlock, /isActive: overlayIsHealthy/);
});

test("host removal observer watches only the direct document root", async () => {
  const source = await readFile(overlayPath, "utf8");
  const observerBlock = source.slice(
    source.indexOf("function observePanelHost()"),
    source.indexOf("function createPanel()")
  );

  assert.match(observerBlock, /observe\(document\.documentElement, \{ childList: true \}\)/);
  assert.doesNotMatch(observerBlock, /subtree\s*:/);
  assert.match(observerBlock, /observe\(panelHost,[\s\S]*?attributeFilter: \['style', 'class', 'hidden'\]/);
  assert.match(source, /handleUnexpectedPanelRemoval[\s\S]*?STOP_FACTCHECK/);
});

test("overlay health checks rendered visibility, geometry, and pointer reachability", async () => {
  const source = await readFile(overlayPath, "utf8");
  const healthBlock = source.slice(
    source.indexOf("function renderedStyleIsVisible"),
    source.indexOf("async function stopForOverlayIntegrityFailure")
  );

  assert.match(healthBlock, /style\.display !== 'none'/);
  assert.match(healthBlock, /style\.visibility !== 'hidden'/);
  assert.match(healthBlock, /contentVisibility !== 'hidden'/);
  assert.match(healthBlock, /opacity > 0\.05/);
  assert.match(healthBlock, /getComputedStyle\(panelHost\)/);
  assert.match(healthBlock, /getComputedStyle\(panel\)/);
  assert.match(healthBlock, /hostStyle\.pointerEvents !== 'none'/);
  assert.match(healthBlock, /panelStyle\.pointerEvents === 'none'/);
  assert.match(healthBlock, /getBoundingClientRect\(\)/);
  assert.match(healthBlock, /rectIntersectsViewport/);
});

test("utterance timestamps estimate media start time and clamp safely", async () => {
  const source = await readFile(overlayPath, "utf8");
  const helper = source.match(/function estimateUtteranceStartSeconds\([^)]*\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper, "timestamp estimator helper must remain testable as a pure function");

  const context = {};
  vm.runInNewContext(`${helper}; results = [
    estimateUtteranceStartSeconds(100, 4, 1.5),
    estimateUtteranceStartSeconds(2, 4, 1),
    estimateUtteranceStartSeconds(100, null, 2),
    estimateUtteranceStartSeconds(100, 4, 0)
  ];`, context);
  assert.deepEqual([...context.results], [94, 0, 100, 100]);
  assert.match(source, /const timestamp = getVideoTimestamp\(message\)/);
});

test("visual fixture exercises hostile page CSS and lifecycle probes", async () => {
  const fixture = await readFile(fixturePath, "utf8");

  assert.match(fixture, /Deliberately hostile host-page rules/);
  assert.match(fixture, /#intruth-extension-root[\s\S]*?display: none !important/);
  assert.match(fixture, /hostUsesClosedShadowRoot/);
  assert.match(fixture, /removeHost\(\)/);
  assert.match(fixture, /tamperHost\(\)/);
  assert.match(fixture, /setProperty\('display', 'none', 'important'\)/);
  assert.match(fixture, /ping\(\)/);
});
