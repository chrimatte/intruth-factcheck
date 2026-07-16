import './pipeline-core.js';

const core = globalThis.InTruthPipelineCore;

export const VERDICT_EXPLANATION_MAX_CHARS = core.VERDICT_EXPLANATION_MAX_CHARS;
export const VERDICT_CITATION_QUOTE_MAX_CHARS = core.VERDICT_CITATION_QUOTE_MAX_CHARS;
export const VERDICT_MAX_CITATIONS = core.VERDICT_MAX_CITATIONS;
export const safeText = core.safeText;
export const tokenizeUnicode = core.tokenizeUnicode;
export const normalizeClaimKey = core.normalizeClaimKey;
export const normalizeComparableText = core.normalizeComparableText;
export const isExactTranscriptQuote = core.isExactTranscriptQuote;
export const extractNumericInvariants = core.extractNumericInvariants;
export const countNegationInvariants = core.countNegationInvariants;
export const claimQuotePreservesInvariants = core.claimQuotePreservesInvariants;
export const claimIsExtractiveFromQuotes = core.claimIsExtractiveFromQuotes;
export const normalizeUnitConfidence = core.normalizeUnitConfidence;
export const summarizeAsrConfidence = core.summarizeAsrConfidence;
export const claimHasAsrSensitiveTokens = core.claimHasAsrSensitiveTokens;
export const assessAsrConfidence = core.assessAsrConfidence;
export const buildAnthropicToolRequest = core.buildAnthropicToolRequest;
export const isBlockedDomain = core.isBlockedDomain;
export const canonicalPublisherDomain = core.canonicalPublisherDomain;
export const normalizeSource = core.normalizeSource;
export const validateGroundedResult = core.validateGroundedResult;
