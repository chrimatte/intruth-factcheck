import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const exportSource = await readFile(
  new URL('../realtime-factcheck/src/content/session-export.js', import.meta.url),
  'utf8'
);

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function loadExporter() {
  const state = { html: '', clicked: false };
  class FakeBlob {
    constructor(parts) {
      this.parts = parts;
    }
  }
  class FakeURL extends URL {}
  FakeURL.createObjectURL = blob => {
    state.html = blob.parts.join('');
    return 'blob:intruth-report';
  };
  FakeURL.revokeObjectURL = () => {};

  const document = {
    title: 'Historical video',
    body: {
      appendChild() {},
    },
    createElement(tag) {
      assert.equal(tag, 'a');
      return {
        href: '',
        download: '',
        click() {
          state.clicked = true;
        },
        remove() {},
      };
    },
  };
  const sandbox = {
    Blob: FakeBlob,
    Date,
    URL: FakeURL,
    document,
    escapeHtml,
    setTimeout(callback) {
      callback();
      return 1;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(exportSource, sandbox, { filename: 'session-export.js' });
  return { sandbox, state };
}

test('HTML reports sort completed results by video time instead of provider completion', () => {
  const { sandbox, state } = loadExporter();
  vm.runInContext("startSession('session-order')", sandbox);
  vm.runInContext(`logVerdict(${JSON.stringify({
    claimId: 'later',
    claim: 'The later statement.',
    status: 'COMPLETE',
    verdict: 'TRUE',
    confidence: 'MEDIUM',
    explanation: 'Supported.',
    _timestamp: '10:01',
  })})`, sandbox);
  vm.runInContext(`logVerdict(${JSON.stringify({
    claimId: 'earlier',
    claim: 'The earlier statement.',
    status: 'COMPLETE',
    verdict: 'TRUE',
    confidence: 'MEDIUM',
    explanation: 'Supported.',
    _timestamp: '09:32',
  })})`, sandbox);

  const result = vm.runInContext('exportHTMLReport()', sandbox);
  assert.equal(result.ok, true);
  assert.equal(state.clicked, true);
  assert.ok(state.html.indexOf('The earlier statement.') < state.html.indexOf('The later statement.'));
  assert.match(state.html, /Claim 1<\/span><span class="timestamp">09:32/);
  assert.match(state.html, /Claim 2<\/span><span class="timestamp">10:01/);
});

test('HTML reports keep global chronology when speakers interleave', () => {
  const { sandbox, state } = loadExporter();
  vm.runInContext("startSession('session-speakers')", sandbox);
  for (const result of [
    { claimId: 'a1', claim: 'Speaker A first.', speaker: 'Speaker A', _timestamp: '01:00' },
    { claimId: 'b1', claim: 'Speaker B second.', speaker: 'Speaker B', _timestamp: '02:00' },
    { claimId: 'a2', claim: 'Speaker A third.', speaker: 'Speaker A', _timestamp: '03:00' },
  ]) {
    vm.runInContext(`logVerdict(${JSON.stringify({
      status: 'COMPLETE',
      verdict: 'TRUE',
      confidence: 'MEDIUM',
      explanation: 'Supported.',
      ...result,
    })})`, sandbox);
  }

  vm.runInContext('exportHTMLReport()', sandbox);
  const positions = [
    state.html.indexOf('Speaker A first.'),
    state.html.indexOf('Speaker B second.'),
    state.html.indexOf('Speaker A third.'),
  ];
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2]);
  assert.match(state.html, /Claim 1<\/span><span class="timestamp">01:00/);
  assert.match(state.html, /Claim 2<\/span><span class="timestamp">02:00/);
  assert.match(state.html, /Claim 3<\/span><span class="timestamp">03:00/);
});

test('HTML reports fall back to elapsed time when a video timestamp is missing', () => {
  const { sandbox, state } = loadExporter();
  vm.runInContext("startSession('session-missing-time')", sandbox);
  vm.runInContext(`logVerdict(${JSON.stringify({
    claimId: 'missing',
    claim: 'Missing video timestamp.',
    status: 'COMPLETE',
    verdict: 'TRUE',
    confidence: 'MEDIUM',
    explanation: 'Supported.',
  })})`, sandbox);
  vm.runInContext(`logVerdict(${JSON.stringify({
    claimId: 'timed',
    claim: 'Explicit video timestamp.',
    status: 'COMPLETE',
    verdict: 'TRUE',
    confidence: 'MEDIUM',
    explanation: 'Supported.',
    _timestamp: '10:00',
  })})`, sandbox);
  vm.runInContext("sessionLog.find(entry => entry.claimId === 'missing').secondsElapsed = 180", sandbox);
  vm.runInContext("sessionLog.find(entry => entry.claimId === 'timed').secondsElapsed = 60", sandbox);

  vm.runInContext('exportHTMLReport()', sandbox);
  assert.ok(
    state.html.indexOf('Explicit video timestamp.') < state.html.indexOf('Missing video timestamp.')
  );
});
