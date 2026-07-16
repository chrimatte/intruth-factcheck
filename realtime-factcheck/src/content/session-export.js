// session-export.js
// Keeps a bounded session history and exports a self-contained HTML report.

const sessionLog = [];
const sessionLogIndex = new Map();
const MAX_SESSION_LOG_ENTRIES = 250;
const MAX_SOURCE_SENTENCE_IDS = 6;
const MAX_SOURCE_QUOTES_PER_CLAIM = 6;
const MAX_SOURCE_QUOTE_CHARS = 600;
const MAX_DIAGNOSTIC_EVENTS = 40;

let sessionStartTime = null;
let sessionStoppedAt = null;
let sessionIdentifier = null;
let sessionDiagnostics = createSessionDiagnostics();

function createSessionDiagnostics() {
  return {
    transcriptSegments: 0,
    transcriptCharacters: 0,
    firstMediaTimestamp: '',
    lastMediaTimestamp: '',
    timelineChanges: 0,
    latestTimelineEpoch: 0,
    transcriptionReconnects: 0,
    droppedAudioFrames: 0,
    recoveryWarnings: 0,
    analysisWindows: 0,
    events: [],
  };
}

function normalizeTimelineEpoch(value) {
  const epoch = Number(value);
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null;
}

function normalizeDiagnosticCode(value, fallback = 'UNKNOWN') {
  const code = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 80);
  return code || fallback;
}

function diagnosticMediaTime(details = {}) {
  const explicitTimestamp = String(
    details.mediaTimestamp || details.videoTimestamp || ''
  ).trim();
  if (explicitTimestamp && parseVideoTimestamp(explicitTimestamp) !== null) {
    return explicitTimestamp.slice(0, 16);
  }
  const currentTime = Number(details.currentTime ?? details.mediaTime);
  return Number.isFinite(currentTime) && currentTime >= 0
    ? formatElapsed(Math.floor(currentTime))
    : '';
}

function appendDiagnosticEvent(kind, code, details = {}) {
  const suppliedEpoch = normalizeTimelineEpoch(details.timelineEpoch ?? details.epoch);
  const timelineEpoch = suppliedEpoch ?? sessionDiagnostics.latestTimelineEpoch;
  sessionDiagnostics.events.push({
    kind: normalizeDiagnosticCode(kind, 'STATUS').toLocaleLowerCase(),
    code: normalizeDiagnosticCode(code),
    timelineEpoch,
    mediaTime: diagnosticMediaTime(details),
  });
  if (sessionDiagnostics.events.length > MAX_DIAGNOSTIC_EVENTS) {
    sessionDiagnostics.events.splice(
      0,
      sessionDiagnostics.events.length - MAX_DIAGNOSTIC_EVENTS
    );
  }
}

function recordTranscriptDiagnostic(text, mediaTimestamp, timelineEpoch = 0) {
  const transcriptText = String(text || '');
  if (!transcriptText) return;
  sessionDiagnostics.transcriptSegments++;
  sessionDiagnostics.transcriptCharacters += transcriptText.length;
  const timestamp = String(mediaTimestamp || '').trim();
  if (timestamp) {
    if (!sessionDiagnostics.firstMediaTimestamp) sessionDiagnostics.firstMediaTimestamp = timestamp;
    sessionDiagnostics.lastMediaTimestamp = timestamp;
  }
  const epoch = Number(timelineEpoch);
  if (Number.isSafeInteger(epoch) && epoch >= 0) {
    sessionDiagnostics.latestTimelineEpoch = Math.max(sessionDiagnostics.latestTimelineEpoch, epoch);
  }
}

function recordTimelineDiagnostic(timelineEpoch, details = {}) {
  sessionDiagnostics.timelineChanges++;
  const epoch = normalizeTimelineEpoch(timelineEpoch);
  if (epoch !== null) {
    sessionDiagnostics.latestTimelineEpoch = Math.max(sessionDiagnostics.latestTimelineEpoch, epoch);
  }
  const normalizedDetails = details && typeof details === 'object' ? details : {};
  appendDiagnosticEvent('timeline', normalizedDetails.phase || 'timeline_change', {
    ...normalizedDetails,
    timelineEpoch: epoch ?? sessionDiagnostics.latestTimelineEpoch,
  });
}

function recordCaptureDiagnostic(status, details = {}) {
  const normalizedStatus = String(status || '').toLocaleLowerCase();
  if (normalizedStatus === 'transcription_reconnected') sessionDiagnostics.transcriptionReconnects++;
  if (normalizedStatus === 'warning' || normalizedStatus === 'audio_capture_stalled') {
    sessionDiagnostics.recoveryWarnings++;
  }
  const droppedFrames = Number(details.droppedFrames);
  if (Number.isFinite(droppedFrames) && droppedFrames >= 0) {
    sessionDiagnostics.droppedAudioFrames = Math.max(
      sessionDiagnostics.droppedAudioFrames,
      Math.floor(droppedFrames)
    );
  }
  const epoch = normalizeTimelineEpoch(details.timelineEpoch ?? details.epoch);
  if (epoch !== null) {
    sessionDiagnostics.latestTimelineEpoch = Math.max(sessionDiagnostics.latestTimelineEpoch, epoch);
  }
  appendDiagnosticEvent(
    details.code || details.errorCode ? 'error' : 'status',
    details.code || details.errorCode || normalizedStatus,
    details
  );
}

function recordSessionMetricsDiagnostic(metrics) {
  const windows = Number(metrics?.analysisWindows);
  if (Number.isFinite(windows) && windows >= 0) {
    sessionDiagnostics.analysisWindows = Math.max(
      sessionDiagnostics.analysisWindows,
      Math.floor(windows)
    );
  }
}

function normalizeSessionKey(result) {
  if (result?.claimId !== undefined && result?.claimId !== null) return String(result.claimId);
  if (result?.id !== undefined && result?.id !== null) return String(result.id);
  const normalizedClaim = String(result?.claim || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `legacy:${normalizedClaim}`;
}

function normalizeSourceSentenceIds(result, sourceQuotes = []) {
  const candidates = [
    ...(Array.isArray(result?.sourceSentenceIds) ? result.sourceSentenceIds : []),
    ...sourceQuotes.map(sourceQuote => sourceQuote.sourceSentenceId),
  ];
  const seen = new Set();
  const ids = [];
  for (const candidate of candidates) {
    const id = String(candidate || '').trim().slice(0, 80);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_SOURCE_SENTENCE_IDS) break;
  }
  return ids;
}

function normalizeSourceQuotes(result) {
  const quotes = [];
  const seen = new Set();
  for (const rawSource of Array.isArray(result?.sourceQuotes) ? result.sourceQuotes : []) {
    const sourceSentenceId = String(rawSource?.sourceSentenceId || '').trim().slice(0, 80);
    const quote = String(rawSource?.quote || '').trim().slice(0, MAX_SOURCE_QUOTE_CHARS);
    const key = `${sourceSentenceId}\u0000${quote}`;
    if (!sourceSentenceId || !quote || seen.has(key)) continue;
    seen.add(key);
    quotes.push({ sourceSentenceId, quote });
    if (quotes.length >= MAX_SOURCE_QUOTES_PER_CLAIM) break;
  }
  return quotes;
}

function normalizeExportSource(source, index) {
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

  return {
    url,
    title: String(raw.title || domain || `Source ${index + 1}`).trim(),
    domain,
    date: String(raw.date || raw.publishedAt || raw.published_at || '').trim(),
    snippet: String(raw.snippet || raw.description || raw.evidence || '').trim(),
    quote: String(raw.quote || '').trim(),
  };
}

function safeReportHref(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
}

function rebuildSessionIndex() {
  sessionLogIndex.clear();
  sessionLog.forEach((entry, index) => sessionLogIndex.set(entry.claimId, index));
}

function logVerdict(result) {
  if (!result?.claim) return;

  const status = String(result.status || '').toUpperCase();
  const verdict = String(result.verdict || '').toUpperCase();
  const state = status === 'ERROR' || status === 'UNVERIFIABLE' || status === 'CHECKING'
    ? status
    : (verdict || status);
  if (result.pending || state === 'CHECKING') return;

  const claimId = normalizeSessionKey(result);
  const existingIndex = sessionLogIndex.get(claimId);
  const sourceQuotes = normalizeSourceQuotes(result);
  const entry = {
    claimId,
    sessionId: sessionIdentifier,
    timestamp: new Date().toISOString(),
    secondsElapsed: sessionStartTime ? Math.round((Date.now() - sessionStartTime) / 1000) : 0,
    videoTimestamp: String(result._timestamp || ''),
    timelineEpoch: Number.isSafeInteger(Number(result.timelineEpoch))
      ? Math.max(0, Number(result.timelineEpoch))
      : 0,
    claim: String(result.claim),
    statementType: String(
      result.statementType || (state === 'OPINION' ? 'OPINION' : 'FACTUAL')
    ).toUpperCase(),
    verdict: state || 'UNVERIFIABLE',
    confidence: String(result.confidence || ''),
    explanation: String(result.explanation || result.error || ''),
    speakerConfidence: String(result.speaker_confidence || ''),
    speakerName: result.speaker ? String(result.speaker) : null,
    sourceSentenceIds: normalizeSourceSentenceIds(result, sourceQuotes),
    sourceQuotes,
    sources: (result.sources || []).map(normalizeExportSource),
  };

  if (existingIndex !== undefined) {
    const previous = sessionLog[existingIndex];
    sessionLog[existingIndex] = {
      ...previous,
      ...entry,
      secondsElapsed: previous.secondsElapsed,
      videoTimestamp: entry.videoTimestamp || previous.videoTimestamp,
      speakerName: entry.speakerName || previous.speakerName,
      sourceSentenceIds: entry.sourceSentenceIds.length
        ? entry.sourceSentenceIds
        : previous.sourceSentenceIds,
      sourceQuotes: entry.sourceQuotes.length ? entry.sourceQuotes : previous.sourceQuotes,
    };
    return;
  }

  sessionLog.push(entry);
  sessionLogIndex.set(claimId, sessionLog.length - 1);

  if (sessionLog.length > MAX_SESSION_LOG_ENTRIES) {
    sessionLog.splice(0, sessionLog.length - MAX_SESSION_LOG_ENTRIES);
    rebuildSessionIndex();
  }
}

function updateSessionSpeaker(claimId, speakerName) {
  const index = sessionLogIndex.get(String(claimId));
  if (index === undefined || !speakerName) return;
  sessionLog[index].speakerName = String(speakerName);
}

function startSession(sessionId = null) {
  sessionLog.length = 0;
  sessionLogIndex.clear();
  sessionStartTime = Date.now();
  sessionStoppedAt = null;
  sessionIdentifier = sessionId === null || sessionId === undefined ? null : String(sessionId);
  sessionDiagnostics = createSessionDiagnostics();
}

function stopSession() {
  sessionStoppedAt = Date.now();
  sessionStartTime = null;
  return sessionLog.length;
}

function hasExportableSession() {
  return sessionLog.length > 0;
}

function formatElapsed(secondsElapsed) {
  const total = Math.max(0, Number(secondsElapsed) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function parseVideoTimestamp(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const parts = text.split(':').map(Number);
  if (!parts.length || parts.length > 3 || parts.some(part => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function parseElapsedSeconds(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function chronologicalSessionEntries() {
  const entries = sessionLog.map((entry, receivedIndex) => ({ entry, receivedIndex }));
  const playbackOffsets = entries.flatMap(({ entry }) => {
    const videoTime = parseVideoTimestamp(entry.videoTimestamp);
    const elapsedTime = parseElapsedSeconds(entry.secondsElapsed);
    return videoTime === null || elapsedTime === null ? [] : [videoTime - elapsedTime];
  }).sort((left, right) => left - right);
  const middle = Math.floor(playbackOffsets.length / 2);
  const playbackOffset = !playbackOffsets.length
    ? null
    : playbackOffsets.length % 2
      ? playbackOffsets[middle]
      : (playbackOffsets[middle - 1] + playbackOffsets[middle]) / 2;

  return entries
    .map(item => {
      const videoTime = parseVideoTimestamp(item.entry.videoTimestamp);
      const elapsedTime = parseElapsedSeconds(item.entry.secondsElapsed);
      return {
        ...item,
        timelineTime: videoTime ?? (
          elapsedTime !== null && playbackOffset !== null
            ? elapsedTime + playbackOffset
            : null
        ),
      };
    })
    .sort((left, right) => {
      if (left.timelineTime === null && right.timelineTime === null) {
        return left.receivedIndex - right.receivedIndex;
      }
      if (left.timelineTime === null) return 1;
      if (right.timelineTime === null) return -1;
      return left.timelineTime - right.timelineTime || left.receivedIndex - right.receivedIndex;
    });
}

function exportHTMLReport() {
  if (!sessionLog.length) {
    return { ok: false, error: 'No completed statements are available to export yet.' };
  }

  const pageTitle = document.title || 'Fact-check session';
  const exportDate = new Date().toLocaleString();
  const endedDate = sessionStoppedAt ? new Date(sessionStoppedAt).toLocaleString() : '';

  const verdictClass = (verdict) => {
    const normalized = String(verdict || '').toUpperCase();
    if (normalized === 'TRUE') return 'true';
    if (normalized === 'SUBSTANTIALLY TRUE') return 'subtrue';
    if (normalized === 'FALSE') return 'false';
    if (normalized === 'MISLEADING') return 'misleading';
    if (normalized === 'OPINION') return 'opinion';
    if (normalized === 'ERROR') return 'error';
    return 'unverifiable';
  };

  const speakerSections = [];
  chronologicalSessionEntries().forEach(({ entry }, index) => {
    const rawSpeaker = entry.speakerName;
    const speaker = rawSpeaker && !/^Speaker\s*\d+$/i.test(rawSpeaker) && rawSpeaker !== 'Other'
      ? rawSpeaker
      : 'Unknown speaker';
    let section = speakerSections.at(-1);
    if (!section || section.speaker !== speaker) {
      section = { speaker, claims: [] };
      speakerSections.push(section);
    }
    section.claims.push({ entry, index });
  });

  const claimsHTML = speakerSections.map(({ speaker, claims }) => {
    const cards = claims.map(({ entry, index }) => {
      const sourceSentenceIds = Array.isArray(entry.sourceSentenceIds)
        ? entry.sourceSentenceIds
        : [];
      const sourceQuotes = Array.isArray(entry.sourceQuotes) ? entry.sourceQuotes : [];
      const transcriptProvenanceHTML = sourceSentenceIds.length || sourceQuotes.length
        ? '<section class="transcript-provenance" aria-label="Transcript provenance">' +
            '<div class="provenance-heading"><strong>Transcript provenance</strong>' +
              '<span>Bounded excerpts only — not the full transcript</span></div>' +
            (sourceSentenceIds.length
              ? '<p class="utterance-ids">Utterance IDs: ' + sourceSentenceIds
                  .map(sourceSentenceId => '<code>' + escapeHtml(sourceSentenceId) + '</code>')
                  .join(', ') + '</p>'
              : '') +
            (sourceQuotes.length
              ? '<ol class="transcript-quotes">' + sourceQuotes.map(sourceQuote => (
                  '<li><code>' + escapeHtml(sourceQuote.sourceSentenceId) + '</code>' +
                    '<blockquote dir="auto">' + escapeHtml(sourceQuote.quote) + '</blockquote></li>'
                )).join('') + '</ol>'
              : '<p class="no-sources">No exact transcript excerpt was retained for this result.</p>') +
          '</section>'
        : '';
      const sourcesHTML = entry.verdict === 'OPINION'
        ? '<p class="no-sources">Opinion — no evidence search or factual verdict was requested.</p>'
        : entry.sources.length
        ? '<ul class="sources" aria-label="Evidence sources">' + entry.sources.map((source, sourceIndex) => {
            const href = safeReportHref(source.url);
            const title = source.title || source.domain || `Source ${sourceIndex + 1}`;
            const titleHTML = href
              ? '<a href="' + escapeHtml(href) + '" rel="noopener noreferrer">' + escapeHtml(title) + '</a>'
              : '<span class="source-title">' + escapeHtml(title) + '</span>';
            const meta = [source.domain, source.date].filter(Boolean).join(' · ');
            return '<li>' + titleHTML +
              (meta ? '<span class="source-meta">' + escapeHtml(meta) + '</span>' : '') +
              (source.snippet ? '<p>' + escapeHtml(source.snippet) + '</p>' : '') +
              (source.quote && source.quote !== source.snippet ? '<blockquote>' + escapeHtml(source.quote) + '</blockquote>' : '') +
            '</li>';
          }).join('') + '</ul>'
        : '<p class="no-sources">No source links were returned for this result.</p>';

      const time = entry.videoTimestamp || formatElapsed(entry.secondsElapsed);
      return '<article class="claim-card" data-timeline-epoch="' + escapeHtml(entry.timelineEpoch) + '">' +
        '<div class="claim-kicker">' +
          '<span>' + (entry.verdict === 'OPINION' ? 'Opinion ' : 'Claim ') + (index + 1) + '</span>' +
          '<span class="timestamp">' + escapeHtml(time) + '</span>' +
        '</div>' +
        '<div class="verdict-row">' +
          '<span class="verdict ' + verdictClass(entry.verdict) + '">' + escapeHtml(entry.verdict) + '</span>' +
          (entry.confidence ? '<span class="confidence">' + escapeHtml(entry.confidence) + ' evidence confidence</span>' : '') +
        '</div>' +
        '<h3 dir="auto">' + escapeHtml(entry.claim) + '</h3>' +
        (entry.explanation ? '<p class="explanation" dir="auto">' + escapeHtml(entry.explanation) + '</p>' : '') +
        transcriptProvenanceHTML +
        sourcesHTML +
      '</article>';
    }).join('');

    return '<section class="speaker-section">' +
      '<div class="speaker-heading"><h2>' + escapeHtml(speaker) + '</h2><span>' + claims.length + ' statement' + (claims.length === 1 ? '' : 's') + '</span></div>' +
      cards +
    '</section>';
  }).join('');

  const summaryOrder = ['TRUE', 'SUBSTANTIALLY TRUE', 'FALSE', 'MISLEADING', 'UNVERIFIABLE', 'OPINION', 'ERROR'];
  const summaryHTML = summaryOrder.map((verdict) => {
    const count = sessionLog.filter((entry) => entry.verdict === verdict).length;
    return '<div class="summary-item"><strong class="' + verdictClass(verdict) + '">' + count + '</strong><span>' + escapeHtml(verdict) + '</span></div>';
  }).join('');

  const mediaRange = [
    sessionDiagnostics.firstMediaTimestamp,
    sessionDiagnostics.lastMediaTimestamp,
  ].filter(Boolean).join('–');
  const diagnosticItems = [
    ['Transcript segments', sessionDiagnostics.transcriptSegments],
    ['Transcript characters', sessionDiagnostics.transcriptCharacters],
    ['Media range', mediaRange || 'n/a'],
    ['Timeline changes', sessionDiagnostics.timelineChanges],
    ['Latest timeline epoch', sessionDiagnostics.latestTimelineEpoch],
    ['Transcription reconnects', sessionDiagnostics.transcriptionReconnects],
    ['Dropped audio frames', sessionDiagnostics.droppedAudioFrames],
    ['Recovery warnings', sessionDiagnostics.recoveryWarnings],
    ['Analysis windows', sessionDiagnostics.analysisWindows],
  ];
  const diagnosticsHTML = diagnosticItems.map(([label, value]) => (
    '<div><strong>' + escapeHtml(value) + '</strong><span>' + escapeHtml(label) + '</span></div>'
  )).join('');
  const diagnosticEventsHTML = sessionDiagnostics.events.length
    ? '<section class="diagnostic-events" aria-labelledby="diagnostic-events-heading">' +
        '<div class="diagnostic-events-heading"><div><p class="eyebrow">Diagnostics</p>' +
          '<h2 id="diagnostic-events-heading">Capture event log</h2></div>' +
          '<span>Oldest to newest · last ' + sessionDiagnostics.events.length + '</span></div>' +
        '<p class="diagnostic-note">Status and error codes only; provider keys, error messages, and raw transcript text are excluded.</p>' +
        '<ol>' + sessionDiagnostics.events.map(event => {
          const metadata = [
            `epoch ${event.timelineEpoch}`,
            event.mediaTime ? `media ${event.mediaTime}` : '',
          ].filter(Boolean).join(' · ');
          return '<li><span class="event-kind">' + escapeHtml(event.kind) + '</span>' +
            '<code>' + escapeHtml(event.code) + '</code>' +
            '<span class="event-meta">' + escapeHtml(metadata) + '</span></li>';
        }).join('') + '</ol>' +
      '</section>'
    : '';

  const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>' +
    '<title>InTruth session report</title><style>' +
    ':root{color-scheme:light;--ink:#1c1917;--muted:#57534e;--line:#d6d3d1;--paper:#fafaf9;}' +
    '*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.6 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}' +
    'main{width:min(860px,calc(100% - 40px));margin:0 auto;padding:56px 0 72px;}' +
    '.report-header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:end;border-bottom:2px solid var(--ink);padding-bottom:20px;}' +
    '.eyebrow{margin:0 0 6px;color:var(--muted);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;}' +
    'h1{margin:0;font-size:32px;line-height:1.05;letter-spacing:-.035em;} .meta{display:grid;gap:3px;text-align:right;color:var(--muted);font-size:12px;}' +
    '.context{margin:18px 0 0;max-width:68ch;color:var(--muted);overflow-wrap:anywhere;}' +
    '.summary{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));margin:28px 0 44px;border-block:1px solid var(--line);}' +
    '.summary-item{padding:14px 8px;text-align:center;border-right:1px solid var(--line);}.summary-item:last-child{border-right:0;}' +
    '.summary-item strong{display:block;font-size:22px;font-variant-numeric:tabular-nums}.summary-item span{display:block;color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.04em;}' +
    '.diagnostics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line);margin:-24px 0 44px}.diagnostics div{background:var(--paper);padding:10px 12px}.diagnostics strong,.diagnostics span{display:block}.diagnostics strong{font-variant-numeric:tabular-nums}.diagnostics span{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em}' +
    '.diagnostic-events{margin:-22px 0 44px;border-block:1px solid var(--line);padding:18px 0}.diagnostic-events-heading{display:flex;align-items:end;justify-content:space-between;gap:20px}.diagnostic-events-heading h2{margin:0;font-size:18px}.diagnostic-events-heading>span,.diagnostic-note{color:var(--muted);font-size:11px}.diagnostic-note{margin:6px 0 12px}.diagnostic-events ol{list-style:none;margin:0;padding:0}.diagnostic-events li{display:grid;grid-template-columns:72px minmax(0,1fr) auto;gap:10px;align-items:baseline;padding:7px 0;border-top:1px solid #e7e5e4}.event-kind{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em}.diagnostic-events code,.utterance-ids code,.transcript-quotes code{font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}.event-meta{color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}' +
    '.true{color:#166534}.subtrue{color:#0f766e}.false,.error{color:#991b1b}.misleading{color:#92400e}.unverifiable{color:#57534e}.opinion{color:#6d28d9}' +
    '.speaker-section{margin-top:40px}.speaker-heading{display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px solid var(--ink);padding-bottom:8px;margin-bottom:0;}' +
    '.speaker-heading h2{margin:0;font-size:18px;letter-spacing:-.015em}.speaker-heading span{color:var(--muted);font-size:12px;}' +
    '.claim-card{padding:22px 0;border-bottom:1px solid var(--line);break-inside:avoid;}.claim-kicker,.verdict-row{display:flex;align-items:center;gap:10px;}' +
    '.claim-kicker{justify-content:space-between;color:var(--muted);font-size:11px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;}' +
    '.timestamp{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-variant-numeric:tabular-nums;}.verdict-row{margin-top:10px;}' +
    '.verdict{font-size:11px;font-weight:800;letter-spacing:.055em}.confidence{color:var(--muted);font-size:11px;}' +
    '.claim-card h3{margin:10px 0 6px;font-size:17px;line-height:1.4;letter-spacing:-.012em}.explanation{margin:0;max-width:72ch;color:#44403c;}' +
    '.transcript-provenance{margin-top:16px;padding:12px;border:1px solid var(--line);background:#f5f5f4}.provenance-heading{display:flex;justify-content:space-between;gap:16px;align-items:baseline}.provenance-heading strong{font-size:11px;text-transform:uppercase;letter-spacing:.045em}.provenance-heading span,.utterance-ids{color:var(--muted);font-size:10px}.utterance-ids{margin:5px 0 0}.transcript-quotes{margin:9px 0 0;padding:0;list-style:none}.transcript-quotes li+li{margin-top:9px}.transcript-quotes blockquote{margin:3px 0 0;padding-left:10px;border-left:2px solid var(--line);color:#44403c;font-size:12px}' +
    '.sources{list-style:none;margin:16px 0 0;padding:0;border-top:1px solid #e7e5e4}.sources li{padding:10px 0;border-bottom:1px solid #e7e5e4;}' +
    '.sources a,.source-title{color:#1d4ed8;font-weight:700;text-decoration:none}.sources a:hover{text-decoration:underline}.source-meta{display:block;color:var(--muted);font-size:11px;}' +
    '.sources p,.sources blockquote,.no-sources{margin:3px 0 0;color:var(--muted);font-size:12px}.sources blockquote{padding-left:10px;border-left:2px solid var(--line);font-style:italic}.no-sources{font-style:italic;}' +
    '@media(max-width:700px){main{width:min(100% - 28px,860px);padding-top:32px}.report-header{grid-template-columns:1fr}.meta{text-align:left}.summary{grid-template-columns:repeat(2,1fr)}.diagnostics{grid-template-columns:repeat(2,1fr)}.diagnostic-events-heading,.provenance-heading{align-items:flex-start;flex-direction:column;gap:3px}.diagnostic-events li{grid-template-columns:64px minmax(0,1fr)}.event-meta{grid-column:2}}' +
    '@media print{body{background:#fff}main{width:auto;padding:20px}.claim-card{break-inside:avoid}.summary{margin-bottom:28px}}' +
    '</style></head><body><main>' +
      '<header class="report-header"><div><p class="eyebrow">InTruth</p><h1>Session report</h1></div>' +
      '<div class="meta"><span>Exported ' + escapeHtml(exportDate) + '</span>' +
      (endedDate ? '<span>Session ended ' + escapeHtml(endedDate) + '</span>' : '<span>Session active at export</span>') +
      '<span>' + sessionLog.length + ' completed statement' + (sessionLog.length === 1 ? '' : 's') + '</span></div></header>' +
      '<p class="context" dir="auto">' + escapeHtml(pageTitle) + '</p>' +
      '<section class="summary" aria-label="Statement summary">' + summaryHTML + '</section>' +
      '<section class="diagnostics" aria-label="Session diagnostics">' + diagnosticsHTML + '</section>' +
      diagnosticEventsHTML +
      claimsHTML +
    '</main></body></html>';

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const datePart = new Date().toISOString().slice(0, 10);
  anchor.href = url;
  anchor.download = `intruth-session-${datePart}.html`;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return { ok: true, count: sessionLog.length };
}
