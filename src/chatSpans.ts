// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-claude-code

import type { AssistantResponse } from './parser.js';
import type { Message } from '@coreweave/forge-sdk/agentlens/tracing';
import {
  ATTR,
  buildUsage,
  contentBlocksToParts,
  parseTimestamp,
  providerFromModel,
} from './genaiSpans.js';
import type { SpanParent } from './genaiSpans.js';

type ChatOptions = {
  agentName?: string;
  /** Used by blockable/repeated stop hooks to emit each response once. */
  seen?: Set<string>;
  /** Recorded on the turn's first chat span; the root span exports only at turn close. */
  userMessage?: string;
};

function responseKey(response: AssistantResponse, index: number): string {
  return response.id
    ? `id:${response.id}:${index}`
    : `legacy:${response.startTime ?? ''}:${response.endTime ?? ''}:${index}`;
}

/** Emit one LLM span per normalized provider response. */
export function emitChatSpans(
  parent: SpanParent,
  responses: AssistantResponse[],
  options: ChatOptions = {},
): void {
  let userMessage = options.userMessage;
  let toolResults: NonNullable<AssistantResponse['toolResults']> = [];
  for (const [index, response] of responses.entries()) {
    toolResults.push(...response.toolResults ?? []);
    const key = responseKey(response, index);
    if (!response.model) continue;
    if (options.seen?.has(key)) {
      userMessage = undefined;
      toolResults = [];
      continue;
    }

    const inputMessages: Message[] = [];
    if (userMessage) inputMessages.push({ role: 'user', parts: [{ type: 'text', content: userMessage }] });
    if (toolResults.length) inputMessages.push({
      role: 'tool',
      parts: toolResults.map(result => ({ type: 'tool_call_response', ...result })),
    });

    const provider = providerFromModel(response.model);
    const llm = parent.startLLM({
      model: response.model,
      ...(provider ? { providerName: provider } : {}),
      startTime: parseTimestamp(response.startTime ?? response.endTime) ?? new Date(),
    });
    const parts = contentBlocksToParts(response.content);
    llm.record({
      ...(inputMessages.length ? { inputMessages } : {}),
      ...(parts.length ? { outputMessages: [{ role: 'assistant', parts }] } : {}),
      usage: buildUsage(response.usage, response.reasoningTokens),
      outputType: 'text',
      ...(response.id ? { responseId: response.id } : {}),
      ...(response.finishReason ? { finishReasons: [response.finishReason] } : {}),
    });
    if (options.agentName) llm.setAttributes({ [ATTR.AGENT_NAME]: options.agentName });
    llm.end({ endTime: parseTimestamp(response.endTime) ?? new Date() });
    options.seen?.add(key);
    userMessage = undefined;
    toolResults = [];
  }
}
