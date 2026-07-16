# Privacy notice

Last updated: 16 July 2026

InTruth runs as a browser extension and does not use a developer-operated backend, analytics service, advertising SDK, or telemetry collector. It does send data directly from the user's browser to the three providers the user configures. Capture starts only after an explicit action and consent in the popup.

## Data flow

| Data | Recipient | Purpose | Trigger |
| --- | --- | --- | --- |
| Active-tab audio | Deepgram | Streaming speech-to-text and speaker diarization | User starts a session |
| Transcript excerpts and page context | Anthropic | Classify salient factual claims and opinions | Final transcript segments arrive |
| Self-contained factual-claim search query | Serper | Retrieve current web evidence | A factual claim is detected; opinions bypass this stage |
| Factual claim and retrieved evidence | Anthropic | Produce an evidence-grounded result | Evidence retrieval completes and the session budget allows it; opinions bypass this stage |

The respective provider credential is sent only to that provider. The extension developer does not receive provider requests or credentials.

## Local storage and retention

Chrome local extension storage contains the three API keys, language and analysis preferences, Anthropic session-budget preference, and consent choice. The extension limits that storage to trusted extension contexts; supported webpages cannot read it through the injected content script. The values remain until extension data is cleared, the extension is removed, or the user replaces them.

Chrome's memory-backed session storage temporarily holds the active session identity and capture state, aggregate provider token/cost counters, and a bounded set of pending claims. A pending record can include the claim, short transcript source quotes, experimental lexical markers, and an undelivered result with its cited source snippets and links. This lets a restarted Manifest V3 service worker preserve the session budget, end interrupted work safely, and retry delivery of a terminal card instead of leaving a claim indefinitely marked as checking. The record is restricted to trusted extension contexts and cleared when the session stops, startup rolls back, or recovery finds no valid capture; after an unexpected browser or extension failure it may remain only until cleanup next runs or the browser session ends.

Transcript cards and verdicts are also held in the supported page while the isolated overlay exists. InTruth does not upload an exported report: choosing **Export report** creates a local HTML download under the user's control. That file contains the completed statements and verdicts, cited-source metadata and excerpts, up to six bounded exact claim-source transcript excerpts and utterance IDs per statement, and up to 40 sanitized capture/recovery events with timeline epoch and media time. It does not contain the full transcript, provider keys, or provider error messages.

Chrome extension storage is not guaranteed to encrypt API credentials against a person or process with access to the browser profile or device. Users should create restricted, revocable provider keys, monitor provider usage, and rotate any key they believe is exposed.

## Third-party processing

Deepgram, Anthropic, and Serper independently control their infrastructure, logs, retention, account settings, and legal compliance. Their terms and privacy policies apply to data sent to them. Users should review the policies and configure their provider accounts before granting consent. InTruth cannot delete data retained by a provider; users must use that provider's account controls or support process.

## User controls

- Start and stop determine when active-tab audio capture occurs.
- Efficient/Balanced mode controls whether evidence verdicts use Haiku 4.5 or Sonnet 5.
- The Anthropic session guard pauses new claim analysis at the selected estimated cost while transcription remains active. The estimate does not include Deepgram or Serper and may differ from provider billing.
- The popup explains the recipients before first capture and requires consent.
- Clearing InTruth's site/extension data in Chrome removes locally stored settings and credentials.
- Uninstalling the extension removes its Chrome-managed local and session storage.
- Provider keys can be revoked independently in each provider account.

Stopping the extension prevents new capture and requests; a request already accepted by a provider may still finish under that provider's rules.

## What InTruth does not do

InTruth does not sell data, build advertising profiles, track browsing across unrelated sites, or infer identity for advertising. It does not intentionally collect data from unsupported pages. The extension processes only the active supported tab after the user starts a session.

## Changes and questions

Material changes to data handling should update this file, the in-product disclosure, the Chrome Web Store disclosure, and the changelog in the same release. Privacy questions and bug reports can be opened in the repository without including transcripts, credentials, or other sensitive data.
