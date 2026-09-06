# terminal-helper

An IDE-grade terminal wrapper for Claude Code, built on the official Agent SDK.

Surfaces what the CLI hides: live subagent reasoning (tiled, concurrent), the
execution timeline, whole-tree token/cost accounting, the raw API wire traffic,
and a browser for the skills/memories/MCP config that shapes Claude's behavior.

## Status

Under construction. See the plan for milestones.

- **M0** scaffold ✅
- **M1** read-only inspector — transcript parser + agent tree ✅, UI in progress
- **M2** live single session
- **M3** tabs + live subagent visualization *(the centerpiece)*
- **M4** config browser
- **M5** proxy: API inspector + model switching

## Run

```bash
bun install
bun run dev      # launch the app
bun test         # unit tests
```

## Design notes

**The transcript format is undocumented.** `src/data/transcript.ts` and
`src/data/agentTree.ts` are written to degrade rather than fail: unparseable
lines are skipped and counted, unknown record types ignored. They are the
highest-churn-risk code in the app and are isolated behind that boundary.

**Two id spaces.** Subagent logs are keyed by a hex `agentId`; the main
transcript keys the same agent by the spawning `toolu_...` tool_use id. The
`agent-<id>.meta.json` sidecars supply the mapping. Without it every subagent
appears as two disjoint nodes (verified: 181 nodes vs. the correct 91).

**Cost comes from `modelUsage`, never `usage`.** On a result message, `usage`
excludes subagent tokens entirely. Per-step `output_tokens` on assistant
messages is a placeholder that only resolves on the result message.

**`~/.claude.json` is read-only to this app, permanently.** It holds live
credentials and ~600 keys of server cache; round-tripping it risks dropping
unknown keys and clobbering concurrent CLI writes. Config writes go to
`~/.claude/settings.json` only.
