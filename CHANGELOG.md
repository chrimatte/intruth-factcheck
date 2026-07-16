# Changelog

All notable changes are documented here. This project uses semantic versions for the checked-in extension.

## [2.0.2] - Unreleased

### Changed

- The overlay uses one 16 px content gutter, clearer copy, readable live transcript typography, and structured empty states.
- Claims and verdicts render newest first so the live panel follows the current point in the video.
- User-facing verdict labels now describe evidence support instead of presenting model states as absolute truth.
- Claim rows, status labels, and verdict cards use distinct green, teal, red, amber, gray, and rose treatments derived from the original visual system.

### Fixed

- Claim numbers and empty-state copy can no longer lose their left gutter to the generic list reset.

## [2.0.1] - 2026-07-16

### Fixed

- Offscreen audio capture now obtains the Deepgram credential through an authenticated service-worker response instead of calling the unavailable `chrome.storage` API.
- Failed startup responses no longer leave the popup in a misleading `Retry stop` state after rollback has completed.

## [2.0.0] - 2026-07-16

### Added

- Bring-your-own-key configuration for Anthropic, Deepgram, and Serper with an explicit data-flow consent step.
- Evidence-first claim states, immutable session/claim identifiers, citation metadata, and first-class abstention/error results.
- Manifest and HTML reference validation, embedded-secret detection, syntax checks, unit tests, CI, and a reproducible unpacked build artifact.
- Privacy, security, architecture, and contribution documentation.
- Accessible status announcements, responsive overlay behavior, source details, and reduced-motion support.
- Closed-Shadow-DOM overlay isolation, stylesheet/visibility integrity checks, and a worker watchdog that stops invisible capture.
- A persisted terminal-result outbox with bounded retry and Manifest V3 restart recovery.
- ASR-confidence gating, exact transcript provenance, and numeric, negation, entity, and qualifier preservation checks.
- Efficient/Balanced model routing, multilingual auto-transcription, visible token/cost counters, and configurable Anthropic session guards.
- Pipeline activity feedback that distinguishes no detected claim, rejected candidates, evidence verification, and budget exhaustion.

### Changed

- Fast model output is used only to identify candidate claims; it is no longer displayed as a factual verdict.
- Search failures and insufficient evidence now prevent categorical results.
- Provider and WebSocket operations use explicit timeouts, structured failures, and cleanup.
- Deepgram uses Nova-3 with bounded buffering, speaker-safe word segmentation, 300 ms endpointing, and graceful final-stream draining.
- Anthropic structured-tool requests use pinned Haiku 4.5 for extraction; Efficient mode also verifies with Haiku, while Balanced mode reserves the Sonnet 5 API contract for evidence-bearing verdicts. Snippet-only verdict confidence is capped at `MEDIUM`.
- Transcript analysis uses adaptive six-utterance/token batching, a bounded 12-second idle deadline, four-utterance context, local invariant-aware deduplication, and no automatic retry after an uncertain paid Anthropic timeout.
- The report action accurately exports HTML instead of claiming to create a PDF.
- Remote font requests were removed, and the icon assets are valid transparent PNG files.

### Fixed

- Public checkouts now reference checked-in runtime files and can be loaded without private source files.
- Late asynchronous work cannot update a different capture session.
- Unicode claims no longer collapse to the same empty deduplication key.
- Unsupported-page startup, final transcript flushing, speaker interim double-counting, and dangling drag listeners.
- Start/stop/reconnect races, cross-tab popup state, terminal-card delivery loss, and page-removable overlay capture.
- Decimal numbers and dotted dates are no longer split into separate transcript sentences.
- Italian clitics and typographic punctuation, repeated numeric/negation quotes, CJK tokenization, overly strict sensitive-ASR thresholds, and silent empty-pipeline states.
