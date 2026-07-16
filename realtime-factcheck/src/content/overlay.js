// overlay.js
// Accessible, session-aware content overlay for live fact-check results.

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MAX_TRANSCRIPT_NODES = 180;
const MAX_VISIBLE_CLAIMS = 80;
const MAX_TIMESTAMP_BUFFER = 40;
const PANEL_MARGIN = 8;

const TERMINAL_STATES = new Set([
  'TRUE',
  'SUBSTANTIALLY TRUE',
  'FALSE',
  'MISLEADING',
  'UNVERIFIABLE',
  'OPINION',
  'ERROR',
]);

let panel = null;
let panelHost = null;
let panelRoot = null;
let transcriptFeedEl = null;
let interimEl = null;
let claimFeedEl = null;
let verdictListEl = null;
let sessionStatusEl = null;
let activityEl = null;
let sessionNoticeEl = null;
let exportButtonEl = null;

let panelAbortController = null;
let panelHostObserver = null;
let panelRemovalExpected = false;
let panelRemovalHandling = false;
let overlayIntegrityFailed = false;
let panelStylesheetReady = false;
const managedTimeouts = new Set();

let mediaTimelineAbortController = null;
let mediaElementAbortController = null;
let mediaTimelineObserver = null;
let mediaTimelineRebindFrame = null;
let observedMediaElement = null;
let hasObservedMediaElement = false;
let mediaTimelineSeeking = false;
let mediaTimelineEpoch = 0;

let transcriptCollapsed = false;
let sessionIsLive = false;
let activeSessionId = null;
let legacySessionSequence = 0;
let claimSequence = 0;
let latestPipelineMetrics = null;

const claimRecords = new Map();
const claimAliases = new Map();
const claimOrder = [];
const transcriptNodes = [];
const sentenceTimestamps = [];
let lastTranscriptTimestamp = '';

// Speaker state
let speakers = [];
let lastActiveSpeaker = null;
const confirmedSpeakerMap = {};
const pendingSpeakerIds = new Set();

const SPEAKER_COLORS = [
  '#93c5fd',
  '#fca5a5',
  '#fcd34d',
  '#6ee7b7',
  '#c4b5fd',
  '#fdba74',
];
const speakerColorMap = new Map();

const SPEAKER_PARSE_NOISE = new Set([
  'debate', 'presidential', 'vp', 'vice', '2024', '2023', '2022', '2021', '2020',
  '2019', '2016', 'surrounded', 'tonight', 'live', 'full', 'official',
]);

function getSessionId(message) {
  const value = message?.sessionId ?? message?.session_id ?? message?.session?.id;
  return value === undefined || value === null || value === '' ? null : String(value);
}

function isMessageForActiveSession(message) {
  if (!sessionIsLive || !activeSessionId) return false;
  const incomingSessionId = getSessionId(message);
  if (!incomingSessionId) return activeSessionId.startsWith('legacy-');
  return incomingSessionId === activeSessionId;
}

function sendRuntimeMessage(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // The extension context can disappear during page navigation.
  }
}

function sendRuntimeRequest(message, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('The extension did not confirm the request in time.'));
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) reject(new Error(runtimeError.message));
        else if (!response?.ok) reject(new Error(response?.error?.message || response?.error || 'The request failed.'));
        else resolve(response);
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

function captureStatusShowsActive(status, sessionId) {
  if (!status || typeof status !== 'object') return false;
  const statusSessionId = getSessionId(status);
  const belongsToSession = !statusSessionId || statusSessionId === String(sessionId || '');
  if (!belongsToSession) return false;
  if (status.isCapturing === true) return true;
  const phase = String(status.phase || '').toUpperCase();
  if (phase === 'STOPPING' && status.isCapturing === false) return false;
  return phase === 'STARTING' || phase === 'ACTIVE' || phase === 'STOPPING';
}

function resultMatchesMediaTimeline(result, message = null) {
  const rawEpoch = result?.timelineEpoch ?? message?.timelineEpoch;
  const epoch = Number(rawEpoch);
  const hasEpoch = Number.isSafeInteger(epoch) && epoch >= 0;
  if (hasEpoch && epoch === mediaTimelineEpoch) return true;

  // A terminal update from an older epoch may complete a card that was already
  // shown before the user sought. Never create a new stale card after the seek.
  const claimId = explicitClaimId(result, message);
  const existing = claimId ? claimRecords.get(claimId) : null;
  if (existing) {
    const existingEpoch = Number(existing.result?.timelineEpoch);
    return hasEpoch && Number.isSafeInteger(existingEpoch) && existingEpoch === epoch;
  }
  return !hasEpoch && mediaTimelineEpoch === 0;
}

async function stopCaptureForPanelClose(sessionId) {
  try {
    await sendRuntimeRequest({ type: 'STOP_FACTCHECK', sessionId });
    return true;
  } catch (stopError) {
    try {
      const status = await sendRuntimeRequest({ type: 'GET_STATUS' }, 2500);
      if (captureStatusShowsActive(status, sessionId)) return false;
      return true;
    } catch (statusError) {
      // A missing response is not proof that capture is active. Retry the stop
      // without holding the only visible close control hostage to a lost reply.
      console.warn('[InTruth] Stop status could not be confirmed.', stopError, statusError);
      sendRuntimeMessage({ type: 'STOP_FACTCHECK', sessionId });
      return true;
    }
  }
}

function setManagedTimeout(callback, delay) {
  const timeoutId = setTimeout(() => {
    managedTimeouts.delete(timeoutId);
    callback();
  }, delay);
  managedTimeouts.add(timeoutId);
  return timeoutId;
}

function clearManagedTimeouts() {
  managedTimeouts.forEach((timeoutId) => clearTimeout(timeoutId));
  managedTimeouts.clear();
}

function hashString(value) {
  let hash = 2166136261;
  const input = String(value || 'claim');
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeClaimSignature(claim) {
  return String(claim || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function explicitClaimId(result, message = null) {
  const hasMultipleResults = Array.isArray(message?.results) && message.results.length > 1;
  const messageClaimId = hasMultipleResults ? null : message?.claimId;
  const value = result?.claimId ?? result?.claim_id ?? result?.id ?? messageClaimId;
  return value === undefined || value === null || value === '' ? null : String(value);
}

function registerClaimAliases(record, result) {
  const candidates = [result?.claim, result?._fastClaim, record?.result?.claim, record?.result?._fastClaim];
  candidates.forEach((candidate) => {
    const signature = normalizeClaimSignature(candidate);
    if (signature) claimAliases.set(signature, record.id);
  });
}

function wordSimilarity(left, right) {
  const leftWords = new Set(normalizeClaimSignature(left).split(/\s+/).filter((word) => word.length >= 4));
  const rightWords = normalizeClaimSignature(right).split(/\s+/).filter((word) => word.length >= 4);
  if (!leftWords.size || !rightWords.length) return 0;
  const overlap = rightWords.filter((word) => leftWords.has(word)).length;
  return overlap / Math.max(leftWords.size, rightWords.length);
}

function findClaimRecord(result, message = null, allowLegacyAlias = false) {
  const explicitId = explicitClaimId(result, message);
  if (explicitId && claimRecords.has(explicitId)) return claimRecords.get(explicitId);

  if (!allowLegacyAlias) return null;

  for (const candidate of [result?._fastClaim, result?.claim]) {
    const signature = normalizeClaimSignature(candidate);
    const aliasedId = signature ? claimAliases.get(signature) : null;
    if (aliasedId && claimRecords.has(aliasedId)) return claimRecords.get(aliasedId);
  }

  return null;
}

function createClaimId(result, message = null) {
  const explicitId = explicitClaimId(result, message);
  if (explicitId) return explicitId;
  const signature = normalizeClaimSignature(result?._fastClaim || result?.claim);
  const aliasedId = signature ? claimAliases.get(signature) : null;
  if (aliasedId) return aliasedId;
  return `legacy-${hashString(signature || `${Date.now()}-${claimSequence}`)}`;
}

function normalizedResultState(result, forceChecking = false) {
  const status = String(result?.status || '').toUpperCase().trim();
  const verdict = String(result?.verdict || '').toUpperCase().trim();

  if (forceChecking || result?.pending === true || status === 'CHECKING' || status === 'PENDING') return 'CHECKING';
  if (status === 'ERROR' || verdict === 'ERROR' || result?.error) return 'ERROR';
  if (status === 'OPINION' || verdict === 'OPINION') return 'OPINION';
  if (status === 'UNVERIFIABLE' || verdict === 'UNVERIFIABLE') return 'UNVERIFIABLE';
  if (TERMINAL_STATES.has(verdict)) return verdict;
  if (status === 'COMPLETE' && verdict) return verdict;
  return result?.pending === false ? 'UNVERIFIABLE' : 'CHECKING';
}

function stateClass(state) {
  const classes = {
    CHECKING: 'checking',
    TRUE: 'true',
    'SUBSTANTIALLY TRUE': 'subtrue',
    FALSE: 'false',
    MISLEADING: 'misleading',
    UNVERIFIABLE: 'unverifiable',
    OPINION: 'opinion',
    ERROR: 'error',
  };
  return classes[state] || 'unverifiable';
}

function stateLabel(state) {
  const labels = {
    CHECKING: 'Checking sources',
    TRUE: 'Supported',
    'SUBSTANTIALLY TRUE': 'Mostly supported',
    FALSE: 'Contradicted',
    MISLEADING: 'Misleading',
    UNVERIFIABLE: 'Not enough evidence',
    OPINION: 'Opinion',
    ERROR: 'Check failed',
  };
  return labels[state] || 'Not enough evidence';
}

function queueStateLabel(state) {
  const labels = {
    CHECKING: 'Checking',
    TRUE: 'Supported',
    'SUBSTANTIALLY TRUE': 'Mostly supported',
    FALSE: 'Contradicted',
    MISLEADING: 'Misleading',
    UNVERIFIABLE: 'Unverified',
    OPINION: 'Opinion',
    ERROR: 'Failed',
  };
  return labels[state] || 'Unverified';
}

function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

function safeExternalUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
}

function normalizeSources(result) {
  const citations = Array.isArray(result?.citations) ? result.citations : [];
  return (Array.isArray(result?.sources) ? result.sources : []).map((source, index) => {
    const raw = typeof source === 'string' ? { url: source } : (source || {});
    const url = String(raw.url || raw.link || '').trim();
    let domain = String(raw.domain || raw.publisher || '').trim();
    if (!domain && url) {
      try {
        domain = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        domain = '';
      }
    }

    const citation = citations.find((item) => {
      const sourceIdMatches = raw.id !== undefined && String(item?.sourceId) === String(raw.id);
      const evidenceIdMatches = raw.evidenceId !== undefined && String(item?.evidenceId) === String(raw.evidenceId);
      return sourceIdMatches || evidenceIdMatches;
    });

    return {
      id: raw.id ?? null,
      evidenceId: raw.evidenceId ?? null,
      url,
      title: String(raw.title || domain || `Source ${index + 1}`).trim(),
      domain,
      date: String(raw.date || raw.publishedAt || raw.published_at || '').trim(),
      snippet: String(raw.snippet || raw.description || raw.evidence || '').trim(),
      quote: String(citation?.quote || raw.quote || '').trim(),
    };
  });
}

function buildSourcesHTML(result) {
  const sources = normalizeSources(result);
  if (!sources.length) {
    const state = normalizedResultState(result);
    if (state === 'CHECKING' || state === 'OPINION') return '';
    return '<section class="rtfc-sources rtfc-sources--empty" aria-label="Evidence sources">' +
      '<h4>Sources reviewed</h4><p class="rtfc-source-empty">No source links were available for this result.</p>' +
    '</section>';
  }

  const items = sources.map((source, index) => {
    const href = safeExternalUrl(source.url);
    const title = source.title || source.domain || `Source ${index + 1}`;
    const titleHTML = href
      ? '<a class="rtfc-source-title" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(title) + '</a>'
      : '<span class="rtfc-source-title">' + escapeHtml(title) + '</span>';
    const meta = [source.domain, source.date].filter(Boolean).join(' · ');
    const quote = source.quote && source.quote !== source.snippet
      ? '<blockquote dir="auto">' + escapeHtml(source.quote) + '</blockquote>'
      : '';
    return '<li class="rtfc-source-item">' +
      titleHTML +
      (meta ? '<span class="rtfc-source-meta">' + escapeHtml(meta) + '</span>' : '') +
      (source.snippet ? '<p class="rtfc-source-snippet" dir="auto">' + escapeHtml(source.snippet) + '</p>' : '') +
      quote +
    '</li>';
  }).join('');

  return '<section class="rtfc-sources" aria-label="Evidence sources">' +
    '<h4>Sources reviewed</h4><ol>' + items + '</ol>' +
  '</section>';
}

function getSpeakerColor(name) {
  if (!speakerColorMap.has(name)) {
    speakerColorMap.set(name, SPEAKER_COLORS[speakerColorMap.size % SPEAKER_COLORS.length]);
  }
  return speakerColorMap.get(name);
}

function parseSpeakersFromTitle(title) {
  if (!title) return [];
  const clean = title.split('|')[0].trim();
  const roleMatch = clean.match(/(\d+)\s+([a-z]+(?:\s+[a-z]+)?)\s+(?:vs?\.?|versus)\s+(\d+)\s+([a-z]+(?:\s+[a-z]+)?)/i);
  if (roleMatch) {
    const capitalize = (value) => value.charAt(0).toUpperCase() + value.slice(1);
    return [capitalize(roleMatch[2]), capitalize(roleMatch[4])];
  }

  const nameVsGroupMatch = clean.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:vs?\.?|versus)\s+(\d+)\s+(.+)/i);
  if (nameVsGroupMatch) {
    const name = nameVsGroupMatch[1].trim().split(' ').pop();
    const groupWords = nameVsGroupMatch[3].trim().split(/\s+/);
    const group = groupWords.filter((word) => !SPEAKER_PARSE_NOISE.has(word.toLowerCase())).pop() || groupWords.pop();
    return [name, group];
  }

  const vsSplit = clean.split(/\s+(?:vs?\.?|versus|and|&)\s+/i);
  if (vsSplit.length >= 2) {
    const lastName = (part) => {
      const words = part.trim().split(/\s+/);
      for (let index = words.length - 1; index >= 0; index -= 1) {
        if (/^[A-Z]/.test(words[index]) && !SPEAKER_PARSE_NOISE.has(words[index].toLowerCase())) return words[index];
      }
      return null;
    };
    const first = lastName(vsSplit[0]);
    const second = lastName(vsSplit[1]);
    if (first && second) return [first, second];
  }

  return [];
}

function normalizeSpeakerName(name) {
  if (!name) return name;
  for (const speaker of speakers) {
    const lastName = speaker.trim().split(' ').pop().toLowerCase();
    if (name.toLowerCase() === speaker.toLowerCase()) return speaker;
    if (name.toLowerCase().includes(lastName)) return speaker;
  }
  return name;
}

function sendSpeakerMap() {
  const speakerIdToName = {};
  Object.entries(confirmedSpeakerMap).forEach(([speakerId, name]) => {
    if (name) speakerIdToName[speakerId] = name;
  });
  if (!Object.keys(speakerIdToName).length) return;
  sendRuntimeMessage({ type: 'SPEAKER_NAMES', sessionId: activeSessionId, speakerIdToName });
}

function renderSpeakerEditor() {
  const editor = panel?.querySelector('#rtfc-speaker-editor');
  if (!editor) return;
  if (!speakers.length) {
    editor.replaceChildren();
    editor.hidden = true;
    return;
  }

  editor.hidden = false;
  editor.innerHTML = speakers.map((name, index) => {
    const color = getSpeakerColor(name);
    return '<label class="rtfc-speaker-chip" style="--rtfc-speaker-color:' + escapeHtml(color) + '">' +
      '<span class="rtfc-sr-only">Speaker ' + (index + 1) + ' name</span>' +
      '<input class="rtfc-speaker-chip-input" value="' + escapeHtml(name) + '" data-idx="' + index + '" aria-label="Speaker ' + (index + 1) + ' name" />' +
    '</label>';
  }).join('');
}

function retryTagAllCards() {
  claimRecords.forEach((record) => {
    const speakerId = record.result?.dominantSpeakerId;
    if (speakerId === undefined || speakerId === null) return;
    const confirmedName = confirmedSpeakerMap[String(speakerId)];
    if (!confirmedName) return;
    const speakerName = normalizeSpeakerName(confirmedName);
    record.result.speaker = speakerName;
    if (typeof updateSessionSpeaker === 'function') updateSessionSpeaker(record.id, speakerName);
    renderClaimRecord(record);
  });
}

function showSpeakerBanner(speakerId, sample, attempt = 0, expectedSessionId = activeSessionId) {
  const id = String(speakerId);
  if (!sessionIsLive || activeSessionId !== expectedSessionId || pendingSpeakerIds.has(id) || id in confirmedSpeakerMap) return;

  if (!speakers.length) {
    if (attempt < 4) {
      setManagedTimeout(() => showSpeakerBanner(speakerId, sample, attempt + 1, expectedSessionId), 1000);
    }
    return;
  }

  pendingSpeakerIds.add(id);
  const banner = document.createElement('div');
  banner.className = 'rtfc-speaker-banner';
  banner.dataset.speakerId = id;
  banner.setAttribute('role', 'group');
  banner.setAttribute('aria-label', 'Identify a newly detected speaker');
  banner.innerHTML =
    '<p class="rtfc-speaker-banner-title">Who is speaking?</p>' +
    '<p class="rtfc-speaker-banner-text">Select the speaker for this excerpt.</p>' +
    '<blockquote dir="auto">' + escapeHtml(sample) + '</blockquote>' +
    '<div class="rtfc-speaker-banner-buttons">' +
      speakers.map((name) => '<button type="button" class="rtfc-speaker-banner-btn" data-action="confirm-speaker" data-name="' + escapeHtml(name) + '" data-id="' + escapeHtml(id) + '">' + escapeHtml(name) + '</button>').join('') +
      '<button type="button" class="rtfc-speaker-banner-btn rtfc-speaker-banner-btn--skip" data-action="confirm-speaker" data-id="' + escapeHtml(id) + '">Not sure</button>' +
    '</div>';

  const verdictsSection = panel?.querySelector('#rtfc-verdicts-section');
  verdictsSection?.insertAdjacentElement('beforebegin', banner);
}

function buildLexicalRows(lexical) {
  if (!lexical) return '';
  const rates = lexical.rates || {};
  const rows = [];
  const addRate = (label, value, example = '') => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) return;
    rows.push('<li><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(numericValue) + '%</strong>' +
      (example ? '<small>' + escapeHtml(example) + '</small>' : '') + '</li>');
  };

  addRate('Hedging language', rates.hedging, 'Examples include “I think”, “maybe”, and “probably”.');
  addRate('Certainty markers', rates.certainty, 'Examples include “definitely” and “always”.');
  addRate('Filler words', rates.filler, 'Examples include “um”, “like”, and “you know”.');
  addRate('Emotional language', rates.emotional);
  addRate('Qualifying words', rates.exclusive, 'Examples include “but” and “except”.');
  addRate('First-person singular', rates.firstPersonSg);

  if (lexical.wordsPerSecond !== null && lexical.wordsPerSecond !== undefined) {
    const rate = Number(lexical.wordsPerSecond);
    if (Number.isFinite(rate)) {
      const rateDescription = rate > 3.5 ? 'fast' : rate < 2 ? 'slow' : 'moderate';
      rows.push('<li><span>Speech rate</span><strong>' + escapeHtml(rate) + ' w/s</strong><small>' + escapeHtml(rateDescription) + ' pace</small></li>');
    }
  }

  return rows.join('');
}

function speakerTagHTML(result) {
  if (result?.dominantSpeakerId === null || result?.dominantSpeakerId === undefined) return '';
  const confirmedName = confirmedSpeakerMap[String(result.dominantSpeakerId)];
  if (!confirmedName) return '';
  const name = normalizeSpeakerName(confirmedName);
  const color = getSpeakerColor(name);
  return '<span class="rtfc-speaker-tag" style="--rtfc-speaker-color:' + escapeHtml(color) + '">' + escapeHtml(name) + '</span>';
}

function buildClaimCard(record) {
  const result = record.result;
  const state = record.state;
  const className = stateClass(state);
  const headingId = `${record.domId}-heading`;
  const markersId = `${record.domId}-markers`;
  const confidence = result.confidence ? String(result.confidence).toLowerCase() : '';
  const lexicalRows = buildLexicalRows(result.lexical);
  const showMarkers = state !== 'CHECKING' && (lexicalRows || result.speaker_confidence);

  const explanation = state === 'CHECKING'
    ? 'Comparing this claim with available sources…'
    : state === 'OPINION'
      ? (result.explanation || 'This is an opinion or interpretation, so no factual verdict applies.')
    : state === 'ERROR'
      ? (result.explanation || result.error || 'Verification could not be completed.')
      : state === 'UNVERIFIABLE'
        ? (result.explanation || 'The available evidence was not sufficient for a reliable verdict.')
        : (result.explanation || '');

  const article = document.createElement('article');
  article.className = `rtfc-verdict rtfc-verdict--${className}`;
  article.id = record.domId;
  article.dataset.claimId = record.id;
  article.dataset.state = state;
  article.dataset.speakerid = result.dominantSpeakerId === null || result.dominantSpeakerId === undefined
    ? ''
    : String(result.dominantSpeakerId);
  article.tabIndex = -1;
  article.setAttribute('aria-labelledby', headingId);
  article.innerHTML =
    '<div class="rtfc-verdict-topline">' +
      '<div class="rtfc-verdict-status">' +
        '<span class="rtfc-badge rtfc-badge--' + className + '">' + escapeHtml(stateLabel(state)) + '</span>' +
        (confidence ? '<span class="rtfc-confidence">' + escapeHtml(confidence) + ' evidence confidence</span>' : '') +
      '</div>' +
      '<time class="rtfc-timestamp">' + escapeHtml(result._timestamp || '') + '</time>' +
    '</div>' +
    speakerTagHTML(result) +
    '<h3 class="rtfc-claim" id="' + headingId + '" dir="auto">' + escapeHtml(result.claim || 'Untitled claim') + '</h3>' +
    '<p class="rtfc-explanation" dir="auto">' + escapeHtml(explanation) + '</p>' +
    (state === 'CHECKING'
      ? '<div class="rtfc-checking-lines" aria-hidden="true"><span></span><span></span><span></span></div>'
      : '') +
    (showMarkers
      ? '<div class="rtfc-markers">' +
          '<button type="button" class="rtfc-marker-toggle" aria-expanded="false" aria-controls="' + markersId + '">' +
            '<span>Speech-pattern analysis · Experimental</span><span class="rtfc-chevron" aria-hidden="true"></span>' +
          '</button>' +
          '<div class="rtfc-marker-panel" id="' + markersId + '" hidden>' +
            '<p class="rtfc-marker-disclaimer">These patterns describe delivery only. They do not indicate truthfulness or deception.</p>' +
            (result.speaker_confidence ? '<p class="rtfc-marker-model-label">Model label: ' + escapeHtml(String(result.speaker_confidence).toLowerCase()) + '</p>' : '') +
            (lexicalRows ? '<ul>' + lexicalRows + '</ul>' : '') +
          '</div>' +
        '</div>'
      : '') +
    buildSourcesHTML(result);
  article._resultData = result;
  return article;
}

function updateClaimBullet(record) {
  if (!record.bullet) return;
  record.bullet.dataset.state = record.state;
  record.bullet.className = `rtfc-claim-item rtfc-claim-item--${stateClass(record.state)}`;
  const status = record.bullet.querySelector('.rtfc-claim-state');
  if (status) status.textContent = queueStateLabel(record.state);
  const link = record.bullet.querySelector('.rtfc-claim-link');
  if (link) {
    const hasTarget = Boolean(record.card?.isConnected);
    const action = record.state === 'CHECKING'
      ? 'View verification progress'
      : record.state === 'OPINION'
        ? 'View opinion classification'
        : 'View verdict';
    link.disabled = !hasTarget;
    link.setAttribute('aria-controls', record.domId);
    link.setAttribute(
      'aria-label',
      `${action} for statement ${record.sequence}: ${record.result.claim || 'Untitled statement'}`,
    );
  }
}

function renderClaimRecord(record) {
  if (!verdictListEl) return;
  const empty = verdictListEl.querySelector('.rtfc-empty-state');
  empty?.remove();

  const expanded = record.card?.querySelector('.rtfc-marker-toggle')?.getAttribute('aria-expanded') === 'true';
  const hadFocus = record.card?.matches(':focus') === true;
  const highlightRemaining = Math.max(
    0,
    Number(record.navigationHighlightExpiresAt || 0) - Date.now(),
  );
  const newCard = buildClaimCard(record);
  if (record.card?.isConnected) record.card.replaceWith(newCard);
  else verdictListEl.prepend(newCard);
  record.card = newCard;

  if (hadFocus) newCard.focus({ preventScroll: true });
  if (highlightRemaining > 0) highlightVerdictCard(record, newCard, highlightRemaining);

  if (expanded) {
    const toggle = newCard.querySelector('.rtfc-marker-toggle');
    const details = newCard.querySelector('.rtfc-marker-panel');
    if (toggle && details) {
      toggle.setAttribute('aria-expanded', 'true');
      details.hidden = false;
    }
  }

  updateClaimBullet(record);
}

function createClaimBullet(record) {
  if (!claimFeedEl) return null;
  claimFeedEl.querySelector('.rtfc-claims-empty')?.remove();
  const item = document.createElement('li');
  item.className = 'rtfc-claim-item rtfc-claim-item--checking';
  item.dataset.claimId = record.id;
  item.dataset.state = record.state;
  item.innerHTML =
    '<button type="button" class="rtfc-claim-link" data-action="open-verdict" data-claim-id="' + escapeHtml(record.id) + '" disabled>' +
      '<span class="rtfc-claim-number" aria-hidden="true">' + record.sequence + '</span>' +
      '<span class="rtfc-claim-copy" dir="auto">' + escapeHtml(record.result.claim) + '</span>' +
      '<span class="rtfc-claim-state">' + escapeHtml(queueStateLabel(record.state)) + '</span>' +
      '<span class="rtfc-claim-open" aria-hidden="true">›</span>' +
    '</button>';
  claimFeedEl.prepend(item);
  return item;
}

function removeClaimRecord(record) {
  record.card?.remove();
  record.bullet?.remove();
  claimRecords.delete(record.id);
  for (const [alias, claimId] of claimAliases.entries()) {
    if (claimId === record.id) claimAliases.delete(alias);
  }
}

function enforceClaimCap() {
  while (claimOrder.length > MAX_VISIBLE_CLAIMS) {
    let removableIndex = claimOrder.findIndex((claimId) => isTerminalState(claimRecords.get(claimId)?.state));
    if (removableIndex < 0) removableIndex = 0;
    const [claimId] = claimOrder.splice(removableIndex, 1);
    const record = claimRecords.get(claimId);
    if (record) removeClaimRecord(record);
  }
}

function createClaimRecord(result, message = null, forceChecking = true) {
  const claimId = createClaimId(result, message);
  const existing = claimRecords.get(claimId);
  if (existing) return existing;

  claimSequence += 1;
  const state = normalizedResultState(result, forceChecking);
  const normalizedResult = {
    ...result,
    claimId,
    verdict: state,
    status: state === 'CHECKING' ? 'CHECKING' : result.status,
    pending: state === 'CHECKING',
    sources: normalizeSources(result),
  };
  const record = {
    id: claimId,
    domId: `rtfc-claim-${hashString(claimId)}`,
    sequence: claimSequence,
    state,
    result: normalizedResult,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    card: null,
    bullet: null,
  };
  claimRecords.set(claimId, record);
  claimOrder.push(claimId);
  registerClaimAliases(record, result);
  record.bullet = createClaimBullet(record);
  renderClaimRecord(record);

  if (isTerminalState(state)) logVerdict(record.result);
  enforceClaimCap();
  updateExportButton();
  return record;
}

function addCheckingClaim(result, message = null) {
  if (!explicitClaimId(result, message) && !activeSessionId?.startsWith('legacy-')) {
    console.warn('[InTruth] Ignored claim without claimId in a session-scoped message.');
    return null;
  }
  const incomingState = normalizedResultState(result);
  const forceChecking = result?.pending === true || incomingState === 'CHECKING';
  const record = createClaimRecord(result, message, forceChecking);
  if (!forceChecking && isTerminalState(incomingState)) applyClaimResult(result, message);
  return record;
}

function applyClaimResult(result, message = null) {
  if (!result?.claim && !explicitClaimId(result, message)) return null;
  const allowLegacyAlias = Boolean(activeSessionId?.startsWith('legacy-'));
  const claimId = explicitClaimId(result, message);
  if (!claimId && !allowLegacyAlias) {
    console.warn('[InTruth] Ignored claim update without claimId.');
    return null;
  }

  let record = findClaimRecord(result, message, allowLegacyAlias);
  if (!record && claimId) record = createClaimRecord(result, message, false);
  if (!record) {
    console.warn('[InTruth] Ignored legacy claim update without an exact claim alias.');
    return null;
  }

  const state = normalizedResultState(result);
  const mergedSources = normalizeSources(result);
  record.state = state;
  record.updatedAt = Date.now();
  record.result = {
    ...record.result,
    ...result,
    claimId: record.id,
    claim: result.claim || record.result.claim,
    verdict: state,
    pending: state === 'CHECKING',
    sources: mergedSources.length ? mergedSources : (record.result.sources || []),
  };
  if (record.result.dominantSpeakerId !== null && record.result.dominantSpeakerId !== undefined) {
    record.result.dominantSpeakerId = String(record.result.dominantSpeakerId);
    const confirmedName = confirmedSpeakerMap[record.result.dominantSpeakerId];
    if (confirmedName) record.result.speaker = normalizeSpeakerName(confirmedName);
  }
  if (!record.result._timestamp) record.result._timestamp = getClaimTimestamp(record.result.claim);
  registerClaimAliases(record, result);
  renderClaimRecord(record);
  if (isTerminalState(state)) logVerdict(record.result);
  updateExportButton();
  return record;
}

function updateExportButton() {
  if (!exportButtonEl) return;
  const available = typeof hasExportableSession === 'function' && hasExportableSession();
  exportButtonEl.disabled = !available;
  exportButtonEl.title = available
    ? 'Download completed statements as an HTML report'
    : 'A completed statement is required before a report can be exported';
}

function showError(message, options = {}) {
  if (!panel) return;
  panel.querySelector('.rtfc-error-toast')?.remove();

  const toast = document.createElement('div');
  toast.className = 'rtfc-error-toast';
  toast.setAttribute('role', 'alert');
  toast.innerHTML =
    '<svg class="rtfc-error-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5m0 3.5v.01M10.3 3.8 2.7 17a2 2 0 0 0 1.73 3h15.14a2 2 0 0 0 1.73-3L13.7 3.8a2 2 0 0 0-3.4 0Z"/></svg>' +
    '<span class="rtfc-error-message">' + escapeHtml(message || 'An unexpected error occurred.') + '</span>' +
    '<button type="button" class="rtfc-icon-button rtfc-error-close" aria-label="Dismiss error">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>' +
    '</button>';
  panel.querySelector('#rtfc-header')?.insertAdjacentElement('afterend', toast);

  if (!options.persistent) {
    setManagedTimeout(() => toast.isConnected && toast.remove(), options.duration || 7000);
  }
}

function formatEstimatedCost(value) {
  const cost = Number(value);
  if (!Number.isFinite(cost) || cost <= 0) return '$0.00 est.';
  if (cost < 0.01) return '<$0.01 est.';
  return `$${cost.toFixed(2)} est.`;
}

function setClaimEmptyState(title, detail) {
  const empty = claimFeedEl?.querySelector('.rtfc-claims-empty');
  if (!empty) return;
  empty.innerHTML =
    '<strong>' + escapeHtml(title) + '</strong>' +
    '<span>' + escapeHtml(detail) + '</span>';
}

function updatePipelineActivity(message) {
  if (!activityEl || !message?.metrics || typeof message.metrics !== 'object') return;
  const metrics = message.metrics;
  latestPipelineMetrics = metrics;
  if (typeof recordSessionMetricsDiagnostic === 'function') {
    recordSessionMetricsDiagnostic(metrics);
  }
  const status = String(message.status || '').toLowerCase();
  const labels = {
    listening: 'Listening for statements',
    analyzing: 'Analyzing transcript',
    extraction: 'Passage analyzed',
    no_claims: 'No statement detected',
    claims_rejected: 'Potential statement skipped',
    verification: 'Checking sources',
    verified: 'Verdict ready',
    opinion: 'Opinion identified',
    budget_reached: 'Budget reached · transcription continues',
  };
  const windows = Number(metrics.analysisWindows) || 0;
  const claims = Number(metrics.claimsDetected) || 0;
  const opinions = Math.min(claims, Number(metrics.opinionsDetected) || 0);
  const factualClaims = Math.max(0, claims - opinions);
  const mode = metrics.analysisMode === 'balanced' ? 'Balanced' : 'Efficient';
  const statementMetrics = opinions > 0
    ? `${factualClaims} claim${factualClaims === 1 ? '' : 's'} · ${opinions} opinion${opinions === 1 ? '' : 's'}`
    : `${claims} claim${claims === 1 ? '' : 's'}`;
  activityEl.innerHTML =
    '<div class="rtfc-activity-topline">' +
      '<strong>' + escapeHtml(labels[status] || 'Analysis active') + '</strong>' +
      '<span class="rtfc-activity-mode">' + escapeHtml(`${mode} mode`) + '</span>' +
    '</div>' +
    '<span class="rtfc-activity-metrics">' +
      escapeHtml(`${windows} passage${windows === 1 ? '' : 's'} · ${statementMetrics} · ${formatEstimatedCost(metrics.estimatedCostUsd)}`) +
    '</span>';

  const emptyClaims = claimFeedEl?.querySelector('.rtfc-claims-empty');
  if (emptyClaims) {
    if (status === 'budget_reached') {
      setClaimEmptyState(
        'Analysis paused',
        'The session budget was reached. Transcription continues without new claim checks.'
      );
    } else if (status === 'claims_rejected') {
      setClaimEmptyState(
        'Potential statement skipped',
        'It could not be matched reliably to the transcript.'
      );
    } else if (windows > 0) {
      setClaimEmptyState(
        'No statement detected',
        `${windows} transcript passage${windows === 1 ? '' : 's'} analyzed so far.`
      );
    }
  }
}

function panelMarkup() {
  return '<header id="rtfc-header">' +
      '<div class="rtfc-brand-lockup">' +
        '<span class="rtfc-live-dot" aria-hidden="true"></span>' +
        '<div><strong>InTruth</strong><span id="rtfc-session-status" role="status" aria-live="polite">Analysis active</span></div>' +
      '</div>' +
      '<div class="rtfc-header-actions">' +
        '<button type="button" id="rtfc-export" class="rtfc-text-button" disabled>Export report</button>' +
        '<button type="button" id="rtfc-close" class="rtfc-icon-button" aria-label="Close InTruth and stop the session">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>' +
        '</button>' +
      '</div>' +
    '</header>' +
    '<div id="rtfc-pipeline-activity" class="rtfc-pipeline-activity" role="status" aria-live="polite">' +
      '<div class="rtfc-activity-topline"><strong>Listening for statements</strong><span class="rtfc-activity-mode">Efficient mode</span></div>' +
      '<span class="rtfc-activity-metrics">0 passages · 0 claims · $0.00 est.</span>' +
    '</div>' +
    '<div id="rtfc-session-notice" class="rtfc-session-notice" role="status" hidden>' +
      '<strong>Analysis complete</strong><span>Results remain available for export.</span>' +
    '</div>' +
    '<div id="rtfc-body">' +
      '<section id="rtfc-transcript-section" class="rtfc-section" aria-labelledby="rtfc-transcript-heading">' +
        '<div class="rtfc-section-header">' +
          '<div><p class="rtfc-section-kicker">Live transcription</p><h2 id="rtfc-transcript-heading">Transcript</h2></div>' +
          '<button type="button" class="rtfc-section-toggle" id="rtfc-transcript-toggle" aria-label="Collapse transcript" aria-expanded="true" aria-controls="rtfc-transcript-content"><span class="rtfc-chevron" aria-hidden="true"></span></button>' +
        '</div>' +
        '<div id="rtfc-transcript-content">' +
          '<div id="rtfc-transcript-feed" role="log" aria-label="Live transcript" aria-live="off"></div>' +
          '<p id="rtfc-interim" dir="auto"></p>' +
        '</div>' +
      '</section>' +
      '<section id="rtfc-claims-section" class="rtfc-section" aria-labelledby="rtfc-claims-heading">' +
        '<div class="rtfc-section-header"><div><p class="rtfc-section-kicker">Statement detection</p><h2 id="rtfc-claims-heading">Statements</h2></div></div>' +
        '<ol id="rtfc-claim-feed"><li class="rtfc-claims-empty"><strong>No statements yet</strong><span>Factual claims and clearly marked opinions will appear here.</span></li></ol>' +
      '</section>' +
      '<section id="rtfc-verdicts-section" class="rtfc-section" aria-labelledby="rtfc-verdicts-heading">' +
        '<div class="rtfc-section-header rtfc-verdicts-heading-row">' +
          '<div><p class="rtfc-section-kicker">Evidence and classification</p><h2 id="rtfc-verdicts-heading">Results</h2></div>' +
          '<div id="rtfc-speaker-editor" aria-label="Speaker names" hidden></div>' +
        '</div>' +
        '<div id="rtfc-verdicts" role="log" aria-live="polite" aria-relevant="additions text">' +
          '<div class="rtfc-empty-state"><strong>No results yet</strong><span>Evidence verdicts and opinion labels will appear here.</span></div>' +
        '</div>' +
      '</section>' +
    '</div>';
}

function highlightVerdictCard(record, card, duration = 1200) {
  if (!record || !card?.isConnected) return;
  const highlightToken = {};
  record.navigationHighlightToken = highlightToken;
  card.classList.remove('rtfc-verdict--targeted');
  void card.offsetWidth;
  card.classList.add('rtfc-verdict--targeted');
  setManagedTimeout(() => {
    if (record.navigationHighlightToken !== highlightToken) return;
    card.classList.remove('rtfc-verdict--targeted');
    delete record.navigationHighlightToken;
    delete record.navigationHighlightExpiresAt;
  }, Math.max(1, duration));
}

function focusClaimVerdict(claimId) {
  const record = claimRecords.get(String(claimId || ''));
  const card = record?.card;
  const body = panel?.querySelector('#rtfc-body');
  if (!card?.isConnected || !body) return;

  const bodyRect = body.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const targetTop = Math.max(0, body.scrollTop + cardRect.top - bodyRect.top - 12);
  const reduceMotion = typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  card.focus({ preventScroll: true });
  body.scrollTo({
    top: targetTop,
    behavior: reduceMotion ? 'auto' : 'smooth',
  });

  record.navigationHighlightExpiresAt = Date.now() + 1200;
  highlightVerdictCard(record, card);
}

function installPanelEvents() {
  panelAbortController = new AbortController();
  const { signal } = panelAbortController;

  panel.addEventListener('click', async (event) => {
    const target = event.target.closest('button, a');
    if (!target || !panel.contains(target)) return;

    if (target.dataset.action === 'open-verdict') {
      focusClaimVerdict(target.dataset.claimId);
      return;
    }

    if (target.id === 'rtfc-export') {
      const result = typeof exportHTMLReport === 'function'
        ? exportHTMLReport()
        : { ok: false, error: 'HTML export is unavailable.' };
      if (!result.ok) showError(result.error);
      return;
    }

    if (target.id === 'rtfc-close') {
      if (sessionIsLive) {
        const closingPanel = panel;
        const closingSessionId = activeSessionId;
        target.disabled = true;
        target.setAttribute('aria-busy', 'true');
        if (sessionStatusEl) sessionStatusEl.textContent = 'Stopping analysis…';
        const stopped = await stopCaptureForPanelClose(closingSessionId);
        if (panel !== closingPanel) return;
        if (!stopped) {
          target.disabled = false;
          target.removeAttribute('aria-busy');
          if (sessionStatusEl) sessionStatusEl.textContent = 'Analysis active';
          showError('Audio capture is still active. Click × to retry stopping it.', {
            persistent: true,
          });
          return;
        }
        if (sessionIsLive && activeSessionId === closingSessionId) finishSession();
      }
      removePanel();
      return;
    }

    if (target.id === 'rtfc-transcript-toggle') {
      transcriptCollapsed = !transcriptCollapsed;
      const content = panel.querySelector('#rtfc-transcript-content');
      content.hidden = transcriptCollapsed;
      target.setAttribute('aria-expanded', String(!transcriptCollapsed));
      target.setAttribute('aria-label', transcriptCollapsed ? 'Expand transcript' : 'Collapse transcript');
      return;
    }

    if (target.classList.contains('rtfc-error-close')) {
      target.closest('.rtfc-error-toast')?.remove();
      return;
    }

    if (target.classList.contains('rtfc-marker-toggle')) {
      const details = panel.querySelector(`#${CSS.escape(target.getAttribute('aria-controls'))}`);
      const expanded = target.getAttribute('aria-expanded') === 'true';
      target.setAttribute('aria-expanded', String(!expanded));
      if (details) details.hidden = expanded;
      return;
    }

    if (target.dataset.action === 'confirm-speaker') {
      const speakerId = String(target.dataset.id);
      const name = target.dataset.name;
      if (name) {
        confirmedSpeakerMap[speakerId] = name;
        sendRuntimeMessage({
          type: 'SPEAKER_NAMES',
          sessionId: activeSessionId,
          speakerIdToName: { [speakerId]: name },
        });
      } else {
        confirmedSpeakerMap[speakerId] = null;
      }
      pendingSpeakerIds.delete(speakerId);
      target.closest('.rtfc-speaker-banner')?.remove();
      retryTagAllCards();
    }
  }, { signal });

  panel.addEventListener('change', (event) => {
    const input = event.target.closest('.rtfc-speaker-chip-input');
    if (!input) return;
    const index = Number.parseInt(input.dataset.idx, 10);
    if (!Number.isInteger(index) || !speakers[index]) return;
    const oldName = speakers[index];
    const newName = input.value.trim() || oldName;
    input.value = newName;
    if (newName === oldName) return;
    if (speakerColorMap.has(oldName)) {
      speakerColorMap.set(newName, speakerColorMap.get(oldName));
      speakerColorMap.delete(oldName);
    }
    speakers[index] = newName;
    Object.entries(confirmedSpeakerMap).forEach(([speakerId, confirmedName]) => {
      if (confirmedName === oldName) confirmedSpeakerMap[speakerId] = newName;
    });
    input.closest('.rtfc-speaker-chip')?.style.setProperty('--rtfc-speaker-color', getSpeakerColor(newName));
    sendSpeakerMap();
    retryTagAllCards();
  }, { signal });

  panel.addEventListener('focusin', (event) => {
    if (event.target.matches('.rtfc-speaker-chip-input')) event.target.select();
  }, { signal });
}

function makeDraggable(panelElement) {
  const header = panelElement.querySelector('#rtfc-header');
  const signal = panelAbortController.signal;
  let pointerId = null;
  let originRect = null;
  let startX = 0;
  let startY = 0;

  const clampPosition = (left, top, width, height) => {
    const maximumLeft = Math.max(PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN);
    const maximumTop = Math.max(PANEL_MARGIN, window.innerHeight - height - PANEL_MARGIN);
    return {
      left: Math.min(Math.max(PANEL_MARGIN, left), maximumLeft),
      top: Math.min(Math.max(PANEL_MARGIN, top), maximumTop),
    };
  };

  const setPanelPosition = (left, top) => {
    panelElement.dataset.positioned = 'true';
    panelElement.style.setProperty('--rtfc-panel-x', `${Math.round(left)}px`);
    panelElement.style.setProperty('--rtfc-panel-y', `${Math.round(top)}px`);
  };

  const endDrag = () => {
    const capturedPointerId = pointerId;
    pointerId = null;
    originRect = null;
    panelElement.removeAttribute('data-dragging');
    if (capturedPointerId !== null && header.hasPointerCapture(capturedPointerId)) {
      header.releasePointerCapture(capturedPointerId);
    }
  };

  header.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button, input, a')) return;
    originRect = panelElement.getBoundingClientRect();
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    setPanelPosition(originRect.left, originRect.top);
    panelElement.dataset.dragging = 'true';
    header.setPointerCapture(pointerId);
    event.preventDefault();
  }, { signal });

  header.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId || !originRect) return;
    const position = clampPosition(
      originRect.left + event.clientX - startX,
      originRect.top + event.clientY - startY,
      originRect.width,
      originRect.height,
    );
    setPanelPosition(position.left, position.top);
  }, { signal });

  header.addEventListener('pointerup', endDrag, { signal });
  header.addEventListener('pointercancel', endDrag, { signal });
  header.addEventListener('lostpointercapture', endDrag, { signal });

  window.addEventListener('resize', () => {
    const rect = panelElement.getBoundingClientRect();
    const position = clampPosition(rect.left, rect.top, rect.width, rect.height);
    setPanelPosition(position.left, position.top);
  }, { signal });
}

function rectIntersectsViewport(rect, viewportWidth, viewportHeight) {
  return rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < viewportWidth &&
    rect.top < viewportHeight;
}

function renderedStyleIsVisible(style) {
  const opacity = Number.parseFloat(style.opacity);
  const contentVisibility = style.contentVisibility || style.getPropertyValue('content-visibility');
  return style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.visibility !== 'collapse' &&
    contentVisibility !== 'hidden' &&
    (!Number.isFinite(opacity) || opacity > 0.05);
}

function isOverlayHealthy() {
  if (
    !panelStylesheetReady ||
    overlayIntegrityFailed ||
    !panelHost?.isConnected ||
    !panel?.isConnected
  ) return false;

  const viewportWidth = Math.max(0, window.innerWidth || document.documentElement?.clientWidth || 0);
  const viewportHeight = Math.max(0, window.innerHeight || document.documentElement?.clientHeight || 0);
  if (!viewportWidth || !viewportHeight) return false;

  const hostStyle = window.getComputedStyle(panelHost);
  const panelStyle = window.getComputedStyle(panel);
  if (!renderedStyleIsVisible(hostStyle) || !renderedStyleIsVisible(panelStyle)) return false;
  if (hostStyle.pointerEvents !== 'none' || panelStyle.pointerEvents === 'none') return false;

  const hostRect = panelHost.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const expectedPanelWidth = Math.min(380, Math.max(0, viewportWidth - 24));
  return rectIntersectsViewport(hostRect, viewportWidth, viewportHeight) &&
    rectIntersectsViewport(panelRect, viewportWidth, viewportHeight) &&
    hostRect.width >= viewportWidth * 0.5 &&
    hostRect.height >= viewportHeight * 0.5 &&
    panelRect.width >= expectedPanelWidth * 0.5;
}

async function stopForOverlayIntegrityFailure(message, options = {}) {
  if (
    panelRemovalExpected ||
    panelRemovalHandling ||
    !sessionIsLive
  ) return;

  panelRemovalHandling = true;
  overlayIntegrityFailed = true;
  const affectedSessionId = activeSessionId;

  if (options.reattachHost && panelHost && !panelHost.isConnected) {
    // A host page may replace its body during navigation. Reattach once so the
    // stop state remains visible, but never consider this session healthy again.
    try {
      document.documentElement?.appendChild(panelHost);
    } catch {
      // The background watchdog independently treats the failed PING as fatal.
    }
  }

  if (sessionStatusEl) sessionStatusEl.textContent = 'Stopping analysis…';
  if (panel?.isConnected) showError(message, { persistent: true });

  try {
    await sendRuntimeRequest({ type: 'STOP_FACTCHECK', sessionId: affectedSessionId }, 5000);
    if (sessionIsLive && activeSessionId === affectedSessionId) finishSession();
  } catch {
    // The background watchdog will also fail because PING reports this overlay
    // as unhealthy. Keeping the visible error avoids claiming a successful stop.
  } finally {
    if (!sessionIsLive || activeSessionId === affectedSessionId) panelRemovalHandling = false;
  }
}

function handleUnexpectedPanelRemoval() {
  if (!panelHost || panelHost.isConnected) return;
  return stopForOverlayIntegrityFailure(
    'The page removed the InTruth safety panel. Audio capture is being stopped automatically.',
    { reattachHost: true },
  );
}

function observePanelHost() {
  panelHostObserver?.disconnect();
  panelHostObserver = new MutationObserver((mutations) => {
    if (!panelHost?.isConnected) {
      void handleUnexpectedPanelRemoval();
      return;
    }

    const hostAttributeChanged = mutations.some((mutation) =>
      mutation.type === 'attributes' && mutation.target === panelHost
    );
    if (hostAttributeChanged) {
      void stopForOverlayIntegrityFailure(
        'The page changed the InTruth safety panel. Audio capture is being stopped automatically.',
      );
      return;
    }

    if (panelStylesheetReady && !isOverlayHealthy()) {
      void stopForOverlayIntegrityFailure(
        'The InTruth safety panel is no longer visible. Audio capture is being stopped automatically.',
      );
    }
  });
  if (document.documentElement) {
    panelHostObserver.observe(document.documentElement, { childList: true });
  }
  if (panelHost) {
    panelHostObserver.observe(panelHost, {
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden'],
    });
  }
}

function createPanel() {
  if (panel) return;

  panelStylesheetReady = false;
  panelHost = document.createElement('div');
  panelHost.id = 'intruth-extension-root';
  panelHost.style.setProperty('all', 'initial', 'important');
  panelHost.style.setProperty('position', 'fixed', 'important');
  panelHost.style.setProperty('inset', '0', 'important');
  panelHost.style.setProperty('display', 'block', 'important');
  panelHost.style.setProperty('pointer-events', 'none', 'important');
  panelHost.style.setProperty('z-index', '2147483647', 'important');

  panelRoot = panelHost.attachShadow({ mode: 'closed' });
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = chrome.runtime.getURL('src/content/overlay.css');
  const stylesheetHost = panelHost;
  stylesheet.addEventListener('load', () => {
    if (panelHost !== stylesheetHost) return;
    panelStylesheetReady = true;
    if (!isOverlayHealthy()) {
      void stopForOverlayIntegrityFailure(
        'The InTruth safety panel could not be displayed safely. Audio capture is being stopped automatically.',
      );
    }
  }, { once: true });
  stylesheet.addEventListener('error', () => {
    if (panelHost !== stylesheetHost) return;
    panelStylesheetReady = false;
    void stopForOverlayIntegrityFailure(
      'InTruth could not load its safety interface. Audio capture is being stopped automatically.',
    );
  }, { once: true });

  panel = document.createElement('aside');
  panel.id = 'rtfc-panel';
  panel.setAttribute('aria-label', 'InTruth live fact-check');
  panel.dataset.sessionState = 'live';
  panel.style.setProperty('pointer-events', 'auto');
  panel.innerHTML = panelMarkup();
  panelRoot.append(stylesheet, panel);
  document.documentElement.appendChild(panelHost);
  observePanelHost();

  transcriptFeedEl = panel.querySelector('#rtfc-transcript-feed');
  interimEl = panel.querySelector('#rtfc-interim');
  claimFeedEl = panel.querySelector('#rtfc-claim-feed');
  verdictListEl = panel.querySelector('#rtfc-verdicts');
  sessionStatusEl = panel.querySelector('#rtfc-session-status');
  activityEl = panel.querySelector('#rtfc-pipeline-activity');
  sessionNoticeEl = panel.querySelector('#rtfc-session-notice');
  exportButtonEl = panel.querySelector('#rtfc-export');

  installPanelEvents();
  makeDraggable(panel);
  updateExportButton();
}

function clearOverlayState() {
  claimRecords.clear();
  claimAliases.clear();
  claimOrder.length = 0;
  transcriptNodes.length = 0;
  sentenceTimestamps.length = 0;
  claimSequence = 0;
  latestPipelineMetrics = null;
  transcriptCollapsed = false;
  lastTranscriptTimestamp = '';
  lastActiveSpeaker = null;
  speakers = [];
  speakerColorMap.clear();
  pendingSpeakerIds.clear();
  Object.keys(confirmedSpeakerMap).forEach((key) => delete confirmedSpeakerMap[key]);
}

function removePanel() {
  panelRemovalExpected = true;
  teardownMediaTimelineEvents();
  panelHostObserver?.disconnect();
  panelHostObserver = null;
  clearManagedTimeouts();
  panelAbortController?.abort();
  panelAbortController = null;
  panelHost?.remove();
  panel = null;
  panelHost = null;
  panelRoot = null;
  transcriptFeedEl = null;
  interimEl = null;
  claimFeedEl = null;
  verdictListEl = null;
  sessionStatusEl = null;
  activityEl = null;
  sessionNoticeEl = null;
  exportButtonEl = null;
  sessionIsLive = false;
  activeSessionId = null;
  overlayIntegrityFailed = false;
  panelStylesheetReady = false;
  panelRemovalHandling = false;
  clearOverlayState();
  panelRemovalExpected = false;
}

function finishSession() {
  if (!panel || !sessionIsLive) return;
  teardownMediaTimelineEvents();
  clearManagedTimeouts();

  for (const record of claimRecords.values()) {
    if (record.state !== 'CHECKING') continue;
    applyClaimResult({
      ...record.result,
      claimId: record.id,
      status: 'ERROR',
      verdict: 'ERROR',
      pending: false,
      explanation: 'Verification stopped before this claim could be completed.',
    });
  }

  sessionIsLive = false;
  stopSession();
  panel.dataset.sessionState = 'ended';
  sessionStatusEl.textContent = 'Analysis complete';
  const hasResults = typeof hasExportableSession === 'function' && hasExportableSession();
  const noticeCopy = sessionNoticeEl.querySelector('span');
  if (noticeCopy) {
    noticeCopy.textContent = hasResults
      ? 'Completed results remain available for export.'
      : 'No completed statements are available to export.';
  }
  sessionNoticeEl.hidden = false;
  panel.querySelector('#rtfc-close')?.setAttribute('aria-label', 'Close InTruth');
  panel.querySelectorAll('.rtfc-speaker-banner').forEach((banner) => banner.remove());
  panel.querySelectorAll('.rtfc-speaker-chip-input').forEach((input) => {
    input.disabled = true;
  });
  clearInterim();
  updateExportButton();
}

function beginSession(message) {
  if (panel) {
    if (sessionIsLive) finishSession();
    removePanel();
  }

  const incomingSessionId = getSessionId(message);
  legacySessionSequence += 1;
  activeSessionId = incomingSessionId || `legacy-${Date.now()}-${legacySessionSequence}`;
  sessionIsLive = true;
  overlayIntegrityFailed = false;
  clearOverlayState();
  startSession(activeSessionId);
  createPanel();
  installMediaTimelineEvents();

  speakers = parseSpeakersFromTitle(document.title || '');
  renderSpeakerEditor();
  sendRuntimeMessage({
    type: 'PAGE_TITLE',
    sessionId: activeSessionId,
    title: document.title || '',
    date: (() => {
      const element = document.querySelector('meta[itemprop="uploadDate"]') ||
        document.querySelector('meta[property="og:updated_time"]');
      if (!element?.content) return '';
      const date = new Date(element.content);
      // Keep the machine-readable value locale independent. The worker compares
      // evidence publication dates against the video date; localized strings such
      // as "16 luglio 2026" are not reliably understood by Date.parse().
      return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
    })(),
  });
}

function addTranscriptText(text) {
  if (!transcriptFeedEl || !text) return;
  const span = document.createElement('span');
  span.textContent = `${text} `;
  span.className = 'rtfc-transcript-word';
  span.dir = 'auto';
  transcriptFeedEl.appendChild(span);
  transcriptNodes.push(span);

  while (transcriptNodes.length > MAX_TRANSCRIPT_NODES) transcriptNodes.shift()?.remove();
  transcriptFeedEl.scrollTop = transcriptFeedEl.scrollHeight;
}

function updateInterim(text) {
  if (interimEl) interimEl.textContent = text || '';
}

function clearInterim() {
  if (interimEl) interimEl.textContent = '';
}

function resetMediaTimelineBoundary() {
  clearInterim();
  sentenceTimestamps.length = 0;
  lastTranscriptTimestamp = '';
  lastActiveSpeaker = null;
}

function sendMediaTimelineEvent(phase, video, reason) {
  if (!sessionIsLive || !activeSessionId || !video) return;
  const rawCurrentTime = Number(video.currentTime);
  const rawPlaybackRate = Number(video.playbackRate);
  sendRuntimeMessage({
    type: 'MEDIA_TIMELINE_EVENT',
    sessionId: activeSessionId,
    phase,
    epoch: mediaTimelineEpoch,
    currentTime: Number.isFinite(rawCurrentTime) && rawCurrentTime >= 0 ? rawCurrentTime : 0,
    paused: Boolean(video.paused),
    playbackRate: Number.isFinite(rawPlaybackRate) && rawPlaybackRate > 0 ? rawPlaybackRate : 1,
    reason,
  });
}

function beginMediaTimelineBoundary(video, reason) {
  mediaTimelineEpoch += 1;
  mediaTimelineSeeking = true;
  resetMediaTimelineBoundary();
  if (typeof recordTimelineDiagnostic === 'function') {
    recordTimelineDiagnostic(mediaTimelineEpoch, {
      phase: 'seeking',
      reason,
      currentTime: Number(video?.currentTime),
    });
  }
  sendMediaTimelineEvent('seeking', video, reason);
}

function completeMediaTimelineBoundary(video, reason) {
  if (!mediaTimelineSeeking) beginMediaTimelineBoundary(video, reason);
  mediaTimelineSeeking = false;
  sendMediaTimelineEvent('seeked', video, reason);
}

function bindMediaTimelineElement(video) {
  const nextVideo = video || null;
  if (nextVideo === observedMediaElement && mediaElementAbortController) return;

  const isReplacement = Boolean(
    nextVideo && hasObservedMediaElement && nextVideo !== observedMediaElement
  );
  mediaElementAbortController?.abort();
  mediaElementAbortController = null;
  observedMediaElement = nextVideo;
  if (!nextVideo) return;

  const expectedSessionId = activeSessionId;
  mediaElementAbortController = new AbortController();
  const { signal } = mediaElementAbortController;
  nextVideo.addEventListener('seeking', () => {
    if (
      !sessionIsLive ||
      activeSessionId !== expectedSessionId ||
      observedMediaElement !== nextVideo
    ) return;
    beginMediaTimelineBoundary(nextVideo, 'user_seek');
  }, { signal });
  nextVideo.addEventListener('seeked', () => {
    if (
      !sessionIsLive ||
      activeSessionId !== expectedSessionId ||
      observedMediaElement !== nextVideo
    ) return;
    completeMediaTimelineBoundary(nextVideo, 'user_seek');
  }, { signal });
  nextVideo.addEventListener('pause', () => {
    if (
      !sessionIsLive ||
      activeSessionId !== expectedSessionId ||
      observedMediaElement !== nextVideo
    ) return;
    sendMediaTimelineEvent('paused', nextVideo, 'playback_state');
  }, { signal });
  nextVideo.addEventListener('play', () => {
    if (
      !sessionIsLive ||
      activeSessionId !== expectedSessionId ||
      observedMediaElement !== nextVideo
    ) return;
    sendMediaTimelineEvent('playing', nextVideo, 'playback_state');
  }, { signal });

  if (isReplacement) {
    beginMediaTimelineBoundary(nextVideo, 'media_replaced');
    completeMediaTimelineBoundary(nextVideo, 'media_replaced');
  }
  hasObservedMediaElement = true;
  sendMediaTimelineEvent(nextVideo.paused ? 'paused' : 'playing', nextVideo, 'media_bound');
}

function findMediaElement() {
  return document.querySelector('#movie_player video.html5-main-video') ||
    document.querySelector('video');
}

function scheduleMediaTimelineRebind() {
  if (mediaTimelineRebindFrame !== null || !sessionIsLive) return;
  mediaTimelineRebindFrame = window.requestAnimationFrame(() => {
    mediaTimelineRebindFrame = null;
    if (!sessionIsLive) return;
    bindMediaTimelineElement(findMediaElement());
  });
}

function mutationContainsMediaElement(mutation) {
  const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
  return nodes.some((node) =>
    node?.nodeType === Node.ELEMENT_NODE &&
    (node.matches?.('video') || node.querySelector?.('video'))
  );
}

function installMediaTimelineEvents() {
  teardownMediaTimelineEvents();
  if (!sessionIsLive || !activeSessionId) return;

  mediaTimelineAbortController = new AbortController();
  document.addEventListener('yt-navigate-finish', scheduleMediaTimelineRebind, {
    signal: mediaTimelineAbortController.signal,
  });
  bindMediaTimelineElement(findMediaElement());

  mediaTimelineObserver = new MutationObserver((mutations) => {
    if (!observedMediaElement?.isConnected || mutations.some(mutationContainsMediaElement)) {
      scheduleMediaTimelineRebind();
    }
  });
  if (document.documentElement) {
    mediaTimelineObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
}

function teardownMediaTimelineEvents() {
  mediaTimelineObserver?.disconnect();
  mediaTimelineObserver = null;
  mediaTimelineAbortController?.abort();
  mediaTimelineAbortController = null;
  mediaElementAbortController?.abort();
  mediaElementAbortController = null;
  if (mediaTimelineRebindFrame !== null) {
    window.cancelAnimationFrame(mediaTimelineRebindFrame);
    mediaTimelineRebindFrame = null;
  }
  observedMediaElement = null;
  hasObservedMediaElement = false;
  mediaTimelineSeeking = false;
  mediaTimelineEpoch = 0;
}

function estimateUtteranceStartSeconds(currentTime, duration, playbackRate) {
  const current = Number(currentTime);
  const safeCurrent = Number.isFinite(current) && current >= 0 ? current : 0;
  const utteranceDuration = Number(duration);
  if (!Number.isFinite(utteranceDuration) || utteranceDuration <= 0) return safeCurrent;
  const rate = Number(playbackRate);
  const safeRate = Number.isFinite(rate) && rate >= 0 ? rate : 1;
  return Math.max(0, safeCurrent - utteranceDuration * safeRate);
}

function formatVideoTimestamp(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getVideoTimestamp(message = null) {
  const video = findMediaElement();
  if (!video) return '';
  const timestamp = message
    ? estimateUtteranceStartSeconds(video.currentTime, message.duration, video.playbackRate)
    : video.currentTime;
  return formatVideoTimestamp(timestamp);
}

function getClaimTimestamp(claim) {
  if (!sentenceTimestamps.length) return lastTranscriptTimestamp || getVideoTimestamp();
  let bestMatch = null;
  let bestScore = 0;
  for (const entry of sentenceTimestamps) {
    const score = wordSimilarity(claim, entry.text);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry;
    }
  }
  return bestScore >= 0.3 && bestMatch
    ? bestMatch.timestamp
    : (lastTranscriptTimestamp || getVideoTimestamp());
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'PING') {
    const overlayIsHealthy = Boolean(sessionIsLive && isOverlayHealthy());
    sendResponse({
      ok: !sessionIsLive || overlayIsHealthy,
      type: 'PONG',
      requestId: message.requestId,
      sessionId: activeSessionId,
      isActive: overlayIsHealthy,
      ...(!sessionIsLive || overlayIsHealthy
        ? {}
        : { error: 'The InTruth overlay failed its integrity check.' }),
    });
    return false;
  }

  if (message?.type === 'START_FACTCHECK') {
    beginSession(message);
    return false;
  }

  if (message?.type === 'STOP_FACTCHECK') {
    const incomingSessionId = getSessionId(message);
    const isLegacyStop = !incomingSessionId && activeSessionId?.startsWith('legacy-');
    if (incomingSessionId === activeSessionId || isLegacyStop) finishSession();
    return false;
  }

  if (!isMessageForActiveSession(message)) return false;

  switch (message.type) {
    case 'TRANSCRIPT_RESULT':
      if (mediaTimelineSeeking || !resultMatchesMediaTimeline(message, message)) break;
      if (message.interim) {
        updateInterim(message.text);
      } else if (message.isFinal) {
        const timestamp = getVideoTimestamp(message);
        lastTranscriptTimestamp = timestamp;
        sentenceTimestamps.push({ text: message.text || '', timestamp });
        if (sentenceTimestamps.length > MAX_TIMESTAMP_BUFFER) sentenceTimestamps.shift();
        if (typeof recordTranscriptDiagnostic === 'function') {
          recordTranscriptDiagnostic(message.text, timestamp, message.timelineEpoch);
        }
        clearInterim();
        const displayText = String(message.text || '').replace(/^\[.*?\]\s*/, '');
        addTranscriptText(displayText);
        const labelMatch = String(message.text || '').match(/^\[(.+?)\]/);
        if (labelMatch && speakers.includes(labelMatch[1])) lastActiveSpeaker = labelMatch[1];
      }
      break;

    case 'NEW_SPEAKER':
      showSpeakerBanner(message.speakerId, message.sample || '');
      break;

    case 'PIPELINE_ERROR':
      if (typeof recordCaptureDiagnostic === 'function' && !message.claimId) {
        recordCaptureDiagnostic(
          message.code === 'AUDIO_CAPTURE_STALLED' ? 'audio_capture_stalled' : 'warning',
          {
            ...message,
            timelineEpoch: message.timelineEpoch ?? mediaTimelineEpoch,
            currentTime: message.currentTime ?? Number(observedMediaElement?.currentTime),
          }
        );
      }
      if (message.claimId) {
        applyClaimResult({
          claimId: message.claimId,
          claim: message.claim,
          status: 'ERROR',
          verdict: 'ERROR',
          pending: false,
          explanation: message.message || 'Verification could not be completed.',
        }, message);
      } else {
        showError(message.message || 'The fact-checking pipeline reported an error.', { persistent: true });
      }
      break;

    case 'PIPELINE_STATUS': {
      const status = String(message.status || '').toLowerCase();
      if (typeof recordCaptureDiagnostic === 'function') {
        recordCaptureDiagnostic(status, {
          ...message,
          timelineEpoch: message.timelineEpoch ?? mediaTimelineEpoch,
          currentTime: message.currentTime ?? Number(observedMediaElement?.currentTime),
        });
      }
      if (status === 'listening' || status === 'backpressure_recovered') {
        panel.querySelector('.rtfc-error-toast')?.remove();
        panel.dataset.sessionState = 'live';
        sessionStatusEl.textContent = 'Analysis active';
      } else if (status === 'backpressure') {
        sessionStatusEl.textContent = 'Processing delayed';
        showError('Audio processing is catching up. The live transcript may be briefly delayed.', { persistent: true });
      }
      break;
    }

    case 'PIPELINE_ACTIVITY':
      updatePipelineActivity(message);
      break;

    case 'NEW_CLAIM':
    case 'NEW_VERDICT': {
      const results = Array.isArray(message.results) ? message.results : (message.result ? [message.result] : []);
      results
        .filter(result => resultMatchesMediaTimeline(result, message))
        .forEach((result) => addCheckingClaim(result, message));
      break;
    }

    case 'CLAIM_RESULT':
    case 'CLAIM_STATUS':
    case 'UPDATE_VERDICT':
    case 'UPDATE_VERDICTS': {
      const results = Array.isArray(message.results) ? message.results : (message.result ? [message.result] : []);
      results
        .filter(result => resultMatchesMediaTimeline(result, message))
        .forEach((result) => applyClaimResult(result, message));
      break;
    }

    case 'CLAIM_UNVERIFIABLE':
      applyClaimResult({
        ...(message.result || {}),
        claimId: message.claimId ?? message.result?.claimId,
        claim: message.claim ?? message.result?.claim,
        status: 'UNVERIFIABLE',
        verdict: 'UNVERIFIABLE',
        pending: false,
        explanation: message.message || message.result?.explanation,
      }, message);
      break;

    case 'CLAIM_ERROR':
      applyClaimResult({
        ...(message.result || {}),
        claimId: message.claimId ?? message.result?.claimId,
        claim: message.claim ?? message.result?.claim,
        status: 'ERROR',
        verdict: 'ERROR',
        pending: false,
        explanation: message.message || message.result?.explanation,
      }, message);
      break;
  }

  return false;
});
