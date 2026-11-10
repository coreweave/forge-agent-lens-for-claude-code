// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-claude-code

// Attribute-key constants and formatting helpers typed against the Forge SDK.

import type { Attributes } from '@opentelemetry/api';
import type { Message, MessagePart, SubAgent, Tool, Turn, Usage } from '@coreweave/forge-sdk/agentlens/tracing';
import { isTextBlock, isThinkingBlock, isRedactedThinkingBlock, isToolUseBlock } from './parser.js';
import type { UsageSummary } from './parser.js';
import { jsonStr } from './utils.js';

/** Forge's two public invoke-agent handles that can own chat, tool, and
 * subagent spans. The SDK does not currently export a common parent type. */
export type SpanParent = Turn | SubAgent;

// Attribute keys: `gen_ai.*` from the OTel GenAI semconv
// (https://github.com/open-telemetry/semantic-conventions-genai); `forge.*`
// are this integration's extensions, which the backend routes into its
// queryable custom-attribute maps. The remaining `weave.*` keys belong to the
// Weave backend: `weave.compaction.*` has dedicated columns.

export const ATTR = {
  // GenAI semconv - classification
  OPERATION_NAME: 'gen_ai.operation.name',

  // GenAI semconv - agent
  AGENT_NAME: 'gen_ai.agent.name',
  AGENT_ID: 'gen_ai.agent.id',
  CONVERSATION_ID: 'gen_ai.conversation.id',

  // GenAI semconv - model
  RESPONSE_MODEL: 'gen_ai.response.model',
  RESPONSE_ID: 'gen_ai.response.id',
  RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',

  // GenAI semconv - usage
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  USAGE_CACHE_READ_INPUT_TOKENS: 'gen_ai.usage.cache_read.input_tokens',
  USAGE_CACHE_CREATION_INPUT_TOKENS: 'gen_ai.usage.cache_creation.input_tokens',

  // GenAI semconv - messages
  INPUT_MESSAGES: 'gen_ai.input.messages',
  OUTPUT_MESSAGES: 'gen_ai.output.messages',
  SYSTEM_INSTRUCTIONS: 'gen_ai.system_instructions',

  // GenAI semconv - errors
  ERROR_TYPE: 'error.type',

  // Forge extensions - claude_code per-turn metadata
  FORGE_CWD: 'forge.claude_code.cwd',
  FORGE_SOURCE: 'forge.claude_code.source',
  FORGE_PLUGIN_VERSION: 'forge.claude_code.plugin.version',
  FORGE_ORPHAN_REASON: 'forge.claude_code.orphan_reason',

  // Integration identity, named as the Forge SDK's own integrations name it.
  // Unlike gen_ai.agent.name, not user-overridable and never changes per
  // subagent. Set on the conversation; propagated to every span.
  FORGE_INTEGRATION_NAME: 'forge.integration.name',
  FORGE_INTEGRATION_VERSION: 'forge.integration.version',

  // Back-pointer from a subagent's invoke_agent span to the tool_use_id of
  // the Agent call that spawned it (correlation without walking the tree).
  FORGE_SUBAGENT_SPAWNING_TOOL_CALL_ID: 'forge.claude_code.subagent.spawning_tool_call_id',

  // CoreWeave Forge AgentLens backend - compaction
  COMPACTION_SUMMARY: 'weave.compaction.summary',
  COMPACTION_ITEMS_BEFORE: 'weave.compaction.items_before',
  COMPACTION_ITEMS_AFTER: 'weave.compaction.items_after',

  // Permission span events
  EVT_PERMISSION_REQUEST: 'forge.permission_request',
  EVT_PERMISSION_RESOLVED: 'forge.permission_resolved',
  EVT_PERMISSION_APPROVED: 'forge.permission.approved',
  EVT_PERMISSION_SUGGESTIONS: 'forge.permission.suggestions',
} as const;

/** Top-level `gen_ai.agent.name` fallback; users override via settings
 *  `agent_name` / `FORGE_CLAUDE_CODE_AGENT_NAME`. */
export const DEFAULT_AGENT_NAME = 'claude-code';

const INTEGRATION_NAME = 'forge-agent-lens-for-claude-code';

/** Free-form integration metadata prefix: new fields (e.g.
 *  `claude_code_app_version`) need no new attribute constant. */
const FORGE_INTEGRATION_META_PREFIX = 'forge.integration.meta.';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Derive `gen_ai.provider.name` from a model id; undefined when the routing
 *  layer is ambiguous - better to omit than guess. */
export function providerFromModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  if (/^(us\.)?anthropic\./i.test(model)) return 'aws.bedrock';
  if (/^claude-/i.test(model)) return 'anthropic';
  return undefined;
}

/** Plain assistant messages for turn and subagent `invoke_agent` spans;
 *  the SDK serializes them at `end()` (chat spans carry parts instead). */
export function assistantOutputMessages(texts: string[]): Message[] {
  return texts.map((content) => ({ role: 'assistant', content }));
}

/** Parse an ISO timestamp; returns undefined for missing or unparseable input. */
export function parseTimestamp(ts: string | undefined): Date | undefined {
  if (!ts) return undefined;
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

/** Per-session integration attributes; `meta` flattens to
 *  `forge.integration.meta.<key>` (falsy values skipped). */
export function buildIntegrationAttrs(args: {
  version: string;
  meta?: Record<string, string | undefined>;
}): Attributes {
  const attrs: Attributes = {
    [ATTR.FORGE_INTEGRATION_NAME]: INTEGRATION_NAME,
    [ATTR.FORGE_INTEGRATION_VERSION]: args.version,
  };
  if (args.meta) {
    for (const [key, value] of Object.entries(args.meta)) {
      if (value) attrs[`${FORGE_INTEGRATION_META_PREFIX}${key}`] = value;
    }
  }
  return attrs;
}

/** Map assistant content blocks to ordered `MessagePart`s so the model's
 *  natural interleave survives into a chat span's `gen_ai.output.messages`. */
export function contentBlocksToParts(blocks: unknown[]): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const block of blocks) {
    if (isTextBlock(block)) {
      if (block.text.trim()) parts.push({ type: 'text', content: block.text });
    } else if (isThinkingBlock(block)) {
      if (block.thinking.trim()) parts.push({ type: 'reasoning', content: block.thinking });
    } else if (isRedactedThinkingBlock(block)) {
      // Encrypted reasoning: a placeholder keeps its slot in transcript order.
      parts.push({ type: 'reasoning', content: '[redacted]' });
    } else if (isToolUseBlock(block)) {
      parts.push({
        type: 'tool_call',
        id: block.id,
        name: block.name,
        arguments: jsonStr(block.input),
      });
    }
  }
  return parts;
}

/** Anthropic usage → `Usage`. OTel inputTokens is the TOTAL prompt, so sum
 *  Anthropic's three disjoint fields (uncached + cache_read + cache_creation).
 *  https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/anthropic.md */
export function buildUsage(usage: UsageSummary, reasoningTokens?: number): Usage {
  const out: Usage = {
    inputTokens:
      usage.input_tokens
      + (usage.cache_read_input_tokens ?? 0)
      + (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens,
  };
  if (usage.cache_read_input_tokens !== undefined) {
    out.cacheReadInputTokens = usage.cache_read_input_tokens;
  }
  if (usage.cache_creation_input_tokens !== undefined) {
    out.cacheCreationInputTokens = usage.cache_creation_input_tokens;
  }
  if (reasoningTokens !== undefined && reasoningTokens > 0) {
    out.reasoningTokens = reasoningTokens;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Span events
// ─────────────────────────────────────────────────────────────────────────────

/** Added at PermissionRequest time. */
export function addPermissionRequestEvent(tool: Tool | SubAgent, args: { suggestions?: unknown; timestamp: Date }): void {
  const attrs: Attributes = {};
  if (args.suggestions !== undefined) {
    attrs[ATTR.EVT_PERMISSION_SUGGESTIONS] = jsonStr(args.suggestions);
  }
  tool.addEvent(ATTR.EVT_PERMISSION_REQUEST, attrs, args.timestamp);
}

/** Added when execution proves a dialog was approved, or when auto mode emits
 * a standalone PermissionDenied decision. */
export function addPermissionResolvedEvent(tool: Tool | SubAgent, args: { approved: boolean; timestamp: Date }): void {
  tool.addEvent(
    ATTR.EVT_PERMISSION_RESOLVED,
    { [ATTR.EVT_PERMISSION_APPROVED]: args.approved },
    args.timestamp,
  );
}

export interface CompactionAttrs {
  summary?: string;
  itemsBefore?: number;
  itemsAfter?: number;
}

/** Set `weave.compaction.*` on a turn (backend renders a context_compacted card).
 *  Session-level, but with no session span it rides the open (or next) turn. */
export function setCompactionAttrs(turn: Turn, attrs: CompactionAttrs): void {
  const out: Attributes = {};
  if (attrs.summary !== undefined) out[ATTR.COMPACTION_SUMMARY] = attrs.summary;
  if (attrs.itemsBefore !== undefined) out[ATTR.COMPACTION_ITEMS_BEFORE] = attrs.itemsBefore;
  if (attrs.itemsAfter !== undefined) out[ATTR.COMPACTION_ITEMS_AFTER] = attrs.itemsAfter;
  if (Object.keys(out).length) turn.setAttributes(out);
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Single-line preview of a value: whitespace collapsed, truncated with `…`. */
export function snippet(value: unknown, maxLen = 60): string {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + '…';
}
