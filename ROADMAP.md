# Roadmap

Estimates are rough working hours for one person, including tests and documentation.

## Next

These close the most obvious gaps before running Last Orders in a real pub.

- **Browser end-to-end tests (about 5 hours).** Add Playwright and script a full game with a host, a big screen and three teams in separate browser contexts: joining, a timed question running out, a buzzer round, a joker, a dropped connection that resumes, and the tie-breaker. Run them on a phone-sized and a laptop-sized viewport in CI.
- **Rate limiting (about 3 hours).** Limit room creation and `auth.join` attempts per client IP with Cloudflare's rate limiting binding, return a clear error to the client, and document the setting. Also cap commands per socket per second inside the room so one misbehaving phone cannot flood the host.
- **Undo for the host (about 4 hours).** Keep a short history of reducer states in the room (for example the last 20 host actions, excluding team submissions) and add `host.undo`. Mis-tapping "right" on the wrong buzzer is the most likely mistake on a busy night.
- **Wrong-buzz penalty (about 2 hours).** An optional per-round `buzzPenalty` in the quiz format, applied in `teamScores`, shown on the host buttons and covered by the editor and tests.
- **Answer grace window (about 2 hours).** An optional room setting of up to one second that still accepts an answer stamped just after the deadline, to be fair to slow mobile connections. Show the setting on the host console and keep the strict behaviour as the default.
- **Freeze the scoreboard (about 2 hours).** A host toggle that stops the big screen and phones updating scores during the final round, then reveals the final standings in one go.
- **Second phone for a team (about 3 hours).** A "add another phone" QR code on the team view that carries the resume token, so a team can answer from more than one device. The room already accepts several sockets per team.

## Then

- **Image uploads (about 6 hours).** Let the editor upload pictures to an R2 bucket owned by the deployer, with type and size checks, so quiz writers do not need to host images elsewhere. Keep URLs working as they do now.
- **Several-part answers (about 6 hours).** A new question type such as "name three of the five Great Lakes" with per-item matching, partial points and marking in the host table.
- **Co-host link (about 4 hours).** A second, separate token that can mark answers and adjust scores but cannot load quizzes, reset or close the room, for a helper with a tablet.
- **Results export (about 2 hours).** A host button that downloads final standings and per-round scores as CSV, generated in the browser from the host view. Nicknames only.
- **Moderation (about 2 hours).** Let the host rename a team as well as remove it, and support an optional word list the deployer can supply to refuse obviously offensive names at join time.
- **Translation (about 5 hours).** Move UI strings into a message catalogue, add Welsh and Cornish as the first translations, and let the host pick the language for the big screen and phones.
- **Storage write batching (about 2 hours).** Measure write volume during a busy timed question and, if needed, coalesce answer writes within a short window while keeping the reveal and lock writes immediate.

## Later

- **Accessibility review (about 4 hours).** Test the team view with VoiceOver and TalkBack on real phones, add a high-contrast theme option and an option to show the question in a larger font on phones.
- **Quiz library (about 8 hours).** A simple shared library of quizzes published by the deployer, with signed read-only links, so a pub can rotate quizzes without passing files around.
- **Picture round sheets (about 3 hours).** Print a handout of all pictures in a round for tables without a good view of the TV.
- **Latency display (about 2 hours).** Show the host an estimate of each team's connection delay, measured with ping timings, to help explain buzz order disputes.
