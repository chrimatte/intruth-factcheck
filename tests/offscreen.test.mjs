import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const offscreenSource = await readFile(
  new URL('../realtime-factcheck/src/offscreen/offscreen-ex.js', import.meta.url),
  'utf8'
);

function loadOffscreen({ storageGet = async () => ({ deepgramKey: 'test-key' }) } = {}) {
  const messages = [];
  const sandbox = {
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(message) {
          messages.push(message);
          return Promise.resolve({ ok: true });
        },
      },
      storage: { local: { get: storageGet } },
    },
    console: { error() {}, warn() {}, log() {} },
    crypto: globalThis.crypto,
    URLSearchParams,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(offscreenSource, sandbox, { filename: 'offscreen-ex.js' });
  return { sandbox, messages };
}

function evaluate(harness, source) {
  return vm.runInContext(source, harness.sandbox);
}

test('STOP_CAPTURE cancels a start waiting on local storage', async () => {
  let resolveStorage;
  const storageResult = new Promise(resolve => { resolveStorage = resolve; });
  const harness = loadOffscreen({ storageGet: () => storageResult });

  const starting = evaluate(
    harness,
    "startCapture({ streamId: 'stream-1', language: 'en', sessionId: 'session_1234' })"
  );
  const stopped = await evaluate(harness, "stopCapture('session_1234')");
  resolveStorage({ deepgramKey: 'test-key' });

  assert.equal(stopped.state, 'idle');
  assert.equal(stopped.cancelledPendingStart, true);
  await assert.rejects(starting, error => error?.code === 'START_CANCELLED');
});

test('stopping a pending replacement does not stop the existing session', async () => {
  let resolveStorage;
  const storageResult = new Promise(resolve => { resolveStorage = resolve; });
  const harness = loadOffscreen({ storageGet: () => storageResult });
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
  resolveStorage({ deepgramKey: 'test-key' });

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
