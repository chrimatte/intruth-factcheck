// popup.js

const UI_STATES = Object.freeze({
  INACTIVE: 'inactive',
  STARTING: 'starting',
  LISTENING: 'listening',
  STOPPING: 'stopping',
  ERROR: 'error',
});

const PRIVACY_NOTICE_VERSION = '2026-07-16-v2';

const STORAGE_KEYS = [
  'anthropicKey',
  'deepgramKey',
  'serperKey',
  'transcriptLanguage',
  'analysisMode',
  'sessionBudgetUsd',
  'privacyConsent',
  'privacyConsentVersion',
];

const elements = {
  toggle: document.getElementById('toggleBtn'),
  buttonLabel: document.getElementById('buttonLabel'),
  status: document.getElementById('status'),
  statusText: document.getElementById('statusText'),
  errorNotice: document.getElementById('errorNotice'),
  form: document.getElementById('configForm'),
  hint: document.getElementById('configHint'),
  anthropicKey: document.getElementById('anthropicKey'),
  deepgramKey: document.getElementById('deepgramKey'),
  serperKey: document.getElementById('serperKey'),
  language: document.getElementById('languageSelect'),
  languageCode: document.getElementById('languageCode'),
  analysisMode: document.getElementById('analysisMode'),
  sessionBudget: document.getElementById('sessionBudgetUsd'),
  consent: document.getElementById('privacyConsent'),
};

const keyInputs = [elements.anthropicKey, elements.deepgramKey, elements.serperKey];
const model = {
  initialized: false,
  state: UI_STATES.INACTIVE,
  supportedTab: false,
  captureMayBeActive: false,
  errorMessage: '',
  sessionId: null,
  currentTabId: null,
  sessionTabId: null,
};
let statusSyncToken = 0;

chrome.runtime.onMessage.addListener(message => {
  if (!message || typeof message !== 'object' || !model.initialized) return;
  // The in-flight start/stop request owns those transitions and its response
  // provides the authoritative result; avoid racing it with status broadcasts.
  if (model.state === UI_STATES.STARTING || model.state === UI_STATES.STOPPING) return;
  if (!model.captureMayBeActive && !model.sessionId) return;
  if (message.sessionId && model.sessionId && message.sessionId !== model.sessionId) return;

  if (message.type === 'PIPELINE_ERROR') {
    const serialized = message.error && typeof message.error === 'object'
      ? message.error
      : message;
    const fallback = message.fatal
      ? 'The transcription session stopped because of a provider error.'
      : 'The transcription connection was interrupted and may reconnect.';
    transitionTo(UI_STATES.ERROR, {
      errorMessage: typeof serialized.message === 'string' && serialized.message.trim()
        ? serialized.message.trim()
        : fallback,
      captureMayBeActive: true,
    });
    elements.errorNotice.focus();
    if (message.fatal) reconcileTerminalStatus(message.sessionId || model.sessionId);
    return;
  }

  if (message.type === 'PIPELINE_STATUS' && message.status === 'listening') {
    statusSyncToken++;
    transitionTo(UI_STATES.LISTENING, {
      sessionId: message.sessionId || model.sessionId,
      captureMayBeActive: true,
      errorMessage: '',
    });
  }
});

for (const input of keyInputs) {
  input.addEventListener('input', () => {
    input.classList.remove('stored');
    input.removeAttribute('aria-invalid');
    render();
  });

  input.addEventListener('change', async () => {
    const value = input.value.trim();
    input.value = value;
    try {
      await storageSet({ [input.id]: value });
      input.classList.toggle('stored', Boolean(value));
    } catch (error) {
      showNonCaptureError(error.message);
    }
    render();
  });
}

elements.language.addEventListener('change', async () => {
  updateLanguageCode();
  try {
    await storageSet({ transcriptLanguage: elements.language.value });
  } catch (error) {
    showNonCaptureError(error.message);
  }
});

elements.analysisMode.addEventListener('change', async () => {
  try {
    await storageSet({ analysisMode: elements.analysisMode.value });
  } catch (error) {
    showNonCaptureError(error.message);
  }
});

elements.sessionBudget.addEventListener('change', async () => {
  try {
    await storageSet({ sessionBudgetUsd: Number(elements.sessionBudget.value) });
  } catch (error) {
    showNonCaptureError(error.message);
  }
});

elements.consent.addEventListener('change', async () => {
  elements.consent.removeAttribute('aria-invalid');
  try {
    await storageSet({
      privacyConsent: elements.consent.checked,
      privacyConsentVersion: elements.consent.checked ? PRIVACY_NOTICE_VERSION : '',
    });
  } catch (error) {
    showNonCaptureError(error.message);
  }
  render();
});

elements.form.addEventListener('submit', event => {
  event.preventDefault();
  if (!elements.toggle.disabled) elements.toggle.click();
});

elements.toggle.addEventListener('click', async () => {
  if (model.state === UI_STATES.LISTENING || model.captureMayBeActive) {
    await stopFactChecking();
  } else {
    await startFactChecking();
  }
});

initialize().catch(error => {
  model.initialized = true;
  transitionTo(UI_STATES.ERROR, {
    errorMessage: error.message || 'Unable to initialize the extension controls.',
    captureMayBeActive: true,
  });
});

async function initialize() {
  render();

  const [stored, tab, status] = await Promise.all([
    storageGet(STORAGE_KEYS),
    getActiveTab(),
    sendMessage({ type: 'GET_STATUS' }),
  ]);

  elements.anthropicKey.value = stored.anthropicKey || '';
  elements.deepgramKey.value = stored.deepgramKey || '';
  elements.serperKey.value = stored.serperKey || '';
  elements.language.value = isKnownLanguage(stored.transcriptLanguage)
    ? stored.transcriptLanguage
    : 'multi';
  elements.analysisMode.value = stored.analysisMode === 'balanced'
    ? 'balanced'
    : 'efficient';
  const storedBudget = Number(stored.sessionBudgetUsd);
  elements.sessionBudget.value = [0, 0.25, 0.5, 1].includes(storedBudget)
    ? String(storedBudget)
    : '0.5';
  elements.consent.checked = stored.privacyConsent === true
    && stored.privacyConsentVersion === PRIVACY_NOTICE_VERSION;

  for (const input of keyInputs) input.classList.toggle('stored', Boolean(input.value));

  model.currentTabId = Number.isInteger(tab?.id) ? tab.id : null;
  model.supportedTab = isSupportedUrl(tab?.url);
  model.initialized = true;
  updateLanguageCode();

  const backgroundPhase = String(status?.phase || '').toUpperCase();
  const sessionTabId = Number.isInteger(status?.tabId) ? status.tabId : null;
  if (backgroundPhase === 'STARTING' && status?.sessionId) {
    // A newly opened popup does not own the in-flight start request. Present a
    // conservative stop action instead of pretending that the tab is ready.
    transitionTo(UI_STATES.ERROR, {
      sessionId: status.sessionId,
      sessionTabId,
      captureMayBeActive: true,
      errorMessage: 'Session startup is still in progress. You can stop it safely.',
    });
  } else if (backgroundPhase === 'STOPPING' && status?.sessionId) {
    transitionTo(UI_STATES.STOPPING, {
      sessionId: status.sessionId,
      sessionTabId,
      captureMayBeActive: true,
    });
    void reconcileTerminalStatus(status.sessionId, false);
  } else if (status?.isCapturing || backgroundPhase === 'ACTIVE') {
    transitionTo(UI_STATES.LISTENING, {
      sessionId: status.sessionId || null,
      sessionTabId,
      captureMayBeActive: true,
    });
  } else {
    transitionTo(UI_STATES.INACTIVE, { captureMayBeActive: false });
  }
}

function isKnownLanguage(language) {
  return [...elements.language.options].some(option => option.value === language);
}

function updateLanguageCode() {
  elements.languageCode.textContent = elements.language.value === 'multi'
    ? 'AUTO'
    : elements.language.value.toUpperCase();
}

function isSupportedUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    return url.hostname === 'www.youtube.com'
      || url.hostname === 'www.jubileemedia.com'
      || url.hostname === 'jubilee.com'
      || url.hostname.endsWith('.jubilee.com');
  } catch (_error) {
    return false;
  }
}

function getConfiguration() {
  return {
    anthropicKey: elements.anthropicKey.value.trim(),
    deepgramKey: elements.deepgramKey.value.trim(),
    serperKey: elements.serperKey.value.trim(),
    transcriptLanguage: elements.language.value,
    analysisMode: elements.analysisMode.value,
    sessionBudgetUsd: Number(elements.sessionBudget.value),
    privacyConsent: elements.consent.checked,
    privacyConsentVersion: elements.consent.checked ? PRIVACY_NOTICE_VERSION : '',
  };
}

function getMissingConfiguration() {
  const config = getConfiguration();
  const missing = [];
  if (!config.anthropicKey) missing.push('Anthropic key');
  if (!config.deepgramKey) missing.push('Deepgram key');
  if (!config.serperKey) missing.push('Serper key');
  if (!config.privacyConsent) missing.push('data-transfer consent');
  return missing;
}

function canStart() {
  return model.initialized
    && model.supportedTab
    && !model.captureMayBeActive
    && getMissingConfiguration().length === 0;
}

function transitionTo(state, options = {}) {
  model.state = state;
  if ('captureMayBeActive' in options) model.captureMayBeActive = options.captureMayBeActive;
  if ('errorMessage' in options) model.errorMessage = options.errorMessage || '';
  if ('sessionId' in options) model.sessionId = options.sessionId;
  if ('sessionTabId' in options) model.sessionTabId = options.sessionTabId;

  if (state === UI_STATES.LISTENING) model.captureMayBeActive = true;
  if (state === UI_STATES.INACTIVE) {
    model.captureMayBeActive = false;
    model.errorMessage = '';
    model.sessionId = null;
    model.sessionTabId = null;
  }
  render();
}

function render() {
  const busy = model.state === UI_STATES.STARTING || model.state === UI_STATES.STOPPING;
  const captureControls = model.state === UI_STATES.LISTENING || model.captureMayBeActive;
  const sessionInAnotherTab = captureControls
    && model.currentTabId !== null
    && model.sessionTabId !== null
    && model.currentTabId !== model.sessionTabId;
  const missing = getMissingConfiguration();

  elements.status.className = `status status--${model.state}`;
  elements.toggle.className = `toggle-btn toggle-btn--${model.state}`;
  elements.toggle.setAttribute('aria-busy', String(busy));
  elements.toggle.setAttribute('aria-pressed', String(captureControls));
  elements.form.setAttribute('aria-busy', String(busy));
  elements.form.inert = busy;
  elements.form.hidden = captureControls;

  elements.errorNotice.hidden = !model.errorMessage;
  elements.errorNotice.textContent = model.errorMessage;

  if (!model.initialized) {
    elements.statusText.textContent = 'Checking current tab';
    elements.buttonLabel.textContent = 'Start fact-checking';
    elements.toggle.disabled = true;
    elements.hint.textContent = 'Loading local configuration and capture status.';
    return;
  }

  switch (model.state) {
    case UI_STATES.STARTING:
      elements.statusText.textContent = 'Starting audio and provider connections';
      elements.buttonLabel.textContent = 'Starting session';
      elements.toggle.disabled = true;
      break;

    case UI_STATES.LISTENING:
      elements.statusText.textContent = sessionInAnotherTab
        ? 'Session active in another tab'
        : 'Listening and fact-checking';
      elements.buttonLabel.textContent = sessionInAnotherTab
        ? 'Stop other tab session'
        : 'Stop fact-checking';
      elements.toggle.disabled = false;
      break;

    case UI_STATES.STOPPING:
      elements.statusText.textContent = 'Stopping audio capture';
      elements.buttonLabel.textContent = 'Stopping session';
      elements.toggle.disabled = true;
      break;

    case UI_STATES.ERROR:
      elements.statusText.textContent = model.captureMayBeActive
        ? (sessionInAnotherTab ? 'Other tab session needs attention' : 'Capture state needs attention')
        : 'Session could not start';
      elements.buttonLabel.textContent = model.captureMayBeActive
        ? (sessionInAnotherTab ? 'Stop other tab session' : 'Retry stop')
        : 'Start fact-checking';
      elements.toggle.disabled = model.captureMayBeActive ? false : !canStart();
      break;

    default:
      elements.statusText.textContent = model.supportedTab ? 'Ready' : 'Unsupported page';
      elements.buttonLabel.textContent = 'Start fact-checking';
      elements.toggle.disabled = !canStart();
  }

  if (captureControls) {
    elements.hint.textContent = '';
  } else if (!model.supportedTab) {
    elements.hint.textContent = 'Open a supported YouTube or Jubilee page to start.';
  } else if (missing.length) {
    elements.hint.textContent = `Required: ${missing.join(', ')}.`;
  } else {
    elements.hint.textContent = 'Configuration is complete. Provider keys are checked only when the session starts.';
  }
}

async function startFactChecking() {
  if (!canStart()) {
    focusFirstIncompleteField();
    return;
  }

  const config = getConfiguration();
  let startRequested = false;
  transitionTo(UI_STATES.STARTING, {
    errorMessage: '',
    captureMayBeActive: false,
  });

  try {
    await storageSet(config);
    for (const input of keyInputs) input.classList.add('stored');

    const requestedSessionId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `session-${Date.now()}`;
    model.sessionId = requestedSessionId;
    startRequested = true;
    const response = await sendMessage({
      type: 'START_FACTCHECK',
      sessionId: requestedSessionId,
    });
    if (!response?.ok) {
      // START_FACTCHECK error responses are sent only after the background has
      // completed rollback. Keep the conservative Retry stop state only for a
      // transport failure where Chrome did not return an authoritative result.
      transitionTo(UI_STATES.ERROR, {
        errorMessage: getResponseError(response, 'The session could not start.'),
        captureMayBeActive: false,
        sessionId: null,
        sessionTabId: null,
      });
      elements.errorNotice.focus();
      return;
    }

    transitionTo(UI_STATES.LISTENING, {
      sessionId: response.sessionId || requestedSessionId,
      sessionTabId: model.currentTabId,
      captureMayBeActive: true,
      errorMessage: '',
    });
  } catch (error) {
    transitionTo(UI_STATES.ERROR, {
      errorMessage: error.message || 'The session could not start.',
      // A failed background response can arrive after tab audio opened. Offer a
      // stop action until the background confirms cleanup.
      captureMayBeActive: startRequested,
    });
    elements.errorNotice.focus();
  }
}

async function stopFactChecking() {
  transitionTo(UI_STATES.STOPPING, {
    errorMessage: '',
    captureMayBeActive: true,
  });

  try {
    const response = await sendMessage({
      type: 'STOP_FACTCHECK',
      sessionId: model.sessionId,
    });
    if (response && response.ok === false) {
      throw new Error(getResponseError(response, 'The session did not stop cleanly.'));
    }
    transitionTo(UI_STATES.INACTIVE, { captureMayBeActive: false });
  } catch (error) {
    transitionTo(UI_STATES.ERROR, {
      errorMessage: error.message || 'The session did not stop cleanly. Retry stop.',
      captureMayBeActive: true,
    });
    elements.errorNotice.focus();
  }
}

function showNonCaptureError(message) {
  transitionTo(UI_STATES.ERROR, {
    errorMessage: message || 'Unable to save the local configuration.',
    captureMayBeActive: false,
  });
  elements.errorNotice.focus();
}

function focusFirstIncompleteField() {
  const config = getConfiguration();
  const candidates = [
    [elements.anthropicKey, !config.anthropicKey],
    [elements.deepgramKey, !config.deepgramKey],
    [elements.serperKey, !config.serperKey],
    [elements.consent, !config.privacyConsent],
  ];
  const firstMissing = candidates.find(([, missing]) => missing);
  if (!firstMissing) return;
  firstMissing[0].setAttribute('aria-invalid', 'true');
  firstMissing[0].focus();
}

function getResponseError(response, fallback) {
  if (typeof response?.error === 'string' && response.error) return response.error;
  if (response?.error && typeof response.error.message === 'string') return response.error.message;
  return fallback;
}

async function reconcileTerminalStatus(sessionId, preserveError = true) {
  const token = ++statusSyncToken;
  const delays = [150, 400, 900, 1800, 3200];

  for (const delay of delays) {
    await new Promise(resolve => setTimeout(resolve, delay));
    if (token !== statusSyncToken) return;

    try {
      const status = await sendMessage({ type: 'GET_STATUS' });
      if (token !== statusSyncToken) return;
      if (status?.isCapturing) continue;

      if (preserveError) {
        transitionTo(UI_STATES.ERROR, {
          errorMessage: model.errorMessage,
          captureMayBeActive: false,
          sessionId: null,
          sessionTabId: null,
        });
      } else {
        transitionTo(UI_STATES.INACTIVE, { captureMayBeActive: false });
      }
      return;
    } catch (_error) {
      // Keep the conservative retry-stop state until background confirms idle.
    }
  }
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, result => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result || {});
    });
  });
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tabs?.[0] || null);
    });
  });
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}
