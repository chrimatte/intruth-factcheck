// popup.js

const UI_STATES = Object.freeze({
  INACTIVE: 'inactive',
  STARTING: 'starting',
  LISTENING: 'listening',
  STOPPING: 'stopping',
  ERROR: 'error',
});

const VIEW_STATES = Object.freeze({
  HOME: 'home',
  SETTINGS: 'settings',
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
  popup: document.getElementById('popup'),
  toggle: document.getElementById('toggleBtn'),
  buttonLabel: document.getElementById('buttonLabel'),
  status: document.getElementById('status'),
  statusText: document.getElementById('statusText'),
  errorNotice: document.getElementById('errorNotice'),
  homeView: document.getElementById('homeView'),
  homeEyebrow: document.getElementById('homeEyebrow'),
  homeTitle: document.getElementById('homeTitle'),
  homeDescription: document.getElementById('homeDescription'),
  preferenceSummary: document.getElementById('preferenceSummary'),
  openSettings: document.getElementById('openSettings'),
  settingsView: document.getElementById('settingsView'),
  settingsBack: document.getElementById('settingsBack'),
  settingsBackLabel: document.getElementById('settingsBackLabel'),
  settingsEyebrow: document.getElementById('settingsEyebrow'),
  settingsTitle: document.getElementById('settingsTitle'),
  settingsIntro: document.getElementById('settingsIntro'),
  form: document.getElementById('configForm'),
  hint: document.getElementById('configHint'),
  settingsHint: document.getElementById('settingsHint'),
  saveSettings: document.getElementById('saveSettings'),
  saveSettingsLabel: document.getElementById('saveSettingsLabel'),
  privacyNoticeLink: document.getElementById('privacyNoticeLink'),
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
  view: VIEW_STATES.SETTINGS,
  setupRequired: true,
  settingsSaving: false,
  settingsDirty: false,
  settingsMessage: '',
  savedConfig: defaultConfiguration(),
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
    model.settingsDirty = true;
    model.settingsMessage = '';
    render();
  });
}

elements.language.addEventListener('change', () => {
  updateLanguageCode();
  model.settingsDirty = true;
  model.settingsMessage = '';
  render();
});

elements.analysisMode.addEventListener('change', () => {
  model.settingsDirty = true;
  model.settingsMessage = '';
  render();
});

elements.sessionBudget.addEventListener('change', () => {
  model.settingsDirty = true;
  model.settingsMessage = '';
  render();
});

elements.consent.addEventListener('change', () => {
  elements.consent.removeAttribute('aria-invalid');
  model.settingsDirty = true;
  model.settingsMessage = '';
  render();
});

elements.openSettings.addEventListener('click', openSettingsView);
elements.settingsBack.addEventListener('click', returnToHome);
elements.privacyNoticeLink.addEventListener('click', async event => {
  event.preventDefault();
  const saved = await saveSettings({ returnHomeWhenComplete: false });
  if (!saved) return;
  try {
    await createTab(chrome.runtime.getURL('src/popup/privacy.html'));
  } catch (error) {
    showNonCaptureError(error.message);
  }
});

elements.form.addEventListener('submit', event => {
  event.preventDefault();
  void saveSettings();
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

  model.savedConfig = normalizeStoredConfiguration(stored);
  model.setupRequired = !isSetupComplete(model.savedConfig);
  model.view = model.setupRequired ? VIEW_STATES.SETTINGS : VIEW_STATES.HOME;
  populateInputs(model.savedConfig);

  model.currentTabId = Number.isInteger(tab?.id) ? tab.id : null;
  model.supportedTab = isSupportedUrl(tab?.url);
  model.initialized = true;

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

function defaultConfiguration() {
  return {
    anthropicKey: '',
    deepgramKey: '',
    serperKey: '',
    transcriptLanguage: 'multi',
    analysisMode: 'efficient',
    sessionBudgetUsd: 0.5,
    privacyConsent: false,
    privacyConsentVersion: '',
  };
}

function normalizeStoredConfiguration(stored = {}) {
  const storedBudget = Number(stored.sessionBudgetUsd);
  const consentIsCurrent = stored.privacyConsent === true
    && stored.privacyConsentVersion === PRIVACY_NOTICE_VERSION;

  return {
    anthropicKey: typeof stored.anthropicKey === 'string' ? stored.anthropicKey.trim() : '',
    deepgramKey: typeof stored.deepgramKey === 'string' ? stored.deepgramKey.trim() : '',
    serperKey: typeof stored.serperKey === 'string' ? stored.serperKey.trim() : '',
    transcriptLanguage: isKnownLanguage(stored.transcriptLanguage)
      ? stored.transcriptLanguage
      : 'multi',
    analysisMode: stored.analysisMode === 'balanced' ? 'balanced' : 'efficient',
    sessionBudgetUsd: [0, 0.25, 0.5, 1].includes(storedBudget) ? storedBudget : 0.5,
    privacyConsent: consentIsCurrent,
    privacyConsentVersion: consentIsCurrent ? PRIVACY_NOTICE_VERSION : '',
  };
}

function populateInputs(config) {
  elements.anthropicKey.value = config.anthropicKey || '';
  elements.deepgramKey.value = config.deepgramKey || '';
  elements.serperKey.value = config.serperKey || '';
  elements.language.value = isKnownLanguage(config.transcriptLanguage)
    ? config.transcriptLanguage
    : 'multi';
  elements.analysisMode.value = config.analysisMode === 'balanced' ? 'balanced' : 'efficient';
  elements.sessionBudget.value = String(config.sessionBudgetUsd);
  elements.consent.checked = hasCurrentConsent(config);
  for (const input of keyInputs) {
    input.classList.toggle('stored', Boolean(input.value));
    input.removeAttribute('aria-invalid');
  }
  elements.consent.removeAttribute('aria-invalid');
  model.settingsDirty = false;
  updateLanguageCode();
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

function getDraftConfiguration() {
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

function getMissingConfiguration(config = model.savedConfig) {
  const missing = [];
  if (!config.anthropicKey?.trim()) missing.push('Anthropic key');
  if (!config.deepgramKey?.trim()) missing.push('Deepgram key');
  if (!config.serperKey?.trim()) missing.push('Serper key');
  if (!hasCurrentConsent(config)) missing.push('data-transfer consent');
  return missing;
}

function hasAllProviderKeys(config = model.savedConfig) {
  return Boolean(
    config.anthropicKey?.trim()
    && config.deepgramKey?.trim()
    && config.serperKey?.trim()
  );
}

function hasCurrentConsent(config = model.savedConfig) {
  return config.privacyConsent === true
    && config.privacyConsentVersion === PRIVACY_NOTICE_VERSION;
}

function isSetupComplete(config = model.savedConfig) {
  return hasAllProviderKeys(config) && hasCurrentConsent(config);
}

function canStart() {
  return model.initialized
    && model.supportedTab
    && !model.captureMayBeActive
    && isSetupComplete(model.savedConfig);
}

function hasCaptureControls() {
  return model.state === UI_STATES.LISTENING || model.captureMayBeActive;
}

function effectiveView() {
  return hasCaptureControls() ? VIEW_STATES.HOME : model.view;
}

function openSettingsView() {
  if (!model.initialized || model.settingsSaving || hasCaptureControls()) return;
  populateInputs(model.savedConfig);
  model.view = VIEW_STATES.SETTINGS;
  model.setupRequired = !isSetupComplete(model.savedConfig);
  model.settingsMessage = '';
  if (model.state === UI_STATES.ERROR) {
    model.state = UI_STATES.INACTIVE;
    model.errorMessage = '';
  }
  render();
  elements.settingsTitle.focus();
}

function returnToHome() {
  if (model.settingsSaving || hasCaptureControls()) return;
  if (!isSetupComplete(model.savedConfig)) {
    focusFirstIncompleteField(model.savedConfig);
    return;
  }
  populateInputs(model.savedConfig);
  model.view = VIEW_STATES.HOME;
  model.setupRequired = false;
  model.settingsMessage = '';
  render();
  elements.homeTitle.focus();
}

async function saveSettings({ returnHomeWhenComplete = true } = {}) {
  if (!model.initialized || model.settingsSaving || hasCaptureControls()) return;

  const config = getDraftConfiguration();
  model.settingsSaving = true;
  model.settingsMessage = 'Saving settings locally…';
  model.errorMessage = '';
  render();

  try {
    await storageSet(config);
    model.savedConfig = { ...config };
    model.setupRequired = !isSetupComplete(model.savedConfig);
    model.settingsSaving = false;
    populateInputs(model.savedConfig);

    if (model.setupRequired) {
      const missing = getMissingConfiguration(model.savedConfig);
      model.view = VIEW_STATES.SETTINGS;
      model.settingsMessage = `Saved locally. Required: ${missing.join(', ')}.`;
      if (model.state === UI_STATES.ERROR) model.state = UI_STATES.INACTIVE;
      render();
      focusFirstIncompleteField(model.savedConfig);
      return true;
    }

    model.view = returnHomeWhenComplete ? VIEW_STATES.HOME : VIEW_STATES.SETTINGS;
    model.settingsMessage = '';
    if (model.state === UI_STATES.ERROR) model.state = UI_STATES.INACTIVE;
    render();
    if (returnHomeWhenComplete) elements.homeTitle.focus();
    return true;
  } catch (error) {
    model.settingsSaving = false;
    model.settingsMessage = 'Changes were not saved.';
    showNonCaptureError(error.message);
    return false;
  }
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
  const initializing = !model.initialized;
  const sessionBusy = model.state === UI_STATES.STARTING || model.state === UI_STATES.STOPPING;
  const busy = initializing || sessionBusy || model.settingsSaving;
  const captureControls = hasCaptureControls();
  const view = effectiveView();
  const sessionInAnotherTab = captureControls
    && model.currentTabId !== null
    && model.sessionTabId !== null
    && model.currentTabId !== model.sessionTabId;

  elements.popup.setAttribute('aria-busy', String(busy));
  elements.status.className = `status status--${model.state}`;
  elements.toggle.className = `toggle-btn toggle-btn--${model.state}`;
  elements.toggle.setAttribute('aria-busy', String(sessionBusy));
  elements.toggle.setAttribute('aria-pressed', String(captureControls));

  setViewVisibility(elements.homeView, view === VIEW_STATES.HOME);
  setViewVisibility(elements.settingsView, view === VIEW_STATES.SETTINGS);

  elements.openSettings.hidden = !model.initialized || view !== VIEW_STATES.HOME;
  elements.openSettings.disabled = busy || captureControls;
  elements.openSettings.title = captureControls ? 'Stop the session to edit settings' : '';
  elements.settingsBack.hidden = model.setupRequired;
  elements.settingsBack.disabled = busy;
  elements.settingsBackLabel.textContent = model.settingsDirty ? 'Discard changes' : 'Home';
  elements.form.setAttribute('aria-busy', String(model.settingsSaving));
  elements.form.inert = busy || captureControls;
  elements.saveSettings.disabled = busy || captureControls;
  elements.saveSettings.setAttribute('aria-busy', String(model.settingsSaving));

  elements.errorNotice.hidden = !model.errorMessage;
  elements.errorNotice.textContent = model.errorMessage;

  renderSettingsCopy();
  renderHomeCopy();

  if (!model.initialized) {
    elements.statusText.textContent = 'Checking current tab';
    elements.buttonLabel.textContent = 'Start fact-checking';
    elements.toggle.disabled = true;
    elements.hint.textContent = 'Loading local configuration and capture status.';
    elements.settingsHint.textContent = 'Loading saved settings…';
    return;
  }

  if (model.settingsSaving) {
    elements.statusText.textContent = 'Saving local settings';
  } else {
    switch (model.state) {
      case UI_STATES.STARTING:
        elements.statusText.textContent = 'Starting audio and provider connections';
        break;
      case UI_STATES.LISTENING:
        elements.statusText.textContent = sessionInAnotherTab
          ? 'Session active in another tab'
          : 'Listening and fact-checking';
        break;
      case UI_STATES.STOPPING:
        elements.statusText.textContent = 'Stopping audio capture';
        break;
      case UI_STATES.ERROR:
        elements.statusText.textContent = view === VIEW_STATES.SETTINGS
          ? 'Settings need attention'
          : model.captureMayBeActive
            ? (sessionInAnotherTab ? 'Other tab session needs attention' : 'Capture state needs attention')
            : 'Session could not start';
        break;
      default:
        if (view === VIEW_STATES.SETTINGS) {
          elements.statusText.textContent = model.setupRequired ? 'Setup required' : 'Provider settings';
        } else {
          elements.statusText.textContent = model.supportedTab ? 'Ready' : 'Unsupported page';
        }
    }
  }

  switch (model.state) {
    case UI_STATES.STARTING:
      elements.buttonLabel.textContent = 'Starting session';
      elements.toggle.disabled = true;
      break;
    case UI_STATES.LISTENING:
      elements.buttonLabel.textContent = sessionInAnotherTab
        ? 'Stop other tab session'
        : 'Stop fact-checking';
      elements.toggle.disabled = false;
      break;
    case UI_STATES.STOPPING:
      elements.buttonLabel.textContent = 'Stopping session';
      elements.toggle.disabled = true;
      break;
    case UI_STATES.ERROR:
      elements.buttonLabel.textContent = model.captureMayBeActive
        ? (sessionInAnotherTab ? 'Stop other tab session' : 'Retry stop')
        : 'Start fact-checking';
      elements.toggle.disabled = model.captureMayBeActive ? false : !canStart();
      break;
    default:
      elements.buttonLabel.textContent = 'Start fact-checking';
      elements.toggle.disabled = !canStart();
  }

  if (captureControls) {
    elements.hint.textContent = '';
  } else if (!model.supportedTab) {
    elements.hint.textContent = 'Open a supported YouTube or Jubilee page to start.';
  } else if (!isSetupComplete(model.savedConfig)) {
    elements.hint.textContent = 'Complete provider setup before starting a session.';
  } else {
    elements.hint.textContent = '';
  }

  elements.settingsHint.textContent = model.settingsMessage
    || (model.settingsDirty
      ? 'Unsaved changes.'
      : model.setupRequired
        ? 'All three keys and data-transfer consent are required.'
        : 'Changes apply to the next session.');
}

function setViewVisibility(element, visible) {
  element.hidden = !visible;
  element.inert = !visible;
}

function renderSettingsCopy() {
  const keysSaved = hasAllProviderKeys(model.savedConfig);
  if (model.setupRequired) {
    elements.settingsEyebrow.textContent = keysSaved ? 'Consent required' : 'First-time setup';
    elements.settingsTitle.textContent = keysSaved ? 'Complete setup' : 'Connect providers';
    elements.settingsIntro.textContent = keysSaved
      ? 'Your keys are saved locally. Review the data transfer and confirm consent to continue.'
      : 'Add the three keys used for transcription, analysis, and evidence search.';
    elements.saveSettingsLabel.textContent = 'Save and continue';
  } else {
    elements.settingsEyebrow.textContent = 'Local configuration';
    elements.settingsTitle.textContent = 'Settings';
    elements.settingsIntro.textContent = 'Update provider access and session preferences. Changes stay in Chrome.';
    elements.saveSettingsLabel.textContent = 'Save changes';
  }
}

function renderHomeCopy() {
  const config = model.savedConfig;
  elements.preferenceSummary.textContent = `${languageSummary(config.transcriptLanguage)} · ${modeSummary(config.analysisMode)} · ${budgetSummary(config.sessionBudgetUsd)}`;

  if (model.state === UI_STATES.STARTING) {
    elements.homeEyebrow.textContent = 'Opening live session';
    elements.homeTitle.textContent = 'Starting fact-checking';
    elements.homeDescription.textContent = 'Connecting audio capture, transcription, analysis, and evidence search.';
  } else if (model.state === UI_STATES.STOPPING) {
    elements.homeEyebrow.textContent = 'Closing live session';
    elements.homeTitle.textContent = 'Stopping fact-checking';
    elements.homeDescription.textContent = 'Finishing the current transcript and releasing audio capture.';
  } else if (hasCaptureControls()) {
    elements.homeEyebrow.textContent = 'Live on this browser';
    elements.homeTitle.textContent = model.state === UI_STATES.ERROR
      ? 'Capture needs attention'
      : 'Live fact-checking is active';
    elements.homeDescription.textContent = 'Results are updating beside the video. Stop here when you are finished.';
  } else if (!model.supportedTab) {
    elements.homeEyebrow.textContent = 'Supported video required';
    elements.homeTitle.textContent = 'Open a supported video';
    elements.homeDescription.textContent = 'InTruth works on YouTube and supported Jubilee pages.';
  } else {
    elements.homeEyebrow.textContent = 'Ready on this tab';
    elements.homeTitle.textContent = 'Ready to fact-check';
    elements.homeDescription.textContent = 'Start live transcription, factual-claim checks, and clearly marked opinions.';
  }
}

function languageSummary(language) {
  if (!language || language === 'multi') return 'Auto transcript';
  const option = [...elements.language.options].find(item => item.value === language);
  return option?.textContent || language.toUpperCase();
}

function modeSummary(mode) {
  return mode === 'balanced' ? 'Balanced' : 'Efficient';
}

function budgetSummary(rawBudget) {
  const budget = Number(rawBudget);
  return budget === 0 ? 'No cost guard' : `$${budget.toFixed(2)} guard`;
}

async function startFactChecking() {
  if (!canStart()) {
    if (!isSetupComplete(model.savedConfig)) {
      model.view = VIEW_STATES.SETTINGS;
      model.setupRequired = true;
      populateInputs(model.savedConfig);
      render();
      focusFirstIncompleteField(model.savedConfig);
    }
    return;
  }

  let startRequested = false;
  transitionTo(UI_STATES.STARTING, {
    errorMessage: '',
    captureMayBeActive: false,
  });

  try {
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
    model.setupRequired = !isSetupComplete(model.savedConfig);
    model.view = model.setupRequired ? VIEW_STATES.SETTINGS : VIEW_STATES.HOME;
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

function focusFirstIncompleteField(config = getDraftConfiguration()) {
  const candidates = [
    [elements.anthropicKey, !config.anthropicKey?.trim()],
    [elements.deepgramKey, !config.deepgramKey?.trim()],
    [elements.serperKey, !config.serperKey?.trim()],
    [elements.consent, !hasCurrentConsent(config)],
  ];
  const firstMissing = candidates.find(([, missing]) => missing);
  if (!firstMissing) return;
  if (!hasCaptureControls()) {
    model.view = VIEW_STATES.SETTINGS;
    render();
  }
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

function createTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url }, tab => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tab || null);
    });
  });
}
