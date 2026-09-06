# terminal-helper

An IDE-grade terminal wrapper for Claude Code, built on the official Agent SDK.

Surfaces what the CLI hides: live subagent reasoning (tiled, concurrent), the
execution timeline, whole-tree token/cost accounting, the raw API wire traffic,
and a browser for the skills/memories/MCP config that shapes Claude's behavior.

## Status

Under construction. See the plan for milestones.

- **M0** scaffold ✅
- **M1** read-only inspector — parser, agent tree, timeline, session browser ✅
- **M2** live single session — SDK streaming, permissions, model info ✅
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

**OpenTUI does not clip text to its container.** It emits the full string and
lets the terminal wrap, which collapses a row-based layout. Every row is
therefore clipped explicitly with `fit()`, and row boxes carry
`width: "100%"` + `flexShrink: 0` so they do not shrink to content and overlap.

**Bun needs `preload = ["@opentui/solid/preload"]`** in `bunfig.toml`, or
`render()` dies inside `createRoot`: solid-js's export map lists `node` (the SSR
stub) ahead of the client build, and neither a `conditions` entry nor
`--conditions=solid` overrides it.

**Debug logging must go to a file, not `console.*`.** OpenTUI restores the
terminal on exit, which swallows anything written to stdout/stderr from inside
the render loop. A `console.error` that never appears is not proof the code
did not run -- append to a file instead. (This cost an hour of chasing a
non-existent SDK stall.)

**In streaming-input mode the SDK emits nothing until the first prompt is
queued** -- not even `system/init`. So `sessionId`, `model`, `apiKeySource` and
the tool list are unknown until the user's first turn; the UI renders an
"unknown" state rather than blocking on init. `LiveSession.ready` resolves when
init lands.

**`~/.claude.json` is read-only to this app, permanently.** It holds live
credentials and ~600 keys of server cache; round-tripping it risks dropping
unknown keys and clobbering concurrent CLI writes. Config writes go to
`~/.claude/settings.json` only.
