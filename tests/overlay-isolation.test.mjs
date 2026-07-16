import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const manifestPath = new URL("../realtime-factcheck/manifest.json", import.meta.url);
const overlayPath = new URL("../realtime-factcheck/src/content/overlay.js", import.meta.url);
const overlayCssPath = new URL("../realtime-factcheck/src/content/overlay.css", import.meta.url);
const fixturePath = new URL("./fixtures/overlay-preview.html", import.meta.url);

function cssRuleBodies(source, selector) {
  const bodies = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  const stylesheet = source.replace(/\/\*[\s\S]*?\*\//g, "");
  let match;

  while ((match = rulePattern.exec(stylesheet))) {
    const selectors = match[1].split(",").map((value) => value.trim());
    if (selectors.some((value) => value === selector || value.endsWith(` ${selector}`))) {
      bodies.push({ body: match[2], index: match.index, selectors });
    }
  }

  return bodies;
}

function cssDeclaration(body, property) {
  return body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))?.[1].trim() || "";
}

function paddingInlineStart(value) {
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) return tokens[0];
  if (tokens.length === 2 || tokens.length === 3) return tokens[1];
  return tokens[3] || "";
}

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

test("media timeline seeks create a new transcript boundary and survive video replacement", async () => {
  const source = await readFile(overlayPath, "utf8");
  const resetHelper = source.match(/function resetMediaTimelineBoundary\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(resetHelper, "timeline reset helper must remain testable");

  const context = {
    sentenceTimestamps: [{ text: "before", timestamp: "01:00" }],
    lastTranscriptTimestamp: "01:00",
    lastActiveSpeaker: "Speaker 1",
    clearInterim() {
      context.interimCleared = true;
    },
  };
  vm.runInNewContext(`${resetHelper}; resetMediaTimelineBoundary(); result = {
    timestamps: sentenceTimestamps.length,
    lastTimestamp: lastTranscriptTimestamp,
    lastSpeaker: lastActiveSpeaker,
    interimCleared
  };`, context);
  assert.deepEqual({ ...context.result }, {
    timestamps: 0,
    lastTimestamp: "",
    lastSpeaker: null,
    interimCleared: true,
  });

  assert.match(source, /addEventListener\('seeking',[\s\S]*?beginMediaTimelineBoundary/);
  assert.match(source, /addEventListener\('seeked',[\s\S]*?completeMediaTimelineBoundary/);
  assert.match(source, /type: 'MEDIA_TIMELINE_EVENT'/);
  assert.match(source, /epoch: mediaTimelineEpoch/);
  assert.match(source, /currentTime: Number\.isFinite/);
  assert.match(source, /media_replaced/);
  assert.match(source, /#movie_player video\.html5-main-video/);
  assert.match(source, /mediaTimelineObserver\.observe\(document\.documentElement, \{ childList: true, subtree: true \}\)/);
  assert.match(source, /case 'TRANSCRIPT_RESULT':\s+if \(mediaTimelineSeeking \|\| !resultMatchesMediaTimeline/);
  assert.match(source, /addEventListener\('pause'/);
  assert.match(source, /addEventListener\('play'/);
  assert.match(source, /nextVideo\.paused \? 'paused' : 'playing'/);
  assert.match(source, /date\.toISOString\(\)\.slice\(0, 10\)/);
  assert.doesNotMatch(source, /date\.toLocaleDateString/);

  const finishBlock = source.slice(source.indexOf("function finishSession()"), source.indexOf("function beginSession("));
  const removeBlock = source.slice(source.indexOf("function removePanel()"), source.indexOf("function finishSession()"));
  assert.match(finishBlock, /teardownMediaTimelineEvents\(\)/);
  assert.match(removeBlock, /teardownMediaTimelineEvents\(\)/);
  assert.match(source, /mediaTimelineObserver\?\.disconnect\(\)/);
  assert.match(source, /mediaElementAbortController\?\.abort\(\)/);
});

test("panel close reconciles a lost stop response before deciding whether to block", async () => {
  const source = await readFile(overlayPath, "utf8");
  const getSessionIdHelper = source.match(/function getSessionId\([^)]*\) \{[\s\S]*?\n\}/)?.[0];
  const statusHelper = source.match(/function captureStatusShowsActive\([^)]*\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(getSessionIdHelper && statusHelper, "capture status reconciliation helpers must remain testable");

  const context = {};
  vm.runInNewContext(`${getSessionIdHelper}; ${statusHelper}; results = [
    captureStatusShowsActive({ isCapturing: true, phase: 'ACTIVE', sessionId: 'session-1' }, 'session-1'),
    captureStatusShowsActive({ isCapturing: false, phase: 'STOPPING', sessionId: 'session-1' }, 'session-1'),
    captureStatusShowsActive({ isCapturing: false, phase: 'INACTIVE', sessionId: null }, 'session-1'),
    captureStatusShowsActive({ isCapturing: true, phase: 'ACTIVE', sessionId: 'new-session' }, 'session-1'),
    captureStatusShowsActive(null, 'session-1')
  ];`, context);
  assert.deepEqual([...context.results], [true, false, false, false, false]);

  const stopHelper = source.slice(
    source.indexOf("async function stopCaptureForPanelClose("),
    source.indexOf("function setManagedTimeout(")
  );
  const closeBlock = source.slice(
    source.indexOf("if (target.id === 'rtfc-close')"),
    source.indexOf("if (target.id === 'rtfc-transcript-toggle')")
  );
  assert.match(stopHelper, /STOP_FACTCHECK/);
  assert.match(stopHelper, /catch \(stopError\)[\s\S]*?GET_STATUS/);
  assert.match(stopHelper, /captureStatusShowsActive\(status, sessionId\)/);
  assert.match(closeBlock, /if \(!stopped\)/);
  assert.match(closeBlock, /Audio capture is still active\. Click × to retry stopping it\./);
  assert.doesNotMatch(source, /could not confirm that audio capture stopped/);
});

test("pipeline activity makes empty analysis and estimated cost visible", async () => {
  const source = await readFile(overlayPath, "utf8");

  assert.match(source, /id="rtfc-pipeline-activity"/);
  assert.match(source, /case 'PIPELINE_ACTIVITY'/);
  assert.match(source, /no_claims\s*:/);
  assert.match(source, /claims_rejected\s*:/);
  assert.match(source, /budget_reached\s*:/);
  assert.match(source, /estimatedCostUsd/);
  assert.match(source, /'No statement detected'/);
});

test("overlay content follows one shared gutter and the claim reset cannot remove it", async () => {
  const css = await readFile(overlayCssPath, "utf8");
  const panelRule = cssRuleBodies(css, "#rtfc-panel")[0]?.body || "";
  assert.match(panelRule, /--rtfc-gutter\s*:/, "the panel must expose a single alignment token");

  const alignedSelectors = [
    "#rtfc-header",
    ".rtfc-pipeline-activity",
    ".rtfc-section-header",
    "#rtfc-transcript-feed",
    "#rtfc-interim",
    "#rtfc-claim-feed",
    "#rtfc-verdicts",
  ];
  const inlineStarts = alignedSelectors.map((selector) => {
    const rule = cssRuleBodies(css, selector).find(({ body }) => cssDeclaration(body, "padding"));
    assert.ok(rule, `${selector} must declare its section padding explicitly`);
    const value = paddingInlineStart(cssDeclaration(rule.body, "padding"));
    assert.ok(value, `${selector} must preserve an inline-start gutter`);
    return value;
  });

  assert.deepEqual(
    new Set(inlineStarts),
    new Set(["var(--rtfc-gutter)"]),
    "header, activity, transcript, claims, and verdicts must start on the same gutter"
  );

  const claimRules = cssRuleBodies(css, "#rtfc-claim-feed");
  const claimOverride = claimRules.find(({ selectors }) =>
    selectors.includes("#rtfc-panel #rtfc-claim-feed")
  );
  assert.ok(
    claimOverride,
    "the claim feed must outrank the generic #rtfc-panel ol padding reset"
  );
  assert.equal(cssDeclaration(claimOverride.body, "list-style"), "none");
  assert.equal(paddingInlineStart(cssDeclaration(claimOverride.body, "padding")), "var(--rtfc-gutter)");
});

test("empty states have stable indentation and concise, distinct status copy", async () => {
  const [css, source] = await Promise.all([
    readFile(overlayCssPath, "utf8"),
    readFile(overlayPath, "utf8"),
  ]);

  for (const selector of [".rtfc-claims-empty", ".rtfc-empty-state"]) {
    const body = cssRuleBodies(css, selector)[0]?.body || "";
    assert.ok(body, `${selector} styles must remain present`);
    assert.doesNotMatch(body, /(?:margin-left|margin-inline-start|text-indent)\s*:\s*-/);
    assert.doesNotMatch(body, /translateX\(\s*-/);
  }

  assert.match(source, />Analysis active<\/span>/);
  assert.match(source, /listening: 'Listening for statements'/);
  assert.match(source, /<strong>Listening for statements<\/strong>/);
  assert.match(source, /0 passages · 0 claims/);
  assert.doesNotMatch(source, /0 windows · 0 claims/);
  assert.match(source, /<strong>No statements yet<\/strong>/);
  assert.match(source, /Factual claims and clearly marked opinions will appear here\./);
  assert.match(source, /<strong>No results yet<\/strong>/);
  assert.match(source, /Evidence verdicts and opinion labels will appear here\./);
});

test("claim states remain color-distinct and newest results render first", async () => {
  const [css, source] = await Promise.all([
    readFile(overlayCssPath, "utf8"),
    readFile(overlayPath, "utf8"),
  ]);

  const colorNames = ["true", "subtrue", "false", "misleading", "unverifiable", "opinion", "error"];
  const colors = colorNames.map((name) => {
    const match = css.match(new RegExp(`--rtfc-${name}\\s*:\\s*([^;]+)`));
    assert.ok(match, `missing color token for ${name}`);
    return match[1].trim();
  });
  assert.equal(new Set(colors).size, colors.length, "every result state needs a distinct color");

  assert.match(css, /\.rtfc-claim-number\s*\{[^}]*var\(--rtfc-state-color\)/s);
  assert.match(css, /\.rtfc-claim-state\s*\{[^}]*var\(--rtfc-state-color\)/s);
  assert.match(css, /\.rtfc-claim-item\s*\{[^}]*border-bottom[^}]*var\(--rtfc-state-color\)/s);
  assert.match(css, /\.rtfc-verdict\s*\{[^}]*background[^}]*var\(--rtfc-state-color\)[^}]*border-left[^}]*var\(--rtfc-state-color\)/s);
  assert.match(source, /TRUE: 'Supported'/);
  assert.match(source, /FALSE: 'Contradicted'/);
  assert.match(source, /UNVERIFIABLE: 'Not enough evidence'/);
  assert.match(source, /OPINION: 'Opinion'/);

  assert.match(source, /verdictListEl\.prepend\(newCard\)/);
  assert.match(source, /claimFeedEl\.prepend\(item\)/);
  assert.doesNotMatch(source, /verdictListEl\.appendChild\(newCard\)/);
  assert.doesNotMatch(source, /claimFeedEl\.appendChild\(item\)/);
});

test("statement rows navigate accessibly to their associated result", async () => {
  const [css, source] = await Promise.all([
    readFile(overlayCssPath, "utf8"),
    readFile(overlayPath, "utf8"),
  ]);

  assert.match(source, /<button type="button" class="rtfc-claim-link"/);
  assert.match(source, /data-action="open-verdict"/);
  assert.match(source, /link\.setAttribute\('aria-controls', record\.domId\)/);
  assert.match(source, /article\.tabIndex = -1/);
  assert.match(source, /focusClaimVerdict\(target\.dataset\.claimId\)/);
  assert.match(source, /body\.scrollTo\(\{/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /highlightVerdictCard\(record, newCard, highlightRemaining\)/);
  assert.match(source, /navigationHighlightExpiresAt/);
  assert.match(css, /\.rtfc-verdict--targeted::after/);
  assert.match(css, /\.rtfc-claim-open/);
});

test("opinions are first-class, non-verdict results", async () => {
  const [source, exportSource, fixture] = await Promise.all([
    readFile(overlayPath, "utf8"),
    readFile(new URL("../realtime-factcheck/src/content/session-export.js", import.meta.url), "utf8"),
    readFile(fixturePath, "utf8"),
  ]);

  assert.match(source, /'OPINION'/);
  assert.match(source, /View opinion classification/);
  assert.match(source, /Opinion identified/);
  assert.match(exportSource, /Opinion — no evidence search or factual verdict was requested\./);
  assert.match(exportSource, /'OPINION'/);
  assert.match(fixture, /statementType: 'OPINION'/);
  assert.match(fixture, /The message of the Holocaust is never again not just for Jews/);
});

test("visual fixture exercises hostile page CSS and lifecycle probes", async () => {
  const fixture = await readFile(fixturePath, "utf8");

  assert.match(fixture, /Deliberately hostile host-page rules/);
  assert.match(fixture, /#intruth-extension-root[\s\S]*?display: none !important/);
  assert.match(fixture, /hostUsesClosedShadowRoot/);
  assert.match(fixture, /removeHost\(\)/);
  assert.match(fixture, /tamperHost\(\)/);
  assert.match(fixture, /navigateToOpinion\(\)/);
  assert.match(fixture, /data-testid="navigation-status"/);
  assert.match(fixture, /setProperty\('display', 'none', 'important'\)/);
  assert.match(fixture, /ping\(\)/);
  assert.match(fixture, /fixtureState !== 'empty'/);
  assert.match(fixture, /opinionsDetected: 1/);
});
