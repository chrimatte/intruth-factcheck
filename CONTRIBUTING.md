# Contributing

Thank you for improving InTruth. Changes should make uncertainty more visible, keep user data flows explicit, and preserve the user's ability to inspect evidence.

## Local workflow

1. Create a focused branch from the current default branch.
2. Use Node.js 20 or later.
3. Run `npm run ci` before opening a pull request.
4. Load `dist/intruth` through `chrome://extensions` and exercise the changed path on a supported page.
5. Include screenshots for popup or overlay changes and describe any new provider data flow.

There are no runtime npm dependencies. Avoid adding one for behavior that can be implemented safely with browser or Node platform APIs.

## Required manual checks

- Start is blocked on unsupported URLs and incomplete consent/configuration.
- A failed start leaves no offscreen capture running.
- Stop closes capture and prevents late results from updating a new session.
- Claims appear as neutral while checking.
- Retrieval failure becomes `UNVERIFIABLE` or a visible error, never an uncited categorical verdict.
- Source links display meaningful metadata and open safely.
- Keyboard navigation, focus visibility, status announcements, reduced motion, and narrow viewports work.
- No provider credential appears in source, console output, report export, or the built artifact.

## Pull requests

Keep changes reviewable and document observable behavior, limitations, and tests. Changes to a verdict category, evidence rule, prompt, supported language, permission, provider, or retention behavior must update the relevant tests and documentation.

Do not use real credentials or sensitive transcripts in tests. Use synthetic fixtures and explicit malformed/error cases, including 401, 429, 5xx, timeout, missing evidence, stale session, prompt-injection text, non-Latin claims, and ASR uncertainty.
