// session-export.js
// Keeps a bounded session history and exports a self-contained HTML report.

const sessionLog = [];
const sessionLogIndex = new Map();
const MAX_SESSION_LOG_ENTRIES = 250;

let sessionStartTime = null;
let sessionStoppedAt = null;
let sessionIdentifier = null;

function normalizeSessionKey(result) {
  if (result?.claimId !== undefined && result?.claimId !== null) return String(result.claimId);
  if (result?.id !== undefined && result?.id !== null) return String(result.id);
  const normalizedClaim = String(result?.claim || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `legacy:${normalizedClaim}`;
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
  const entry = {
    claimId,
    sessionId: sessionIdentifier,
    timestamp: new Date().toISOString(),
    secondsElapsed: sessionStartTime ? Math.round((Date.now() - sessionStartTime) / 1000) : 0,
    videoTimestamp: String(result._timestamp || ''),
    claim: String(result.claim),
    verdict: state || 'UNVERIFIABLE',
    confidence: String(result.confidence || ''),
    explanation: String(result.explanation || result.error || ''),
    speakerConfidence: String(result.speaker_confidence || ''),
    speakerName: result.speaker ? String(result.speaker) : null,
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

function exportHTMLReport() {
  if (!sessionLog.length) {
    return { ok: false, error: 'No completed claims are available to export yet.' };
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
    if (normalized === 'ERROR') return 'error';
    return 'unverifiable';
  };

  const speakerGroups = new Map();
  sessionLog.forEach((entry, index) => {
    const rawSpeaker = entry.speakerName;
    const speaker = rawSpeaker && !/^Speaker\s*\d+$/i.test(rawSpeaker) && rawSpeaker !== 'Other'
      ? rawSpeaker
      : 'Unknown speaker';
    if (!speakerGroups.has(speaker)) speakerGroups.set(speaker, []);
    speakerGroups.get(speaker).push({ entry, index });
  });

  const claimsHTML = [...speakerGroups.entries()].map(([speaker, claims]) => {
    const cards = claims.map(({ entry, index }) => {
      const sourcesHTML = entry.sources.length
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
      return '<article class="claim-card">' +
        '<div class="claim-kicker">' +
          '<span>Claim ' + (index + 1) + '</span>' +
          '<span class="timestamp">' + escapeHtml(time) + '</span>' +
        '</div>' +
        '<div class="verdict-row">' +
          '<span class="verdict ' + verdictClass(entry.verdict) + '">' + escapeHtml(entry.verdict) + '</span>' +
          (entry.confidence ? '<span class="confidence">' + escapeHtml(entry.confidence) + ' confidence</span>' : '') +
        '</div>' +
        '<h3 dir="auto">' + escapeHtml(entry.claim) + '</h3>' +
        (entry.explanation ? '<p class="explanation" dir="auto">' + escapeHtml(entry.explanation) + '</p>' : '') +
        sourcesHTML +
      '</article>';
    }).join('');

    return '<section class="speaker-section">' +
      '<div class="speaker-heading"><h2>' + escapeHtml(speaker) + '</h2><span>' + claims.length + ' claim' + (claims.length === 1 ? '' : 's') + '</span></div>' +
      cards +
    '</section>';
  }).join('');

  const summaryOrder = ['TRUE', 'SUBSTANTIALLY TRUE', 'FALSE', 'MISLEADING', 'UNVERIFIABLE', 'ERROR'];
  const summaryHTML = summaryOrder.map((verdict) => {
    const count = sessionLog.filter((entry) => entry.verdict === verdict).length;
    return '<div class="summary-item"><strong class="' + verdictClass(verdict) + '">' + count + '</strong><span>' + escapeHtml(verdict) + '</span></div>';
  }).join('');

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
    '.summary{display:grid;grid-template-columns:repeat(6,1fr);margin:28px 0 44px;border-block:1px solid var(--line);}' +
    '.summary-item{padding:14px 8px;text-align:center;border-right:1px solid var(--line);}.summary-item:last-child{border-right:0;}' +
    '.summary-item strong{display:block;font-size:22px;font-variant-numeric:tabular-nums}.summary-item span{display:block;color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.04em;}' +
    '.true{color:#166534}.subtrue{color:#0f766e}.false,.error{color:#991b1b}.misleading{color:#92400e}.unverifiable{color:#57534e}' +
    '.speaker-section{margin-top:40px}.speaker-heading{display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px solid var(--ink);padding-bottom:8px;margin-bottom:0;}' +
    '.speaker-heading h2{margin:0;font-size:18px;letter-spacing:-.015em}.speaker-heading span{color:var(--muted);font-size:12px;}' +
    '.claim-card{padding:22px 0;border-bottom:1px solid var(--line);break-inside:avoid;}.claim-kicker,.verdict-row{display:flex;align-items:center;gap:10px;}' +
    '.claim-kicker{justify-content:space-between;color:var(--muted);font-size:11px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;}' +
    '.timestamp{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-variant-numeric:tabular-nums;}.verdict-row{margin-top:10px;}' +
    '.verdict{font-size:11px;font-weight:800;letter-spacing:.055em}.confidence{color:var(--muted);font-size:11px;}' +
    '.claim-card h3{margin:10px 0 6px;font-size:17px;line-height:1.4;letter-spacing:-.012em}.explanation{margin:0;max-width:72ch;color:#44403c;}' +
    '.sources{list-style:none;margin:16px 0 0;padding:0;border-top:1px solid #e7e5e4}.sources li{padding:10px 0;border-bottom:1px solid #e7e5e4;}' +
    '.sources a,.source-title{color:#1d4ed8;font-weight:700;text-decoration:none}.sources a:hover{text-decoration:underline}.source-meta{display:block;color:var(--muted);font-size:11px;}' +
    '.sources p,.sources blockquote,.no-sources{margin:3px 0 0;color:var(--muted);font-size:12px}.sources blockquote{padding-left:10px;border-left:2px solid var(--line);font-style:italic}.no-sources{font-style:italic;}' +
    '@media(max-width:700px){main{width:min(100% - 28px,860px);padding-top:32px}.report-header{grid-template-columns:1fr}.meta{text-align:left}.summary{grid-template-columns:repeat(3,1fr)}.summary-item:nth-child(3){border-right:0}}' +
    '@media print{body{background:#fff}main{width:auto;padding:20px}.claim-card{break-inside:avoid}.summary{margin-bottom:28px}}' +
    '</style></head><body><main>' +
      '<header class="report-header"><div><p class="eyebrow">InTruth</p><h1>Session report</h1></div>' +
      '<div class="meta"><span>Exported ' + escapeHtml(exportDate) + '</span>' +
      (endedDate ? '<span>Session ended ' + escapeHtml(endedDate) + '</span>' : '<span>Session active at export</span>') +
      '<span>' + sessionLog.length + ' completed claim' + (sessionLog.length === 1 ? '' : 's') + '</span></div></header>' +
      '<p class="context" dir="auto">' + escapeHtml(pageTitle) + '</p>' +
      '<section class="summary" aria-label="Verdict summary">' + summaryHTML + '</section>' +
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
