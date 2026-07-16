(function initPipelineCore(root) {
  'use strict';

  const VALID_VERDICTS = new Set([
    'TRUE',
    'SUBSTANTIALLY TRUE',
    'FALSE',
    'MISLEADING',
    'UNVERIFIABLE',
  ]);
  const VALID_CONFIDENCE = new Set(['HIGH', 'MEDIUM', 'LOW']);
  const NEGATION_TOKENS = new Set([
    'no', 'not', 'never', 'none', 'neither', 'nor',
    'non', 'mai', 'nessuno', 'nessuna',
    'nunca', 'jamás', 'ningún', 'ninguna',
    'ne', 'pas', 'jamais', 'aucun', 'aucune',
    'nicht', 'nie', 'kein', 'keine',
    'não', 'nunca', 'nenhum', 'nenhuma',
    'niet', 'geen', 'nooit',
    'нет', 'не', 'никогда',
    'لا', 'ليس', 'لم', 'لن',
    'नहीं', 'नही', 'कभी',
    '不', '没', '沒有', '没有',
    'ない', 'ません',
    '아니', '않', '없',
    'değil', 'yok', 'asla',
  ]);
  const ASR_CONFIDENCE_THRESHOLD = 0.72;
  const ASR_SENSITIVE_CONFIDENCE_THRESHOLD = 0.84;
  const COMMON_SECOND_LEVEL_SUFFIXES = new Set([
    'ac.uk', 'co.uk', 'gov.uk', 'org.uk',
    'asn.au', 'com.au', 'edu.au', 'gov.au', 'net.au', 'org.au',
    'co.jp', 'go.jp', 'ne.jp', 'or.jp',
    'co.nz', 'govt.nz', 'org.nz',
    'com.br', 'gov.br', 'org.br',
    'com.cn', 'gov.cn', 'org.cn',
    'com.mx', 'gob.mx', 'org.mx',
    'co.in', 'gov.in', 'org.in',
  ]);
  const EXTRACTION_STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'as', 'at', 'by', 'for', 'from',
    'in', 'into', 'of', 'on', 'to', 'with', 'is', 'are', 'was', 'were', 'be',
    'been', 'being', 'that', 'this', 'these', 'those', 'it', 'its',
    'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'e', 'o', 'è',
    'era', 'sono', 'di', 'da', 'a', 'in', 'su', 'per', 'con', 'che',
    'el', 'los', 'las', 'una', 'unos', 'unas', 'y', 'o', 'es', 'son', 'era',
    'de', 'del', 'en', 'por', 'para', 'con', 'que',
    'le', 'la', 'les', 'un', 'une', 'des', 'et', 'ou', 'est', 'sont', 'était',
    'de', 'du', 'dans', 'sur', 'pour', 'avec', 'que',
    'der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'ist', 'sind', 'war',
    'von', 'im', 'in', 'auf', 'für', 'mit', 'dass',
    'o', 'a', 'os', 'as', 'um', 'uma', 'e', 'ou', 'é', 'são', 'era', 'de',
    'do', 'da', 'em', 'por', 'para', 'com', 'que',
  ]);
  const ENGLISH_NEGATION_CONTRACTION = /\b(?:cannot|can't|cant|won't|wont|don't|dont|doesn't|doesnt|didn't|didnt|isn't|isnt|aren't|arent|wasn't|wasnt|weren't|werent|haven't|havent|hasn't|hasnt|hadn't|hadnt|shouldn't|shouldnt|wouldn't|wouldnt|couldn't|couldnt|mustn't|mustnt)\b/giu;
  const PERCENT_WORD_PATTERN = '(?:%|percent(?:age)?|per\\s+cento|por\\s+ciento|pour\\s+cent|prozent|por\\s+cento|процент(?:а|ов)?|प्रतिशत)';

  function safeText(value, maxLength = 2000) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
  }

  function tokenizeUnicode(text) {
    return String(text || '')
      .normalize('NFKC')
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) || [];
  }

  function normalizeClaimKey(claim) {
    return tokenizeUnicode(claim).join(' ');
  }

  function normalizeComparableText(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase();
  }

  function isExactTranscriptQuote(quote, sentenceText) {
    const normalizedQuote = String(quote || '').normalize('NFKC').trim();
    const normalizedSentence = String(sentenceText || '').normalize('NFKC');
    return Boolean(normalizedQuote && normalizedSentence.includes(normalizedQuote));
  }

  function extractNumericInvariants(value) {
    const normalized = normalizeComparableText(value);
    const pattern = new RegExp(
      `\\p{N}+(?:[.,]\\p{N}+)*(?:\\s*${PERCENT_WORD_PATTERN})?`,
      'gu'
    );
    return (normalized.match(pattern) || []).map(rawValue => {
      const isPercent = new RegExp(`${PERCENT_WORD_PATTERN}$`, 'u').test(rawValue);
      const numeric = (rawValue.match(/\p{N}+(?:[.,]\p{N}+)*/u) || [''])[0]
        .replace(',', '.');
      return `${numeric}${isPercent ? '%' : ''}`;
    }).sort();
  }

  function countNegationInvariants(value) {
    const normalized = normalizeComparableText(value);
    let count = (normalized.match(ENGLISH_NEGATION_CONTRACTION) || []).length;
    count += tokenizeUnicode(normalized)
      .filter(token => NEGATION_TOKENS.has(token))
      .length;
    // Tokenizers do not split grammatical suffixes in CJK text.
    count += (normalized.match(/(?:没有|沒有|不是|不会|不會|できない|ではない|ありません|않다|않습니다|없다|아니다)/gu) || []).length;
    return count;
  }

  function claimQuotePreservesInvariants(claim, quoteText) {
    const claimNumbers = extractNumericInvariants(claim);
    const quoteNumbers = extractNumericInvariants(quoteText);
    if (
      claimNumbers.length !== quoteNumbers.length ||
      claimNumbers.some((value, index) => value !== quoteNumbers[index])
    ) return false;
    return countNegationInvariants(claim) === countNegationInvariants(quoteText);
  }

  function claimIsExtractiveFromQuotes(claim, quoteText) {
    const quoteTokens = new Set(tokenizeUnicode(quoteText));
    const materialClaimTokens = tokenizeUnicode(claim)
      .filter(token => !EXTRACTION_STOPWORDS.has(token));
    if (!materialClaimTokens.length || !quoteTokens.size) return false;
    return materialClaimTokens.every(token => quoteTokens.has(token));
  }

  function normalizeUnitConfidence(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1 ? numeric : null;
  }

  function summarizeAsrConfidence(messageConfidence, words) {
    const overall = normalizeUnitConfidence(messageConfidence);
    const wordValues = (Array.isArray(words) ? words : [])
      .map(word => normalizeUnitConfidence(word?.confidence))
      .filter(value => value !== null);
    const wordAverage = wordValues.length
      ? wordValues.reduce((sum, value) => sum + value, 0) / wordValues.length
      : null;
    const candidates = [overall, wordAverage].filter(value => value !== null);
    return candidates.length ? Math.min(...candidates) : null;
  }

  function claimHasAsrSensitiveTokens(claim) {
    const text = String(claim || '').normalize('NFKC');
    if (/\p{N}/u.test(text)) return true;
    return countNegationInvariants(text) > 0;
  }

  function assessAsrConfidence(claim, sentenceConfidences) {
    const values = (Array.isArray(sentenceConfidences) ? sentenceConfidences : [])
      .map(normalizeUnitConfidence)
      .filter(value => value !== null);
    const asrConfidence = values.length ? Math.min(...values) : null;
    const sensitive = claimHasAsrSensitiveTokens(claim);
    const threshold = sensitive
      ? ASR_SENSITIVE_CONFIDENCE_THRESHOLD
      : ASR_CONFIDENCE_THRESHOLD;
    return {
      asrConfidence,
      threshold,
      sensitive,
      sufficient: asrConfidence !== null && asrConfidence >= threshold,
    };
  }

  function buildAnthropicToolRequest({
    model,
    maxTokens,
    system,
    payload,
    toolName,
    schema,
  }) {
    return {
      model,
      max_tokens: maxTokens,
      // Sonnet 5 enables adaptive thinking by default. Forced tool choice is only
      // valid when thinking is explicitly disabled; temperature must remain unset.
      thinking: { type: 'disabled' },
      system,
      tools: [{
        name: toolName,
        description: 'Return the validated structured result for this pipeline stage.',
        input_schema: schema,
      }],
      tool_choice: { type: 'tool', name: toolName },
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    };
  }

  function isBlockedDomain(hostname, blockedDomains) {
    const normalized = String(hostname || '').toLowerCase().replace(/^www\./, '');
    for (const rawDomain of blockedDomains || []) {
      const blocked = String(rawDomain || '').toLowerCase().replace(/^www\./, '');
      if (blocked && (normalized === blocked || normalized.endsWith(`.${blocked}`))) return true;
    }
    return false;
  }

  function canonicalPublisherDomain(hostname) {
    const normalized = String(hostname || '')
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\.$/, '');
    if (!normalized || normalized.includes(':') || /^\d+(?:\.\d+){3}$/.test(normalized)) {
      return normalized;
    }
    const labels = normalized.split('.').filter(Boolean);
    if (labels.length <= 2) return normalized;
    const lastTwo = labels.slice(-2).join('.');
    return COMMON_SECOND_LEVEL_SUFFIXES.has(lastTwo) && labels.length >= 3
      ? labels.slice(-3).join('.')
      : lastTwo;
  }

  function normalizeSource(candidate, blockedDomains) {
    const url = safeText(candidate?.url, 2000);
    const snippet = safeText(candidate?.snippet, 1200);
    if (!url || !snippet) return null;
    try {
      const parsed = new URL(url);
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        isBlockedDomain(parsed.hostname, blockedDomains)
      ) return null;
      return {
        url: parsed.href,
        title: safeText(candidate?.title, 400),
        domain: parsed.hostname.toLowerCase().replace(/^www\./, ''),
        date: safeText(candidate?.date, 100),
        snippet,
      };
    } catch {
      return null;
    }
  }

  function validateGroundedResult(input, sources) {
    const verdict = safeText(input?.verdict, 40).toUpperCase();
    const confidence = safeText(input?.confidence, 20).toUpperCase();
    const explanation = safeText(input?.explanation, 1200);
    if (!VALID_VERDICTS.has(verdict) || !VALID_CONFIDENCE.has(confidence) || !explanation) {
      return { ok: false, reason: 'INVALID_SCHEMA' };
    }

    const byEvidenceId = new Map((sources || []).map(source => [source.evidenceId, source]));
    const citations = [];
    const seen = new Set();
    for (const citation of Array.isArray(input?.citations) ? input.citations : []) {
      const evidenceId = safeText(citation?.evidenceId, 40);
      const quote = safeText(citation?.quote, 400);
      const source = byEvidenceId.get(evidenceId);
      if (!source || !quote || seen.has(evidenceId)) continue;
      const evidenceText = `${source.title || ''}\n${source.snippet || ''}`
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .toLocaleLowerCase();
      const normalizedQuote = quote
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .toLocaleLowerCase();
      if (!evidenceText.includes(normalizedQuote)) continue;
      seen.add(evidenceId);
      citations.push({ evidenceId, sourceId: source.id, quote });
    }

    if (verdict !== 'UNVERIFIABLE' && citations.length === 0) {
      return {
        ok: true,
        verdict: 'UNVERIFIABLE',
        confidence: 'LOW',
        explanation: 'The available search excerpts did not contain a validated citation for this claim.',
        citations: [],
        sources: [],
      };
    }

    const citedSourceIds = new Set(citations.map(citation => citation.sourceId));
    const citedSources = (sources || []).filter(source => citedSourceIds.has(source.id));
    return {
      ok: true,
      verdict,
      // Search snippets are discovery evidence, not primary documents. They can
      // support a categorical result, but never HIGH confidence on their own.
      confidence: verdict !== 'UNVERIFIABLE' && confidence === 'HIGH'
        ? 'MEDIUM'
        : confidence,
      explanation,
      citations: verdict === 'UNVERIFIABLE' ? [] : citations,
      sources: verdict === 'UNVERIFIABLE' ? [] : citedSources,
    };
  }

  root.InTruthPipelineCore = Object.freeze({
    safeText,
    tokenizeUnicode,
    normalizeClaimKey,
    normalizeComparableText,
    isExactTranscriptQuote,
    extractNumericInvariants,
    countNegationInvariants,
    claimQuotePreservesInvariants,
    claimIsExtractiveFromQuotes,
    normalizeUnitConfidence,
    summarizeAsrConfidence,
    claimHasAsrSensitiveTokens,
    assessAsrConfidence,
    buildAnthropicToolRequest,
    isBlockedDomain,
    canonicalPublisherDomain,
    normalizeSource,
    validateGroundedResult,
  });
})(globalThis);
