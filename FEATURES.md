# terminal-helper vs. plain Claude Code

The ship gate: at least ten things this does that `claude` in iTerm cannot.
Every row was verified against real data on this machine, not asserted.

| # | Feature | Plain Claude Code | Verified by |
|---|---|---|---|
| 1 | **Live subagent reasoning, tiled** — N agents thinking side by side, each with its own scrollback | Collapsed spinner tree; reasoning discarded | 3 parallel Explore agents each streaming prompt, text and Bash calls |
| 2 | **Subagent timeline** — real parallelism vs. serialization on a wall clock | Not available | 8 agents over the 90-subagent session, overlap matching raw timestamps |
| 3 | **Per-agent detail** — exact prompt, full transcript, tools, cost | Requires digging through raw JSONL | AgentDetail strip; `agent-*.jsonl` join |
| 4 | **Nested fan-out tree** — agents spawning agents, correct depth | Flattened at best | `parent_tool_use_id` chain; depth asserted in tests |
| 5 | **Raw API inspector** — full wire request/response, copy-as-curl | Not available at any verbosity | 670 KB request captured, `authorization: ••••` redacted |
| 6 | **Whole-tree cost from `modelUsage`** — subagents included, per model | `/context` is main-loop, current-session only | `usage` excludes subagents by the SDK's own docs; tests cover it |
| 7 | **Historical cost across every past session** | Not available | 105 sessions enumerated, 875.9k tok on one replay |
| 8 | **Skills by cost-per-use** + live system-prompt budget | `/skills` lists; shows no cost, no usage | 57 skills / ~5,921 tokens; `investigate` 418 tok for 1 use |
| 9 | **Orphan-usage reporting** — used skills living outside the user dir | Not available | `backend-testing` 16×, `artifact-design` 12× |
| 10 | **Backend swap without losing the view** | Restart, new session | Same proxy URL across providers; conversation preserved |
| 11 | **Cache economics per request** | Not surfaced | 248,827 tokens written in 3.7 s, read back in 1.6 s |
| 12 | **Cost display that knows your billing** — hides dollars on a subscription | Always estimates | `apiKeySource=none` → "subscription", not a dollar figure |
| 13 | **Searchable memory browser** across projects | Manual file reading | 64 files, 3 indexes, 34 hits for "feedback" |
| 14 | **Agent-level stop** — mark one subagent stopped, not the turn | All-or-nothing `Esc` | `x` in tree/grid/timeline |

**14 of 14 demonstrable — gate met (≥10).**

## Numbers worth knowing

Measured on this machine, not estimated:

- **~670 KB per API request.** Your system prompt, skills, memories and tool
  definitions ride along on every call.
- **~5,921 tokens of skill descriptions every session**, from 57 skills. Six
  have ever been invoked. The browser sorts by cost-per-use so the decision is
  yours, not the tool's.
- **Prompt caching is doing real work**: a 248,827-token cache write costs
  3.7 s; reading it back costs 1.6 s.
