# Sessions view

The Agent Sessions icon in the activity bar lists your sessions:

- Claude Code: `~/.claude/projects/<project>/<session>.jsonl`
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`

Each session shows its date, first prompt, turn count and size. To read other folders, set `agentSessionViewer.claudeRoots` or `agentSessionViewer.codexRoots`.

The extension only reads these files. It never changes, moves or deletes them.
