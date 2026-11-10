// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-claude-code

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import * as tracing from '@coreweave/forge-sdk/agentlens/tracing';
import { ATTR } from '../src/genaiSpans.ts';
import { VERSION } from '../src/setup.ts';
import {
  flushForge,
  initForgeInMemory,
  makeGenaiDaemon,
  makeTranscript as makeAgentTranscript,
  spanParentId,
} from './helpers.ts';

type Transcript = {
  file: string;
  append(...entries: Record<string, unknown>[]): void;
};

function makeTranscript(t: TestContext, sessionId: string): Transcript {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.forge-turn-lifecycle-'));
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, '');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    file,
    append(...entries) {
      fs.appendFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    },
  };
}

function userEntry(
  text: string,
  options: { timestamp?: string; version?: string } = {},
): Record<string, unknown> {
  return {
    type: 'user',
    ...options,
    message: { role: 'user', content: text },
  };
}

function assistantEntry(
  id: string,
  text: string,
  options: {
    timestamp?: string;
    usage?: Record<string, number>;
    finishReason?: string;
  } = {},
): Record<string, unknown> {
  return {
    type: 'assistant',
    ...(options.timestamp ? { timestamp: options.timestamp } : {}),
    message: {
      role: 'assistant',
      id,
      model: 'claude-opus-4-8',
      usage: options.usage ?? { input_tokens: 100, output_tokens: 50 },
      content: [{ type: 'text', text }],
      ...(options.finishReason ? { stop_reason: options.finishReason } : {}),
    },
  };
}

function turns(spans: ReadableSpan[]): ReadableSpan[] {
  return spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent');
}

function chats(spans: ReadableSpan[]): ReadableSpan[] {
  return spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'chat');
}

for (const scenario of [
  { name: 'empty transcript', child: false, stale: false },
  { name: 'empty transcript with a child', child: true, stale: false },
  { name: 'stale transcript with a child', child: true, stale: true },
]) {
  test(`Stop keeps an unready root open until SessionEnd: ${scenario.name}`, async (t) => {
    const exporter = await initForgeInMemory();
    exporter.reset();
    const sessionId = `unready-stop-${scenario.child}-${scenario.stale}`;
    const transcript = makeTranscript(t, sessionId);
    const daemon = makeGenaiDaemon();
    const base = { session_id: sessionId, transcript_path: transcript.file, prompt_id: 'p1' };
    await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', ...base, prompt: 'work' });
    if (scenario.child) {
      await daemon.routeEvent({ hook_event_name: 'PreToolUse', ...base, tool_use_id: 'child', tool_name: 'Bash', tool_input: { command: 'pwd' } });
    }
    if (scenario.stale) {
      transcript.append(userEntry('work'), assistantEntry('working', 'working'));
    }
    await daemon.routeEvent({
      hook_event_name: 'Stop', ...base,
      ...(scenario.stale ? { last_assistant_message: 'finished' } : {}),
    });
    await flushForge();
    assert.equal(turns(exporter.getFinishedSpans()).length, 0);

    if (scenario.child) {
      await daemon.routeEvent({ hook_event_name: 'PostToolUse', ...base, tool_use_id: 'child', tool_name: 'Bash', tool_response: 'done' });
      await flushForge();
      assert.equal(turns(exporter.getFinishedSpans()).length, 0, 'child completion preserves an unready root');
    }
    if (!scenario.stale) transcript.append(userEntry('work'));
    transcript.append(assistantEntry('finished', 'finished', { finishReason: 'end_turn' }));
    await daemon.routeEvent({ hook_event_name: 'SessionEnd', ...base, reason: 'clear' });
    await flushForge();

    const roots = turns(exporter.getFinishedSpans());
    assert.equal(roots.length, 1);
    assert.deepEqual(roots[0].attributes[ATTR.RESPONSE_FINISH_REASONS], ['end_turn']);
    assert.ok(String(roots[0].attributes[ATTR.OUTPUT_MESSAGES]).includes('finished'));
  });
}

test('unsupported context retention exports exactly one root at SessionEnd', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const startTurn = tracing.Conversation.prototype.startTurn;
  t.mock.method(tracing.Conversation.prototype, 'startTurn', function (
    this: tracing.Conversation,
    options?: tracing.TurnInit,
  ) {
    const turn = startTurn.call(this, options);
    return new Proxy(turn, {
      get(target, property) {
        if (property === 'span') return undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  const sessionId = 'stop-unsupported-retention';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('work'));
  const daemon = makeGenaiDaemon();
  const base = { session_id: sessionId, transcript_path: transcript.file, prompt_id: 'p1' };
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', ...base, prompt: 'work' });
  transcript.append(assistantEntry('finished', 'finished', { finishReason: 'end_turn' }));
  await daemon.routeEvent({ hook_event_name: 'Stop', ...base });
  await flushForge();
  assert.equal(turns(exporter.getFinishedSpans()).length, 0);

  await daemon.routeEvent({ hook_event_name: 'SessionEnd', ...base, reason: 'clear' });
  await daemon.drain('test cleanup');
  await flushForge();
  const roots = turns(exporter.getFinishedSpans());
  assert.equal(roots.length, 1);
  assert.deepEqual(roots[0].attributes[ATTR.RESPONSE_FINISH_REASONS], ['end_turn']);
});

for (const restart of [false, true]) {
  test(`Stop exports the original root exactly once across ${restart ? 'lost daemon state' : 'later cleanup'}`, async (t) => {
    const exporter = await initForgeInMemory();
    exporter.reset();
    const sessionId = `stop-export-${restart}`;
    const transcript = makeTranscript(t, sessionId);
    transcript.append(userEntry('first'));
    const original = makeGenaiDaemon();
    const base = { session_id: sessionId, transcript_path: transcript.file };
    await original.routeEvent({ hook_event_name: 'UserPromptSubmit', ...base, prompt_id: 'p1', prompt: 'first' });
    transcript.append(assistantEntry('first-chat', 'answer'));
    await original.routeEvent({ hook_event_name: 'Stop', ...base, prompt_id: 'p1' });
    await flushForge();
    const [root] = turns(exporter.getFinishedSpans());
    assert.ok(root, 'the root exports without SessionEnd or shutdown');
    const chat = chats(exporter.getFinishedSpans())[0];
    assert.equal(spanParentId(chat), root.spanContext().spanId);

    const daemon = restart ? makeGenaiDaemon() : original;
    transcript.append(userEntry('second'));
    await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', ...base, prompt_id: 'p2', prompt: 'second' });
    await daemon.routeEvent({ hook_event_name: 'Stop', ...base, prompt_id: 'p2' });
    await daemon.routeEvent({ hook_event_name: 'SessionEnd', ...base, prompt_id: 'p2', reason: 'clear' });
    await daemon.drain('inactivity');
    await flushForge();
    assert.equal(turns(exporter.getFinishedSpans()).filter(s => s.spanContext().spanId === root.spanContext().spanId).length, 1);
    assert.equal(turns(exporter.getFinishedSpans()).length, 2);
    if (restart) await original.drain('test cleanup');
  });
}

for (const promptId of ['p1', undefined]) {
  test(`blocked Stop continuation and late internal agent reuse the ended root (${promptId ?? 'legacy'})`, async (t) => {
    const exporter = await initForgeInMemory();
    exporter.reset();
    const sessionId = `stop-continuation-${promptId}`;
    const transcript = makeAgentTranscript(t, sessionId, 'stop-continuation');
    transcript.append(userEntry('first'));
    const daemon = makeGenaiDaemon();
    const base = { session_id: sessionId, transcript_path: transcript.file, prompt_id: promptId };
    await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', ...base, prompt: 'first' });
    transcript.append(assistantEntry('before-stop', 'initial output'));
    await daemon.routeEvent({ hook_event_name: 'Stop', ...base });
    await flushForge();
    const [root] = turns(exporter.getFinishedSpans());
    assert.ok(root);
    const output = root.attributes[ATTR.OUTPUT_MESSAGES];
    await daemon.routeEvent({ hook_event_name: 'PreToolUse', ...base, tool_use_id: 'late-tool', tool_name: 'Bash', tool_input: { command: 'pwd' } });
    await daemon.routeEvent({ hook_event_name: 'PostToolUse', ...base, tool_use_id: 'late-tool', tool_name: 'Bash', tool_response: '/x' });
    const subPath = transcript.subagent('internal', userEntry('summarize'), assistantEntry('internal-chat', 'summary'));
    await daemon.routeEvent({ hook_event_name: 'SubagentStop', ...base, agent_id: 'internal', agent_type: 'compact', agent_transcript_path: subPath });
    transcript.append(assistantEntry('after-stop', 'continued output', { finishReason: 'end_turn' }));
    await daemon.routeEvent({ hook_event_name: 'Stop', ...base });
    await daemon.routeEvent({ hook_event_name: 'PostCompact', ...base, compact_summary: 'late summary' });
    transcript.append(userEntry('next'));
    const nextBase = { ...base, prompt_id: promptId === undefined ? undefined : 'p2' };
    await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', ...nextBase, prompt: 'next' });
    await daemon.routeEvent({ hook_event_name: 'SessionEnd', ...nextBase, reason: 'clear' });
    await daemon.drain('test cleanup');
    await flushForge();
    const spans = exporter.getFinishedSpans();
    const roots = turns(spans).filter(s => s.attributes[ATTR.AGENT_NAME] === 'claude-code');
    assert.equal(roots.length, 2);
    assert.equal(root.attributes[ATTR.COMPACTION_SUMMARY], undefined);
    assert.equal(roots[1].attributes[ATTR.COMPACTION_SUMMARY], 'late summary');
    assert.equal(root.attributes[ATTR.OUTPUT_MESSAGES], output);
    assert.equal(root.attributes[ATTR.RESPONSE_FINISH_REASONS], undefined);
    for (const responseId of ['before-stop', 'after-stop']) {
      const matches = chats(spans).filter(s => s.attributes[ATTR.RESPONSE_ID] === responseId);
      assert.equal(matches.length, 1);
      assert.equal(spanParentId(matches[0]), root.spanContext().spanId);
    }
    const tool = spans.find(s => s.attributes['gen_ai.tool.call.id'] === 'late-tool');
    const agent = turns(spans).find(s => s.attributes[ATTR.AGENT_NAME] === 'compact');
    assert.ok(tool && agent);
    assert.equal(spanParentId(tool), root.spanContext().spanId);
    assert.equal(spanParentId(agent), root.spanContext().spanId);
    const internal = chats(spans).find(s => s.attributes[ATTR.RESPONSE_ID] === 'internal-chat');
    assert.ok(internal);
    assert.equal(spanParentId(internal), agent.spanContext().spanId);
  });
}

for (const agent of [false, true]) {
  test(`Stop waits for its last open ${agent ? 'agent' : 'tool'} then exports the root`, async (t) => {
    const exporter = await initForgeInMemory();
    exporter.reset();
    const sessionId = `stop-open-child-${agent}`;
    const transcript = makeAgentTranscript(t, sessionId, 'stop-child');
    transcript.append(userEntry('work'));
    const daemon = makeGenaiDaemon();
    const base = { session_id: sessionId, transcript_path: transcript.file, prompt_id: 'p1' };
    await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', ...base, prompt: 'work' });
    await daemon.routeEvent({ hook_event_name: 'PreToolUse', ...base, tool_use_id: 'child', tool_name: agent ? 'Agent' : 'Bash', tool_input: agent ? { subagent_type: 'Explore', prompt: 'explore' } : { command: 'pwd' } });
    if (agent) await daemon.routeEvent({ hook_event_name: 'SubagentStart', ...base, agent_id: 'explorer', agent_type: 'Explore' });
    transcript.append(assistantEntry('open-chat', 'working'));
    await daemon.routeEvent({ hook_event_name: 'Stop', ...base });
    await flushForge();
    const roots = () => turns(exporter.getFinishedSpans()).filter(s => s.attributes[ATTR.AGENT_NAME] === 'claude-code');
    assert.equal(roots().length, 0, 'an open child holds the root');
    if (agent) {
      const subPath = transcript.subagent('explorer', userEntry('explore'), assistantEntry('explorer-chat', 'done'));
      await daemon.routeEvent({ hook_event_name: 'SubagentStop', ...base, agent_id: 'explorer', agent_type: 'Explore', agent_transcript_path: subPath });
      await flushForge();
      assert.equal(roots().length, 0, 'a dispatched agent still awaits PostToolUse');
    }
    await daemon.routeEvent({ hook_event_name: 'PostToolUse', ...base, tool_use_id: 'child', tool_name: agent ? 'Agent' : 'Bash', tool_response: 'done' });
    await flushForge();
    assert.equal(roots().length, 1, 'last child completion exports the stopped root');
    const child = exporter.getFinishedSpans().find(s => agent
      ? s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent' && s.attributes[ATTR.AGENT_NAME] === 'Explore'
      : s.attributes['gen_ai.tool.call.id'] === 'child');
    assert.ok(child);
    assert.equal(spanParentId(child), roots()[0].spanContext().spanId);
    await daemon.routeEvent({ hook_event_name: 'SessionEnd', ...base, reason: 'clear' });
    await daemon.drain('test cleanup');
    await flushForge();
    assert.equal(roots().length, 1);
  });
}

test('a superseded stopped root records late output before its last child closes', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'superseded-stop-late-output';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('first'));
  const daemon = makeGenaiDaemon();
  const base = { session_id: sessionId, transcript_path: transcript.file };
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', ...base, prompt_id: 'p1', prompt: 'first' });
  await daemon.routeEvent({ hook_event_name: 'PreToolUse', ...base, prompt_id: 'p1', tool_use_id: 'child', tool_name: 'Bash', tool_input: { command: 'pwd' } });
  transcript.append(assistantEntry('initial-response', 'working'));
  await daemon.routeEvent({ hook_event_name: 'Stop', ...base, prompt_id: 'p1' });
  transcript.append(
    assistantEntry('late-response', 'late first output', { finishReason: 'end_turn' }),
    userEntry('second'),
  );
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', ...base, prompt_id: 'p2', prompt: 'second' });
  await flushForge();
  assert.equal(turns(exporter.getFinishedSpans()).length, 0);

  await daemon.routeEvent({ hook_event_name: 'PostToolUse', ...base, prompt_id: 'p1', tool_use_id: 'child', tool_name: 'Bash', tool_response: '/x' });
  await flushForge();
  const spans = exporter.getFinishedSpans();
  const roots = turns(spans);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].attributes[ATTR.OUTPUT_MESSAGES], JSON.stringify([
    { role: 'assistant', content: 'working' },
    { role: 'assistant', content: 'late first output' },
  ]));
  assert.deepEqual(roots[0].attributes[ATTR.RESPONSE_FINISH_REASONS], ['end_turn']);
  const lateChat = chats(spans).filter(span => span.attributes[ATTR.RESPONSE_ID] === 'late-response');
  assert.equal(lateChat.length, 1);
  assert.equal(spanParentId(lateChat[0]), roots[0].spanContext().spanId);
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', ...base, prompt_id: 'p2', reason: 'clear' });
  await daemon.drain('test cleanup');
});

test('Stop exports the root and later snapshots emit only new normalized responses', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'root-stop-snapshots';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('do it', {
    timestamp: '2026-01-01T00:00:00.000Z',
    version: '1.2.3',
  }));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'do it',
  });
  transcript.append(assistantEntry('response-a', 'working', {
    timestamp: '2026-01-01T00:00:01.000Z',
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 20 },
  }));
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: sessionId });
  await flushForge();

  assert.equal(turns(exporter.getFinishedSpans()).length, 1, 'Stop exports the root');
  assert.deepEqual(chats(exporter.getFinishedSpans()).map(span => span.attributes[ATTR.RESPONSE_ID]), [
    'response-a',
  ]);

  transcript.append(assistantEntry('response-b', 'done', {
    timestamp: '2026-01-01T00:00:02.000Z',
    finishReason: 'end_turn',
  }));
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: sessionId });
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear',
  });
  await flushForge();

  const spans = exporter.getFinishedSpans();
  for (const span of spans) {
    assert.equal(span.attributes[ATTR.FORGE_INTEGRATION_NAME], 'forge-agent-lens-for-claude-code');
    assert.equal(span.resource.attributes['wandb.sdk.name'], 'forge');
  }
  const [turn] = turns(spans);
  const responseSpans = chats(spans);
  assert.ok(turn);
  assert.equal(turns(spans).length, 1);
  assert.equal(responseSpans.length, 2, 'repeated Stop does not replay response-a');
  assert.deepEqual(responseSpans.map(span => span.attributes[ATTR.RESPONSE_ID]), [
    'response-a',
    'response-b',
  ]);
  assert.ok(responseSpans.every(span => spanParentId(span) === turn.spanContext().spanId));
  assert.equal(turn.attributes[ATTR.FORGE_ORPHAN_REASON], undefined);
  assert.equal(
    turn.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([
      { role: 'assistant', content: 'working' },
    ]),
  );
  assert.equal(turn.attributes[ATTR.RESPONSE_FINISH_REASONS], undefined);
  assert.equal(turn.attributes[ATTR.FORGE_INTEGRATION_NAME], 'forge-agent-lens-for-claude-code');
  assert.equal(turn.attributes[ATTR.FORGE_INTEGRATION_VERSION], VERSION);
  assert.equal(turn.attributes['forge.integration.meta.claude_code_app_version'], '1.2.3');
  assert.equal(responseSpans[0].attributes[ATTR.USAGE_INPUT_TOKENS], 30);
});

test('a second Stop records hook-only output beneath the ended root', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'hook-only-stop-output';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('work'));
  const daemon = makeGenaiDaemon();
  const base = { session_id: sessionId, transcript_path: transcript.file, prompt_id: 'p1' };
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', ...base, prompt: 'work' });
  transcript.append(assistantEntry('initial-response', 'initial output'));
  await daemon.routeEvent({ hook_event_name: 'Stop', ...base });
  await flushForge();
  const [root] = turns(exporter.getFinishedSpans());
  assert.ok(root);
  const output = root.attributes[ATTR.OUTPUT_MESSAGES];

  for (let attempt = 0; attempt < 2; attempt++) {
    await daemon.routeEvent({ hook_event_name: 'Stop', ...base, last_assistant_message: 'continued answer' });
  }
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', ...base, reason: 'clear' });
  await daemon.drain('test cleanup');
  await flushForge();
  const spans = exporter.getFinishedSpans();
  assert.equal(turns(spans).length, 1);
  assert.equal(root.attributes[ATTR.OUTPUT_MESSAGES], output);
  const responses = chats(spans);
  assert.equal(responses.length, 2, 'a repeated hook-only answer exports once');
  const continuation = responses.find(span => span.attributes[ATTR.RESPONSE_ID] === undefined);
  assert.ok(continuation);
  assert.equal(spanParentId(continuation), root.spanContext().spanId);
  assert.equal(continuation.attributes[ATTR.OUTPUT_MESSAGES], JSON.stringify([
    { role: 'assistant', content: 'continued answer' },
  ]));
});

test('the first chat span carries the prompt when Stop exports the root', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'root-live-prompt';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('where do traces go'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'where do traces go',
  });
  transcript.append(
    assistantEntry('response-a', 'checking'),
    assistantEntry('response-b', 'here', { finishReason: 'end_turn' }),
  );
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: sessionId });
  await flushForge();

  const spans = exporter.getFinishedSpans();
  assert.equal(turns(spans).length, 1);
  assert.deepEqual(
    chats(spans).map(span => [span.attributes[ATTR.RESPONSE_ID], span.attributes[ATTR.INPUT_MESSAGES]]),
    [
      ['response-a', JSON.stringify([
        { role: 'user', parts: [{ type: 'text', content: 'where do traces go' }] },
      ])],
      ['response-b', undefined],
    ],
  );
});

test('a mid-turn transcript user line does not copy the prompt onto a replayed chat span', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'root-live-prompt-offset-shift';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('hello'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'hello' });
  transcript.append(assistantEntry('response-a', 'first'));
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: sessionId });
  // A plain-string user line starts a new transcript turn without a UserPromptSubmit.
  transcript.append(
    userEntry('<task-notification><task-id>a</task-id></task-notification>'),
    assistantEntry('response-b', 'second'),
  );
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: sessionId });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear' });
  await flushForge();

  const withPrompt = chats(exporter.getFinishedSpans())
    .filter(span => span.attributes[ATTR.INPUT_MESSAGES] !== undefined)
    .map(span => span.attributes[ATTR.RESPONSE_ID]);
  assert.deepEqual(withPrompt, ['response-a']);
});

test('the prompt skips a first response that has no model', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'root-live-prompt-no-model';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('hello'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'hello' });
  transcript.append(
    { type: 'assistant', message: { role: 'assistant', id: 'response-a' } },
    assistantEntry('response-b', 'second'),
  );
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: sessionId });
  await flushForge();

  assert.deepEqual(
    chats(exporter.getFinishedSpans()).map(span => [span.attributes[ATTR.RESPONSE_ID], span.attributes[ATTR.INPUT_MESSAGES]]),
    [['response-b', JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'hello' }] }])]],
  );
});

function toolUseEntry(id: string, toolUseId: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      id,
      model: 'claude-opus-4-8',
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'ls' } }],
      stop_reason: 'tool_use',
    },
  };
}

function toolResultEntry(toolUseId: string): Record<string, unknown> {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
  };
}

async function startLiveSession(t: TestContext, sessionId: string) {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('list files'));
  const daemon = makeGenaiDaemon();
  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'list files' });
  const preToolUse = (toolUseId: string) => daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sessionId,
    tool_use_id: toolUseId, tool_name: 'Bash', tool_input: { command: 'ls' },
  });
  return { exporter, transcript, daemon, preToolUse };
}

test('a response is sent before Stop once the next response starts a tool', async (t) => {
  const { exporter, transcript, daemon, preToolUse } = await startLiveSession(t, 'live-chat-next-response');
  transcript.append(toolUseEntry('response-a', 'tool-1'));
  await preToolUse('tool-1');
  transcript.append(toolResultEntry('tool-1'), toolUseEntry('response-b', 'tool-2'));
  await preToolUse('tool-2');
  await flushForge();

  assert.equal(turns(exporter.getFinishedSpans()).length, 0);
  assert.deepEqual(
    chats(exporter.getFinishedSpans()).map(span => [span.attributes[ATTR.RESPONSE_ID], span.attributes[ATTR.INPUT_MESSAGES]]),
    [['response-a', JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'list files' }] }])]],
  );

  transcript.append(toolResultEntry('tool-2'), assistantEntry('response-c', 'done', { finishReason: 'end_turn' }));
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: 'live-chat-next-response' });
  await flushForge();
  assert.deepEqual(
    chats(exporter.getFinishedSpans()).map(span => span.attributes[ATTR.RESPONSE_ID]),
    ['response-a', 'response-b', 'response-c'],
  );
});

test('a response still streaming parallel tool calls is not sent early', async (t) => {
  const { exporter, transcript, daemon, preToolUse } = await startLiveSession(t, 'live-chat-parallel');
  // Claude Code runs tool-1 before writing the response's tool-2 block.
  transcript.append(toolUseEntry('response-a', 'tool-1'));
  await preToolUse('tool-1');
  transcript.append(toolResultEntry('tool-1'), toolUseEntry('response-a', 'tool-2'));
  await preToolUse('tool-2');
  transcript.append(toolResultEntry('tool-2'), assistantEntry('response-b', 'done', { finishReason: 'end_turn' }));
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: 'live-chat-parallel' });
  await flushForge();

  const [first] = chats(exporter.getFinishedSpans());
  assert.ok(first);
  assert.equal(first.attributes[ATTR.RESPONSE_ID], 'response-a');
  assert.equal(first.attributes[ATTR.OUTPUT_MESSAGES], JSON.stringify([{
    role: 'assistant',
    parts: [
      { type: 'tool_call', id: 'tool-1', name: 'Bash', arguments: '{"command":"ls"}' },
      { type: 'tool_call', id: 'tool-2', name: 'Bash', arguments: '{"command":"ls"}' },
    ],
  }]));
});

test('a newer prompt closes an interrupted root without replaying its response', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'root-interrupted';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('first'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'first' });
  transcript.append(
    assistantEntry('only-once', 'first answer'),
    userEntry('second'),
  );
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'second' });
  transcript.append(userEntry('third'));
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'third' });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear' });
  await flushForge();

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.filter(span => span.attributes[ATTR.RESPONSE_ID] === 'only-once').length, 1);
  const rootSpans = turns(spans);
  assert.equal(rootSpans.length, 3);
  const first = rootSpans.find(span => String(span.attributes[ATTR.INPUT_MESSAGES]).includes('first'));
  const second = rootSpans.find(span => String(span.attributes[ATTR.INPUT_MESSAGES]).includes('second'));
  assert.ok(first && second);
  assert.equal(first.attributes[ATTR.FORGE_ORPHAN_REASON], 'superseded_by_next_prompt');
  assert.equal(second.attributes[ATTR.FORGE_ORPHAN_REASON], 'superseded_by_next_prompt');
});

test('an identical prompt submitted during transcript lag does not replay prior output', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'root-repeated-prompt-race';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('same prompt'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    prompt_id: 'prompt-a', prompt: 'same prompt',
  });
  transcript.append(assistantEntry('response-a', 'first answer'));
  await daemon.routeEvent({
    hook_event_name: 'Stop', session_id: sessionId, prompt_id: 'prompt-a',
  });

  // The second hook can arrive before its identical user line reaches JSONL.
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    prompt_id: 'prompt-b', prompt: 'same prompt',
  });
  await daemon.routeEvent({
    hook_event_name: 'Stop', session_id: sessionId, prompt_id: 'prompt-b',
  });
  await flushForge();

  const laggingSpans = exporter.getFinishedSpans();
  assert.equal(turns(laggingSpans).length, 2, 'both stopped roots export during lag');
  assert.deepEqual(
    chats(laggingSpans).map(span => span.attributes[ATTR.RESPONSE_ID]),
    ['response-a'],
    'the lagging second root does not replay the first response',
  );

  transcript.append(
    userEntry('same prompt'),
    assistantEntry('response-b', 'second answer'),
  );
  await daemon.routeEvent({
    hook_event_name: 'Stop', session_id: sessionId, prompt_id: 'prompt-b',
  });
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd', session_id: sessionId,
    prompt_id: 'prompt-b', reason: 'clear',
  });
  await flushForge();

  const spans = exporter.getFinishedSpans();
  assert.equal(turns(spans).length, 2);
  assert.deepEqual(
    chats(spans).map(span => span.attributes[ATTR.RESPONSE_ID]),
    ['response-a', 'response-b'],
  );
});

test('duplicate prompt_id is idempotent', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'root-prompt-id';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('once'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  const prompt = {
    hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    prompt_id: 'prompt-1', prompt: 'once',
  };
  await daemon.routeEvent(prompt);
  await daemon.routeEvent(prompt);
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd', session_id: sessionId,
    prompt_id: 'prompt-1', reason: 'clear',
  });
  await flushForge();

  assert.equal(turns(exporter.getFinishedSpans()).length, 1);
});

test('an out-of-order Stop does not replace the foreground prompt', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'root-out-of-order-stop';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(userEntry('foreground'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    prompt_id: 'foreground-id', prompt: 'foreground',
  });
  await daemon.routeEvent({
    hook_event_name: 'Stop', session_id: sessionId,
    prompt_id: 'background-id', transcript_path: transcript.file,
  });
  transcript.append(userEntry('next'));
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    prompt_id: 'next-id', prompt: 'next',
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear' });
  await flushForge();

  const foreground = turns(exporter.getFinishedSpans()).find(span =>
    String(span.attributes[ATTR.INPUT_MESSAGES]).includes('foreground'));
  assert.ok(foreground);
  assert.equal(foreground.attributes[ATTR.FORGE_ORPHAN_REASON], 'superseded_by_next_prompt');
});

test('SessionEnd alone reconstructs the final turn, including its input', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'root-session-end-restart';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(
    userEntry('finish it', { timestamp: '2026-01-01T00:00:00.000Z' }),
    assistantEntry('restart-final', 'finished', {
      timestamp: '2026-01-01T00:00:01.000Z',
      finishReason: 'end_turn',
    }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionEnd', session_id: sessionId,
    prompt_id: 'final-prompt', transcript_path: transcript.file,
    cwd: '/x', reason: 'clear',
  });
  await flushForge();

  const spans = exporter.getFinishedSpans();
  const [turn] = turns(spans);
  const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'restart-final');
  assert.ok(turn && chat);
  assert.equal(
    turn.attributes[ATTR.INPUT_MESSAGES],
    JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'finish it' }] }]),
  );
  assert.equal(spanParentId(chat), turn.spanContext().spanId);
});

test('shutdown does not synthesize a historical turn for an idle resumed session', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'root-idle-resume-shutdown';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(
    userEntry('historical prompt'),
    assistantEntry('historical-response', 'historical answer'),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: transcript.file, source: 'resume', cwd: '/x',
  });
  await daemon.drain('test shutdown');
  await flushForge();

  const spans = exporter.getFinishedSpans();
  assert.equal(turns(spans).length, 0);
  assert.equal(chats(spans).length, 0);
});

test('restart-first Stop does not claim another transcript prompt', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'root-stop-restart';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(
    userEntry('older'),
    assistantEntry('older-response', 'old'),
    userEntry('newer'),
    assistantEntry('newer-response', 'new'),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'Stop', session_id: sessionId, prompt_id: 'older-prompt',
    transcript_path: transcript.file, cwd: '/x',
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear' });
  await flushForge();

  const spans = exporter.getFinishedSpans();
  assert.equal(turns(spans).length, 1);
  assert.equal(chats(spans).length, 0);
});

test('SessionEnd preserves input, output and finish reason after a restart-first Stop', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'root-stop-same-prompt-restart';
  const transcript = makeTranscript(t, sessionId);
  transcript.append(
    userEntry('final prompt'),
    assistantEntry('final-response', 'finished', { finishReason: 'end_turn' }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'Stop', session_id: sessionId, prompt_id: 'prompt-a',
    transcript_path: transcript.file, cwd: '/x',
  });
  await flushForge();
  assert.equal(turns(exporter.getFinishedSpans()).length, 0);

  await daemon.routeEvent({
    hook_event_name: 'SessionEnd', session_id: sessionId, prompt_id: 'prompt-a',
    transcript_path: transcript.file, reason: 'clear',
  });
  await flushForge();

  const spans = exporter.getFinishedSpans();
  const [turn] = turns(spans);
  const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'final-response');
  assert.ok(turn && chat);
  assert.equal(turns(spans).length, 1);
  assert.equal(turn.attributes[ATTR.INPUT_MESSAGES], JSON.stringify([
    { role: 'user', parts: [{ type: 'text', content: 'final prompt' }] },
  ]));
  assert.equal(turn.attributes[ATTR.OUTPUT_MESSAGES], JSON.stringify([
    { role: 'assistant', content: 'finished' },
  ]));
  assert.deepEqual(turn.attributes[ATTR.RESPONSE_FINISH_REASONS], ['end_turn']);
  assert.equal(spanParentId(chat), turn.spanContext().spanId);
});

test('a prompt arriving before Claude Code creates the transcript still opens a turn', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'prompt-before-transcript';
  // Deliberately not created yet: Claude Code writes the file after SessionStart.
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.forge-turn-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, `${sessionId}.jsonl`);
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sessionId,
    transcript_path: file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    transcript_path: file, prompt: 'first prompt', prompt_id: 'prompt-a',
  });

  fs.writeFileSync(file, JSON.stringify(userEntry('first prompt')) + '\n');
  fs.appendFileSync(file, JSON.stringify(assistantEntry('msg-a', 'reply')) + '\n');
  await daemon.routeEvent({ hook_event_name: 'Stop', session_id: sessionId });
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd', session_id: sessionId, reason: 'clear',
  });
  await flushForge();

  const spans = exporter.getFinishedSpans();
  const [turn] = turns(spans);
  assert.ok(turn, 'the first prompt must not be dropped');
  assert.equal(
    turn.attributes[ATTR.INPUT_MESSAGES],
    JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'first prompt' }] }]),
  );
  assert.equal(chats(spans).length, 1, 'its response is still recorded');
});

test('a delayed prompt-less tool result attaches to its own turn, not the newest', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'delayed-legacy-tool';
  const transcript = makeTranscript(t, sessionId);
  // Older transcript turn: the prompt and the response that called the tool.
  transcript.append(userEntry('old prompt'));
  transcript.append({
    type: 'assistant',
    message: {
      role: 'assistant', id: 'msg-old', model: 'claude-opus-4-8',
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [{ type: 'tool_use', id: 'old-tool', name: 'Bash', input: { command: 'ls' } }],
    },
  });
  transcript.append(userEntry('new prompt'));
  const daemon = makeGenaiDaemon();
  const base = { session_id: sessionId, transcript_path: transcript.file };

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', ...base, source: 'startup', cwd: '/x',
  });
  // Legacy hooks carry no prompt_id, so the newer prompt becomes the current turn.
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', ...base, prompt: 'new prompt' });
  // Delayed terminal hook for the older tool, still without a prompt_id.
  await daemon.routeEvent({
    hook_event_name: 'PostToolUse', ...base, tool_use_id: 'old-tool',
    tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'ok',
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', ...base, reason: 'clear' });
  await flushForge();

  const spans = exporter.getFinishedSpans();
  const [toolSpan] = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'execute_tool');
  assert.ok(toolSpan);
  const parent = turns(spans).find(span => span.spanContext().spanId === spanParentId(toolSpan));
  assert.ok(parent, 'the tool hangs off a turn');
  assert.equal(
    parent.attributes[ATTR.INPUT_MESSAGES],
    JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'old prompt' }] }]),
    'the old tool belongs to the turn that called it',
  );
  assert.equal(turns(spans).length, 2, 'the newer turn stays separate');
});
