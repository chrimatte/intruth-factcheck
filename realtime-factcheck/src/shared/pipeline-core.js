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
  const VERDICT_EXPLANATION_MAX_CHARS = 360;
  const VERDICT_CITATION_QUOTE_MAX_CHARS = 240;
  const VERDICT_MAX_CITATIONS = 3;
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
  // Deepgram confidence is an ASR ranking signal, not a calibrated probability.
  // Keep a stricter gate for numbers, negation, acronyms, and named entities,
  // without discarding otherwise usable utterances merely because they contain
  // a year or percentage.
  const ASR_CONFIDENCE_THRESHOLD = 0.68;
  const ASR_SENSITIVE_CONFIDENCE_THRESHOLD = 0.78;
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
    'il', 'lo', 'la', 'l', 'i', 'gli', 'le', 'un', 'uno', 'una', 'e', 'o', 'è',
    'era', 'sono', 'di', 'd', 'da', 'a', 'in', 'su', 'per', 'con', 'che',
    'al', 'allo', 'alla', 'ai', 'agli', 'alle', 'dal', 'dallo', 'dalla', 'dai',
    'dagli', 'dalle', 'dall', 'del', 'dello', 'della', 'dei', 'degli', 'delle',
    'dell', 'nel', 'nello', 'nella', 'nei', 'negli', 'nelle', 'nell', 'sul',
    'sullo', 'sulla', 'sui', 'sugli', 'sulle', 'sull', 'all', 'col', 'coi',
    'el', 'los', 'las', 'una', 'unos', 'unas', 'y', 'o', 'es', 'son', 'era',
    'de', 'del', 'al', 'en', 'por', 'para', 'con', 'que',
    'le', 'la', 'les', 'un', 'une', 'des', 'et', 'ou', 'est', 'sont', 'était',
    'de', 'd', 'du', 'au', 'aux', 'dans', 'sur', 'pour', 'avec', 'que',
    'der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'ist', 'sind', 'war',
    'von', 'im', 'in', 'auf', 'für', 'mit', 'dass',
    'o', 'a', 'os', 'as', 'um', 'uma', 'e', 'ou', 'é', 'são', 'era', 'de',
    'do', 'da', 'dos', 'das', 'ao', 'aos', 'à', 'às', 'em', 'no', 'na',
    'nos', 'nas', 'por', 'para', 'com', 'que',
    // Other languages exposed by the extension. These are function words only;
    // entities, predicates, qualifiers, numbers, and negation remain material.
    'het', 'een', 'en', 'of', 'is', 'zijn', 'was', 'van', 'voor', 'dat',
    'i', 'lub', 'albo', 'jest', 'są', 'był', 'była', 'było', 'z', 'w',
    'na', 'do', 'od', 'dla', 'że',
    'ett', 'och', 'eller', 'är', 'var', 'av', 'på', 'för', 'med', 'att',
    'bir', 've', 'veya', 'ile', 'için', 'bu', 'şu', 'o',
    'и', 'или', 'это', 'был', 'была', 'было', 'в', 'на', 'из', 'для', 'что',
    'و', 'أو', 'في', 'من', 'إلى', 'على', 'لـ', 'هذا', 'هذه',
    'और', 'या', 'है', 'हैं', 'था', 'थी', 'में', 'से', 'को', 'के', 'की',
    '的', '了', '是', '在', '和', '与', '與', '为', '為',
    'は', 'が', 'の', 'を', 'に', 'で', 'と', 'です', 'ます',
  ]);
  const ENGLISH_NEGATION_CONTRACTION = /\b(?:cannot|can't|cant|won't|wont|don't|dont|doesn't|doesnt|didn't|didnt|isn't|isnt|aren't|arent|wasn't|wasnt|weren't|werent|haven't|havent|hasn't|hasnt|hadn't|hadnt|shouldn't|shouldnt|wouldn't|wouldnt|couldn't|couldnt|mustn't|mustnt)\b/giu;
  const PERCENT_WORD_PATTERN = '(?:%|percent(?:age)?|per\\s+cento|por\\s+ciento|pour\\s+cent|prozent|por\\s+cento|процент(?:а|ов)?|प्रतिशत)';
  const WORD_PART_PATTERN = /[\p{L}\p{M}]+|\p{N}+/gu;
  const WORD_SEGMENTER = typeof Intl === 'object' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('und', { granularity: 'word' })
    : null;

  function safeText(value, maxLength = 2000) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
  }

  function compactTextAtBoundary(value, maxLength) {
    const text = typeof value === 'string'
      ? value.trim().replace(/\s+/gu, ' ')
      : '';
    if (!text || !Number.isInteger(maxLength) || maxLength < 2) return '';
    if (text.length <= maxLength) return text;

    const available = maxLength - 1;
    const prefix = text.slice(0, available + 1);
    const sentenceEnds = [...prefix.matchAll(/[.!?](?=\s|$)/gu)];
    const sentenceEnd = sentenceEnds.at(-1)?.index;
    if (Number.isInteger(sentenceEnd) && sentenceEnd >= Math.floor(maxLength * 0.5)) {
      return prefix.slice(0, sentenceEnd + 1).trim();
    }

    const wordEnd = prefix.lastIndexOf(' ', available);
    const cutAt = wordEnd >= Math.floor(maxLength * 0.55) ? wordEnd : available;
    const compact = prefix
      .slice(0, cutAt)
      .trimEnd()
      .replace(/[,:;\-–—]+$/u, '')
      .trimEnd();
    return compact ? `${compact}…` : '';
  }

  function tokenizeUnicode(text) {
    const normalized = String(text || '')
      .normalize('NFKC')
      .toLowerCase();
    if (!normalized) return [];

    // Intl.Segmenter prevents an entire punctuation-free CJK utterance from
    // becoming one indivisible token. Splitting each segment into letter and
    // number runs also treats apostrophe clitics and adjacent digits uniformly.
    if (WORD_SEGMENTER) {
      const tokens = [];
      for (const segment of WORD_SEGMENTER.segment(normalized)) {
        if (!segment.isWordLike) continue;
        tokens.push(...(segment.segment.match(WORD_PART_PATTERN) || []));
      }
      return tokens;
    }
    return normalized.match(WORD_PART_PATTERN) || [];
  }

  function normalizeClaimKey(claim) {
    return tokenizeUnicode(claim).join(' ');
  }

  function normalizeComparableText(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function isExactTranscriptQuote(quote, sentenceText) {
    const normalizeSurface = value => String(value || '')
      .normalize('NFKC')
      .replace(/[\u2018\u2019\u201A\u201B\u2032\uFF07]/gu, "'")
      .replace(/[\u201C\u201D\u201E\u201F\u2033\uFF02]/gu, '"')
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/gu, '-')
      .replace(/\u2026/gu, '...')
      .replace(/\s+/gu, ' ')
      .trim()
      .toLowerCase();
    const normalizedQuote = normalizeSurface(quote);
    const normalizedSentence = normalizeSurface(sentenceText);
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
    // Supporting quotes may repeat the same fact. Compare unique values so two
    // corroborating quotes containing "4.2%" do not invalidate one atomic claim,
    // while an added or omitted year/quantity still fails closed.
    const claimNumberSet = new Set(claimNumbers);
    const quoteNumberSet = new Set(quoteNumbers);
    if (
      claimNumberSet.size !== quoteNumberSet.size ||
      [...claimNumberSet].some(value => !quoteNumberSet.has(value))
    ) return false;

    // Repeated supporting quotes likewise repeat grammatical negation. Presence
    // must match in both directions, but its duplicate count is not semantic.
    return (countNegationInvariants(claim) > 0) ===
      (countNegationInvariants(quoteText) > 0);
  }

  function claimIsExtractiveFromQuotes(claim, quoteText) {
    const quoteTokens = new Set(tokenizeUnicode(quoteText));
    const materialClaimTokens = tokenizeUnicode(claim)
      // Some spellings are ambiguous across languages (for example Portuguese
      // "no" is a contraction while English/Spanish "no" is negation). A known
      // negation token is always material regardless of the stop-word table.
      .filter(token => NEGATION_TOKENS.has(token) || !EXTRACTION_STOPWORDS.has(token));
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
    // Fragment-local word confidence is more useful than the confidence for a
    // larger utterance. Claim-specific words are checked separately below, so one
    // unrelated low-confidence filler cannot suppress an otherwise clear claim.
    return wordAverage ?? overall;
  }

  function claimHasAsrSensitiveTokens(claim, language = '') {
    const text = String(claim || '').normalize('NFKC');
    if (/\p{N}/u.test(text)) return true;
    if (countNegationInvariants(text) > 0) return true;
    if (/\b[\p{Lu}\p{N}]{2,}\b/u.test(text)) return true;
    // German capitalizes ordinary nouns, so title case alone is not evidence of
    // a named entity in German or in auto mode where the language is unknown.
    const normalizedLanguage = String(language || '').toLocaleLowerCase();
    if (normalizedLanguage === 'de' || normalizedLanguage === 'multi') return false;
    const words = text.match(/[\p{L}\p{M}][\p{L}\p{M}'’.-]*/gu) || [];
    return words.slice(1).some(word => /^\p{Lu}[\p{L}\p{M}'’.-]{2,}$/u.test(word));
  }

  function claimWordConfidence(claim, asrWords) {
    const materialTokens = new Set(tokenizeUnicode(claim)
      .filter(token => NEGATION_TOKENS.has(token) || !EXTRACTION_STOPWORDS.has(token)));
    if (!materialTokens.size) return null;

    const matchingValues = [];
    for (const word of Array.isArray(asrWords) ? asrWords : []) {
      const confidence = normalizeUnitConfidence(word?.confidence);
      if (confidence === null) continue;
      const wordTokens = tokenizeUnicode(word?.word || word?.punctuated_word || '');
      if (wordTokens.some(token => materialTokens.has(token))) matchingValues.push(confidence);
    }
    return matchingValues.length ? Math.min(...matchingValues) : null;
  }

  function assessAsrConfidence(claim, sentenceConfidences, asrWords = [], language = '') {
    const values = (Array.isArray(sentenceConfidences) ? sentenceConfidences : [])
      .map(normalizeUnitConfidence)
      .filter(value => value !== null);
    const sentenceConfidence = values.length ? Math.min(...values) : null;
    const matchedWordConfidence = claimWordConfidence(claim, asrWords);
    const candidates = [sentenceConfidence, matchedWordConfidence]
      .filter(value => value !== null);
    const asrConfidence = candidates.length ? Math.min(...candidates) : null;
    const sensitive = claimHasAsrSensitiveTokens(claim, language);
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
    const request = {
      model,
      max_tokens: maxTokens,
      system,
      tools: [{
        name: toolName,
        description: 'Return the validated structured result for this pipeline stage.',
        input_schema: schema,
      }],
      tool_choice: { type: 'tool', name: toolName },
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    };
    // Sonnet 5 enables adaptive thinking by default. Forced tool choice is only
    // valid when thinking is explicitly disabled; temperature must remain unset.
    // Haiku defaults to non-thinking mode and needs no extra request field.
    if (model === 'claude-sonnet-5') request.thinking = { type: 'disabled' };
    return request;
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
    const explanation = compactTextAtBoundary(
      input?.explanation,
      VERDICT_EXPLANATION_MAX_CHARS
    );
    if (!VALID_VERDICTS.has(verdict) || !VALID_CONFIDENCE.has(confidence) || !explanation) {
      return { ok: false, reason: 'INVALID_SCHEMA' };
    }

    const byEvidenceId = new Map((sources || []).map(source => [source.evidenceId, source]));
    const citations = [];
    const seen = new Set();
    const inputCitations = Array.isArray(input?.citations) ? input.citations : [];
    for (const citation of inputCitations) {
      if (citations.length >= VERDICT_MAX_CITATIONS) break;
      const evidenceId = safeText(citation?.evidenceId, 40);
      const quote = safeText(citation?.quote, VERDICT_CITATION_QUOTE_MAX_CHARS);
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
      // UNVERIFIABLE describes an evidence gap, not confidence that the claim is
      // false, so it always carries the lowest factual-confidence label.
      confidence: verdict === 'UNVERIFIABLE'
        ? 'LOW'
        : (confidence === 'HIGH' ? 'MEDIUM' : confidence),
      explanation,
      // Keep any exact, validated citations for an abstention. They let the user
      // inspect what was reviewed instead of turning every abstention into an
      // opaque "no sources" card.
      citations,
      sources: citedSources,
    };
  }

  root.InTruthPipelineCore = Object.freeze({
    VERDICT_EXPLANATION_MAX_CHARS,
    VERDICT_CITATION_QUOTE_MAX_CHARS,
    VERDICT_MAX_CITATIONS,
    safeText,
    compactTextAtBoundary,
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
