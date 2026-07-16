# Changelog

All notable changes are documented here. This project uses semantic versions for the checked-in extension.

## [2.0.0] - Unreleased

### Added

- Bring-your-own-key configuration for Anthropic, Deepgram, and Serper with an explicit data-flow consent step.
- Evidence-first claim states, immutable session/claim identifiers, citation metadata, and first-class abstention/error results.
- Manifest and HTML reference validation, embedded-secret detection, syntax checks, unit tests, CI, and a reproducible unpacked build artifact.
- Privacy, security, architecture, and contribution documentation.
- Accessible status announcements, responsive overlay behavior, source details, and reduced-motion support.
- Closed-Shadow-DOM overlay isolation, stylesheet/visibility integrity checks, and a worker watchdog that stops invisible capture.
- A persisted terminal-result outbox with bounded retry and Manifest V3 restart recovery.
- ASR-confidence gating, exact transcript provenance, and numeric, negation, entity, and qualifier preservation checks.

### Changed

- Fast model output is used only to identify candidate claims; it is no longer displayed as a factual verdict.
- Search failures and insufficient evidence now prevent categorical results.
- Provider and WebSocket operations use explicit timeouts, structured failures, and cleanup.
- Deepgram uses Nova-3 with bounded buffering, speaker-safe word segmentation, 300 ms endpointing, and graceful final-stream draining.
- Anthropic structured-tool requests use the Sonnet 5 API contract, and snippet-only verdict confidence is capped at `MEDIUM`.
- The report action accurately exports HTML instead of claiming to create a PDF.
- Remote font requests were removed, and the icon assets are valid transparent PNG files.

### Fixed

- Public checkouts now reference checked-in runtime files and can be loaded without private source files.
- Late asynchronous work cannot update a different capture session.
- Unicode claims no longer collapse to the same empty deduplication key.
- Unsupported-page startup, final transcript flushing, speaker interim double-counting, and dangling drag listeners.
- Start/stop/reconnect races, cross-tab popup state, terminal-card delivery loss, and page-removable overlay capture.
- Decimal numbers and dotted dates are no longer split into separate transcript sentences.
