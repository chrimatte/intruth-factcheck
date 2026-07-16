// offscreen-ex.js
// Owns one tab-audio capture at a time and streams PCM audio to Deepgram.

const DEEPGRAM_ENDPOINT = 'wss://api.deepgram.com/v1/listen';
const HANDSHAKE_TIMEOUT_MS = 10000;
const CLOSE_STREAM_TIMEOUT_MS = 2500;
const BUFFER_HIGH_WATER_BYTES = 1024 * 1024;
const BUFFER_LOW_WATER_BYTES = 256 * 1024;
const BACKPRESSURE_NOTICE_MS = 5000;
const MAX_TRANSCRIPT_WORDS = 500;
const MAX_UTTERANCE_CHARS = 4000;
const MAX_UTTERANCE_PARTS = 40;
const MAX_UTTERANCE_SECONDS = 30;
const ALLOWED_LANGUAGES = new Set([
  'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'hi',
  'ja', 'zh', 'ar', 'ko', 'ru', 'pl', 'sv', 'tr',
]);

let currentCapture = null;
let pendingStart = null;
let captureSequence = 0;
let lifecycleRevision = 0;

class CaptureError extends Error {
  constructor(code, message, retryable = false, details = undefined) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;

  if (message.type === 'START_CAPTURE') {
    startCapture(message)
      .then(result => sendResponse(result))
      .catch(error => {
        const sessionId = normalizeSessionId(message.sessionId, false);
        const serialized = serializeError(error);
        console.error('[offscreen] start failed:', serialized.code, serialized.message);
        sendResponse({
          ok: false,
          sessionId,
          error: serialized,
          code: serialized.code,
          message: serialized.message,
          retryable: serialized.retryable,
        });
      });
    return true;
  }

  if (message.type === 'STOP_CAPTURE') {
    stopCapture(message.sessionId, 'requested')
      .then(result => sendResponse(result))
      .catch(error => {
        const serialized = serializeError(error, 'STOP_FAILED');
        sendResponse({
          ok: false,
          sessionId: normalizeSessionId(message.sessionId, false),
          error: serialized,
          code: serialized.code,
          message: serialized.message,
          retryable: serialized.retryable,
        });
      });
    return true;
  }

  if (message.type === 'GET_CAPTURE_STATUS') {
    sendResponse(getCaptureStatus());
  }

  return undefined;
});

function normalizeSessionId(value, createFallback = true) {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 128);
  if (!createFallback) return null;
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `capture-${Date.now()}-${++captureSequence}`;
}

function serializeError(error, fallbackCode = 'CAPTURE_FAILED') {
  if (error instanceof CaptureError) {
    return {
      code: error.code,
      message: error.message,
      retryable: Boolean(error.retryable),
      ...(error.details ? { details: error.details } : {}),
    };
  }

  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error || 'Unknown capture error'),
    retryable: false,
  };
}

function sendRuntimeMessage(message) {
  try {
    const result = chrome.runtime.sendMessage(message);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (_error) {
    // The service worker can be unavailable briefly while Chrome restarts it.
  }
}

function emitPipelineError(context, error, fallbackCode, fatal = false) {
  const serialized = serializeError(error, fallbackCode);
  sendRuntimeMessage({
    type: 'PIPELINE_ERROR',
    sessionId: context?.sessionId || null,
    error: serialized,
    // Top-level fields preserve compatibility with older background handlers.
    code: serialized.code,
    message: serialized.message,
    retryable: serialized.retryable,
    fatal: Boolean(fatal),
  });
}

function emitPipelineStatus(context, status, details = {}) {
  sendRuntimeMessage({
    type: 'PIPELINE_STATUS',
    sessionId: context.sessionId,
    status,
    ...details,
  });
}

function getCaptureStatus() {
  const context = currentCapture;
  return {
    ok: true,
    active: Boolean(context && (context.state === 'starting' || context.state === 'listening')),
    state: context?.state || 'idle',
    sessionId: context?.sessionId || null,
    sampleRate: context?.audioContext?.sampleRate || null,
    droppedFrames: context?.droppedFrames || 0,
  };
}

function createCaptureContext(sessionId, language, deepgramKey, revision) {
  return {
    id: ++captureSequence,
    revision,
    sessionId,
    language,
    deepgramKey,
    state: 'starting',
    mediaStream: null,
    audioContext: null,
    source: null,
    processor: null,
    socket: null,
    handshakeReject: null,
    handshakeTimer: null,
    expectedSocketClose: false,
    cleanupPromise: null,
    trackEndHandlers: [],
    droppedFrames: 0,
    sentFrames: 0,
    backpressured: false,
    lastBackpressureNotice: 0,
    utterance: createEmptyUtterance(),
  };
}

function createEmptyUtterance() {
  return {
    parts: [],
    words: [],
    wordsTruncated: false,
    hasUnknownSpeaker: false,
    confidenceSum: 0,
    confidenceWeight: 0,
    speakerStats: new Map(),
  };
}

function isCurrent(context) {
  return currentCapture === context && (context.state === 'starting' || context.state === 'listening');
}

function assertCurrent(context) {
  if (!isCurrent(context)) {
    throw new CaptureError('START_CANCELLED', 'Capture start was superseded or stopped.', false);
  }
}

async function startCapture(message) {
  const streamId = typeof message.streamId === 'string' ? message.streamId.trim() : '';
  if (!streamId) {
    throw new CaptureError('STREAM_ID_MISSING', 'Chrome did not provide a tab audio stream.', true);
  }

  const language = ALLOWED_LANGUAGES.has(message.language) ? message.language : 'en';
  const sessionId = normalizeSessionId(message.sessionId);
  // Claim the lifecycle before the first await. Otherwise STOP_CAPTURE can
  // report success while a pending storage read later resumes and starts audio.
  const revision = ++lifecycleRevision;
  pendingStart = { revision, sessionId };
  let context = null;

  try {
    // The offscreen document is a trusted extension context. Read the
    // credential here instead of broadcasting it in START_CAPTURE.
    let storedConfig;
    try {
      storedConfig = await chrome.storage.local.get(['deepgramKey']);
    } catch (error) {
      throw new CaptureError(
        'CONFIG_READ_FAILED',
        error instanceof Error ? error.message : 'Unable to read the local Deepgram configuration.',
        true
      );
    }
    if (revision !== lifecycleRevision) {
      throw new CaptureError('START_CANCELLED', 'Capture start was superseded or stopped.', false);
    }

    const deepgramKey = typeof storedConfig.deepgramKey === 'string'
      ? storedConfig.deepgramKey.trim()
      : '';
    if (!deepgramKey) {
      throw new CaptureError('DEEPGRAM_KEY_MISSING', 'Enter a Deepgram API key before starting.', false);
    }
    if (deepgramKey.length > 512) {
      throw new CaptureError('DEEPGRAM_KEY_INVALID', 'The Deepgram API key is too long.', false);
    }

    // A monotonically increasing revision prevents an older async start or
    // reconnect callback from reviving capture after a newer start/stop action.
    const previousCapture = currentCapture;
    if (previousCapture) await cleanupContext(previousCapture, { reason: 'superseded' });
    if (revision !== lifecycleRevision) {
      throw new CaptureError('START_CANCELLED', 'Capture start was superseded or stopped.', false);
    }

    context = createCaptureContext(sessionId, language, deepgramKey, revision);
    currentCapture = context;

    await prepareAudioCapture(context, streamId);
    assertCurrent(context);

    await openDeepgramSocket(context);
    assertCurrent(context);

    startAudioProcessor(context);
    context.state = 'listening';
    emitPipelineStatus(context, 'listening', {
      sampleRate: context.audioContext.sampleRate,
      language: context.language,
    });

    return {
      ok: true,
      sessionId: context.sessionId,
      state: context.state,
      sampleRate: context.audioContext.sampleRate,
    };
  } catch (error) {
    if (context) {
      await cleanupContext(context, { reason: 'start_failed', sendCloseStream: false });
    }
    throw error;
  } finally {
    if (pendingStart?.revision === revision) pendingStart = null;
  }
}

async function prepareAudioCapture(context, streamId) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
  } catch (error) {
    throw new CaptureError(
      'TAB_AUDIO_UNAVAILABLE',
      error instanceof Error ? error.message : 'Unable to capture audio from this tab.',
      true
    );
  }

  if (!isCurrent(context)) {
    stream.getTracks().forEach(track => track.stop());
    throw new CaptureError('START_CANCELLED', 'Capture start was superseded or stopped.', false);
  }

  context.mediaStream = stream;

  for (const track of stream.getTracks()) {
    const onEnded = () => handleTrackEnded(context);
    context.trackEndHandlers.push([track, onEnded]);
    track.addEventListener('ended', onEnded, { once: true });
  }

  try {
    context.audioContext = new AudioContext({ latencyHint: 'interactive' });
    if (context.audioContext.state === 'suspended') await context.audioContext.resume();
    assertCurrent(context);

    context.source = context.audioContext.createMediaStreamSource(stream);
    // tabCapture mutes the original tab output; reconnect it immediately.
    context.source.connect(context.audioContext.destination);
  } catch (error) {
    throw new CaptureError(
      'AUDIO_PIPELINE_FAILED',
      error instanceof Error ? error.message : 'Unable to initialize the audio pipeline.',
      true
    );
  }
}

function buildDeepgramUrl(context) {
  const params = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: String(context.audioContext.sampleRate),
    channels: '1',
    model: 'nova-3',
    language: context.language,
    punctuate: 'true',
    interim_results: 'true',
    endpointing: '300',
    utterance_end_ms: '2500',
    smart_format: 'true',
    vad_events: 'true',
    diarize: 'true',
  });
  return `${DEEPGRAM_ENDPOINT}?${params.toString()}`;
}

function openDeepgramSocket(context) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;

    const clearHandshake = () => {
      if (context.handshakeTimer) clearTimeout(context.handshakeTimer);
      context.handshakeTimer = null;
      context.handshakeReject = null;
    };

    const failHandshake = error => {
      if (settled) return;
      settled = true;
      clearHandshake();
      reject(error);
    };

    try {
      socket = new WebSocket(buildDeepgramUrl(context), ['token', context.deepgramKey]);
    } catch (error) {
      reject(new CaptureError(
        'DEEPGRAM_SOCKET_FAILED',
        error instanceof Error ? error.message : 'Unable to create the Deepgram connection.',
        true
      ));
      return;
    }

    context.socket = socket;
    context.handshakeReject = () => failHandshake(
      new CaptureError('START_CANCELLED', 'Capture start was stopped before Deepgram connected.', false)
    );

    context.handshakeTimer = setTimeout(() => {
      failHandshake(new CaptureError(
        'DEEPGRAM_HANDSHAKE_TIMEOUT',
        'Deepgram did not accept the connection in time.',
        true
      ));
      context.expectedSocketClose = true;
      try { socket.close(4000, 'Handshake timeout'); } catch (_error) {}
    }, HANDSHAKE_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      if (!isCurrent(context)) {
        failHandshake(new CaptureError('START_CANCELLED', 'Capture start was superseded.', false));
        try { socket.close(1000, 'Stale capture'); } catch (_error) {}
        return;
      }
      if (settled) return;
      settled = true;
      clearHandshake();
      resolve();
    });

    socket.addEventListener('message', event => handleDeepgramMessage(context, event));

    socket.addEventListener('error', () => {
      const error = new CaptureError(
        settled ? 'DEEPGRAM_SOCKET_ERROR' : 'DEEPGRAM_HANDSHAKE_FAILED',
        settled
          ? 'The Deepgram transcription connection reported an error.'
          : 'Deepgram rejected or could not establish the connection.',
        true
      );
      if (!settled) failHandshake(error);
      else if (!context.expectedSocketClose && isCurrent(context)) emitPipelineError(context, error);
    });

    socket.addEventListener('close', event => {
      if (!settled) {
        const authFailure = event.code === 1008 || event.code === 4001 || event.code === 4003;
        failHandshake(new CaptureError(
          authFailure ? 'DEEPGRAM_AUTH_FAILED' : 'DEEPGRAM_HANDSHAKE_CLOSED',
          authFailure
            ? 'Deepgram rejected the API key.'
            : `Deepgram closed the connection before it was ready (code ${event.code || 1006}).`,
          !authFailure,
          { closeCode: event.code || 1006 }
        ));
        return;
      }
      handleSocketClosed(context, event);
    });
  });
}

function startAudioProcessor(context) {
  const processor = context.audioContext.createScriptProcessor(4096, 1, 1);
  context.processor = processor;

  processor.onaudioprocess = event => {
    const socket = context.socket;
    if (!isCurrent(context) || context.state === 'stopping' || socket?.readyState !== WebSocket.OPEN) return;

    if (context.backpressured) {
      if (socket.bufferedAmount > BUFFER_LOW_WATER_BYTES) {
        noteDroppedFrame(context, socket.bufferedAmount);
        return;
      }
      context.backpressured = false;
      emitPipelineStatus(context, 'backpressure_recovered', {
        bufferedBytes: socket.bufferedAmount,
        droppedFrames: context.droppedFrames,
      });
    }

    if (socket.bufferedAmount >= BUFFER_HIGH_WATER_BYTES) {
      context.backpressured = true;
      noteDroppedFrame(context, socket.bufferedAmount);
      return;
    }

    const float32 = event.inputBuffer.getChannelData(0);
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const sample = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = sample < 0 ? sample * 32768 : sample * 32767;
    }

    try {
      socket.send(int16.buffer);
      context.sentFrames++;
    } catch (error) {
      emitPipelineError(context, new CaptureError(
        'DEEPGRAM_SEND_FAILED',
        error instanceof Error ? error.message : 'Unable to send audio to Deepgram.',
        true
      ));
    }
  };

  context.source.connect(processor);
  // ScriptProcessor must be connected to run; its output buffer is silent.
  processor.connect(context.audioContext.destination);
}

function noteDroppedFrame(context, bufferedBytes) {
  context.droppedFrames++;
  const now = Date.now();
  if (now - context.lastBackpressureNotice < BACKPRESSURE_NOTICE_MS) return;
  context.lastBackpressureNotice = now;
  emitPipelineStatus(context, 'backpressure', {
    bufferedBytes,
    droppedFrames: context.droppedFrames,
  });
}

function normalizeWord(word) {
  const start = optionalNumber(word?.start);
  const end = optionalNumber(word?.end);
  const confidence = optionalNumber(word?.confidence);
  const speakerValue = optionalNumber(word?.speaker);
  const speakerConfidence = optionalNumber(word?.speaker_confidence);
  const rawWord = String(word?.punctuated_word || word?.word || '').trim();

  return {
    word: rawWord.slice(0, 160),
    start,
    end,
    confidence,
    speaker: Number.isInteger(speakerValue) && speakerValue >= 0 ? speakerValue : null,
    speakerConfidence,
  };
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeWords(words) {
  if (!Array.isArray(words)) return [];
  return words.map(normalizeWord).filter(word => word.word);
}

function addFinalResult(context, text, result) {
  const utterance = context.utterance;
  if (text) utterance.parts.push(text);

  const words = normalizeWords(result.words);
  const remaining = Math.max(0, MAX_TRANSCRIPT_WORDS - utterance.words.length);
  if (words.length > remaining) utterance.wordsTruncated = true;
  if (!words.length || words.some(word => word.speaker === null)) {
    utterance.hasUnknownSpeaker = true;
  }
  utterance.words.push(...words.slice(0, remaining));

  // Only final words update speaker attribution; interim results overlap and
  // would otherwise count the same words repeatedly.
  for (const word of words) {
    if (word.confidence !== null) {
      utterance.confidenceSum += word.confidence;
      utterance.confidenceWeight++;
    }
    if (word.speaker === null) continue;

    const stats = utterance.speakerStats.get(word.speaker) || {
      words: 0,
      confidenceSum: 0,
      confidenceWeight: 0,
    };
    stats.words++;
    const speakerConfidence = word.speakerConfidence ?? word.confidence;
    if (speakerConfidence !== null) {
      stats.confidenceSum += speakerConfidence;
      stats.confidenceWeight++;
    }
    utterance.speakerStats.set(word.speaker, stats);
  }

  const resultConfidence = optionalNumber(result.confidence);
  if (!words.length && resultConfidence !== null) {
    utterance.confidenceSum += resultConfidence;
    utterance.confidenceWeight++;
  }
}

function utteranceReachedLimit(utterance) {
  if (utterance.parts.length >= MAX_UTTERANCE_PARTS) return true;
  if (utterance.parts.reduce((sum, part) => sum + part.length + 1, 0) >= MAX_UTTERANCE_CHARS) return true;
  if (utterance.words.length >= MAX_TRANSCRIPT_WORDS) return true;
  const timing = getTiming(utterance.words);
  return timing.duration !== null && timing.duration >= MAX_UTTERANCE_SECONDS;
}

function speakerStatsForWords(words) {
  const statsBySpeaker = new Map();
  for (const word of words) {
    if (word.speaker === null) continue;
    const stats = statsBySpeaker.get(word.speaker) || {
      words: 0,
      confidenceSum: 0,
      confidenceWeight: 0,
    };
    stats.words++;
    const confidence = word.speakerConfidence ?? word.confidence;
    if (confidence !== null) {
      stats.confidenceSum += confidence;
      stats.confidenceWeight++;
    }
    statsBySpeaker.set(word.speaker, stats);
  }
  return statsBySpeaker;
}

function getSpeakerMetadata(utterance, words = null) {
  if (words?.some(word => word.speaker === null)) {
    return { speaker: null, speakerConfidence: null, speakerWordCount: 0 };
  }
  const speakerStats = words ? speakerStatsForWords(words) : utterance.speakerStats;
  // Never assign an utterance to a majority speaker. Mixed-speaker audio is
  // either segmented before emission or deliberately left unattributed.
  if (speakerStats.size !== 1) {
    return { speaker: null, speakerConfidence: null, speakerWordCount: 0 };
  }
  let speaker = null;
  let bestStats = null;

  for (const [candidate, stats] of speakerStats) {
    if (!bestStats || stats.words > bestStats.words) {
      speaker = candidate;
      bestStats = stats;
    }
  }

  return {
    speaker,
    speakerConfidence: bestStats?.confidenceWeight
      ? bestStats.confidenceSum / bestStats.confidenceWeight
      : null,
    speakerWordCount: bestStats?.words || 0,
  };
}

function getTiming(words) {
  const starts = words.map(word => word.start).filter(Number.isFinite);
  const ends = words.map(word => word.end).filter(Number.isFinite);
  const start = starts.length ? Math.min(...starts) : null;
  const end = ends.length ? Math.max(...ends) : null;
  return {
    start,
    duration: start !== null && end !== null ? Math.max(0, end - start) : null,
  };
}

function buildTranscriptPayload(context, text, options) {
  const words = options.words || [];
  const speaker = options.forceUnknownSpeaker
    ? { speaker: null, speakerConfidence: null, speakerWordCount: 0 }
    : getSpeakerMetadata(context.utterance, words.length ? words : null);
  const timing = getTiming(words);
  const wordConfidences = words
    .map(word => word.confidence)
    .filter(Number.isFinite);
  const wordConfidence = wordConfidences.length
    ? wordConfidences.reduce((sum, value) => sum + value, 0) / wordConfidences.length
    : null;
  const confidence = options.confidence ?? wordConfidence ?? (context.utterance.confidenceWeight
      ? context.utterance.confidenceSum / context.utterance.confidenceWeight
      : null);

  return {
    type: 'TRANSCRIPT_RESULT',
    sessionId: context.sessionId,
    text,
    isFinal: options.isFinal,
    interim: options.interim,
    speaker: speaker.speaker,
    speakerConfidence: speaker.speakerConfidence,
    speakerWordCount: speaker.speakerWordCount,
    confidence: Number.isFinite(confidence) ? confidence : null,
    start: timing.start,
    duration: timing.duration,
    words,
    ...(options.reason ? { finalReason: options.reason } : {}),
  };
}

function sendInterim(context, text, result) {
  const interimWords = normalizeWords(result.words);
  const combinedWords = [...context.utterance.words, ...interimWords].slice(0, MAX_TRANSCRIPT_WORDS);
  const resultConfidence = optionalNumber(result.confidence);
  sendRuntimeMessage(buildTranscriptPayload(context, text, {
    isFinal: false,
    interim: true,
    words: combinedWords,
    confidence: resultConfidence,
  }));
}

function flushUtterance(context, reason) {
  const utterance = context.utterance;
  const text = utterance.parts.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) {
    context.utterance = createEmptyUtterance();
    return false;
  }

  const speakerSegments = [];
  const canSegment = !utterance.wordsTruncated && !utterance.hasUnknownSpeaker;
  if (canSegment) {
    for (const word of utterance.words) {
      const current = speakerSegments[speakerSegments.length - 1];
      if (current?.speaker === word.speaker) current.words.push(word);
      else speakerSegments.push({ speaker: word.speaker, words: [word] });
    }
  }

  if (speakerSegments.length > 1) {
    for (const segment of speakerSegments) {
      const segmentText = segment.words
        .map(word => word.word)
        .join(' ')
        .replace(/\s+([,.;:!?])/g, '$1')
        .trim();
      if (!segmentText) continue;
      sendRuntimeMessage(buildTranscriptPayload(context, segmentText, {
        isFinal: true,
        interim: false,
        words: segment.words,
        reason: `${reason}:speaker_segment`,
      }));
    }
  } else {
    sendRuntimeMessage(buildTranscriptPayload(context, text, {
      isFinal: true,
      interim: false,
      words: utterance.words,
      reason,
      forceUnknownSpeaker: utterance.hasUnknownSpeaker || utterance.speakerStats.size > 1,
    }));
  }
  context.utterance = createEmptyUtterance();
  return true;
}

function handleDeepgramMessage(context, event) {
  if (currentCapture !== context || context.state === 'stopped') return;

  let data;
  try {
    data = JSON.parse(event.data);
  } catch (_error) {
    emitPipelineError(context, new CaptureError(
      'DEEPGRAM_RESPONSE_INVALID',
      'Deepgram returned an unreadable transcription response.',
      true
    ));
    return;
  }

  if (data.type === 'UtteranceEnd') {
    const flushed = flushUtterance(context, 'utterance_end');
    sendRuntimeMessage({
      type: 'UTTERANCE_END',
      sessionId: context.sessionId,
      flushed,
      lastWordEnd: optionalNumber(data.last_word_end),
    });
    return;
  }

  if (data.type === 'Error') {
    if (context.state === 'stopping') return;
    const providerCode = String(data.code || data.err_code || '').trim().slice(0, 120);
    const error = new CaptureError(
      'DEEPGRAM_RESPONSE_ERROR',
      String(data.description || data.message || 'Deepgram reported a transcription error.'),
      false,
      providerCode ? { providerCode } : undefined
    );
    emitPipelineError(context, error, undefined, true);
    // A provider Error frame is terminal for this socket. Stop audio and clear
    // all resources so the rest of the extension cannot remain "listening".
    // expectedSocketClose is set by cleanup, so this path never reconnects.
    cleanupContext(context, {
      reason: 'deepgram_response_error',
      sendCloseStream: false,
    }).catch(() => {});
    return;
  }

  const result = data.channel?.alternatives?.[0];
  const text = String(result?.transcript || '').trim();
  if (!result || !text) return;

  const isFinal = Boolean(data.is_final);
  const speechFinal = Boolean(data.speech_final);

  if (isFinal) {
    addFinalResult(context, text, result);
    if (speechFinal || utteranceReachedLimit(context.utterance)) {
      flushUtterance(context, speechFinal ? 'speech_final' : 'segment_limit');
    } else {
      sendInterim(context, context.utterance.parts.join(' ').trim(), { words: [], confidence: null });
    }
    return;
  }

  const prefix = context.utterance.parts.join(' ').trim();
  sendInterim(context, prefix ? `${prefix} ${text}` : text, result);
}

function handleTrackEnded(context) {
  if (!isCurrent(context) || context.state === 'stopping') return;
  const error = new CaptureError(
    'TAB_AUDIO_ENDED',
    'The captured tab stopped providing audio.',
    false
  );
  emitPipelineError(context, error, undefined, true);
  cleanupContext(context, { reason: 'track_ended', sendCloseStream: true }).catch(() => {});
}

function handleSocketClosed(context, event) {
  if (context.expectedSocketClose || context.state === 'stopped') return;
  if (currentCapture !== context) return;

  const wasListening = context.state === 'listening';
  const authFailure = event.code === 1008 || event.code === 4001 || event.code === 4003;
  const error = new CaptureError(
    authFailure ? 'DEEPGRAM_AUTH_FAILED' : 'DEEPGRAM_DISCONNECTED',
    authFailure
      ? 'Deepgram rejected the API key.'
      : `Deepgram disconnected unexpectedly (code ${event.code || 1006}).`,
    !authFailure,
    { closeCode: event.code || 1006 }
  );
  emitPipelineError(context, error, undefined, authFailure);

  const sessionId = context.sessionId;
  const revision = context.revision;
  cleanupContext(context, { reason: 'socket_closed', sendCloseStream: false })
    .then(() => {
      if (!authFailure && wasListening && lifecycleRevision === revision && !currentCapture) {
        sendRuntimeMessage({
          type: 'REQUEST_NEW_STREAM',
          sessionId,
          reason: 'deepgram_disconnected',
        });
      }
    })
    .catch(() => {});
}

async function stopCapture(requestedSessionId, reason = 'requested') {
  const normalizedRequestedId = normalizeSessionId(requestedSessionId, false);
  const cancelsPendingStart = Boolean(
    normalizedRequestedId && pendingStart?.sessionId === normalizedRequestedId
  );
  if (cancelsPendingStart) {
    lifecycleRevision++;
    pendingStart = null;
  }

  const context = currentCapture;
  if (!context) {
    if (!cancelsPendingStart) lifecycleRevision++;
    return {
      ok: true,
      sessionId: normalizedRequestedId,
      state: 'idle',
      ...(cancelsPendingStart ? { cancelledPendingStart: true } : {}),
    };
  }

  if (normalizedRequestedId && normalizedRequestedId !== context.sessionId) {
    return {
      ok: true,
      ignored: !cancelsPendingStart,
      ...(cancelsPendingStart ? { cancelledPendingStart: true } : {}),
      sessionId: normalizedRequestedId,
      activeSessionId: context.sessionId,
      state: context.state,
    };
  }

  if (!cancelsPendingStart) lifecycleRevision++;
  await cleanupContext(context, { reason, sendCloseStream: true });
  return { ok: true, sessionId: context.sessionId, state: 'idle' };
}

function disconnectAudioProcessor(context) {
  if (context.processor) {
    context.processor.onaudioprocess = null;
    try { context.processor.disconnect(); } catch (_error) {}
    context.processor = null;
  }
  if (context.source) {
    try { context.source.disconnect(); } catch (_error) {}
    context.source = null;
  }
}

async function cleanupContext(context, options = {}) {
  if (!context) return;
  if (context.cleanupPromise) return context.cleanupPromise;

  const sendCloseStream = options.sendCloseStream !== false;
  context.cleanupPromise = (async () => {
    context.state = 'stopping';
    disconnectAudioProcessor(context);

    if (context.handshakeTimer) clearTimeout(context.handshakeTimer);
    context.handshakeTimer = null;
    if (context.handshakeReject) context.handshakeReject();
    context.handshakeReject = null;

    let socket = context.socket;
    context.expectedSocketClose = true;
    if (socket?.readyState === WebSocket.OPEN && sendCloseStream) {
      try {
        socket.send(JSON.stringify({ type: 'CloseStream' }));
        await new Promise(resolve => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.removeEventListener('close', finish);
            resolve();
          };
          const timer = setTimeout(finish, CLOSE_STREAM_TIMEOUT_MS);
          socket.addEventListener('close', finish, { once: true });
          if (socket.readyState === WebSocket.CLOSED) finish();
        });
      } catch (_error) {}
    }

    flushUtterance(context, options.reason || 'stopped');

    // Re-read the field after the await above so a socket created by an
    // interrupted start cannot escape cleanup.
    socket = context.socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      try { socket.close(1000, 'Capture stopped'); } catch (_error) {}
    }
    context.socket = null;

    for (const [track, handler] of context.trackEndHandlers) {
      track.removeEventListener('ended', handler);
    }
    context.trackEndHandlers = [];

    if (context.mediaStream) {
      context.mediaStream.getTracks().forEach(track => track.stop());
      context.mediaStream = null;
    }

    if (context.audioContext) {
      try { await context.audioContext.close(); } catch (_error) {}
      context.audioContext = null;
    }

    context.deepgramKey = '';
    context.utterance = createEmptyUtterance();
    context.state = 'stopped';
    if (currentCapture === context) currentCapture = null;
    emitPipelineStatus(context, 'stopped', { reason: options.reason || 'stopped' });
  })();

  return context.cleanupPromise;
}
