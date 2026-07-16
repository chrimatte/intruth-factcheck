import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const coreSource = await readFile(
  new URL('../realtime-factcheck/src/shared/pipeline-core.js', import.meta.url),
  'utf8'
);
const workerSource = await readFile(
  new URL('../realtime-factcheck/src/background/service-worker-ex.js', import.meta.url),
  'utf8'
);

const EXTENSION_ID = 'intruth-test-extension';
const SESSION_STATE_KEY = 'intruth.activeSession.v2';
const ACTIVE_TAB = {
  id: 42,
  url: 'https://www.youtube.com/watch?v=test-video',
  title: '(188) Test video - YouTube',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate, message, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(typeof message === 'function' ? message() : message);
}

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    listeners,
  };
}

function jsonResponse(data, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[name] ?? headers[name.toLowerCase()] ?? null;
      },
    },
    async text() {
      return JSON.stringify(data);
    },
  };
}

function loadWorker({ hooks = {}, config = {} } = {}) {
  const runtimeMessageEvent = createEvent();
  const state = {
    config: {
      anthropicKey: 'anthropic-test-key',
      deepgramKey: 'deepgram-test-key',
      serperKey: 'serper-test-key',
      transcriptLanguage: 'en',
      privacyConsent: true,
      privacyConsentVersion: '2026-07-16-v3',
      ...config,
    },
    sessionStorage: {},
    sessionWrites: [],
    sessionRemovals: [],
    runtimeMessages: [],
    tabMessages: [],
    offscreenCreated: false,
    offscreenCreateCount: 0,
    offscreenCloseCount: 0,
    streamRequests: [],
    intervalCallbacks: new Map(),
    nextIntervalId: 1,
  };

  const extensionUrl = path => `chrome-extension://${EXTENSION_ID}/${path}`;

  const chrome = {
    storage: {
      local: {
        async setAccessLevel() {},
        async get() {
          return clone(state.config);
        },
      },
      session: {
        async setAccessLevel() {},
        async get(key) {
          if (typeof key === 'string') {
            return Object.hasOwn(state.sessionStorage, key)
              ? { [key]: clone(state.sessionStorage[key]) }
              : {};
          }
          return clone(state.sessionStorage);
        },
        async set(values) {
          const snapshot = clone(values);
          if (hooks.sessionSet) await hooks.sessionSet(snapshot, state);
          Object.assign(state.sessionStorage, snapshot);
          state.sessionWrites.push(snapshot);
        },
        async remove(key) {
          const keys = Array.isArray(key) ? key : [key];
          for (const item of keys) delete state.sessionStorage[item];
          state.sessionRemovals.push(...keys);
        },
      },
    },
    runtime: {
      id: EXTENSION_ID,
      lastError: null,
      getURL(path) {
        return extensionUrl(path);
      },
      async getContexts() {
        return state.offscreenCreated ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : [];
      },
      async sendMessage(message) {
        state.runtimeMessages.push(clone(message));
        if (hooks.runtimeSend) return hooks.runtimeSend(message, state);
        if (message.type === 'START_CAPTURE') {
          return { ok: true, sessionId: message.sessionId };
        }
        if (message.type === 'STOP_CAPTURE') {
          return { ok: true, sessionId: message.sessionId };
        }
        return { ok: true };
      },
      getPlatformInfo(callback) {
        callback({ os: 'mac' });
      },
      onMessage: runtimeMessageEvent,
      onConnect: createEvent(),
    },
    tabs: {
      async query() {
        return [clone(ACTIVE_TAB)];
      },
      async get(tabId) {
        return tabId === ACTIVE_TAB.id ? clone(ACTIVE_TAB) : null;
      },
      async sendMessage(tabId, message) {
        state.tabMessages.push({ tabId, message: clone(message) });
        if (hooks.tabSend) return hooks.tabSend(tabId, message, state);
        if (message.type === 'PING') {
          return {
            ok: true,
            type: 'PONG',
            requestId: message.requestId,
            sessionId: message.sessionId,
            isActive: false,
          };
        }
        return { ok: true };
      },
      onRemoved: createEvent(),
      onUpdated: createEvent(),
    },
    tabCapture: {
      getMediaStreamId({ targetTabId }, callback) {
        state.streamRequests.push(targetTabId);
        callback(`stream-for-tab-${targetTabId}`);
      },
    },
    offscreen: {
      async createDocument() {
        state.offscreenCreated = true;
        state.offscreenCreateCount++;
      },
      async closeDocument() {
        state.offscreenCreated = false;
        state.offscreenCloseCount++;
      },
    },
  };

  const sandbox = {
    AbortController,
    URL,
    chrome,
    console: { error() {}, warn() {}, log() {} },
    crypto: globalThis.crypto,
    fetch(url, options) {
      if (!hooks.fetch) throw new Error(`Unexpected provider request: ${url}`);
      return hooks.fetch(url, options, state);
    },
    setTimeout,
    clearTimeout,
    setInterval(callback, delay) {
      const id = state.nextIntervalId++;
      state.intervalCallbacks.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) {
      state.intervalCallbacks.delete(id);
    },
    importScripts() {},
  };

  vm.createContext(sandbox);
  vm.runInContext(coreSource, sandbox, { filename: 'pipeline-core.js' });
  vm.runInContext(workerSource, sandbox, { filename: 'service-worker-ex.js' });
  const listener = runtimeMessageEvent.listeners.at(-1);
  assert.equal(typeof listener, 'function', 'service worker did not register onMessage');

  return {
    sandbox,
    state,
    hooks,
    async ready() {
      await vm.runInContext('workerReady', sandbox);
    },
    message(message, sender = {}) {
      return new Promise(resolve => {
        const keepChannelOpen = listener(message, sender, resolve);
        assert.equal(keepChannelOpen, true);
      });
    },
  };
}

function popupSender() {
  return {
    id: EXTENSION_ID,
    url: `chrome-extension://${EXTENSION_ID}/src/popup/popup.html`,
  };
}

function offscreenSender() {
  return {
    id: EXTENSION_ID,
    url: `chrome-extension://${EXTENSION_ID}/src/offscreen/offscreen.html`,
  };
}

function activeTabSender(tabId = ACTIVE_TAB.id) {
  return {
    id: EXTENSION_ID,
    tab: { id: tabId },
    url: ACTIVE_TAB.url,
  };
}

async function startSession(harness, sessionId) {
  const response = await harness.message(
    { type: 'START_FACTCHECK', sessionId },
    popupSender()
  );
  assert.equal(response.ok, true, response.error);
  assert.equal(response.sessionId, sessionId);
  return response;
}

test('transcript splitting preserves decimal and dotted-date tokens', async () => {
  const harness = loadWorker();
  await harness.ready();

  const fragments = vm.runInContext(
    "splitTranscript('Il tasso era 4.2% il 16.07.2026. La frase successiva resta separata.')",
    harness.sandbox
  );

  assert.deepEqual(Array.from(fragments), [
    'Il tasso era 4.2% il 16.07.2026.',
    'La frase successiva resta separata.',
  ]);
});

test('prompts classify opinions, preserve governing negation, and enforce evidence boundaries', () => {
  assert.match(workerSource, /statementType:/);
  assert.match(workerSource, /FACTUAL: an atomic, specific assertion/);
  assert.match(workerSource, /Return at most .* central statements/);
  assert.match(workerSource, /usually return zero or one/);
  assert.match(workerSource, /standalone search query with its subject/);
  assert.match(workerSource, /The message of the Holocaust is never again not just for Jews/);
  assert.match(workerSource, /"X does not say \[P\]" never licenses P/);
  assert.match(workerSource, /TRUE: the evidence directly supports every material part/);
  assert.match(workerSource, /SUBSTANTIALLY TRUE: the central assertion is supported/);
  assert.match(workerSource, /a current population figure cannot/);
  assert.match(workerSource, /only repeats the same speaker's statement/);
  assert.match(workerSource, /Never mention internal evidence labels/);
  assert.match(workerSource, /Treat direct address such as "you support\.\.\." as unresolved/);
  assert.match(workerSource, /I never hide what I do/);
  assert.match(workerSource, /VERDICT_MAX_OUTPUT_TOKENS = 480/);
  assert.match(workerSource, /MAX_CLAIMS_PER_BATCH = 2/);
});

test('extraction rejects a factual-looking clause cut out of governing negation', async () => {
  const harness = loadWorker();
  await harness.ready();
  const sentence = "The convention doesn't say you can wait for genocide to happen.";
  const truncatedInput = {
    claims: [{
      statementType: 'FACTUAL',
      claim: 'You can wait for genocide to happen.',
      sourceQuotes: [{
        sourceSentenceId: 'U1',
        quote: 'you can wait for genocide to happen',
      }],
    }],
  };
  const preservedInput = {
    claims: [{
      statementType: 'FACTUAL',
      claim: sentence,
      sourceQuotes: [{ sourceSentenceId: 'U1', quote: sentence }],
    }],
  };
  const batch = [{ id: 'U1', text: sentence }];

  const truncated = vm.runInContext(
    `validateExtractedClaims(${JSON.stringify(truncatedInput)}, ${JSON.stringify(batch)})`,
    harness.sandbox
  );
  const preserved = vm.runInContext(
    `validateExtractedClaims(${JSON.stringify(preservedInput)}, ${JSON.stringify(batch)})`,
    harness.sandbox
  );

  assert.equal(truncated.length, 0);
  assert.equal(preserved.length, 1);
  assert.equal(preserved[0].claim, sentence);
});

test('extraction rejects unresolved references and low-information archive fragments', async () => {
  const harness = loadWorker();
  await harness.ready();
  const statements = [
    'They smuggled in more advanced weapons from abroad.',
    'All of this happened before 1948.',
    'There were 700 Jewish residents in Hebron at the time.',
    'Many arrests were made.',
    'Police swooped on the secret headquarters of assassins and rebels.',
    'The rebellion began with a general strike and later became armed.',
    'You support violent extremists.',
    'Your allies funded the group.',
    'In 2025, you funded violent extremists.',
    'I never hide what I do.',
  ];
  for (const statement of statements) {
    const batch = [{ id: 'U1', text: statement }];
    const input = {
      claims: [{
        statementType: 'FACTUAL',
        claim: statement,
        sourceQuotes: [{ sourceSentenceId: 'U1', quote: statement }],
      }],
    };
    const validated = vm.runInContext(
      `validateExtractedClaims(${JSON.stringify(input)}, ${JSON.stringify(batch)})`,
      harness.sandbox
    );
    assert.equal(validated.length, 0, statement);
  }
});

test('validated claims are restored to transcript order within one model batch', async () => {
  const harness = loadWorker();
  await harness.ready();
  const first = 'Alpha City had 100 residents in 2020.';
  const second = 'Beta City had 200 residents in 2021.';
  const batch = [{ id: 'U1', text: `${first} ${second}` }];
  const input = {
    claims: [second, first].map(claim => ({
      statementType: 'FACTUAL',
      claim,
      sourceQuotes: [{ sourceSentenceId: 'U1', quote: claim }],
    })),
  };

  const validated = vm.runInContext(
    `validateExtractedClaims(${JSON.stringify(input)}, ${JSON.stringify(batch)})`,
    harness.sandbox
  );

  assert.deepEqual(Array.from(validated, item => item.claim), [first, second]);
});

test('source ranking prefers relevant primary evidence available at the video date', async () => {
  const harness = loadWorker();
  await harness.ready();
  const ranked = vm.runInContext(`rankSourceCandidates(${JSON.stringify([{
    url: 'https://commentary.example/story',
    domain: 'commentary.example',
    title: 'Daniella Weiss sanctioned over support for violence',
    snippet: 'Daniella Weiss was sanctioned for supporting violence.',
    date: '2026-05-20',
  }, {
    url: 'https://www.gov.uk/official-notice',
    domain: 'gov.uk',
    title: 'Official sanctions notice for Daniella Weiss',
    snippet: 'Daniella Weiss supported acts of aggression and violence.',
    date: '2025-05-20',
  }, {
    url: 'https://www.un.org/unrelated',
    domain: 'un.org',
    title: 'Unrelated official release',
    snippet: 'A different subject is discussed here.',
    date: '2025-05-19',
  }])}, 'Daniella Weiss was sanctioned for supporting violence', '2025-07-16')`, harness.sandbox);

  assert.deepEqual(Array.from(ranked, source => source.domain), [
    'gov.uk',
    'commentary.example',
    'un.org',
  ]);

  const relevanceGate = vm.runInContext(`rankSourceCandidates(${JSON.stringify([{
    url: 'https://www.un.org/unrelated',
    domain: 'un.org',
    title: 'Official statement about an unrelated subject',
    snippet: 'No matching terms are present.',
    date: '2025-05-19',
  }, {
    url: 'https://relevant.example/report',
    domain: 'relevant.example',
    title: 'Alpha Beta independent report',
    snippet: 'The report documents Alpha Beta.',
    date: '2025-05-18',
  }])}, 'Alpha Beta Gamma Delta Epsilon', '2025-07-16')`, harness.sandbox);
  assert.equal(relevanceGate[0].domain, 'relevant.example');

  const commonTokenGate = vm.runInContext(`rankSourceCandidates(${JSON.stringify([{
    url: 'https://agency.gov.example/unrelated',
    domain: 'agency.gov.uk',
    title: 'The government released the annual report',
    snippet: 'The government released the report after a scheduled meeting.',
    date: '2025-05-19',
  }, {
    url: 'https://legal-analysis.example/occupation',
    domain: 'legal-analysis.example',
    title: 'Court order to end the occupation',
    snippet: 'The court ordered an end to the occupation.',
    date: '2025-05-18',
  }])}, 'The court ordered the government to end the occupation', '2025-07-16')`, harness.sandbox);
  assert.equal(commonTokenGate[0].domain, 'legal-analysis.example');
});

test('overlong compound statements are rejected before evidence spending', async () => {
  const harness = loadWorker();
  await harness.ready();
  const claim = `The International Court found the occupation unlawful and ordered it to end rapidly and required all settlement activity to stop immediately and required settlers to be evacuated and required reparations and required states not to recognize the situation and required international organizations not to assist it.`;
  const input = {
    claims: [{
      statementType: 'FACTUAL',
      claim,
      sourceQuotes: [{ sourceSentenceId: 'U1', quote: claim }],
    }],
  };
  const validated = vm.runInContext(
    `validateExtractedClaims(${JSON.stringify(input)}, ${JSON.stringify([{ id: 'U1', text: claim }])})`,
    harness.sandbox
  );
  assert.equal(validated.length, 0);
});

test('extraction accepts a central statement resolved from adjacent target utterances', async () => {
  const harness = loadWorker();
  await harness.ready();
  const batch = [
    { id: 'U1', text: 'In 1929, violence reached Hebron.' },
    { id: 'U2', text: 'There were 700 Jewish residents in Hebron.' },
  ];
  const claim = 'In 1929, there were 700 Jewish residents in Hebron.';
  const input = {
    claims: [{
      statementType: 'FACTUAL',
      claim,
      sourceQuotes: [
        { sourceSentenceId: 'U1', quote: 'In 1929' },
        { sourceSentenceId: 'U2', quote: 'There were 700 Jewish residents in Hebron' },
      ],
    }],
  };

  const validated = vm.runInContext(
    `validateExtractedClaims(${JSON.stringify(input)}, ${JSON.stringify(batch)})`,
    harness.sandbox
  );

  assert.equal(validated.length, 1);
  assert.equal(validated[0].claim, claim);
  assert.deepEqual(Array.from(validated[0].sourceSentenceIds), ['U1', 'U2']);
});

test('extraction accepts explicit time anchors but rejects anchorless relative time', async () => {
  const harness = loadWorker();
  await harness.ready();
  const statements = [
    ['Shortly after World War II, the organization was founded.', 1],
    ['Soon after, the organization was founded.', 0],
    ['Shortly afterward, the organization was founded.', 0],
  ];

  for (const [statement, expectedLength] of statements) {
    const batch = [{ id: 'U1', text: statement }];
    const input = {
      claims: [{
        statementType: 'FACTUAL',
        claim: statement,
        sourceQuotes: [{ sourceSentenceId: 'U1', quote: statement }],
      }],
    };
    const validated = vm.runInContext(
      `validateExtractedClaims(${JSON.stringify(input)}, ${JSON.stringify(batch)})`,
      harness.sandbox
    );
    assert.equal(validated.length, expectedLength, statement);
  }
});

test('failed START_CAPTURE rolls back media, overlay, storage, and public status', async () => {
  const hooks = {
    runtimeSend(message) {
      if (message.type === 'START_CAPTURE') {
        return {
          ok: false,
          error: { code: 'DEEPGRAM_CONNECT_FAILED', message: 'Deepgram refused the test socket.' },
        };
      }
      return { ok: true };
    },
  };
  const harness = loadWorker({ hooks });
  await harness.ready();

  const response = await harness.message(
    { type: 'START_FACTCHECK', sessionId: 'session_start_failure' },
    popupSender()
  );

  assert.equal(response.ok, false);
  assert.equal(response.code, 'DEEPGRAM_CONNECT_FAILED');
  assert.deepEqual(
    harness.state.runtimeMessages.map(message => message.type),
    ['START_CAPTURE', 'STOP_CAPTURE']
  );
  assert.ok(harness.state.tabMessages.some(entry => entry.message.type === 'STOP_FACTCHECK'));
  assert.equal(harness.state.offscreenCreated, false);
  assert.equal(harness.state.offscreenCreateCount, 1);
  assert.equal(harness.state.offscreenCloseCount, 1);
  assert.equal(harness.state.sessionStorage[SESSION_STATE_KEY], undefined);

  const status = await harness.message({ type: 'GET_STATUS' });
  assert.deepEqual(
    { isCapturing: status.isCapturing, phase: status.phase, sessionId: status.sessionId },
    { isCapturing: false, phase: 'INACTIVE', sessionId: null }
  );
});

test('Deepgram credential is returned only to the active offscreen session and is never persisted', async () => {
  const harness = loadWorker();
  await harness.ready();
  const sessionId = 'session_capture_credential';
  await startSession(harness, sessionId);

  const startMessage = harness.state.runtimeMessages.find(message => message.type === 'START_CAPTURE');
  assert.ok(startMessage);
  assert.equal(Object.hasOwn(startMessage, 'deepgramKey'), false);

  const credential = await harness.message({
    type: 'GET_CAPTURE_CREDENTIAL',
    sessionId,
  }, offscreenSender());
  assert.equal(credential.ok, true);
  assert.equal(credential.sessionId, sessionId);
  assert.equal(credential.deepgramKey, 'deepgram-test-key');

  const untrusted = await harness.message({
    type: 'GET_CAPTURE_CREDENTIAL',
    sessionId,
  }, activeTabSender());
  assert.equal(untrusted.ok, false);
  assert.equal(untrusted.code, 'UNTRUSTED_CREDENTIAL_REQUEST');

  const stale = await harness.message({
    type: 'GET_CAPTURE_CREDENTIAL',
    sessionId: 'different_session',
  }, offscreenSender());
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'STALE_SESSION');

  const persisted = JSON.stringify(harness.state.sessionStorage);
  assert.equal(persisted.includes('deepgram-test-key'), false);
  assert.equal(persisted.includes('anthropic-test-key'), false);
  assert.equal(persisted.includes('serper-test-key'), false);
});

test('STOP aborts provider work immediately, ignores tail audio for analysis, and cleans up', async () => {
  const stopGate = deferred();
  const fetchCalls = [];
  const hooks = {
    runtimeSend(message) {
      if (message.type === 'START_CAPTURE') {
        return { ok: true, sessionId: message.sessionId };
      }
      if (message.type === 'STOP_CAPTURE') return stopGate.promise;
      return { ok: true };
    },
    fetch(url, options) {
      const call = { url, aborted: options.signal.aborted };
      fetchCalls.push(call);
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          call.aborted = true;
          reject(new Error('aborted by test'));
        }, { once: true });
      });
    },
  };
  const harness = loadWorker({ hooks });
  await harness.ready();
  const sessionId = 'session_stop_boundary';
  await startSession(harness, sessionId);

  const transcriptResponse = await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    text: 'Sentence one is factual. Sentence two is factual. Sentence three is factual. Sentence four is factual. Sentence five is factual. Sentence six is factual.',
    isFinal: true,
    confidence: 0.99,
  }, offscreenSender());
  assert.equal(transcriptResponse.queued, true);
  await eventually(() => fetchCalls.length === 1, 'claim extraction provider request did not start');

  const stopping = harness.message(
    { type: 'STOP_FACTCHECK', sessionId },
    popupSender()
  );
  const tailResponse = await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    text: 'This already-buffered tail must only be displayed.',
    isFinal: true,
    confidence: 0.99,
  }, offscreenSender());
  assert.equal(tailResponse.ok, true);
  assert.equal(tailResponse.queued, false);
  assert.equal(fetchCalls.length, 1, 'tail audio triggered a new provider request');
  await eventually(
    () => harness.state.runtimeMessages.some(message => message.type === 'STOP_CAPTURE'),
    'STOP_CAPTURE was not requested'
  );
  assert.equal(fetchCalls[0].aborted, true, 'in-flight provider request was not aborted');

  stopGate.resolve({ ok: true, sessionId });
  const stopped = await stopping;
  assert.equal(stopped.ok, true);
  assert.equal(stopped.alreadyStopped, false);
  assert.equal(harness.state.offscreenCreated, false);
  assert.equal(harness.state.intervalCallbacks.size, 0);
  assert.equal(harness.state.sessionStorage[SESSION_STATE_KEY], undefined);
  const status = await harness.message({ type: 'GET_STATUS' });
  assert.equal(status.isCapturing, false);
  assert.equal(status.phase, 'INACTIVE');
});

test('seeking clears transcript windows, drops queued pre-seek text, and forwards only trusted events', async () => {
  const harness = loadWorker();
  await harness.ready();
  const sessionId = 'session_timeline_boundary';
  await startSession(harness, sessionId);

  const firstTranscript = await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    text: 'The first timeline contains a factual statement.',
    isFinal: true,
    confidence: 0.99,
  }, offscreenSender());
  assert.equal(firstTranscript.queued, true);
  await eventually(
    () => vm.runInContext('activeSession.pendingSentences.length === 1', harness.sandbox),
    'the pre-seek sentence was not queued'
  );
  assert.equal(vm.runInContext('activeSession.contextSentences.length', harness.sandbox), 1);
  assert.notEqual(vm.runInContext('activeSession.flushTimer', harness.sandbox), null);

  const transcriptGate = deferred();
  harness.sandbox.transcriptGate = transcriptGate.promise;
  vm.runInContext('activeSession.transcriptQueue = transcriptGate', harness.sandbox);
  const delayedTranscript = await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    text: 'This old queued sentence must not cross the seek boundary.',
    isFinal: true,
    confidence: 0.99,
  }, offscreenSender());
  assert.equal(delayedTranscript.queued, true);

  const seeking = await harness.message({
    type: 'MEDIA_TIMELINE_EVENT',
    sessionId,
    phase: 'seeking',
    epoch: 7,
    currentTime: 512.25,
    paused: false,
    playbackRate: 1.5,
  }, activeTabSender());
  assert.equal(seeking.ok, true, seeking.error);
  assert.equal(seeking.epoch, 7);
  assert.equal(
    harness.state.sessionStorage[SESSION_STATE_KEY].timelineEpoch,
    7,
    'the hard seek boundary must survive an MV3 worker restart'
  );
  assert.equal(vm.runInContext('activeSession.pendingSentences.length', harness.sandbox), 0);
  assert.equal(vm.runInContext('activeSession.contextSentences.length', harness.sandbox), 0);
  assert.equal(vm.runInContext('activeSession.pendingSince', harness.sandbox), null);
  assert.equal(vm.runInContext('activeSession.flushTimer', harness.sandbox), null);

  transcriptGate.resolve();
  await vm.runInContext('activeSession.transcriptQueue', harness.sandbox);
  assert.equal(
    vm.runInContext('activeSession.pendingSentences.length', harness.sandbox),
    0,
    'a transcript queued before seeking was processed after the boundary'
  );

  const forwarded = harness.state.runtimeMessages.find(message => (
    message.type === 'MEDIA_TIMELINE_EVENT' && message.phase === 'seeking'
  ));
  assert.deepEqual(forwarded, {
    type: 'MEDIA_TIMELINE_EVENT',
    sessionId,
    phase: 'seeking',
    epoch: 7,
    currentTime: 512.25,
    paused: false,
    playbackRate: 1.5,
  });

  const forwardedCount = harness.state.runtimeMessages
    .filter(message => message.type === 'MEDIA_TIMELINE_EVENT').length;
  const wrongTab = await harness.message({
    type: 'MEDIA_TIMELINE_EVENT',
    sessionId,
    phase: 'seeked',
    epoch: 7,
  }, activeTabSender(999));
  assert.equal(wrongTab.ok, false);
  assert.equal(wrongTab.code, 'UNTRUSTED_TIMELINE_EVENT');

  const staleSession = await harness.message({
    type: 'MEDIA_TIMELINE_EVENT',
    sessionId: 'session_stale_timeline',
    phase: 'seeked',
    epoch: 7,
  }, activeTabSender());
  assert.equal(staleSession.ok, false);
  assert.equal(staleSession.code, 'STALE_SESSION');
  assert.equal(
    harness.state.runtimeMessages.filter(message => message.type === 'MEDIA_TIMELINE_EVENT').length,
    forwardedCount,
    'an untrusted or stale event was forwarded to offscreen capture'
  );

  const oldAudio = await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    timelineEpoch: 0,
    text: 'Old audio must not be accepted after seeking.',
    isFinal: true,
  }, offscreenSender());
  assert.equal(oldAudio.ok, false);
  assert.equal(oldAudio.code, 'STALE_TIMELINE_EVENT');

  const staleSeeking = await harness.message({
    type: 'MEDIA_TIMELINE_EVENT',
    sessionId,
    phase: 'seeking',
    epoch: 6,
    currentTime: 400,
  }, activeTabSender());
  assert.equal(staleSeeking.ok, false);
  assert.equal(staleSeeking.code, 'STALE_TIMELINE_EVENT');
  assert.equal(vm.runInContext('activeSession.timelineEpoch', harness.sandbox), 7);

  const unversionedAudio = await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    text: 'Unversioned audio is unsafe after a seek boundary.',
    isFinal: true,
  }, offscreenSender());
  assert.equal(unversionedAudio.ok, false);
  assert.equal(unversionedAudio.code, 'STALE_TIMELINE_EVENT');

  const currentAudio = await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    timelineEpoch: 7,
    text: 'Current timeline audio remains analyzable.',
    isFinal: true,
    confidence: 0.99,
  }, offscreenSender());
  assert.equal(currentAudio.ok, true);
  assert.equal(currentAudio.queued, true);
  const overlayTranscript = harness.state.tabMessages.find(entry => (
    entry.message.type === 'TRANSCRIPT_RESULT' &&
    entry.message.text === 'Current timeline audio remains analyzable.'
  ));
  assert.equal(overlayTranscript.message.timelineEpoch, 7);

  const paused = await harness.message({
    type: 'MEDIA_TIMELINE_EVENT',
    sessionId,
    phase: 'paused',
    epoch: 7,
    currentTime: 513,
  }, activeTabSender());
  const playing = await harness.message({
    type: 'MEDIA_TIMELINE_EVENT',
    sessionId,
    phase: 'playing',
    epoch: 7,
    currentTime: 513,
  }, activeTabSender());
  assert.equal(paused.ok, true);
  assert.equal(playing.ok, true);
  assert.deepEqual(
    harness.state.runtimeMessages
      .filter(message => message.type === 'MEDIA_TIMELINE_EVENT')
      .slice(-2)
      .map(message => message.phase),
    ['paused', 'playing']
  );

  const stopped = await harness.message(
    { type: 'STOP_FACTCHECK', sessionId },
    popupSender()
  );
  assert.equal(stopped.ok, true);
});

test('concurrent seeking and seeked events preserve persistence and offscreen delivery order', async () => {
  const firstTimelinePersistStarted = deferred();
  const releaseFirstTimelinePersist = deferred();
  let timelinePersistCount = 0;
  const harness = loadWorker({
    hooks: {
      async sessionSet(values) {
        const persisted = values[SESSION_STATE_KEY];
        if (persisted?.timelineEpoch !== 9) return;
        timelinePersistCount++;
        if (timelinePersistCount === 1) {
          firstTimelinePersistStarted.resolve();
          await releaseFirstTimelinePersist.promise;
        }
      },
    },
  });
  await harness.ready();
  const sessionId = 'session_timeline_concurrency';
  await startSession(harness, sessionId);

  const seekingPromise = harness.message({
    type: 'MEDIA_TIMELINE_EVENT',
    sessionId,
    phase: 'seeking',
    epoch: 9,
    currentTime: 720,
    paused: false,
    playbackRate: 1,
  }, activeTabSender());
  await firstTimelinePersistStarted.promise;

  const seekedPromise = harness.message({
    type: 'MEDIA_TIMELINE_EVENT',
    sessionId,
    phase: 'seeked',
    epoch: 9,
    currentTime: 720.25,
    paused: false,
    playbackRate: 1,
  }, activeTabSender());

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(
    harness.state.runtimeMessages.some(message => message.type === 'MEDIA_TIMELINE_EVENT'),
    false,
    'seeked overtook the delayed seeking persistence boundary'
  );

  releaseFirstTimelinePersist.resolve();
  const [seeking, seeked] = await Promise.all([seekingPromise, seekedPromise]);
  assert.equal(seeking.ok, true, seeking.error);
  assert.equal(seeked.ok, true, seeked.error);
  assert.deepEqual(
    harness.state.runtimeMessages
      .filter(message => message.type === 'MEDIA_TIMELINE_EVENT')
      .map(message => message.phase),
    ['seeking', 'seeked']
  );
  assert.equal(timelinePersistCount, 2);
  assert.equal(vm.runInContext('activeSession.timelineEpoch', harness.sandbox), 9);
  await vm.runInContext('activeSession.timelineQueue', harness.sandbox);

  const stopped = await harness.message(
    { type: 'STOP_FACTCHECK', sessionId },
    popupSender()
  );
  assert.equal(stopped.ok, true);
});

test('offscreen recovery diagnostics are forwarded to the overlay without losing fields', async () => {
  const harness = loadWorker();
  await harness.ready();
  const sessionId = 'session_pipeline_status';
  await startSession(harness, sessionId);

  const response = await harness.message({
    type: 'PIPELINE_STATUS',
    sessionId,
    status: 'backpressure',
    sampleRate: 48000,
    language: 'en',
    reason: 'socket_busy',
    timelineEpoch: 3,
    droppedFrames: 17,
    bufferedBytes: 262144,
    currentTime: 812.5,
  }, offscreenSender());
  assert.equal(response.ok, true, response.error);

  const forwarded = harness.state.tabMessages.findLast(entry => (
    entry.message.type === 'PIPELINE_STATUS' && entry.message.status === 'backpressure'
  ));
  assert.deepEqual(forwarded.message, {
    type: 'PIPELINE_STATUS',
    sessionId,
    status: 'backpressure',
    sampleRate: 48000,
    language: 'en',
    reason: 'socket_busy',
    timelineEpoch: 3,
    droppedFrames: 17,
    bufferedBytes: 262144,
    currentTime: 812.5,
  });

  await harness.message({ type: 'STOP_FACTCHECK', sessionId }, popupSender());
});

test('a full tab-stream refresh inherits the latest media timeline epoch', async () => {
  const harness = loadWorker();
  await harness.ready();
  const sessionId = 'session_refresh_epoch';
  await startSession(harness, sessionId);

  const seeking = await harness.message({
    type: 'MEDIA_TIMELINE_EVENT',
    sessionId,
    phase: 'seeking',
    epoch: 4,
    currentTime: 420,
    paused: false,
    playbackRate: 1,
  }, activeTabSender());
  assert.equal(seeking.ok, true, seeking.error);

  const refreshed = await harness.message({
    type: 'REQUEST_NEW_STREAM',
    sessionId,
  }, offscreenSender());
  assert.equal(refreshed.ok, true, refreshed.error);

  const captureStarts = harness.state.runtimeMessages.filter(message => (
    message.type === 'START_CAPTURE'
  ));
  assert.equal(captureStarts.length, 2);
  assert.deepEqual(captureStarts.map(message => message.timelineEpoch), [0, 4]);

  const stopped = await harness.message(
    { type: 'STOP_FACTCHECK', sessionId },
    popupSender()
  );
  assert.equal(stopped.ok, true);
});

test('an ignored timeline delivery is retried and never reported as success', async () => {
  let timelineAttempts = 0;
  const harness = loadWorker({
    hooks: {
      runtimeSend(message) {
        if (message.type === 'MEDIA_TIMELINE_EVENT') {
          timelineAttempts++;
          if (timelineAttempts === 1) {
            return {
              ok: false,
              ignored: true,
              code: 'CAPTURE_CONTEXT_UNAVAILABLE',
              error: 'capture refresh in progress',
            };
          }
        }
        return { ok: true, sessionId: message.sessionId };
      },
    },
  });
  await harness.ready();
  const sessionId = 'session_timeline_retry';
  await startSession(harness, sessionId);

  const seeking = await harness.message({
    type: 'MEDIA_TIMELINE_EVENT',
    sessionId,
    phase: 'seeking',
    epoch: 1,
    currentTime: 90,
    paused: false,
    playbackRate: 1,
  }, activeTabSender());

  assert.equal(seeking.ok, true, seeking.error);
  assert.equal(timelineAttempts, 2);

  const stopped = await harness.message(
    { type: 'STOP_FACTCHECK', sessionId },
    popupSender()
  );
  assert.equal(stopped.ok, true);
});

test('a seek invalidates an Anthropic extraction response from the previous timeline', async () => {
  const extractionGate = deferred();
  let extractionStarted = false;
  const claim = 'Alpha City had 100 residents in 2020.';
  const hooks = {
    fetch(url) {
      if (url.includes('anthropic.com')) {
        extractionStarted = true;
        return extractionGate.promise;
      }
      throw new Error(`stale extraction unexpectedly reached evidence search: ${url}`);
    },
  };
  const harness = loadWorker({ hooks });
  await harness.ready();
  const sessionId = 'session_stale_extraction';
  await startSession(harness, sessionId);

  const transcript = await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    timelineEpoch: 0,
    text: `${claim} Sentence two is factual. Sentence three is factual. Sentence four is factual. Sentence five is factual. Sentence six is factual.`,
    isFinal: true,
    confidence: 0.99,
  }, offscreenSender());
  assert.equal(transcript.queued, true);
  await eventually(() => extractionStarted, 'the pre-seek extraction did not start');

  const seeking = await harness.message({
    type: 'MEDIA_TIMELINE_EVENT',
    sessionId,
    phase: 'seeking',
    epoch: 1,
    currentTime: 300,
  }, activeTabSender());
  assert.equal(seeking.ok, true, seeking.error);

  extractionGate.resolve(jsonResponse({
    usage: { input_tokens: 100, output_tokens: 20 },
    content: [{
      type: 'tool_use',
      name: 'emit_claims',
      input: {
        claims: [{
          statementType: 'FACTUAL',
          claim,
          sourceQuotes: [{ sourceSentenceId: 'U1', quote: claim }],
        }],
      },
    }],
  }));
  await vm.runInContext('activeSession.extractionQueue', harness.sandbox);

  assert.equal(vm.runInContext('activeSession.claims.size', harness.sandbox), 0);
  assert.equal(vm.runInContext('activeSession.totalClaims', harness.sandbox), 0);
  assert.equal(
    harness.state.tabMessages.some(entry => entry.message.type === 'NEW_VERDICT'),
    false,
    'a stale extraction result created a claim after seeking'
  );

  const stopped = await harness.message(
    { type: 'STOP_FACTCHECK', sessionId },
    popupSender()
  );
  assert.equal(stopped.ok, true);
});

test('STOP_CAPTURE preempts an in-flight capture refresh before lifecycle cleanup', async () => {
  const refreshGate = deferred();
  let startCount = 0;
  let refreshPending = false;
  let stoppedWhileRefreshPending = false;
  const hooks = {
    runtimeSend(message) {
      if (message.type === 'START_CAPTURE') {
        startCount++;
        if (startCount === 1) return { ok: true, sessionId: message.sessionId };
        refreshPending = true;
        return refreshGate.promise.finally(() => {
          refreshPending = false;
        });
      }
      if (message.type === 'STOP_CAPTURE') {
        if (refreshPending) {
          stoppedWhileRefreshPending = true;
          refreshGate.resolve({ ok: true, sessionId: message.sessionId });
        }
        return { ok: true, sessionId: message.sessionId };
      }
      return { ok: true };
    },
  };
  const harness = loadWorker({ hooks });
  await harness.ready();
  const sessionId = 'session_refresh_preemption';
  await startSession(harness, sessionId);

  const reconnect = harness.message({
    type: 'REQUEST_NEW_STREAM',
    sessionId,
  }, offscreenSender());
  await eventually(() => startCount === 2, 'capture refresh did not reach START_CAPTURE');
  assert.equal(refreshPending, true);

  const stopping = harness.message(
    { type: 'STOP_FACTCHECK', sessionId },
    popupSender()
  );
  await eventually(
    () => harness.state.runtimeMessages.some(message => message.type === 'STOP_CAPTURE'),
    'the immediate STOP_CAPTURE request was not sent'
  );
  assert.equal(
    stoppedWhileRefreshPending,
    true,
    'STOP_CAPTURE waited for the serialized refresh to finish'
  );

  const reconnectResult = await reconnect;
  assert.equal(reconnectResult.ok, false);
  assert.equal(reconnectResult.code, 'SESSION_ABORTED');
  const stopped = await stopping;
  assert.equal(stopped.ok, true, stopped.error);
  assert.equal(stopped.alreadyStopped, false);

  const messageTypes = harness.state.runtimeMessages.map(message => message.type);
  const refreshStartIndex = messageTypes.lastIndexOf('START_CAPTURE');
  const firstStopIndex = messageTypes.indexOf('STOP_CAPTURE');
  assert.ok(firstStopIndex > refreshStartIndex, messageTypes.join(', '));
  assert.equal(harness.state.offscreenCreated, false);
});

test('failed STOP_CAPTURE tears down offscreen before public status releases a draining stop', async () => {
  const deliveryGate = deferred();
  let deliveryPending = false;
  let offscreenClosedBeforeDelivery = false;
  const hooks = {
    runtimeSend(message) {
      if (message.type === 'START_CAPTURE') {
        return { ok: true, sessionId: message.sessionId };
      }
      if (message.type === 'STOP_CAPTURE') {
        return Promise.reject(new Error('offscreen stop channel failed'));
      }
      return { ok: true };
    },
    tabSend(_tabId, message, state) {
      if (message.type === 'PING') {
        return {
          ok: true,
          type: 'PONG',
          requestId: message.requestId,
          sessionId: message.sessionId,
          isActive: false,
        };
      }
      if (message.type === 'UPDATE_VERDICTS') {
        deliveryPending = true;
        offscreenClosedBeforeDelivery = !state.offscreenCreated;
        return deliveryGate.promise;
      }
      return { ok: true };
    },
  };
  const harness = loadWorker({ hooks });
  await harness.ready();
  const sessionId = 'session_close_during_delivery';
  await startSession(harness, sessionId);

  vm.runInContext(`activeSession.claims.set('claim_pending_delivery', {
    sessionId: activeSession.id,
    claimId: 'claim_pending_delivery',
    claim: 'The documented annual rate was 4.2 percent.',
    statementType: 'FACTUAL',
    sourceSentenceIds: ['U1'],
    sourceQuotes: [{ sourceSentenceId: 'U1', quote: 'The documented annual rate was 4.2 percent.' }],
    timelineEpoch: 0,
    speaker: null,
    dominantSpeakerId: null,
    asrConfidence: 0.99,
    lexical: null,
    state: 'COMPLETE',
    finalResult: {
      verdict: 'TRUE',
      status: 'COMPLETE',
      pending: false,
      confidence: 'HIGH',
      explanation: 'The evidence supports the statement.',
      sources: [],
      citations: []
    },
    delivered: false,
    normalizedKey: 'the documented annual rate was 4.2 percent'
  });`, harness.sandbox);

  const stopping = harness.message(
    { type: 'STOP_FACTCHECK', sessionId },
    popupSender()
  );
  await eventually(() => deliveryPending, 'terminal verdict delivery did not begin');

  const drainingStatus = await harness.message({ type: 'GET_STATUS' });
  assert.equal(offscreenClosedBeforeDelivery, true);
  assert.equal(harness.state.offscreenCreated, false);
  assert.equal(harness.state.offscreenCloseCount, 1);
  assert.equal(drainingStatus.isCapturing, false);
  assert.equal(drainingStatus.phase, 'STOPPING');
  assert.equal(drainingStatus.sessionId, sessionId);

  deliveryGate.resolve({ ok: true });
  const stopped = await stopping;
  assert.equal(stopped.ok, true, stopped.error);
  assert.equal(stopped.alreadyStopped, false);
});

test('terminal outbox is durable before delivery and retries a transient overlay failure', async () => {
  const claim = 'The annual rate was 4.2 percent in December 2025.';
  let updateAttempts = 0;
  let persistedBeforeFirstSend = null;
  const anthropicBodies = [];
  const serperBodies = [];
  const hooks = {
    tabSend(_tabId, message, state) {
      if (message.type === 'PING') {
        return {
          ok: true,
          type: 'PONG',
          requestId: message.requestId,
          sessionId: message.sessionId,
          isActive: false,
        };
      }
      if (message.type === 'UPDATE_VERDICTS') {
        updateAttempts++;
        if (updateAttempts === 1) {
          persistedBeforeFirstSend = clone(state.sessionStorage[SESSION_STATE_KEY]);
          throw new Error('content script was briefly unavailable');
        }
      }
      return { ok: true };
    },
    fetch(url, options) {
      if (url.includes('anthropic.com')) {
        const body = JSON.parse(options.body);
        anthropicBodies.push(body);
        const toolName = body.tools[0].name;
        if (toolName === 'emit_claims') {
          return jsonResponse({
            usage: { input_tokens: 1000, output_tokens: 100 },
            content: [{
              type: 'tool_use',
              name: toolName,
              input: {
                claims: [{
                  statementType: 'FACTUAL',
                  claim,
                  sourceQuotes: [{ sourceSentenceId: 'U1', quote: claim }],
                }],
              },
            }],
          });
        }
        return jsonResponse({
          usage: {
            input_tokens: 500,
            output_tokens: 80,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 300,
          },
          content: [{
            type: 'tool_use',
            name: toolName,
            input: {
              verdict: 'TRUE',
              confidence: 'HIGH',
              explanation: 'The supplied excerpt directly supports the claim.',
              citations: [{
                evidenceId: 'E1',
                quote: 'annual rate was 4.2 percent in December 2025',
              }],
            },
          }],
        });
      }
      assert.match(url, /serper\.dev/);
      serperBodies.push(JSON.parse(options.body));
      return jsonResponse({
        organic: [{
          link: 'https://statistics.example/report',
          title: 'Official annual report',
          snippet: 'The annual rate was 4.2 percent in December 2025.',
          date: '2026-01-10',
        }],
      });
    },
  };
  const harness = loadWorker({ hooks });
  await harness.ready();
  const sessionId = 'session_terminal_outbox';
  await startSession(harness, sessionId);

  const response = await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    text: `${claim} Context sentence two. Context sentence three. Context sentence four. Context sentence five. Context sentence six.`,
    isFinal: true,
    confidence: 0.99,
  }, offscreenSender());
  assert.equal(response.queued, true);

  await eventually(
    () => updateAttempts === 2,
    () => `terminal verdict was not retried (attempts=${updateAttempts}, tab messages=${harness.state.tabMessages.map(entry => entry.message.type).join(',')}, runtime messages=${harness.state.runtimeMessages.map(message => message.type).join(',')}, writes=${JSON.stringify(harness.state.sessionWrites)})`,
    2500
  );
  assert.ok(persistedBeforeFirstSend, 'terminal outbox was not present before delivery');
  assert.equal(persistedBeforeFirstSend.pendingClaims.length, 1);
  assert.equal(persistedBeforeFirstSend.pendingClaims[0].delivered, false);
  assert.equal(persistedBeforeFirstSend.pendingClaims[0].finalResult.verdict, 'TRUE');
  assert.equal(updateAttempts, 2);
  await eventually(
    () => harness.state.sessionStorage[SESSION_STATE_KEY]?.pendingClaims?.length === 0,
    'acknowledged terminal result was not removed from the durable outbox'
  );

  const finalMessage = harness.state.tabMessages
    .filter(entry => entry.message.type === 'UPDATE_VERDICTS')
    .at(-1).message.results[0];
  assert.equal(finalMessage.verdict, 'TRUE');
  assert.equal(finalMessage.confidence, 'MEDIUM');
  assert.deepEqual(
    anthropicBodies.map(body => body.model),
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001']
  );
  assert.deepEqual(anthropicBodies.map(body => body.max_tokens), [520, 480]);
  assert.equal(
    anthropicBodies[1].tools[0].input_schema.properties.explanation.maxLength,
    240
  );
  assert.equal(
    anthropicBodies[1].tools[0].input_schema.properties.citations.maxItems,
    3
  );
  assert.equal(serperBodies.length, 1);
  assert.equal(serperBodies[0].q, claim);
  assert.equal(serperBodies[0].q.includes('Test video'), false);
  const status = await harness.message({ type: 'GET_STATUS' });
  assert.equal(status.metrics.anthropicRequests, 2);
  assert.equal(status.metrics.extractionRequests, 1);
  assert.equal(status.metrics.verificationRequests, 1);
  assert.equal(status.metrics.inputTokens, 1500);
  assert.equal(status.metrics.outputTokens, 180);
  assert.equal(status.metrics.cacheCreationInputTokens, 200);
  assert.equal(status.metrics.cacheReadInputTokens, 300);
  assert.equal(status.metrics.estimatedCostUsd, 0.00268);

  const stopped = await harness.message(
    { type: 'STOP_FACTCHECK', sessionId },
    popupSender()
  );
  assert.equal(stopped.ok, true);
});

test('balanced mode extracts Italian claims with Haiku and verifies them with Sonnet', async () => {
  const claim = "Nel 2025 l'economia italiana non è cresciuta del 4,2 per cento.";
  const anthropicBodies = [];
  const hooks = {
    fetch(url, options) {
      if (url.includes('anthropic.com')) {
        const body = JSON.parse(options.body);
        anthropicBodies.push(body);
        const toolName = body.tools[0].name;
        if (toolName === 'emit_claims') {
          return jsonResponse({
            usage: { input_tokens: 900, output_tokens: 90 },
            content: [{
              type: 'tool_use',
              name: toolName,
              input: {
                claims: [{
                  statementType: 'FACTUAL',
                  claim,
                  sourceQuotes: [{ sourceSentenceId: 'U1', quote: claim }],
                }],
              },
            }],
          });
        }
        return jsonResponse({
          usage: { input_tokens: 700, output_tokens: 70 },
          content: [{
            type: 'tool_use',
            name: toolName,
            input: {
              verdict: 'TRUE',
              confidence: 'MEDIUM',
              explanation: 'La fonte citata conferma direttamente il dato contestualizzato.',
              citations: [{
                evidenceId: 'E1',
                quote: "Nel 2025 l'economia italiana non è cresciuta del 4,2 per cento",
              }],
            },
          }],
        });
      }
      assert.match(url, /serper\.dev/);
      return jsonResponse({
        organic: [{
          link: 'https://istat.example/economia-2025',
          title: 'Rapporto economico 2025',
          snippet: "Nel 2025 l'economia italiana non è cresciuta del 4,2 per cento rispetto all'anno precedente.",
          date: '2026-01-15',
        }],
      });
    },
  };
  const harness = loadWorker({
    hooks,
    config: {
      transcriptLanguage: 'it',
      analysisMode: 'balanced',
      sessionBudgetUsd: 1,
    },
  });
  await harness.ready();
  const sessionId = 'session_italian_balanced';
  await startSession(harness, sessionId);

  const queued = await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    text: `${claim} Questa è una frase di contesto. Il relatore continua a parlare. Il pubblico ascolta. La discussione prosegue. Il segmento ora termina.`,
    isFinal: true,
    confidence: 0.9,
  }, offscreenSender());
  assert.equal(queued.queued, true);

  await eventually(
    () => harness.state.tabMessages.some(entry => (
      entry.message.type === 'UPDATE_VERDICTS' &&
      entry.message.results?.[0]?.verdict === 'TRUE'
    )),
    'Italian verdict was not delivered'
  );
  assert.deepEqual(
    anthropicBodies.map(body => body.model),
    ['claude-haiku-4-5-20251001', 'claude-sonnet-5']
  );
  const extractionPayload = JSON.parse(anthropicBodies[0].messages[0].content);
  assert.equal(extractionPayload.language, 'it');
  assert.equal(extractionPayload.language_name, 'Italian');
  assert.equal(anthropicBodies[0].thinking, undefined);
  assert.deepEqual(anthropicBodies[1].thinking, { type: 'disabled' });

  const stopped = await harness.message(
    { type: 'STOP_FACTCHECK', sessionId },
    popupSender()
  );
  assert.equal(stopped.ok, true);
});

test('opinions are delivered locally without Serper or evidence-verification calls', async () => {
  const opinion = 'The message of the Holocaust is never again not just for Jews, but for anyone.';
  const providerCalls = [];
  const hooks = {
    fetch(url, options) {
      providerCalls.push({ url, body: JSON.parse(options.body) });
      assert.match(url, /anthropic\.com/);
      const body = providerCalls.at(-1).body;
      assert.equal(body.tools[0].name, 'emit_claims');
      return jsonResponse({
        usage: { input_tokens: 600, output_tokens: 40 },
        content: [{
          type: 'tool_use',
          name: 'emit_claims',
          input: {
            claims: [{
              statementType: 'OPINION',
              claim: opinion,
              sourceQuotes: [{ sourceSentenceId: 'U1', quote: opinion }],
            }],
          },
        }],
      });
    },
  };
  const harness = loadWorker({ hooks });
  await harness.ready();
  const sessionId = 'session_opinion_bypass';
  await startSession(harness, sessionId);

  const queued = await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    text: `${opinion} Context two. Context three. Context four. Context five. Context six.`,
    isFinal: true,
    confidence: 0.99,
  }, offscreenSender());
  assert.equal(queued.queued, true);

  await eventually(() => harness.state.tabMessages.some(entry => (
    entry.message.type === 'NEW_VERDICT' &&
    entry.message.results?.some(result => result.verdict === 'OPINION')
  )), 'opinion classification was not delivered');

  assert.equal(providerCalls.length, 1, 'opinion triggered a paid evidence-stage request');
  assert.equal(providerCalls[0].body.tools[0].name, 'emit_claims');
  assert.equal(
    harness.state.tabMessages.some(entry => entry.message.type === 'UPDATE_VERDICTS'),
    false
  );
  const status = await harness.message({ type: 'GET_STATUS' });
  assert.equal(status.metrics.claimsDetected, 1);
  assert.equal(status.metrics.factualClaimsDetected, 0);
  assert.equal(status.metrics.opinionsDetected, 1);
  assert.equal(status.metrics.claimsCompleted, 1);
  assert.equal(status.metrics.anthropicRequests, 1);
  assert.equal(status.metrics.extractionRequests, 1);
  assert.equal(status.metrics.verificationRequests, 0);

  const stopped = await harness.message(
    { type: 'STOP_FACTCHECK', sessionId },
    popupSender()
  );
  assert.equal(stopped.ok, true);
});

test('uncertain ASR entities are suppressed before search and verdict spending', async () => {
  const claim = 'David Groom migrated in 1906.';
  const providerCalls = [];
  const hooks = {
    fetch(url, options) {
      providerCalls.push({ url, body: JSON.parse(options.body) });
      assert.match(url, /anthropic\.com/);
      return jsonResponse({
        usage: { input_tokens: 300, output_tokens: 30 },
        content: [{
          type: 'tool_use',
          name: 'emit_claims',
          input: {
            claims: [{
              statementType: 'FACTUAL',
              claim,
              sourceQuotes: [{ sourceSentenceId: 'U1', quote: claim }],
            }],
          },
        }],
      });
    },
  };
  const harness = loadWorker({ hooks });
  await harness.ready();
  const sessionId = 'session_uncertain_entity';
  await startSession(harness, sessionId);

  await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    text: `${claim} Context two. Context three. Context four. Context five. Context six.`,
    isFinal: true,
    confidence: 0.9,
    words: `${claim} Context two. Context three. Context four. Context five. Context six.`
      .split(/\s+/u)
      .map(word => ({
        word,
        confidence: word.startsWith('Groom') ? 0.42 : 0.94,
      })),
  }, offscreenSender());

  await eventually(() => providerCalls.length === 1, 'extraction request did not complete');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(providerCalls.length, 1);
  assert.equal(
    harness.state.tabMessages.some(entry => entry.message.type === 'NEW_VERDICT'),
    false
  );
  const status = await harness.message({ type: 'GET_STATUS' });
  assert.equal(status.metrics.claimsDetected, 0);
  assert.equal(status.metrics.verificationRequests, 0);

  const stopped = await harness.message(
    { type: 'STOP_FACTCHECK', sessionId },
    popupSender()
  );
  assert.equal(stopped.ok, true);
});

test('adaptive batching avoids tiny paid requests and flushes at six utterances', async () => {
  let anthropicCalls = 0;
  const hooks = {
    fetch(url, options) {
      assert.match(url, /anthropic\.com/);
      anthropicCalls++;
      const body = JSON.parse(options.body);
      return jsonResponse({
        usage: { input_tokens: 100, output_tokens: 5 },
        content: [{
          type: 'tool_use',
          name: body.tools[0].name,
          input: { claims: [] },
        }],
      });
    },
  };
  const harness = loadWorker({ hooks });
  await harness.ready();
  const sessionId = 'session_adaptive_batching';
  await startSession(harness, sessionId);

  await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    text: 'One short sentence. Two short sentences. Three short sentences. Four short sentences.',
    isFinal: true,
    confidence: 0.99,
  }, offscreenSender());
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(anthropicCalls, 0, 'four short utterances triggered a premature paid request');

  await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    text: 'Five short sentences. Six short sentences.',
    isFinal: true,
    confidence: 0.99,
  }, offscreenSender());
  await eventually(() => anthropicCalls === 1, 'six utterances did not flush the extraction batch');

  const stopped = await harness.message(
    { type: 'STOP_FACTCHECK', sessionId },
    popupSender()
  );
  assert.equal(stopped.ok, true);
});

test('balanced extraction falls back once on invalid structure but not on a legitimate empty result', async () => {
  const models = [];
  let requestNumber = 0;
  const hooks = {
    fetch(url, options) {
      assert.match(url, /anthropic\.com/);
      requestNumber++;
      const body = JSON.parse(options.body);
      models.push(body.model);
      if (requestNumber === 1) {
        return jsonResponse({
          usage: { input_tokens: 100, output_tokens: 10 },
          content: [{ type: 'text', text: 'not a tool result' }],
        });
      }
      return jsonResponse({
        usage: { input_tokens: 100, output_tokens: 5 },
        content: [{
          type: 'tool_use',
          name: body.tools[0].name,
          input: { claims: [] },
        }],
      });
    },
  };
  const harness = loadWorker({
    hooks,
    config: { analysisMode: 'balanced', sessionBudgetUsd: 1 },
  });
  await harness.ready();
  const sessionId = 'session_balanced_fallback';
  await startSession(harness, sessionId);

  await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    text: 'First one. First two. First three. First four. First five. First six.',
    isFinal: true,
    confidence: 0.99,
  }, offscreenSender());
  await eventually(() => models.length === 2, 'invalid Haiku output did not trigger one fallback');
  assert.deepEqual(models, ['claude-haiku-4-5-20251001', 'claude-sonnet-5']);

  await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    text: 'Second one. Second two. Second three. Second four. Second five. Second six.',
    isFinal: true,
    confidence: 0.99,
  }, offscreenSender());
  await eventually(() => models.length === 3, 'second extraction did not complete');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(models, [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
  ]);

  const stopped = await harness.message(
    { type: 'STOP_FACTCHECK', sessionId },
    popupSender()
  );
  assert.equal(stopped.ok, true);
});

test('Anthropic budget stops new analysis while transcript ingestion remains active', async () => {
  let anthropicCalls = 0;
  const hooks = {
    fetch(url, options) {
      assert.match(url, /anthropic\.com/);
      anthropicCalls++;
      const body = JSON.parse(options.body);
      return jsonResponse({
        usage: { input_tokens: 250000, output_tokens: 0 },
        content: [{
          type: 'tool_use',
          name: body.tools[0].name,
          input: { claims: [] },
        }],
      });
    },
  };
  const harness = loadWorker({
    hooks,
    config: { analysisMode: 'efficient', sessionBudgetUsd: 0.25 },
  });
  await harness.ready();
  const sessionId = 'session_cost_budget';
  await startSession(harness, sessionId);

  const first = await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    text: 'First one. First two. First three. First four. First five. First six.',
    isFinal: true,
    confidence: 0.99,
  }, offscreenSender());
  assert.equal(first.queued, true);
  await eventually(async () => {
    const status = await harness.message({ type: 'GET_STATUS' });
    return status.metrics?.budgetReached === true;
  }, 'usage did not reach the configured budget');
  assert.equal(anthropicCalls, 1);

  const second = await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    text: 'Second one. Second two. Second three. Second four. Second five. Second six.',
    isFinal: true,
    confidence: 0.99,
  }, offscreenSender());
  assert.equal(second.queued, true, 'budget should not disable transcript ingestion');
  await eventually(
    () => harness.state.tabMessages.some(entry => (
      entry.message.type === 'PIPELINE_ERROR' &&
      entry.message.code === 'SESSION_BUDGET_REACHED'
    )),
    'budget warning was not delivered'
  );
  assert.equal(anthropicCalls, 1, 'budget limit allowed another Anthropic request');

  const stopped = await harness.message(
    { type: 'STOP_FACTCHECK', sessionId },
    popupSender()
  );
  assert.equal(stopped.ok, true);
});

test('a failed watchdog PING requests lifecycle stop and tears down capture', async () => {
  let failPing = false;
  const hooks = {
    tabSend(_tabId, message) {
      if (message.type === 'PING') {
        if (failPing) throw new Error('overlay disappeared');
        return {
          ok: true,
          type: 'PONG',
          requestId: message.requestId,
          sessionId: message.sessionId,
          isActive: false,
        };
      }
      return { ok: true };
    },
  };
  const harness = loadWorker({ hooks });
  await harness.ready();
  const sessionId = 'session_watchdog_stop';
  await startSession(harness, sessionId);
  assert.equal(harness.state.intervalCallbacks.size, 1);

  failPing = true;
  const watchdog = [...harness.state.intervalCallbacks.values()][0];
  assert.equal(watchdog.delay, 5000);
  await watchdog.callback();

  await eventually(async () => {
    const status = await harness.message({ type: 'GET_STATUS' });
    return status.phase === 'INACTIVE';
  }, 'watchdog failure did not stop the active session');
  assert.ok(harness.state.runtimeMessages.some(message => message.type === 'STOP_CAPTURE'));
  assert.ok(harness.state.tabMessages.some(entry => entry.message.type === 'STOP_FACTCHECK'));
  assert.equal(harness.state.offscreenCreated, false);
  assert.equal(harness.state.intervalCallbacks.size, 0);
});

test('runtime authorization rejects untrusted and stale session senders', async () => {
  const harness = loadWorker();
  await harness.ready();
  const sessionId = 'session_auth_checks';

  const untrustedStart = await harness.message(
    { type: 'START_FACTCHECK', sessionId },
    { id: 'hostile-extension', url: 'chrome-extension://hostile-extension/popup.html' }
  );
  assert.equal(untrustedStart.ok, false);
  assert.equal(untrustedStart.code, 'UNTRUSTED_START');

  await startSession(harness, sessionId);

  const untrustedTranscript = await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    text: 'Forged transcript.',
    isFinal: true,
  }, activeTabSender());
  assert.equal(untrustedTranscript.ok, false);
  assert.equal(untrustedTranscript.code, 'UNTRUSTED_TRANSCRIPT_SOURCE');

  const staleTranscript = await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId: 'session_stale_transcript',
    text: 'Stale transcript.',
    isFinal: true,
  }, offscreenSender());
  assert.equal(staleTranscript.ok, false);
  assert.equal(staleTranscript.code, 'STALE_SESSION');

  const wrongTabStop = await harness.message(
    { type: 'STOP_FACTCHECK', sessionId },
    activeTabSender(999)
  );
  assert.equal(wrongTabStop.ok, false);
  assert.equal(wrongTabStop.code, 'UNTRUSTED_STOP');

  const staleStop = await harness.message(
    { type: 'STOP_FACTCHECK', sessionId: 'session_stale_stop' },
    activeTabSender()
  );
  assert.equal(staleStop.ok, false);
  assert.equal(staleStop.code, 'STALE_SESSION');

  const stillActiveTranscript = await harness.message({
    type: 'TRANSCRIPT_RESULT',
    sessionId,
    text: 'Trusted audio remains analyzable after rejected stop attempts.',
    isFinal: true,
    confidence: 0.99,
  }, offscreenSender());
  assert.equal(stillActiveTranscript.ok, true);
  assert.equal(
    stillActiveTranscript.queued,
    true,
    'an untrusted or stale STOP latched the privacy boundary on the active session'
  );

  const stopped = await harness.message(
    { type: 'STOP_FACTCHECK', sessionId },
    popupSender()
  );
  assert.equal(stopped.ok, true);
});
