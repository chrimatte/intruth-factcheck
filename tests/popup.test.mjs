import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const popupSource = await readFile(
  new URL('../realtime-factcheck/src/popup/popup.js', import.meta.url),
  'utf8'
);
const popupHtml = await readFile(
  new URL('../realtime-factcheck/src/popup/popup.html', import.meta.url),
  'utf8'
);

const CURRENT_NOTICE = '2026-07-16-v2';
const SUPPORTED_TAB = {
  id: 42,
  url: 'https://www.youtube.com/watch?v=test-video',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function eventually(predicate, message, timeoutMs = 1200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(typeof message === 'function' ? message() : message);
}

function completeConfig(overrides = {}) {
  return {
    anthropicKey: 'anthropic-test-key',
    deepgramKey: 'deepgram-test-key',
    serperKey: 'serper-test-key',
    transcriptLanguage: 'multi',
    analysisMode: 'efficient',
    sessionBudgetUsd: 0.5,
    privacyConsent: true,
    privacyConsentVersion: CURRENT_NOTICE,
    ...overrides,
  };
}

class FakeClassList {
  constructor(element) {
    this.element = element;
    this.values = new Set();
  }

  add(...names) {
    names.forEach(name => this.values.add(name));
    this.sync();
  }

  remove(...names) {
    names.forEach(name => this.values.delete(name));
    this.sync();
  }

  toggle(name, force) {
    const shouldAdd = force === undefined ? !this.values.has(name) : Boolean(force);
    if (shouldAdd) this.values.add(name);
    else this.values.delete(name);
    this.sync();
    return shouldAdd;
  }

  contains(name) {
    return this.values.has(name);
  }

  sync() {
    this.element._className = [...this.values].join(' ');
  }

  replaceFrom(value) {
    this.values = new Set(String(value).split(/\s+/).filter(Boolean));
  }
}

class FakeElement {
  constructor(id, document) {
    this.id = id;
    this.ownerDocument = document;
    this.listeners = new Map();
    this.attributes = new Map();
    this.hidden = false;
    this.inert = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.title = '';
    this.textContent = '';
    this.options = [];
    this._className = '';
    this.classList = new FakeClassList(this);
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value);
    this.classList.replaceFrom(this._className);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  async dispatch(type, detail = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...detail,
    };
    const results = [];
    for (const listener of this.listeners.get(type) || []) {
      results.push(listener(event));
    }
    await Promise.all(results);
    return event;
  }

  click() {
    return this.dispatch('click');
  }
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

function createDocument() {
  const ids = [...popupHtml.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const document = {
    activeElement: null,
    elements: new Map(),
    getElementById(id) {
      return this.elements.get(id) || null;
    },
  };

  for (const id of ids) document.elements.set(id, new FakeElement(id, document));

  document.getElementById('languageSelect').options = [
    ['multi', 'Auto · multilingual'],
    ['en', 'English'],
    ['es', 'Spanish'],
    ['fr', 'French'],
    ['de', 'German'],
    ['it', 'Italian'],
    ['pt', 'Portuguese'],
    ['nl', 'Dutch'],
    ['hi', 'Hindi'],
    ['ja', 'Japanese'],
    ['zh', 'Chinese'],
    ['ar', 'Arabic'],
    ['ko', 'Korean'],
    ['ru', 'Russian'],
    ['pl', 'Polish'],
    ['sv', 'Swedish'],
    ['tr', 'Turkish'],
  ].map(([value, textContent]) => ({ value, textContent }));

  return document;
}

function loadPopup({
  config = {},
  tab = SUPPORTED_TAB,
  status = { phase: 'IDLE', isCapturing: false },
  hooks = {},
} = {}) {
  const document = createDocument();
  const runtimeMessageEvent = createEvent();
  const state = {
    storage: clone(config),
    storageWrites: [],
    runtimeMessages: [],
    createdTabs: [],
    failNextStorageSet: false,
  };

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: runtimeMessageEvent,
      getURL(path) {
        return `chrome-extension://intruth-test/${path}`;
      },
      sendMessage(message, callback) {
        state.runtimeMessages.push(clone(message));
        let response;
        if (hooks.sendMessage) response = hooks.sendMessage(message, state);
        else if (message.type === 'GET_STATUS') response = clone(status);
        else if (message.type === 'START_FACTCHECK') response = { ok: true, sessionId: message.sessionId };
        else if (message.type === 'STOP_FACTCHECK') response = { ok: true };
        queueMicrotask(() => callback(response));
      },
    },
    storage: {
      local: {
        get(_keys, callback) {
          if (hooks.storageGet) {
            hooks.storageGet(callback, state);
            return;
          }
          queueMicrotask(() => callback(clone(state.storage)));
        },
        set(values, callback) {
          if (state.failNextStorageSet) {
            state.failNextStorageSet = false;
            queueMicrotask(() => {
              chrome.runtime.lastError = { message: 'Local storage failed' };
              callback();
              chrome.runtime.lastError = null;
            });
            return;
          }
          const snapshot = clone(values);
          Object.assign(state.storage, snapshot);
          state.storageWrites.push(snapshot);
          queueMicrotask(callback);
        },
      },
    },
    tabs: {
      query(_query, callback) {
        queueMicrotask(() => callback(tab ? [clone(tab)] : []));
      },
      create(options, callback) {
        const created = { id: 99, ...clone(options) };
        state.createdTabs.push(created);
        queueMicrotask(() => callback(created));
      },
    },
  };

  const sandbox = {
    URL,
    chrome,
    console: { error() {}, warn() {}, log() {} },
    crypto: { randomUUID: () => 'popup-session-id' },
    document,
    queueMicrotask,
    setTimeout,
    clearTimeout,
  };

  vm.createContext(sandbox);
  vm.runInContext(popupSource, sandbox, { filename: 'popup.js' });

  return {
    document,
    state,
    runtimeMessageEvent,
    element(id) {
      return document.getElementById(id);
    },
    async ready() {
      await eventually(
        () => document.getElementById('popup').getAttribute('aria-busy') === 'false',
        'popup did not finish initialization'
      );
    },
  };
}

test('incomplete provider keys select setup view and block capture', async () => {
  const popup = loadPopup({ config: completeConfig({ serperKey: '' }) });
  await popup.ready();

  assert.equal(popup.element('settingsView').hidden, false);
  assert.equal(popup.element('settingsView').inert, false);
  assert.equal(popup.element('homeView').hidden, true);
  assert.equal(popup.element('homeView').inert, true);
  assert.equal(popup.element('settingsTitle').textContent, 'Connect providers');
  assert.equal(popup.element('settingsBack').hidden, true);
  assert.equal(popup.element('saveSettingsLabel').textContent, 'Save and continue');
});

test('initialization keeps settings inert and cannot overwrite saved keys', async () => {
  let releaseStorageGet;
  const popup = loadPopup({
    config: completeConfig(),
    hooks: {
      storageGet(callback, state) {
        releaseStorageGet = () => callback(clone(state.storage));
      },
    },
  });

  assert.equal(popup.element('configForm').inert, true);
  assert.equal(popup.element('saveSettings').disabled, true);
  await popup.element('configForm').dispatch('submit');
  assert.equal(popup.state.storageWrites.length, 0);
  assert.equal(popup.state.storage.anthropicKey, 'anthropic-test-key');

  releaseStorageGet();
  await popup.ready();
  assert.equal(popup.element('homeView').hidden, false);
});

test('persisted provider keys select compact home without exposing credential fields', async () => {
  const popup = loadPopup({ config: completeConfig() });
  await popup.ready();

  assert.equal(popup.element('homeView').hidden, false);
  assert.equal(popup.element('settingsView').hidden, true);
  assert.equal(popup.element('settingsView').inert, true);
  assert.equal(popup.element('toggleBtn').disabled, false);
  assert.equal(popup.element('openSettings').hidden, false);
  assert.match(popup.element('preferenceSummary').textContent, /Auto transcript · Efficient · \$0\.50 guard/);

  const homeMarkup = popupHtml.slice(
    popupHtml.indexOf('id="homeView"'),
    popupHtml.indexOf('id="settingsView"')
  );
  assert.doesNotMatch(homeMarkup, /API key|privacyConsent|data-flow-list/);
});

test('provider settings and back use separate views and restore focus', async () => {
  const popup = loadPopup({ config: completeConfig() });
  await popup.ready();

  await popup.element('openSettings').click();
  assert.equal(popup.element('homeView').hidden, true);
  assert.equal(popup.element('settingsView').hidden, false);
  assert.equal(popup.element('settingsBack').hidden, false);
  assert.equal(popup.element('settingsTitle').textContent, 'Settings');
  assert.equal(popup.document.activeElement, popup.element('settingsTitle'));

  popup.element('anthropicKey').value = 'draft-key';
  await popup.element('anthropicKey').dispatch('input');
  assert.equal(popup.element('settingsBackLabel').textContent, 'Discard changes');

  await popup.element('settingsBack').click();
  assert.equal(popup.element('homeView').hidden, false);
  assert.equal(popup.element('settingsView').hidden, true);
  assert.equal(popup.document.activeElement, popup.element('homeTitle'));
  assert.equal(popup.element('anthropicKey').value, 'anthropic-test-key');
});

test('the third key switches to home only after an explicit successful save', async () => {
  const popup = loadPopup({ config: completeConfig({ serperKey: '' }) });
  await popup.ready();

  popup.element('serperKey').value = 'new-serper-key';
  await popup.element('serperKey').dispatch('input');
  assert.equal(popup.element('settingsView').hidden, false);
  assert.equal(popup.state.storageWrites.length, 0);

  await popup.element('configForm').dispatch('submit');
  await eventually(() => popup.element('homeView').hidden === false, 'home was not shown after save');
  assert.equal(popup.state.storage.serperKey, 'new-serper-key');
  assert.equal(popup.state.storageWrites.length, 1);
});

test('a storage failure keeps provider settings open and does not accept the draft', async () => {
  const popup = loadPopup({ config: completeConfig({ serperKey: '' }) });
  await popup.ready();

  popup.element('serperKey').value = 'unsaved-serper-key';
  popup.state.failNextStorageSet = true;
  await popup.element('configForm').dispatch('submit');
  await eventually(() => popup.element('errorNotice').hidden === false, 'storage error was not shown');

  assert.equal(popup.element('settingsView').hidden, false);
  assert.equal(popup.element('homeView').hidden, true);
  assert.equal(popup.state.storage.serperKey, '');
  assert.equal(popup.document.activeElement, popup.element('errorNotice'));
});

test('settings submit saves configuration but never dispatches START_FACTCHECK', async () => {
  const popup = loadPopup({ config: completeConfig() });
  await popup.ready();
  await popup.element('openSettings').click();

  popup.element('analysisMode').value = 'balanced';
  await popup.element('configForm').dispatch('submit');
  await eventually(() => popup.element('homeView').hidden === false, 'home was not restored');

  assert.equal(popup.state.storage.analysisMode, 'balanced');
  assert.equal(
    popup.state.runtimeMessages.filter(message => message.type === 'START_FACTCHECK').length,
    0
  );
});

test('opening the privacy notice saves the current draft before the popup loses focus', async () => {
  const popup = loadPopup({ config: completeConfig({ serperKey: '' }) });
  await popup.ready();

  popup.element('serperKey').value = 'serper-before-privacy';
  await popup.element('serperKey').dispatch('input');
  await popup.element('privacyNoticeLink').click();

  assert.equal(popup.state.storage.serperKey, 'serper-before-privacy');
  assert.deepEqual(popup.state.createdTabs.map(tab => tab.url), [
    'chrome-extension://intruth-test/src/popup/privacy.html',
  ]);
  assert.equal(
    popup.state.runtimeMessages.filter(message => message.type === 'START_FACTCHECK').length,
    0
  );
});

test('configured home preserves successful start and stop transitions', async () => {
  const popup = loadPopup({ config: completeConfig() });
  await popup.ready();

  await popup.element('toggleBtn').click();
  assert.equal(popup.element('buttonLabel').textContent, 'Stop fact-checking');
  assert.equal(popup.element('openSettings').disabled, true);
  assert.equal(
    popup.state.runtimeMessages.filter(message => message.type === 'START_FACTCHECK').length,
    1
  );

  await popup.element('toggleBtn').click();
  assert.equal(popup.element('buttonLabel').textContent, 'Start fact-checking');
  assert.equal(popup.element('openSettings').disabled, false);
  assert.equal(
    popup.state.runtimeMessages.filter(message => message.type === 'STOP_FACTCHECK').length,
    1
  );
});

test('unsupported tabs keep the compact home and settings access but disable start', async () => {
  const popup = loadPopup({
    config: completeConfig(),
    tab: { id: 42, url: 'https://example.com/video' },
  });
  await popup.ready();

  assert.equal(popup.element('homeView').hidden, false);
  assert.equal(popup.element('homeTitle').textContent, 'Open a supported video');
  assert.equal(popup.element('toggleBtn').disabled, true);
  assert.equal(popup.element('openSettings').disabled, false);
});

test('an active session overrides incomplete setup and remains stoppable', async () => {
  const popup = loadPopup({
    config: completeConfig({ serperKey: '' }),
    status: {
      phase: 'ACTIVE',
      isCapturing: true,
      sessionId: 'active-session',
      tabId: SUPPORTED_TAB.id,
    },
  });
  await popup.ready();

  assert.equal(popup.element('homeView').hidden, false);
  assert.equal(popup.element('settingsView').hidden, true);
  assert.equal(popup.element('buttonLabel').textContent, 'Stop fact-checking');

  await popup.element('toggleBtn').click();
  assert.equal(popup.element('settingsView').hidden, false);
  assert.equal(popup.element('settingsTitle').textContent, 'Connect providers');
});

test('current privacy consent is required before setup can reach home', async () => {
  const popup = loadPopup({
    config: completeConfig({ privacyConsentVersion: 'old-notice' }),
  });
  await popup.ready();

  assert.equal(popup.element('settingsView').hidden, false);
  assert.equal(popup.element('settingsTitle').textContent, 'Complete setup');
  assert.equal(popup.element('settingsEyebrow').textContent, 'Consent required');
  assert.equal(popup.element('privacyConsent').checked, false);
});
