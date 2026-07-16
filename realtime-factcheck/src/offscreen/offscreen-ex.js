// offscreen-ex.js
// Owns one tab-audio capture at a time and streams PCM audio to Deepgram.

const DEEPGRAM_ENDPOINT = 'wss://api.deepgram.com/v1/listen';
const HANDSHAKE_TIMEOUT_MS = 10000;
const CLOSE_STREAM_TIMEOUT_MS = 2500;
const DEEPGRAM_KEEPALIVE_MS = 4000;
const AUDIO_HEALTH_CHECK_MS = 5000;
const AUDIO_STALL_TIMEOUT_MS = 15000;
const SEEK_RECOVERY_DEBOUNCE_MS = 350;
const SOCKET_RECONNECT_DELAYS_MS = [0, 500, 1500];
const MAX_RECOVERY_AUDIO_BYTES = 1024 * 1024;
const BUFFER_HIGH_WATER_BYTES = 1024 * 1024;
const BUFFER_LOW_WATER_BYTES = 256 * 1024;
const BACKPRESSURE_NOTICE_MS = 5000;
const MAX_TRANSCRIPT_WORDS = 500;
const MAX_UTTERANCE_CHARS = 4000;
const MAX_UTTERANCE_PARTS = 40;
const MAX_UTTERANCE_SECONDS = 30;
const ALLOWED_LANGUAGES = new Set([
  'multi', 'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'hi',
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

  if (message.type === 'MEDIA_TIMELINE_EVENT') {
    // Content scripts broadcast extension messages too. Let the service worker
    // authenticate the active tab and forward the accepted event back here.
    if (_sender?.tab) return undefined;
    handleMediaTimelineEvent(message)
      .then(result => sendResponse(result))
      .catch(error => {
        const serialized = serializeError(error, 'MEDIA_TIMELINE_FAILED');
        sendResponse({ ok: false, error: serialized, code: serialized.code });
      });
    return true;
  }

  return undefined;
});

function normalizeSessionId(value, createFallback = true) {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 128);
  if (!createFallback) return null;
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `capture-${Date.now()}-${++captureSequence}`;
}

function normalizeTimelineEpoch(value) {
  const epoch = Number(value);
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : 0;
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
  const tracks = context?.mediaStream?.getAudioTracks?.()
    || context?.mediaStream?.getTracks?.()
    || [];
  return {
    ok: true,
    active: Boolean(context && (context.state === 'starting' || context.state === 'listening')),
    state: context?.state || 'idle',
    sessionId: context?.sessionId || null,
    sampleRate: context?.audioContext?.sampleRate || null,
    droppedFrames: context?.droppedFrames || 0,
    sentFrames: context?.sentFrames || 0,
    lastAudioFrameAt: context?.lastAudioFrameAt || null,
    lastKeepAliveAt: context?.lastKeepAliveAt || null,
    audioContextState: context?.audioContext?.state || null,
    socketState: context?.socket?.readyState ?? null,
    trackReadyState: tracks[0]?.readyState || null,
    trackMuted: tracks.some(track => track.muted === true),
    mediaPaused: context?.mediaPaused === true,
    mediaSeeking: context?.mediaSeeking === true,
    timelineEpoch: context?.timelineEpoch || 0,
  };
}

function createCaptureContext(sessionId, language, deepgramKey, revision, timelineEpoch = 0) {
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
    socketRecoveryPromise: null,
    activeRecoveryEpoch: null,
    pendingSocketRecovery: null,
    fullRefreshRequested: false,
    keepAliveTimer: null,
    audioHealthTimer: null,
    seekRecoveryTimer: null,
    audioResumePromise: null,
    audioStateHandler: null,
    cleanupPromise: null,
    trackEventHandlers: [],
    droppedFrames: 0,
    sentFrames: 0,
    lastAudioFrameAt: null,
    lastKeepAliveAt: null,
    trackMutedAt: null,
    mediaPaused: false,
    backpressured: false,
    lastBackpressureNotice: 0,
    mediaSeeking: false,
    timelineEpoch: normalizeTimelineEpoch(timelineEpoch),
    ignoreProviderResults: false,
    pendingAudioFrames: [],
    pendingAudioBytes: 0,
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

  const language = ALLOWED_LANGUAGES.has(message.language) ? message.language : 'multi';
  const sessionId = normalizeSessionId(message.sessionId);
  const requestedTimelineEpoch = normalizeTimelineEpoch(message.timelineEpoch);
  // Claim the lifecycle before the first await. Otherwise STOP_CAPTURE can
  // report success while a pending storage read later resumes and starts audio.
  const revision = ++lifecycleRevision;
  pendingStart = { revision, sessionId };
  let context = null;

  try {
    // Chrome exposes only chrome.runtime to offscreen documents. Request the
    // credential directly from the service worker, which authenticates this
    // document and the active session before replying to this sender only.
    const credentialResponse = await chrome.runtime.sendMessage({
      type: 'GET_CAPTURE_CREDENTIAL',
      sessionId,
    });
    if (revision !== lifecycleRevision) {
      throw new CaptureError('START_CANCELLED', 'Capture start was superseded or stopped.', false);
    }

    if (!credentialResponse?.ok) {
      throw new CaptureError(
        typeof credentialResponse?.code === 'string'
          ? credentialResponse.code
          : 'CONFIG_READ_FAILED',
        typeof credentialResponse?.error === 'string' && credentialResponse.error.trim()
          ? credentialResponse.error.trim()
          : 'Unable to read the Deepgram configuration.',
        false
      );
    }
    if (credentialResponse.sessionId !== sessionId) {
      throw new CaptureError(
        'SESSION_MISMATCH',
        'The transcription credential belongs to a stale session.',
        false
      );
    }

    const deepgramKey = typeof credentialResponse.deepgramKey === 'string'
      ? credentialResponse.deepgramKey.trim()
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

    const credentialTimelineEpoch = normalizeTimelineEpoch(credentialResponse.timelineEpoch);
    context = createCaptureContext(
      sessionId,
      language,
      deepgramKey,
      revision,
      Math.max(requestedTimelineEpoch, credentialTimelineEpoch)
    );
    currentCapture = context;

    await prepareAudioCapture(context, streamId);
    assertCurrent(context);

    await openDeepgramSocket(context);
    assertCurrent(context);

    startAudioProcessor(context);
    context.state = 'listening';
    startDeepgramKeepAlive(context);
    startAudioHealthWatchdog(context);
    emitPipelineStatus(context, 'listening', {
      sampleRate: context.audioContext.sampleRate,
      language: context.language,
    });

    return {
      ok: true,
      sessionId: context.sessionId,
      state: context.state,
      sampleRate: context.audioContext.sampleRate,
      timelineEpoch: context.timelineEpoch,
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
    const onMute = () => handleTrackMuted(context);
    const onUnmute = () => handleTrackUnmuted(context);
    context.trackEventHandlers.push(
      [track, 'ended', onEnded],
      [track, 'mute', onMute],
      [track, 'unmute', onUnmute]
    );
    track.addEventListener('ended', onEnded, { once: true });
    track.addEventListener('mute', onMute);
    track.addEventListener('unmute', onUnmute);
  }

  try {
    context.audioContext = new AudioContext({ latencyHint: 'interactive' });
    context.audioStateHandler = () => handleAudioContextStateChange(context);
    context.audioContext.addEventListener?.('statechange', context.audioStateHandler);
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
      if (context.socket === socket) context.expectedSocketClose = true;
      try { socket.close(4000, 'Handshake timeout'); } catch (_error) {}
    }, HANDSHAKE_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      if (!isCurrent(context) || context.socket !== socket) {
        failHandshake(new CaptureError('START_CANCELLED', 'Capture start was superseded.', false));
        try { socket.close(1000, 'Stale capture'); } catch (_error) {}
        return;
      }
      if (settled) return;
      try {
        // Deepgram NET-0001 requires at least one binary audio frame after each
        // connection opens. A short valid PCM-silence frame covers a paused
        // player or suspended AudioContext until live frames resume.
        const sampleCount = Math.max(160, Math.round(context.audioContext.sampleRate / 50));
        socket.send(new Int16Array(sampleCount).buffer);
        context.lastAudioFrameAt = Date.now();
      } catch (error) {
        failHandshake(new CaptureError(
          'DEEPGRAM_INITIAL_AUDIO_FAILED',
          error instanceof Error ? error.message : 'Unable to initialize the audio stream.',
          true
        ));
        try { socket.close(1011, 'Initial audio failed'); } catch (_error) {}
        return;
      }
      settled = true;
      clearHandshake();
      resolve();
    });

    socket.addEventListener('message', event => {
      if (context.socket === socket) handleDeepgramMessage(context, event);
    });

    socket.addEventListener('error', () => {
      if (context.socket !== socket) return;
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
      if (context.socket !== socket) return;
      if (!settled) {
        const authFailure = isDeepgramAuthFailure(event);
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
      handleSocketClosed(context, event, socket);
    });
  });
}

function isDeepgramAuthFailure(event) {
  const reason = String(event?.reason || '').toUpperCase();
  return event?.code === 4001
    || event?.code === 4003
    || /(?:INVALID[_ ]?AUTH|AUTHENTICATION|INSUFFICIENT[_ ]?PERMISSIONS|FORBIDDEN)/u.test(reason);
}

function closeSocketForReplacement(context, reason) {
  const socket = context.socket;
  context.socket = null;
  context.expectedSocketClose = true;
  if (context.handshakeTimer) clearTimeout(context.handshakeTimer);
  context.handshakeTimer = null;
  context.handshakeReject = null;
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    try { socket.close(1000, reason || 'Reconnecting'); } catch (_error) {}
  }
  context.expectedSocketClose = false;
}

function waitForDelay(delayMs) {
  if (!delayMs) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

function requestNewTabStream(context, reason, error = null) {
  if (!isCurrent(context) || context.state === 'stopping' || context.fullRefreshRequested) return;
  context.fullRefreshRequested = true;
  if (error) emitPipelineError(context, error);
  const sessionId = context.sessionId;
  const revision = context.revision;
  cleanupContext(context, { reason, sendCloseStream: false })
    .then(() => {
      if (lifecycleRevision !== revision || currentCapture) return;
      sendRuntimeMessage({
        type: 'REQUEST_NEW_STREAM',
        sessionId,
        reason,
      });
    })
    .catch(() => {});
}

function recoverDeepgramSocket(context, reason = 'socket_recovery') {
  if (!isCurrent(context) || context.state === 'stopping') return Promise.resolve(false);
  if (context.socketRecoveryPromise) {
    if (reason === 'media_seek' || context.timelineEpoch !== context.activeRecoveryEpoch) {
      context.pendingSocketRecovery = {
        epoch: context.timelineEpoch,
        reason,
      };
    }
    return context.socketRecoveryPromise.then(result => {
      const pending = context.pendingSocketRecovery;
      if (
        !pending
        || !isCurrent(context)
        || context.mediaSeeking
        || pending.epoch !== context.timelineEpoch
      ) return result;
      context.pendingSocketRecovery = null;
      return recoverDeepgramSocket(context, pending.reason);
    });
  }
  const revision = context.revision;
  const recoveryEpoch = context.timelineEpoch;
  context.activeRecoveryEpoch = recoveryEpoch;

  context.socketRecoveryPromise = (async () => {
    context.ignoreProviderResults = true;
    context.utterance = createEmptyUtterance();
    closeSocketForReplacement(context, reason);

    let lastError = null;
    for (const delayMs of SOCKET_RECONNECT_DELAYS_MS) {
      await waitForDelay(delayMs);
      if (!isCurrent(context) || lifecycleRevision !== revision || context.state === 'stopping') {
        return false;
      }
      try {
        await openDeepgramSocket(context);
        if (!isCurrent(context) || lifecycleRevision !== revision) return false;
        // A seek may have started while this handshake was in flight. Keep the
        // new socket quarantined; the seeked event will request one final clean
        // boundary for the latest epoch.
        const matchesTimeline = !context.mediaSeeking && context.timelineEpoch === recoveryEpoch;
        context.ignoreProviderResults = !matchesTimeline;
        context.fullRefreshRequested = false;
        if (matchesTimeline) {
          flushBufferedAudio(context, context.socket);
          emitPipelineStatus(context, 'transcription_reconnected', {
            reason,
            timelineEpoch: context.timelineEpoch,
          });
        }
        return true;
      } catch (error) {
        lastError = error;
        closeSocketForReplacement(context, 'Reconnect retry');
      }
    }

    if (isCurrent(context) && lifecycleRevision === revision) {
      requestNewTabStream(context, 'socket_recovery_failed', new CaptureError(
        'DEEPGRAM_RECONNECT_FAILED',
        lastError instanceof Error
          ? lastError.message
          : 'The transcription connection could not be restored.',
        true
      ));
    }
    return false;
  })().finally(() => {
    context.socketRecoveryPromise = null;
    context.activeRecoveryEpoch = null;
  });
  return context.socketRecoveryPromise;
}

async function handleMediaTimelineEvent(message) {
  const context = currentCapture;
  const sessionId = normalizeSessionId(message?.sessionId, false);
  if (!context || !sessionId || sessionId !== context.sessionId || !isCurrent(context)) {
    return {
      ok: false,
      ignored: true,
      code: 'CAPTURE_CONTEXT_UNAVAILABLE',
      error: 'The active audio capture context is not ready for a timeline event.',
      sessionId,
      activeSessionId: context?.sessionId || null,
    };
  }

  const phase = message?.phase === 'seeking' || message?.phase === 'seeked'
    || message?.phase === 'paused' || message?.phase === 'playing'
    ? message.phase
    : '';
  if (!phase) {
    throw new CaptureError(
      'MEDIA_TIMELINE_INVALID',
      'The media timeline event was not recognized.',
      false
    );
  }

  const incomingEpoch = Number.isSafeInteger(message?.epoch) && message.epoch >= 0
    ? message.epoch
    : context.timelineEpoch + (phase === 'seeking' ? 1 : 0);
  if (incomingEpoch < context.timelineEpoch) {
    return {
      ok: true,
      ignored: true,
      sessionId,
      timelineEpoch: context.timelineEpoch,
    };
  }
  context.timelineEpoch = incomingEpoch;

  if (phase === 'paused' || phase === 'playing') {
    context.mediaPaused = phase === 'paused';
    if (!context.mediaPaused) {
      // Give the Web Audio graph one full watchdog window to resume producing
      // PCM before escalating to a fresh tab stream.
      context.lastAudioFrameAt = Date.now();
      void resumeAudioContext(context);
    }
    emitPipelineStatus(context, phase === 'paused' ? 'media_paused' : 'media_playing', {
      timelineEpoch: context.timelineEpoch,
      currentTime: optionalNumber(message.currentTime),
    });
    return {
      ok: true,
      sessionId,
      phase,
      timelineEpoch: context.timelineEpoch,
    };
  }

  if (context.seekRecoveryTimer !== null) {
    clearTimeout(context.seekRecoveryTimer);
    context.seekRecoveryTimer = null;
  }

  // A seek is a hard transcript boundary. Results already queued by the old
  // Deepgram socket must never be attached to the destination timestamp.
  context.ignoreProviderResults = true;
  context.utterance = createEmptyUtterance();
  context.pendingAudioFrames = [];
  context.pendingAudioBytes = 0;
  context.mediaPaused = message.paused === true;

  if (phase === 'seeking') {
    context.mediaSeeking = true;
    emitPipelineStatus(context, 'timeline_seeking', {
      timelineEpoch: context.timelineEpoch,
      currentTime: optionalNumber(message.currentTime),
    });
    return {
      ok: true,
      sessionId,
      phase,
      timelineEpoch: context.timelineEpoch,
    };
  }

  context.mediaSeeking = false;
  void resumeAudioContext(context);
  const recoveryEpoch = context.timelineEpoch;
  context.seekRecoveryTimer = setTimeout(() => {
    context.seekRecoveryTimer = null;
    if (
      !isCurrent(context)
      || context.state === 'stopping'
      || context.mediaSeeking
      || context.timelineEpoch !== recoveryEpoch
    ) return;
    void recoverDeepgramSocket(context, 'media_seek');
  }, SEEK_RECOVERY_DEBOUNCE_MS);

  emitPipelineStatus(context, 'timeline_seeked', {
    timelineEpoch: recoveryEpoch,
    currentTime: optionalNumber(message.currentTime),
  });
  return {
    ok: true,
    sessionId,
    phase,
    timelineEpoch: recoveryEpoch,
  };
}

function startAudioProcessor(context) {
  const processor = context.audioContext.createScriptProcessor(4096, 1, 1);
  context.processor = processor;

  processor.onaudioprocess = event => {
    const socket = context.socket;
    if (!isCurrent(context) || context.state === 'stopping' || context.mediaSeeking) return;

    const float32 = event.inputBuffer.getChannelData(0);
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const sample = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = sample < 0 ? sample * 32768 : sample * 32767;
    }
    const audioFrame = int16.buffer;
    context.lastAudioFrameAt = Date.now();

    if (context.ignoreProviderResults || socket?.readyState !== WebSocket.OPEN) {
      bufferAudioFrame(context, audioFrame);
      return;
    }

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

    try {
      socket.send(audioFrame);
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

function bufferAudioFrame(context, frame) {
  if (!(frame instanceof ArrayBuffer) || frame.byteLength === 0) return;
  if (context.pendingAudioBytes + frame.byteLength > MAX_RECOVERY_AUDIO_BYTES) {
    context.droppedFrames++;
    return;
  }
  context.pendingAudioFrames.push(frame);
  context.pendingAudioBytes += frame.byteLength;
}

function flushBufferedAudio(context, socket) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return 0;
  let sent = 0;
  for (const frame of context.pendingAudioFrames) {
    try {
      socket.send(frame);
      context.sentFrames++;
      sent++;
    } catch (error) {
      emitPipelineError(context, new CaptureError(
        'DEEPGRAM_BUFFER_FLUSH_FAILED',
        error instanceof Error ? error.message : 'Unable to resume buffered transcription audio.',
        true
      ));
      break;
    }
  }
  context.pendingAudioFrames = [];
  context.pendingAudioBytes = 0;
  if (sent) context.lastAudioFrameAt = Date.now();
  return sent;
}

function startDeepgramKeepAlive(context) {
  if (context.keepAliveTimer !== null) clearInterval(context.keepAliveTimer);
  context.keepAliveTimer = setInterval(() => {
    if (!isCurrent(context) || context.state !== 'listening') return;
    const socket = context.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const lastAudioAt = Number(context.lastAudioFrameAt) || 0;
    if (lastAudioAt && Date.now() - lastAudioAt < DEEPGRAM_KEEPALIVE_MS) return;
    try {
      // Deepgram requires this control payload as a text WebSocket frame.
      socket.send(JSON.stringify({ type: 'KeepAlive' }));
      context.lastKeepAliveAt = Date.now();
    } catch (error) {
      emitPipelineError(context, new CaptureError(
        'DEEPGRAM_KEEPALIVE_FAILED',
        error instanceof Error ? error.message : 'Unable to keep the transcription connection alive.',
        true
      ));
    }
  }, DEEPGRAM_KEEPALIVE_MS);
}

function startAudioHealthWatchdog(context) {
  if (context.audioHealthTimer !== null) clearInterval(context.audioHealthTimer);
  context.audioHealthTimer = setInterval(() => {
    if (
      !isCurrent(context)
      || context.state !== 'listening'
      || context.mediaSeeking
      || context.mediaPaused
      || context.socketRecoveryPromise
      || context.fullRefreshRequested
    ) return;

    if (context.audioContext?.state === 'suspended') void resumeAudioContext(context);
    const lastAudioAt = Number(context.lastAudioFrameAt) || 0;
    const audioStalled = !lastAudioAt || Date.now() - lastAudioAt >= AUDIO_STALL_TIMEOUT_MS;
    const trackPersistentlyMuted = Boolean(
      context.trackMutedAt && Date.now() - context.trackMutedAt >= AUDIO_STALL_TIMEOUT_MS
    );
    if (!audioStalled && !trackPersistentlyMuted && context.audioContext?.state !== 'closed') return;

    requestNewTabStream(context, 'audio_capture_stalled', new CaptureError(
      'AUDIO_CAPTURE_STALLED',
      'Tab audio stopped producing data and is being reconnected.',
      true
    ));
  }, AUDIO_HEALTH_CHECK_MS);
}

function resumeAudioContext(context) {
  if (!isCurrent(context) || !context.audioContext || context.audioContext.state !== 'suspended') {
    return Promise.resolve(false);
  }
  if (context.audioResumePromise) return context.audioResumePromise;
  context.audioResumePromise = Promise.resolve()
    .then(() => context.audioContext?.resume())
    .then(() => {
      if (isCurrent(context) && context.audioContext?.state === 'running') {
        emitPipelineStatus(context, 'audio_resumed', {
          timelineEpoch: context.timelineEpoch,
        });
        return true;
      }
      return false;
    })
    .catch(error => {
      if (isCurrent(context)) {
        emitPipelineError(context, new CaptureError(
          'AUDIO_RESUME_FAILED',
          error instanceof Error ? error.message : 'Unable to resume tab audio after the timeline changed.',
          true
        ));
      }
      return false;
    })
    .finally(() => {
      context.audioResumePromise = null;
    });
  return context.audioResumePromise;
}

function handleAudioContextStateChange(context) {
  if (!isCurrent(context) || context.state === 'stopping') return;
  if (context.audioContext?.state === 'suspended') void resumeAudioContext(context);
}

function handleTrackMuted(context) {
  if (!isCurrent(context) || context.state === 'stopping') return;
  context.trackMutedAt = Date.now();
  emitPipelineStatus(context, 'audio_interrupted', {
    reason: context.mediaSeeking ? 'media_seek' : 'track_muted',
    timelineEpoch: context.timelineEpoch,
  });
  void resumeAudioContext(context);
}

function handleTrackUnmuted(context) {
  if (!isCurrent(context) || context.state === 'stopping') return;
  context.trackMutedAt = null;
  void resumeAudioContext(context);
  emitPipelineStatus(context, 'audio_resumed', {
    timelineEpoch: context.timelineEpoch,
  });
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
    timelineEpoch: context.timelineEpoch || 0,
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

  if (data.type === 'Error') {
    if (context.state === 'stopping') return;
    const providerCode = String(data.code || data.err_code || '')
      .trim()
      .slice(0, 120);
    const normalizedProviderCode = providerCode.toUpperCase();
    const retryable = normalizedProviderCode.startsWith('NET-');
    const authFailure = /(?:AUTH|TOKEN|PERMISSION|FORBIDDEN)/u.test(normalizedProviderCode);
    const error = new CaptureError(
      retryable ? 'DEEPGRAM_TRANSIENT_ERROR' : 'DEEPGRAM_RESPONSE_ERROR',
      String(data.description || data.message || 'Deepgram reported a transcription error.'),
      retryable,
      providerCode ? { providerCode } : undefined
    );
    emitPipelineError(context, error, undefined, !retryable);
    if (retryable) {
      void recoverDeepgramSocket(context, normalizedProviderCode.toLowerCase());
    } else {
      cleanupContext(context, {
        reason: authFailure ? 'deepgram_auth_error' : 'deepgram_response_error',
        sendCloseStream: false,
      }).catch(() => {});
    }
    return;
  }

  if (context.ignoreProviderResults) return;

  if (data.type === 'UtteranceEnd') {
    const flushed = flushUtterance(context, 'utterance_end');
    sendRuntimeMessage({
      type: 'UTTERANCE_END',
      sessionId: context.sessionId,
      timelineEpoch: context.timelineEpoch || 0,
      flushed,
      lastWordEnd: optionalNumber(data.last_word_end),
    });
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
    true
  );
  requestNewTabStream(context, 'track_ended', error);
}

function handleSocketClosed(context, event, socket) {
  if (context.expectedSocketClose || context.state === 'stopped') return;
  if (currentCapture !== context || context.socket !== socket) return;

  const authFailure = isDeepgramAuthFailure(event);
  const error = new CaptureError(
    authFailure ? 'DEEPGRAM_AUTH_FAILED' : 'DEEPGRAM_DISCONNECTED',
    authFailure
      ? 'Deepgram rejected the API key.'
      : `Deepgram disconnected unexpectedly (code ${event.code || 1006}).`,
    !authFailure,
    { closeCode: event.code || 1006 }
  );
  emitPipelineError(context, error, undefined, authFailure);
  if (authFailure) {
    cleanupContext(context, { reason: 'deepgram_auth_failed', sendCloseStream: false })
      .catch(() => {});
    return;
  }
  void recoverDeepgramSocket(context, 'deepgram_disconnected');
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
    context.ignoreProviderResults = true;
    disconnectAudioProcessor(context);

    if (context.keepAliveTimer !== null) clearInterval(context.keepAliveTimer);
    context.keepAliveTimer = null;
    if (context.audioHealthTimer !== null) clearInterval(context.audioHealthTimer);
    context.audioHealthTimer = null;
    if (context.seekRecoveryTimer !== null) clearTimeout(context.seekRecoveryTimer);
    context.seekRecoveryTimer = null;

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

    for (const [track, eventName, handler] of context.trackEventHandlers || []) {
      track.removeEventListener(eventName, handler);
    }
    context.trackEventHandlers = [];

    if (context.mediaStream) {
      context.mediaStream.getTracks().forEach(track => track.stop());
      context.mediaStream = null;
    }

    if (context.audioContext) {
      if (context.audioStateHandler) {
        context.audioContext.removeEventListener?.('statechange', context.audioStateHandler);
      }
      context.audioStateHandler = null;
      try { await context.audioContext.close(); } catch (_error) {}
      context.audioContext = null;
    }

    context.audioResumePromise = null;
    context.socketRecoveryPromise = null;
    context.activeRecoveryEpoch = null;
    context.pendingSocketRecovery = null;
    context.pendingAudioFrames = [];
    context.pendingAudioBytes = 0;
    context.deepgramKey = '';
    context.utterance = createEmptyUtterance();
    context.state = 'stopped';
    if (currentCapture === context) currentCapture = null;
    emitPipelineStatus(context, 'stopped', { reason: options.reason || 'stopped' });
  })();

  return context.cleanupPromise;
}
