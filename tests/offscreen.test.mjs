import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const offscreenSource = await readFile(
  new URL('../realtime-factcheck/src/offscreen/offscreen-ex.js', import.meta.url),
  'utf8'
);

function loadOffscreen({
  runtimeSend,
  getUserMedia,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  WebSocketImpl = { OPEN: 1, CLOSED: 3 },
} = {}) {
  const messages = [];
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(message) {
        messages.push(message);
        if (runtimeSend) return Promise.resolve(runtimeSend(message));
        if (message.type === 'GET_CAPTURE_CREDENTIAL') {
          return Promise.resolve({
            ok: true,
            sessionId: message.sessionId,
            deepgramKey: 'test-key',
          });
        }
        return Promise.resolve({ ok: true });
      },
    },
  };

  const sandbox = {
    chrome,
    console: { error() {}, warn() {}, log() {} },
    crypto: globalThis.crypto,
    URLSearchParams,
    WebSocket: WebSocketImpl,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    setInterval: setIntervalFn,
    clearInterval: clearIntervalFn,
  };
  if (getUserMedia) sandbox.navigator = { mediaDevices: { getUserMedia } };
  vm.createContext(sandbox);
  vm.runInContext(offscreenSource, sandbox, { filename: 'offscreen-ex.js' });
  return { sandbox, messages };
}

function evaluate(harness, source) {
  return vm.runInContext(source, harness.sandbox);
}

test('offscreen startup does not depend on the unavailable chrome.storage API', async () => {
  let mediaRequests = 0;
  const harness = loadOffscreen({
    async getUserMedia() {
      mediaRequests++;
      throw new Error('test reached tab media acquisition');
    },
  });

  const error = await evaluate(
    harness,
    "startCapture({ streamId: 'stream-1', language: 'en', sessionId: 'session_no_storage' })"
  ).then(() => null, reason => reason);

  assert.equal(evaluate(harness, "typeof chrome.storage"), 'undefined');
  assert.equal(harness.messages[0]?.type, 'GET_CAPTURE_CREDENTIAL');
  assert.equal(harness.messages[0]?.sessionId, 'session_no_storage');
  assert.equal(mediaRequests, 1, 'startup tried to read chrome.storage before acquiring tab audio');
  assert.equal(error?.code, 'TAB_AUDIO_UNAVAILABLE');
  assert.equal(error?.message, 'Unable to capture audio from this tab.');
});

test('STOP_CAPTURE cancels a start waiting on the credential response', async () => {
  let resolveCredential;
  const credentialResult = new Promise(resolve => { resolveCredential = resolve; });
  const harness = loadOffscreen({ runtimeSend: () => credentialResult });

  const starting = evaluate(
    harness,
    "startCapture({ streamId: 'stream-1', language: 'en', sessionId: 'session_1234' })"
  );
  const stopped = await evaluate(harness, "stopCapture('session_1234')");
  resolveCredential({
    ok: true,
    sessionId: 'session_1234',
    deepgramKey: 'test-key',
  });

  assert.equal(stopped.state, 'idle');
  assert.equal(stopped.cancelledPendingStart, true);
  await assert.rejects(starting, error => error?.code === 'START_CANCELLED');
});

test('stopping a pending replacement does not stop the existing session', async () => {
  let resolveCredential;
  const credentialResult = new Promise(resolve => { resolveCredential = resolve; });
  const harness = loadOffscreen({ runtimeSend: () => credentialResult });
  evaluate(harness, `
    currentCapture = {
      sessionId: 'existing_session',
      state: 'listening',
      audioContext: null,
      droppedFrames: 0,
    };
  `);

  const starting = evaluate(
    harness,
    "startCapture({ streamId: 'stream-2', language: 'en', sessionId: 'replacement_session' })"
  );
  const stopped = await evaluate(harness, "stopCapture('replacement_session')");
  resolveCredential({
    ok: true,
    sessionId: 'replacement_session',
    deepgramKey: 'test-key',
  });

  assert.equal(stopped.cancelledPendingStart, true);
  assert.equal(stopped.activeSessionId, 'existing_session');
  assert.equal(evaluate(harness, 'getCaptureStatus().sessionId'), 'existing_session');
  await assert.rejects(starting, error => error?.code === 'START_CANCELLED');
});

test('mixed known speakers are emitted as contiguous word-level segments', () => {
  const harness = loadOffscreen();
  const words = [
    { punctuated_word: 'Alpha', start: 0, end: 0.3, confidence: 0.9, speaker: 0, speaker_confidence: 0.95 },
    { punctuated_word: 'beta.', start: 0.3, end: 0.7, confidence: 0.8, speaker: 0, speaker_confidence: 0.9 },
    { punctuated_word: 'Gamma', start: 0.8, end: 1.1, confidence: 0.85, speaker: 1, speaker_confidence: 0.92 },
  ];

  evaluate(harness, `
    const context = { sessionId: 'session_1234', utterance: createEmptyUtterance() };
    addFinalResult(context, 'Alpha beta. Gamma', { words: ${JSON.stringify(words)} });
    flushUtterance(context, 'test');
  `);

  const results = harness.messages.filter(message => message.type === 'TRANSCRIPT_RESULT');
  assert.deepEqual(results.map(result => result.text), ['Alpha beta.', 'Gamma']);
  assert.deepEqual(results.map(result => result.speaker), [0, 1]);
  assert.ok(results.every(result => result.isFinal && result.finalReason === 'test:speaker_segment'));
});

test('unknown attribution and truncated mixed metadata preserve the complete text', () => {
  const unknownHarness = loadOffscreen();
  const unknownWords = [
    { punctuated_word: 'Known', start: 0, end: 0.3, confidence: 0.9, speaker: 0 },
    { punctuated_word: 'mystery', start: 0.3, end: 0.7, confidence: 0.8, speaker: null },
  ];
  evaluate(unknownHarness, `
    const context = { sessionId: 'session_1234', utterance: createEmptyUtterance() };
    addFinalResult(context, 'Known mystery', { words: ${JSON.stringify(unknownWords)} });
    flushUtterance(context, 'test');
  `);
  const unknownResult = unknownHarness.messages.find(message => message.type === 'TRANSCRIPT_RESULT');
  assert.equal(unknownResult.text, 'Known mystery');
  assert.equal(unknownResult.speaker, null);

  const truncatedHarness = loadOffscreen();
  const truncatedWords = Array.from({ length: 501 }, (_, index) => ({
    punctuated_word: `w${index}`,
    start: index / 10,
    end: (index + 1) / 10,
    confidence: 0.9,
    speaker: index < 250 ? 0 : 1,
  }));
  const completeText = truncatedWords.map(word => word.punctuated_word).join(' ');
  evaluate(truncatedHarness, `
    const context = { sessionId: 'session_1234', utterance: createEmptyUtterance() };
    addFinalResult(context, ${JSON.stringify(completeText)}, { words: ${JSON.stringify(truncatedWords)} });
    flushUtterance(context, 'test');
  `);
  const truncatedResults = truncatedHarness.messages.filter(
    message => message.type === 'TRANSCRIPT_RESULT'
  );
  assert.equal(truncatedResults.length, 1);
  assert.equal(truncatedResults[0].text, completeText);
  assert.equal(truncatedResults[0].speaker, null);
  assert.equal(truncatedResults[0].words.length, 500);
});

test('UtteranceEnd flushes an Italian final segment even without speech_final', () => {
  const harness = loadOffscreen();
  evaluate(harness, `
    currentCapture = {
      sessionId: 'session_italian_utterance',
      state: 'listening',
      utterance: createEmptyUtterance(),
    };
    handleDeepgramMessage(currentCapture, { data: JSON.stringify({
      type: 'Results',
      is_final: true,
      speech_final: false,
      channel: { alternatives: [{
        transcript: "L'economia italiana è cresciuta.",
        confidence: 0.92,
        words: [{
          punctuated_word: "L'economia",
          start: 0,
          end: 0.6,
          confidence: 0.92,
          speaker: 0,
        }, {
          punctuated_word: 'italiana',
          start: 0.6,
          end: 1.1,
          confidence: 0.91,
          speaker: 0,
        }, {
          punctuated_word: 'è',
          start: 1.1,
          end: 1.2,
          confidence: 0.9,
          speaker: 0,
        }, {
          punctuated_word: 'cresciuta.',
          start: 1.2,
          end: 1.8,
          confidence: 0.93,
          speaker: 0,
        }],
      }] },
    }) });
    handleDeepgramMessage(currentCapture, { data: JSON.stringify({
      type: 'UtteranceEnd',
      last_word_end: 1.8,
    }) });
  `);

  const transcriptMessages = harness.messages.filter(
    message => message.type === 'TRANSCRIPT_RESULT'
  );
  assert.equal(transcriptMessages.filter(message => message.isFinal).length, 1);
  assert.equal(
    transcriptMessages.find(message => message.isFinal)?.text,
    "L'economia italiana è cresciuta."
  );
  assert.equal(
    harness.messages.find(message => message.type === 'UTTERANCE_END')?.flushed,
    true
  );
});

test('Deepgram streaming URL uses the current low-latency transcription contract', () => {
  const harness = loadOffscreen();
  const value = evaluate(
    harness,
    "buildDeepgramUrl({ audioContext: { sampleRate: 48000 }, language: 'multi' })"
  );
  const url = new URL(value);

  assert.equal(url.origin, 'wss://api.deepgram.com');
  assert.equal(url.searchParams.get('model'), 'nova-3');
  assert.equal(url.searchParams.get('language'), 'multi');
  assert.equal(url.searchParams.get('sample_rate'), '48000');
  assert.equal(url.searchParams.get('interim_results'), 'true');
  assert.equal(url.searchParams.get('endpointing'), '300');
  assert.equal(url.searchParams.get('utterance_end_ms'), '2500');
  assert.equal(url.searchParams.get('diarize'), 'true');
});

test('Deepgram receives a text KeepAlive while tab audio is interrupted', () => {
  let keepAliveTick = null;
  const harness = loadOffscreen({
    setIntervalFn(callback) {
      keepAliveTick = callback;
      return 41;
    },
    clearIntervalFn() {},
  });
  harness.sandbox.controlFrames = [];
  evaluate(harness, `
    currentCapture = {
      sessionId: 'session_keepalive',
      state: 'listening',
      keepAliveTimer: null,
      lastAudioFrameAt: null,
      lastKeepAliveAt: null,
      socket: {
        readyState: WebSocket.OPEN,
        send(payload) { controlFrames.push(payload); },
      },
    };
    startDeepgramKeepAlive(currentCapture);
  `);

  assert.equal(typeof keepAliveTick, 'function');
  keepAliveTick();
  assert.deepEqual([...harness.sandbox.controlFrames], [JSON.stringify({ type: 'KeepAlive' })]);
  assert.equal(evaluate(harness, 'Number.isFinite(currentCapture.lastKeepAliveAt)'), true);
});

test('each Deepgram connection starts with a non-empty binary silence frame', async () => {
  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      this.sent = [];
      sockets.push(this);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emit(type, value = {}) {
      for (const listener of this.listeners.get(type) || []) listener(value);
    }

    send(payload) {
      this.sent.push(payload);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }

  const harness = loadOffscreen({ WebSocketImpl: FakeWebSocket });
  const opening = evaluate(harness, `
    currentCapture = {
      sessionId: 'session_seed_audio',
      language: 'en',
      deepgramKey: 'test-key',
      state: 'starting',
      socket: null,
      handshakeTimer: null,
      handshakeReject: null,
      expectedSocketClose: false,
      lastAudioFrameAt: null,
      audioContext: { sampleRate: 48000 },
    };
    openDeepgramSocket(currentCapture)
  `);
  assert.equal(sockets.length, 1);
  sockets[0].readyState = FakeWebSocket.OPEN;
  sockets[0].emit('open');
  await opening;

  assert.equal(sockets[0].sent.length, 1);
  assert.equal(Object.prototype.toString.call(sockets[0].sent[0]), '[object ArrayBuffer]');
  assert.equal(sockets[0].sent[0].byteLength, 1920);
  assert.equal(evaluate(harness, 'Number.isFinite(currentCapture.lastAudioFrameAt)'), true);
});

test('recent audio suppresses redundant Deepgram KeepAlive frames', () => {
  let keepAliveTick = null;
  const harness = loadOffscreen({
    setIntervalFn(callback) {
      keepAliveTick = callback;
      return 42;
    },
    clearIntervalFn() {},
  });
  harness.sandbox.controlFrames = [];
  evaluate(harness, `
    currentCapture = {
      sessionId: 'session_audio_active',
      state: 'listening',
      keepAliveTimer: null,
      lastAudioFrameAt: Date.now(),
      socket: {
        readyState: WebSocket.OPEN,
        send(payload) { controlFrames.push(payload); },
      },
    };
    startDeepgramKeepAlive(currentCapture);
  `);

  keepAliveTick();
  assert.deepEqual([...harness.sandbox.controlFrames], []);
});

test('Deepgram NET errors trigger socket recovery without ending the session', async () => {
  const harness = loadOffscreen();
  harness.sandbox.recoveryReasons = [];
  evaluate(harness, `
    currentCapture = {
      sessionId: 'session_transient',
      state: 'listening',
      ignoreProviderResults: false,
      utterance: createEmptyUtterance(),
    };
    recoverDeepgramSocket = (_context, reason) => {
      recoveryReasons.push(reason);
      return Promise.resolve(true);
    };
    handleDeepgramMessage(currentCapture, { data: JSON.stringify({
      type: 'Error',
      code: 'NET-0001',
      description: 'audio timeout',
    }) });
  `);
  await Promise.resolve();

  assert.deepEqual([...harness.sandbox.recoveryReasons], ['net-0001']);
  const error = harness.messages.find(message => message.type === 'PIPELINE_ERROR');
  assert.equal(error?.code, 'DEEPGRAM_TRANSIENT_ERROR');
  assert.equal(error?.retryable, true);
  assert.equal(error?.fatal, false);
  assert.equal(evaluate(harness, 'currentCapture.state'), 'listening');
});

test('seeking discards the old utterance and reconnects once after rapid seeked events', async () => {
  let timerCallback = null;
  let timerId = 0;
  const harness = loadOffscreen({
    setTimeoutFn(callback) {
      timerCallback = callback;
      return ++timerId;
    },
    clearTimeoutFn() {
      timerCallback = null;
    },
  });
  harness.sandbox.recoveryReasons = [];
  evaluate(harness, `
    currentCapture = {
      sessionId: 'session_seek',
      revision: 1,
      state: 'listening',
      mediaSeeking: false,
      timelineEpoch: 0,
      seekRecoveryTimer: null,
      ignoreProviderResults: false,
      utterance: createEmptyUtterance(),
      audioContext: { state: 'running' },
    };
    currentCapture.utterance.parts.push('stale text');
    recoverDeepgramSocket = (_context, reason) => {
      recoveryReasons.push(reason);
      return Promise.resolve(true);
    };
  `);

  await evaluate(harness, `handleMediaTimelineEvent({
    sessionId: 'session_seek', phase: 'seeking', epoch: 1, currentTime: 600,
  })`);
  assert.equal(evaluate(harness, 'currentCapture.mediaSeeking'), true);
  assert.equal(evaluate(harness, 'currentCapture.ignoreProviderResults'), true);
  assert.equal(evaluate(harness, 'currentCapture.utterance.parts.length'), 0);

  await evaluate(harness, `handleMediaTimelineEvent({
    sessionId: 'session_seek', phase: 'seeked', epoch: 1, currentTime: 600,
  })`);
  const firstTimer = timerCallback;
  await evaluate(harness, `handleMediaTimelineEvent({
    sessionId: 'session_seek', phase: 'seeked', epoch: 1, currentTime: 601,
  })`);
  assert.notEqual(timerCallback, firstTimer, 'the latest seeked event replaces the older debounce');
  timerCallback();
  await Promise.resolve();

  assert.deepEqual([...harness.sandbox.recoveryReasons], ['media_seek']);
  await evaluate(harness, `handleMediaTimelineEvent({
    sessionId: 'session_seek', phase: 'paused', epoch: 1, currentTime: 601,
  })`);
  assert.equal(evaluate(harness, 'currentCapture.mediaPaused'), true);
  await evaluate(harness, `handleMediaTimelineEvent({
    sessionId: 'session_seek', phase: 'playing', epoch: 1, currentTime: 601,
  })`);
  assert.equal(evaluate(harness, 'currentCapture.mediaPaused'), false);
});

test('a seek queues a clean socket boundary behind an in-flight reconnect', async () => {
  const harness = loadOffscreen();
  evaluate(harness, `
    currentCapture = {
      sessionId: 'session_recovery_seek',
      revision: 0,
      state: 'listening',
      socket: null,
      socketRecoveryPromise: null,
      activeRecoveryEpoch: null,
      pendingSocketRecovery: null,
      expectedSocketClose: false,
      handshakeTimer: null,
      handshakeReject: null,
      mediaSeeking: false,
      timelineEpoch: 0,
      ignoreProviderResults: false,
      fullRefreshRequested: false,
      utterance: createEmptyUtterance(),
    };
    globalThis.openCalls = 0;
    globalThis.resolveFirstOpen = null;
    openDeepgramSocket = () => {
      openCalls += 1;
      if (openCalls === 1) {
        return new Promise(resolve => { resolveFirstOpen = resolve; });
      }
      return Promise.resolve();
    };
    globalThis.firstRecovery = recoverDeepgramSocket(currentCapture, 'network');
  `);
  await Promise.resolve();
  evaluate(harness, `
    currentCapture.timelineEpoch = 1;
    globalThis.seekRecovery = recoverDeepgramSocket(currentCapture, 'media_seek');
    resolveFirstOpen();
  `);
  await evaluate(harness, 'seekRecovery');

  assert.equal(evaluate(harness, 'openCalls'), 2);
  assert.equal(evaluate(harness, 'currentCapture.ignoreProviderResults'), false);
  assert.equal(evaluate(harness, 'currentCapture.activeRecoveryEpoch'), null);
  assert.equal(evaluate(harness, 'currentCapture.pendingSocketRecovery'), null);
});

test('audio health watchdog rebuilds a live-but-silent capture and respects pause', () => {
  const watchdogTicks = [];
  const harness = loadOffscreen({
    setIntervalFn(callback) {
      watchdogTicks.push(callback);
      return watchdogTicks.length;
    },
    clearIntervalFn() {},
  });
  harness.sandbox.refreshReasons = [];
  evaluate(harness, `
    currentCapture = {
      sessionId: 'session_audio_watchdog',
      state: 'listening',
      audioHealthTimer: null,
      mediaSeeking: false,
      mediaPaused: true,
      socketRecoveryPromise: null,
      fullRefreshRequested: false,
      audioContext: { state: 'running' },
      lastAudioFrameAt: Date.now() - AUDIO_STALL_TIMEOUT_MS - 1,
      trackMutedAt: null,
    };
    requestNewTabStream = (_context, reason) => refreshReasons.push(reason);
    startAudioHealthWatchdog(currentCapture);
  `);

  assert.equal(watchdogTicks.length, 1);
  watchdogTicks[0]();
  assert.deepEqual([...harness.sandbox.refreshReasons], []);
  evaluate(harness, 'currentCapture.mediaPaused = false');
  watchdogTicks[0]();
  assert.deepEqual([...harness.sandbox.refreshReasons], ['audio_capture_stalled']);
});

test('post-seek PCM is buffered until the replacement socket is ready', () => {
  const harness = loadOffscreen();
  harness.sandbox.sentFrames = [];
  evaluate(harness, `
    const processor = {
      onaudioprocess: null,
      connect() {},
      disconnect() {},
    };
    currentCapture = {
      sessionId: 'session_buffered_seek',
      state: 'listening',
      mediaSeeking: false,
      ignoreProviderResults: true,
      socket: null,
      pendingAudioFrames: [],
      pendingAudioBytes: 0,
      sentFrames: 0,
      droppedFrames: 0,
      lastAudioFrameAt: null,
      backpressured: false,
      source: { connect() {}, disconnect() {} },
      processor: null,
      audioContext: {
        destination: {},
        createScriptProcessor() { return processor; },
      },
    };
    startAudioProcessor(currentCapture);
    processor.onaudioprocess({
      inputBuffer: { getChannelData() { return new Float32Array([0.25, -0.25, 0]); } },
    });
    globalThis.bufferedBytes = currentCapture.pendingAudioBytes;
    currentCapture.socket = {
      readyState: WebSocket.OPEN,
      send(frame) { sentFrames.push(frame.byteLength); },
    };
    currentCapture.ignoreProviderResults = false;
    globalThis.flushedFrames = flushBufferedAudio(currentCapture, currentCapture.socket);
  `);

  assert.equal(harness.sandbox.bufferedBytes, 6);
  assert.equal(harness.sandbox.flushedFrames, 1);
  assert.deepEqual([...harness.sandbox.sentFrames], [6]);
  assert.equal(evaluate(harness, 'currentCapture.pendingAudioBytes'), 0);
});

test('STOP during a reconnect handshake prevents any later socket or stream revival', async () => {
  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      sockets.push(this);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      this.listeners.set(type, listeners.filter(candidate => candidate !== listener));
    }

    emit(type, value = {}) {
      for (const listener of this.listeners.get(type) || []) listener(value);
    }

    send() {}

    close(code = 1000, reason = '') {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close', { code, reason });
    }
  }

  const harness = loadOffscreen({ WebSocketImpl: FakeWebSocket });
  evaluate(harness, `
    currentCapture = createCaptureContext('session_stop_reconnect', 'en', 'test-key', 0);
    currentCapture.state = 'listening';
    currentCapture.audioContext = {
      sampleRate: 48000,
      state: 'running',
      close() { return Promise.resolve(); },
      removeEventListener() {},
    };
    globalThis.reconnecting = recoverDeepgramSocket(currentCapture, 'network');
  `);
  await Promise.resolve();
  assert.equal(sockets.length, 1);

  const stopped = await evaluate(harness, "stopCapture('session_stop_reconnect')");
  assert.equal(stopped.state, 'idle');
  await evaluate(harness, 'reconnecting');
  sockets[0].emit('open');
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(sockets.length, 1, 'a stopped reconnect created another socket');
  assert.equal(evaluate(harness, 'getCaptureStatus().active'), false);
  assert.equal(
    harness.messages.some(message => message.type === 'REQUEST_NEW_STREAM'),
    false
  );
});

test('transcript payloads carry the media timeline epoch', () => {
  const harness = loadOffscreen();
  const epoch = evaluate(harness, `
    buildTranscriptPayload({
      sessionId: 'session_epoch',
      timelineEpoch: 7,
      utterance: createEmptyUtterance(),
    }, 'After the seek', {
      isFinal: true,
      interim: false,
      words: [],
    }).timelineEpoch
  `);
  assert.equal(epoch, 7);
});

test('a replacement capture context inherits the active media timeline epoch', () => {
  const harness = loadOffscreen();
  const epoch = evaluate(
    harness,
    "createCaptureContext('session_epoch_refresh', 'en', 'test-key', 1, 9).timelineEpoch"
  );
  const invalidEpoch = evaluate(
    harness,
    "createCaptureContext('session_epoch_invalid', 'en', 'test-key', 2, -4).timelineEpoch"
  );

  assert.equal(epoch, 9);
  assert.equal(invalidEpoch, 0);
});
