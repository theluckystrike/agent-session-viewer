# Changelog

## 0.2.0 (2026-11-07)

- Resume in terminal. A new button in the session view, an icon on each session in the tree and a command open a VS Code terminal in the session's project folder and type `claude --resume <id>` or `codex resume <id>`. If the folder no longer exists, the terminal opens in the default folder and a note says so. Copy resume command is still there.
- Subagents sit under the session that started them. Claude Code subagent runs, which Claude Code now saves as separate files in `<session>/subagents/`, show up for the first time, named by their type and task (for example "Subagent Explore: Check error handling of callers"). Codex subagent threads move under their parent thread and are named by their nickname and task, instead of showing as a bare `rollout-…` file name. The tree header counts sessions and subagents apart.
- Codex thread names. Names from Codex's `session_index.jsonl`, including threads you renamed, are used as titles in the tree and the session view.
- Find in this session. A find box in the session toolbar counts matches ("2 of 5") across the whole session, including collapsed tool inputs, outputs, diffs and thinking, and opens each match as you step through with Enter, Shift+Enter or the arrows. After Search Sessions, the session opens with your search words already in the box.
- The Marketplace description and keywords now mention resume and subagents.

## 0.1.5 (2026-11-07)

- The footer under the viewer has a "Rate" link next to Sponsor and More free viewers. It opens the review page of this extension on the Marketplace. Nothing pops up and nothing asks you for a rating. "Hide" still hides the whole line.
- The Marketplace description now opens with "Claude Code history and Codex history viewer".
- Marketplace search keywords updated.

## 0.1.4 (2026-11-07)

- The "More free viewers" list and the README list now show the 15 Zovo extensions on the Marketplace under their current names, and 12 that are coming soon.
- Extensions for related files now come first, starting with Claude Code Usage & Codex Usage Cost Meter and JSONL Viewer & NDJSON Table Viewer.

## 0.1.3 (2026-11-07)

- The Marketplace name is now "Claude Code History & Codex History Viewer", so a search for Claude Code history or Codex history finds it. The extension ID, settings and commands stay the same, and the views still say Agent Session Viewer.

## 0.1.2 (2026-11-06)

- A small line at the end of each session view has two links, "Sponsor" (GitHub Sponsors) and "More free viewers". The new setting `agentSessionViewer.showSupportLinks` (default `true`) hides it, and so does the "Hide" link next to them. There is no popup, and nothing is sent anywhere.
- New commands "Agent Sessions: Support the developer" and "Agent Sessions: More free viewers". The second one lists the other Zovo extensions and installs only the one you pick. Ones that are not on the Marketplace yet open their GitHub page.
- The listing gets a Sponsor button. The README has a short Support section and lists all Zovo extensions.

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
