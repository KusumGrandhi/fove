/**
 * Types for Claude Code's on-disk transcript format.
 *
 * IMPORTANT: this format is UNDOCUMENTED and is the highest churn risk in the
 * app. Everything here is derived from observation of real transcripts, not
 * from a published contract. Treat every field as optional and every record
 * type as potentially unknown -- see parseLine() in transcript.ts, which skips
 * what it cannot understand rather than throwing.
 */

/** Token counts as reported by the API. */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
}

/** Per-model breakdown from a result message. The ONLY whole-tree-accurate source. */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  costBasis?: "list" | "managed" | "unknown";
}

export type ContentBlock =
  | { type: "text"; text?: string }
  | { type: "thinking"; thinking?: string; signature?: string }
  | { type: "tool_use"; id?: string; name?: string; input?: unknown }
  | { type: "tool_result"; tool_use_id?: string; content?: unknown; is_error?: boolean }
  | { type: "image"; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

export interface InnerMessage {
  id?: string;
  model?: string;
  role?: string;
  content?: ContentBlock[] | string;
  usage?: Usage;
}

/**
 * One line of a transcript .jsonl. Heterogeneous: `type` distinguishes message
 * records (user/assistant) from bookkeeping records (queue-operation,
 * file-history-snapshot, ai-title, ...). We only model what we use.
 */
export interface TranscriptRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  message?: InnerMessage;

  // Subagent markers.
  isSidechain?: boolean;
  agentId?: string;
  /** Links a subagent record back to the Agent tool_use that spawned it. */
  sourceToolAssistantUUID?: string;
  /** Present on SDK stream messages; the spawning Agent tool_use id. */
  parent_tool_use_id?: string | null;

  // Context.
  cwd?: string;
  gitBranch?: string;
  version?: string;
  toolUseResult?: unknown;

  [k: string]: unknown;
}

export type AgentStatus = "queued" | "running" | "done" | "error";

/** One node in the reconstructed subagent tree. */
export interface AgentNode {
  /** The Agent tool_use id that spawned this agent. Root uses "root". */
  id: string;
  parentId: string | null;
  name: string;
  /** Human task description from the spawning call, e.g. "Re-adjudicate FN batch 0". */
  label?: string;
  model?: string;
  status: AgentStatus;
  startedAt?: number;
  endedAt?: number;
  usage: Usage;
  costUSD?: number;
  toolCalls: ToolCall[];
  /** Live reasoning/text stream. Bounded -- see MAX_TRANSCRIPT_ENTRIES. */
  transcript: TranscriptEntry[];
  /** Files this agent wrote, for collision detection in AgentDiff. */
  filesTouched: Set<string>;
  depth: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input?: unknown;
  startedAt?: number;
  endedAt?: number;
  isError?: boolean;
  resultPreview?: string;
}

export interface TranscriptEntry {
  kind: "text" | "thinking" | "tool_use" | "tool_result";
  text: string;
  at?: number;
}

export interface SessionSummary {
  sessionId: string;
  projectSlug: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  /** Populated only on demand -- scanning every transcript is expensive. */
  firstPrompt?: string;
  messageCount?: number;
  subagentCount?: number;
}
