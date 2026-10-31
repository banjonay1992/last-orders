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
