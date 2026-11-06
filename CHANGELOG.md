# Changelog

## 0.1.1 (2026-11-06)

- Agent Session Viewer asks one time for a Marketplace rating. It counts each session that opens in the viewer. After 5 of them, and no sooner than 2 days after the first, it shows a small message with "Rate it", "Later" and "Don't ask again". "Later" waits for 20 more, at most two more times. It never shows in your first session, more than once per session, when the window is not focused, or in a remote or untrusted workspace.
- New setting `agentSessionViewer.askForRating` (default `true`) turns it off. Nothing is sent anywhere; "Rate it" only opens the review page in your browser.
- Export to Markdown: a name typed in VS Code's simple save dialog no longer gets ".md" added twice ("notes.md.md"), and a name ending in ".jsonl" is refused as it should be, instead of being saved as "name.jsonl.md".
- The sample sessions made by `npm run fixtures` now number the lines of Read tool output 1, 2, 3, 4 (they showed 1, 2, 2, 2).

## 0.1.0

First release.

- Activity bar tree of Claude Code and Codex sessions, grouped by project folder, with date, first prompt, turn count and size.
- Session view with turns, collapsed tool calls with input and output, file edits as diffs, collapsed thinking and reasoning, and indented subagent turns.
- Header with model, project, branch, times, duration and token totals, plus the cost when the file records it.
- Search across all sessions, streamed, with cancel.
- Markdown export, with an option to leave out tool outputs.
- Copy resume command for both tools.
- Custom editor for session files, detected from the first 20 records.
- Read-only. No network calls and no telemetry.
