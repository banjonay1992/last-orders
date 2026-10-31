# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/).

## [0.1.0] - 2026-10-31

The first working version.

### Added

- Cloudflare Worker with one Durable Object per room, using WebSocket hibernation, per-question storage keys and an alarm for question deadlines and idle-room deletion.
- Pure, deterministic game reducer covering joining, resume tokens, multiple choice and free-text questions, buzzer rounds with server-side ordering, answer locking at lock and reveal, late-answer rejection by server time, host marking, jokers, score adjustments, removing teams, resetting and a closest-guess tie-breaker.
- Typed message protocol shared by the server and clients, with zod validation of everything clients send.
- Host console with a running-order navigator, keyboard shortcuts, fuzzy marking hints and local audio playback for music rounds.
- Mobile-first team view with large controls, a touch-down buzzer, automatic reconnection and a screen wake lock.
- Big-screen view with a locally drawn QR code, countdowns, buzz order, reveals and scores.
- Quiz editor with live validation, browser drafts and JSON import and export.
- Sample quiz with original questions, pictures and synthesised audio clips.
- Unit tests and Workers runtime integration tests, GitHub Actions CI, and documentation of the quiz format.
- Screenshots of a sample game, and deployment instructions for Workers Builds.

### Security

- Per-IP rate limits on room creation, room lookups and WebSocket connections, using Cloudflare rate limiting bindings with an in-memory fallback.
- A message budget for each WebSocket in the room; floods are dropped with a warning and persistent floods are disconnected.
- Tests that only the long random host token, never the room code or another room's token, grants host control, and that the token is never sent to teams or the big screen.

### Fixed

- Big screen option letters now line up with their badges, scores are readable on a TV, and the host toolbar wraps tidily on narrower laptops.
