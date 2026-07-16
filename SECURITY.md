# Security policy

## Supported versions

Security fixes are applied to the latest 2.x release line. Older packages and unpublished Chrome Web Store builds may not contain the protections described in this repository.

## Reporting a vulnerability

Use a private GitHub Security Advisory when available. If private reporting is unavailable, open a minimal issue asking for a secure contact channel. Do not post API keys, transcripts, exploit details, browser-profile data, or provider responses in a public issue.

Include the affected version and commit, Chrome version, reproduction preconditions, impact, and the smallest safe proof of concept. Maintainers should acknowledge a private report promptly, keep the reporter informed, and credit the reporter if requested after a fix is available.

## Credential model

No provider key belongs in source, a build artifact, logs, screenshots, reports, or test fixtures. InTruth uses user-supplied, revocable credentials and restricts Chrome local storage to trusted extension contexts. This reduces exposure to supported webpages but does not protect against a compromised browser profile, extension context, operating system, or device.

Use provider-side budgets, scope restrictions where available, usage alerts, and regular key rotation. Revoke a key immediately if it appears in Git history or an issue; deleting the visible string is not sufficient.

## Trust boundaries

Audio, transcripts, page titles, search queries, search results, and model responses are untrusted. A safe change must preserve:

- explicit user action and consent before capture;
- supported-origin preflight before creating a stream;
- immutable session and claim IDs on asynchronous work;
- strict validation of provider responses and verdict enums;
- evidence gating and an explicit abstention path;
- output escaping and safe external links;
- cleanup after startup failure, stop, disconnect, or service-worker restart.

Never make truthfulness depend on speaking style, confidence, political position, or inferred identity.
