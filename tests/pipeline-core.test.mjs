import assert from "node:assert/strict";
import test from "node:test";
import {
  assessAsrConfidence,
  buildAnthropicToolRequest,
  canonicalPublisherDomain,
  claimIsExtractiveFromQuotes,
  claimQuotePreservesInvariants,
  isExactTranscriptQuote,
  normalizeClaimKey,
  normalizeSource,
  safeText,
  tokenizeUnicode,
  validateGroundedResult
} from "../realtime-factcheck/src/shared/pipeline-core.mjs";

const sources = [
  {
    id: "S1",
    evidenceId: "E1",
    url: "https://statistics.example/report",
    title: "Official report",
    domain: "statistics.example",
    date: "2026-01-10",
    snippet: "The annual rate was 4.2 percent in December 2025."
  },
  {
    id: "S2",
    evidenceId: "E2",
    url: "https://archive.example/table",
    title: "Historical table",
    domain: "archive.example",
    date: "2026-01-11",
    snippet: "The revised table confirms an annual rate of 4.2 percent."
  }
];

test("safeText trims and bounds untrusted strings", () => {
  assert.equal(safeText("  abcdef  ", 4), "abcd");
  assert.equal(safeText({ value: "secret" }), "");
});

test("Unicode tokenization preserves non-Latin claims", () => {
  assert.deepEqual(tokenizeUnicode("الاقتصاد نما ٣٪"), ["الاقتصاد", "نما", "٣"]);
  assert.deepEqual(tokenizeUnicode("通胀率为4%"), ["通胀率为4"]);
  assert.notEqual(normalizeClaimKey("Экономика выросла"), "");
  assert.notEqual(normalizeClaimKey("失業率は4%です"), "");
});

test("claim keys preserve material negation and numbers", () => {
  assert.notEqual(
    normalizeClaimKey("Inflation increased to 4 percent"),
    normalizeClaimKey("Inflation did not increase to 4 percent")
  );
  assert.notEqual(
    normalizeClaimKey("Inflation was 4 percent"),
    normalizeClaimKey("Inflation was 5 percent")
  );
});

test("claim extraction rejects invented entities, qualifiers, numbers, and negation", () => {
  const quote = "The rate fell by 4 percent last year.";
  assert.equal(isExactTranscriptQuote("rate fell by 4 percent", quote), true);
  assert.equal(claimIsExtractiveFromQuotes("The rate fell by 4 percent last year", quote), true);
  assert.equal(claimIsExtractiveFromQuotes("The rate fell by 4 percent last year in Italy", quote), false);
  assert.equal(claimQuotePreservesInvariants("The rate fell by 40 percent", quote), false);
  assert.equal(
    claimQuotePreservesInvariants("The rate cannot fall by 4 percent last year", "The rate can fall by 4 percent last year"),
    false
  );
});

test("ASR confidence fails closed and uses a stricter threshold for sensitive claims", () => {
  assert.deepEqual(assessAsrConfidence("The policy changed", [0.8]), {
    asrConfidence: 0.8,
    threshold: 0.72,
    sensitive: false,
    sufficient: true
  });
  assert.deepEqual(assessAsrConfidence("The rate was 4 percent", [0.8]), {
    asrConfidence: 0.8,
    threshold: 0.84,
    sensitive: true,
    sufficient: false
  });
  assert.equal(assessAsrConfidence("The policy changed", []).sufficient, false);
});

test("Sonnet 5 forced-tool requests disable thinking and omit sampling parameters", () => {
  const body = buildAnthropicToolRequest({
    model: "claude-sonnet-5",
    maxTokens: 400,
    system: "Return structured data.",
    payload: { claim: "Example" },
    toolName: "emit_result",
    schema: { type: "object" }
  });

  assert.equal(body.model, "claude-sonnet-5");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.deepEqual(body.tool_choice, { type: "tool", name: "emit_result" });
  assert.equal("temperature" in body, false);
  assert.equal("top_p" in body, false);
  assert.equal("top_k" in body, false);
});

test("source normalization rejects unsafe URLs and blocked subdomains", () => {
  assert.equal(normalizeSource({ url: "javascript:alert(1)", snippet: "x" }, []), null);
  assert.equal(normalizeSource({ url: "https://news.reddit.com/x", snippet: "x" }, ["reddit.com"]), null);
  assert.deepEqual(
    normalizeSource({ url: "https://WWW.Example.org/report", title: " Report ", snippet: " Evidence " }, []),
    {
      url: "https://www.example.org/report",
      title: "Report",
      domain: "example.org",
      date: "",
      snippet: "Evidence"
    }
  );
});

test("publisher domains collapse subdomains without breaking common country suffixes", () => {
  assert.equal(canonicalPublisherDomain("news.example.org"), "example.org");
  assert.equal(canonicalPublisherDomain("data.bbc.co.uk"), "bbc.co.uk");
  assert.equal(canonicalPublisherDomain("www.example.com.au"), "example.com.au");
});

test("categorical verdict without an exact evidence quote fails closed", () => {
  const result = validateGroundedResult({
    verdict: "FALSE",
    confidence: "HIGH",
    explanation: "The evidence contradicts the claim.",
    citations: [{ evidenceId: "E1", quote: "A sentence that is not in the evidence." }]
  }, sources);

  assert.equal(result.ok, true);
  assert.equal(result.verdict, "UNVERIFIABLE");
  assert.equal(result.confidence, "LOW");
  assert.deepEqual(result.sources, []);
});

test("validated citations retain only cited sources and cap snippet-only confidence", () => {
  const result = validateGroundedResult({
    verdict: "TRUE",
    confidence: "HIGH",
    explanation: "Both excerpts support the stated rate.",
    citations: [
      { evidenceId: "E1", quote: "annual rate was 4.2 percent" },
      { evidenceId: "E2", quote: "confirms an annual rate of 4.2 percent" }
    ]
  }, sources);

  assert.equal(result.ok, true);
  assert.equal(result.verdict, "TRUE");
  assert.equal(result.confidence, "MEDIUM");
  assert.deepEqual(result.sources.map((source) => source.id), ["S1", "S2"]);
  assert.deepEqual(result.citations.map((citation) => citation.evidenceId), ["E1", "E2"]);
});

test("one cited excerpt cannot retain HIGH confidence", () => {
  const result = validateGroundedResult({
    verdict: "MISLEADING",
    confidence: "HIGH",
    explanation: "The date qualifier is omitted.",
    citations: [{ evidenceId: "E1", quote: "in December 2025" }]
  }, sources);

  assert.equal(result.ok, true);
  assert.equal(result.confidence, "MEDIUM");
  assert.deepEqual(result.sources.map((source) => source.id), ["S1"]);
});

test("malformed verdict objects are rejected", () => {
  assert.deepEqual(
    validateGroundedResult({ verdict: "PROBABLY", confidence: "99", explanation: "", citations: [] }, sources),
    { ok: false, reason: "INVALID_SCHEMA" }
  );
});
