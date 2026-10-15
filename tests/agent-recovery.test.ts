// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-claude-code

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATTR } from '../src/genaiSpans.ts';
import {
  assistantEntry,
  initForgeInMemory,
  makeGenaiDaemon,
  makeTranscript,
  spanParentId,
  userEntry,
} from './helpers.ts';
import { finish } from './agent-test-helpers.ts';

test('declared and wildcard Agent candidates with the same prompt stay ambiguous', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sid = 'sub-mixed-type-candidates';
  const agentId = 'mixed-type-agent';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('delegate twice'));
  transcript.subagent(agentId, userEntry('same task'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sid,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'delegate twice',
  });
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid,
    tool_use_id: 'declared-call', tool_name: 'Agent',
    tool_input: { subagent_type: 'general-purpose', prompt: 'same task' },
  });
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid,
    tool_use_id: 'wildcard-call', tool_name: 'Agent',
    tool_input: { prompt: 'same task' },
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart', session_id: sid,
    agent_id: agentId, agent_type: 'general-purpose',
  });
  await finish(daemon, sid);

  const agents = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] !== 'claude-code');
  assert.equal(agents.length, 2);
  assert.equal(agents.some(span => span.attributes[ATTR.AGENT_ID] === agentId), false);
});

test('exact prompt beyond the first 64 KiB selects the right Agent dispatch', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sid = 'sub-exact-prompt';
  const agentId = 'exact-agent';
  const transcript = makeTranscript(t, sid, 'sub-exact-prompt');
  transcript.append(userEntry('dispatch twice'));
  const subPath = transcript.subagent(
    agentId,
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `<system-reminder>${'x'.repeat(70 * 1024)}</system-reminder>` }],
      },
    },
    userEntry('second task'),
    assistantEntry('exact-msg', { type: 'text', text: 'second done' }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'dispatch twice' });
  for (const [toolUseId, prompt] of [['agent-first', 'task'], ['agent-second', 'second task']]) {
    await daemon.routeEvent({
      hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: toolUseId,
      tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt },
    });
  }
  await daemon.routeEvent({ hook_event_name: 'SubagentStart', session_id: sid, agent_id: agentId, agent_type: 'Explore' });
  await daemon.routeEvent({ hook_event_name: 'SubagentStart', session_id: sid, agent_id: agentId, agent_type: 'Explore' });
  await daemon.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'agent-second', tool_response: 'second result' });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'agent-first', tool_response: 'first result' });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  const agents = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  const matched = agents.find(span => span.attributes[ATTR.AGENT_ID] === agentId);
  const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'exact-msg');
  assert.equal(agents.length, 2);
  assert.ok(matched && chat);
  assert.equal(
    matched.attributes[ATTR.INPUT_MESSAGES],
    JSON.stringify([{ role: 'user', content: 'second task' }]),
  );
  assert.equal(spanParentId(chat), matched.spanContext().spanId);
});

test('prefix-colliding restart prompts remain separate partial Agent markers', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sid = 'sub-incompatible-recovery';
  const agentId = 'prefix-agent';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('dispatch'));
  const subPath = transcript.subagent(
    agentId,
    userEntry('prefix task'),
    assistantEntry('prefix-msg', { type: 'text', text: 'prefix output' }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'PostToolUseFailure', session_id: sid, transcript_path: transcript.file,
    tool_use_id: 'fix-call', tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: 'fix' }, error: 'AgentError: fix failed',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId,
    agent_type: 'Explore', agent_transcript_path: subPath,
  });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  const agents = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  const failed = agents.find(span => span.attributes[ATTR.ERROR_TYPE] === 'AgentError');
  const recovered = agents.find(span => span.attributes[ATTR.AGENT_ID] === agentId);
  const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'prefix-msg');
  assert.equal(agents.length, 2);
  assert.ok(failed && recovered && chat);
  assert.equal(failed.attributes[ATTR.AGENT_ID], undefined);
  assert.equal(recovered.attributes[ATTR.ERROR_TYPE], undefined);
  assert.equal(spanParentId(chat), recovered.spanContext().spanId);
});

test('ambiguous prompt correlation never fabricates a third marker', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sid = 'sub-ambiguous';
  const agentId = 'ambiguous-agent';
  const transcript = makeTranscript(t, sid, 'sub-ambiguous');
  transcript.append(userEntry('dispatch twice'));
  const subPath = transcript.subagent(
    agentId,
    userEntry('different prompt'),
    assistantEntry('ambiguous-msg', { type: 'text', text: 'done' }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'dispatch twice' });
  for (const [toolUseId, prompt] of [['agent-a', 'first'], ['agent-b', 'second']]) {
    await daemon.routeEvent({
      hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: toolUseId,
      tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt },
    });
  }
  await daemon.routeEvent({ hook_event_name: 'SubagentStart', session_id: sid, agent_id: agentId, agent_type: 'Explore' });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'agent-a', tool_response: 'a' });
  await daemon.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath });
  await daemon.routeEvent({ hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath });
  await daemon.routeEvent({ hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'agent-b', tool_response: 'b' });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.filter(span =>
    span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore').length, 2);
  const turn = spans.find(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'claude-code');
  const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'ambiguous-msg');
  assert.ok(turn && chat);
  assert.equal(spans.filter(span => span.attributes[ATTR.RESPONSE_ID] === 'ambiguous-msg').length, 1);
  assert.equal(spanParentId(chat), turn.spanContext().spanId);
});

test('restart-first SubagentStart recovers a parent for child hooks', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sid = 'sub-recovery-start-first';
  const agentId = 'start-first-agent';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('delegate it'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SubagentStart', session_id: sid, transcript_path: transcript.file,
    agent_id: agentId, agent_type: 'Explore',
  });
  const subPath = transcript.subagent(
    agentId,
    userEntry('inspect it'),
    assistantEntry('start-first-msg', { type: 'text', text: 'inspected' }),
  );
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid, agent_id: agentId,
    tool_use_id: 'start-first-tool', tool_name: 'Read', tool_input: { file_path: '/x' },
  });
  await daemon.routeEvent({
    hook_event_name: 'PostToolUse', session_id: sid, agent_id: agentId,
    tool_use_id: 'start-first-tool', tool_response: 'contents',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId,
    agent_type: 'Explore', agent_transcript_path: subPath,
  });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  const agents = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  const agent = agents.find(span => span.attributes[ATTR.AGENT_ID] === agentId);
  const tool = spans.find(span => span.attributes['gen_ai.tool.call.id'] === 'start-first-tool');
  const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'start-first-msg');
  assert.equal(agents.length, 1);
  assert.ok(agent && tool && chat);
  assert.equal(spanParentId(tool), agent.spanContext().spanId);
  assert.equal(spanParentId(chat), agent.spanContext().spanId);
  assert.equal(
    agent.attributes[ATTR.INPUT_MESSAGES],
    JSON.stringify([{ role: 'user', content: 'inspect it' }]),
  );
  assert.equal(
    agent.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'inspected' }]),
  );
});

test('a Stop-first recovered Agent keeps its prompt turn open', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sid = 'sub-recovery-retained-turn';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('older prompt'));
  const agentId = 'retained-agent';
  const subPath = transcript.subagent(
    agentId,
    userEntry('background task'),
    assistantEntry('retained-msg', { type: 'text', text: 'still working' }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt_id: 'older', prompt: 'older prompt' });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid, prompt_id: 'older',
    agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath,
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid, prompt_id: 'older',
    agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath,
    last_assistant_message: 'continued',
  });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt_id: 'newer', prompt: 'newer prompt' });

  assert.equal(exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'claude-code').length, 0);

  await finish(daemon, sid);
  const spans = exporter.getFinishedSpans();
  const turns = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'claude-code');
  const agent = spans.find(span => span.attributes[ATTR.AGENT_ID] === agentId);
  assert.equal(spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore').length, 1);
  assert.equal(turns.length, 2);
  assert.ok(agent);
  const parent = turns.find(turn => turn.spanContext().spanId === spanParentId(agent));
  assert.ok(parent);
  assert.equal(
    agent.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'still working\ncontinued' }]),
  );
  assert.deepEqual(
    spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'chat')
      .map(span => span.attributes[ATTR.RESPONSE_ID]).sort(),
    ['retained-msg'],
  );
});

test('restart recovery keeps a later Agent call separate', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sid = 'sub-recovery-separate';
  const agentId = 'recovered-agent';
  const transcript = makeTranscript(t, sid, 'sub-recovery');
  transcript.append(
    userEntry('delegate it'),
    assistantEntry('main-msg', { type: 'text', text: 'working' }),
  );
  const subPath = transcript.subagent(
    agentId,
    userEntry('recover me'),
    assistantEntry('recovered-msg', { type: 'text', text: 'done' }, {
      usage: { input_tokens: 200, output_tokens: 40 },
    }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid, transcript_path: transcript.file,
    agent_id: agentId, agent_type: 'Explore', agent_transcript_path: subPath,
  });
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid,
    tool_use_id: 'lost-agent-call', tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: 'different task' },
  });
  await daemon.routeEvent({
    hook_event_name: 'PostToolUse', session_id: sid, transcript_path: transcript.file,
    tool_use_id: 'lost-agent-call', tool_name: 'Agent',
    tool_input: { subagent_type: 'Explore', prompt: 'different task' },
    tool_response: 'must not replace the recovered transcript',
  });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  const turns = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'claude-code');
  const agents = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  const recovered = agents.find(span => span.attributes[ATTR.AGENT_ID] === agentId);
  const later = agents.find(span => span !== recovered);
  const chat = spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'recovered-msg');
  assert.equal(turns.length, 1);
  assert.equal(agents.length, 2);
  assert.ok(recovered && later && chat);
  assert.equal(spanParentId(recovered), turns[0].spanContext().spanId);
  assert.equal(spanParentId(chat), recovered.spanContext().spanId);
  assert.equal(spanParentId(later), turns[0].spanContext().spanId);
  assert.equal(recovered.attributes[ATTR.FORGE_ORPHAN_REASON], undefined);
  assert.equal(later.attributes[ATTR.FORGE_ORPHAN_REASON], undefined);
  assert.equal(
    recovered.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'done' }]),
  );
  assert.equal(
    later.attributes[ATTR.OUTPUT_MESSAGES],
    JSON.stringify([{ role: 'assistant', content: 'must not replace the recovered transcript' }]),
  );
});

// A Stop-first restart recovers an Agent by agent_id but never learns its
// tool_use_id, so the late Agent PostToolUse has to join that marker.
test('a Stop-first recovered Agent adopts its late PostToolUse', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sid = 'sub-stop-first-adopts';
  const agentId = 'stop-first-agent';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('delegate it'));
  const subPath = transcript.subagent(
    agentId,
    userEntry('do it'),
    assistantEntry('sub-msg-1', { type: 'text', text: 'done' }, {
      usage: { input_tokens: 120, output_tokens: 30 }, finishReason: 'end_turn',
    }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sid,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  // No PreToolUse and no SubagentStart: the daemon restarted mid-Agent.
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId,
    agent_type: 'Explore', agent_transcript_path: subPath,
  });
  await daemon.routeEvent({
    hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'agent-call',
    tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'do it' },
    tool_response: 'done',
  });
  await finish(daemon, sid);

  const agents = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  assert.equal(agents.length, 1, 'one Agent span, not a duplicate');
  assert.equal(agents[0].attributes[ATTR.AGENT_ID], agentId);
  assert.equal(
    agents[0].attributes[ATTR.FORGE_SUBAGENT_SPAWNING_TOOL_CALL_ID],
    'agent-call',
    'the recovered span adopts the tool_use_id',
  );
});

test('a Stop-first recovered Agent ignores a PostToolUse for a different prompt', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sid = 'sub-stop-first-other-prompt';
  const agentId = 'other-prompt-agent';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('delegate it'));
  const subPath = transcript.subagent(agentId, userEntry('do it'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sid,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId,
    agent_type: 'Explore', agent_transcript_path: subPath,
  });
  await daemon.routeEvent({
    hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'unrelated-call',
    tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'a different task' },
    tool_response: 'other result',
  });
  await finish(daemon, sid);

  const agents = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  assert.equal(agents.length, 2, 'different prompts stay separate');
});

test('ambiguous Stop-first Agent candidates are not guessed', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sid = 'sub-stop-first-ambiguous';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('delegate twice'));
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sid,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  // Two recovered markers, same type and same prompt: nothing distinguishes them.
  for (const agentId of ['ambiguous-a', 'ambiguous-b']) {
    const subPath = transcript.subagent(agentId, userEntry('same task'));
    await daemon.routeEvent({
      hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId,
      agent_type: 'Explore', agent_transcript_path: subPath,
    });
  }
  await daemon.routeEvent({
    hook_event_name: 'PostToolUse', session_id: sid, tool_use_id: 'agent-call',
    tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'same task' },
    tool_response: 'done',
  });
  await finish(daemon, sid);

  const agents = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  const adopted = agents.filter(span =>
    span.attributes[ATTR.FORGE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'agent-call');
  assert.equal(agents.length, 3, 'both markers survive plus the unjoined result');
  assert.equal(adopted.length, 1, 'the tool_use_id is not attached to a guess');
  assert.equal(adopted[0].attributes[ATTR.AGENT_ID], undefined, 'and not to either marker');
});

// A recovery attaches to whichever turn was current, while the late result
// resolves the turn holding its tool_use_id. Those differ when the dispatch
// lives in an earlier transcript turn, and the marker must still be adopted.
test('a Stop-first recovered Agent adopts a late Post whose dispatch is in an earlier turn', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sid = 'sub-stop-first-earlier-turn';
  const agentId = 'earlier-turn-agent';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('old prompt'));
  transcript.append(assistantEntry('msg-old', {
    type: 'tool_use', id: 'agent-call', name: 'Agent',
    input: { subagent_type: 'Explore', prompt: 'do it' },
  }));
  transcript.append(userEntry('new prompt'));
  const subPath = transcript.subagent(
    agentId,
    userEntry('do it'),
    assistantEntry('sub-msg-1', { type: 'text', text: 'done' }, {
      usage: { input_tokens: 120, output_tokens: 30 }, finishReason: 'end_turn',
    }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sid,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid, agent_id: agentId,
    agent_type: 'Explore', agent_transcript_path: subPath,
  });
  await daemon.routeEvent({
    hook_event_name: 'PostToolUse', session_id: sid,
    transcript_path: transcript.file, tool_use_id: 'agent-call',
    tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'do it' },
    tool_response: 'done',
  });
  await finish(daemon, sid);

  const agents = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] === 'Explore');
  assert.equal(agents.length, 1, 'one Agent span even across differing turns');
  assert.equal(agents[0].attributes[ATTR.AGENT_ID], agentId);
  assert.equal(agents[0].attributes[ATTR.FORGE_SUBAGENT_SPAWNING_TOOL_CALL_ID], 'agent-call');
});

test('untracked SubagentStop without a transcript emits no span and binds no call', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sid = 'sub-phantom-stop';
  const transcript = makeTranscript(t, sid, sid);
  transcript.append(userEntry('delegate it'));
  // Array-content user records carry no bare-string dispatch prompt.
  const arrayPath = transcript.subagent(
    'array-agent',
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'array task' }] } },
    assistantEntry('array-msg', { type: 'text', text: 'array done' }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', session_id: sid,
    transcript_path: transcript.file, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'delegate it' });
  // Tracked: dispatched and started, then stopped with no readable transcript.
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'tracked-call',
    tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'tracked task' },
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart', session_id: sid,
    agent_id: 'tracked-agent', agent_type: 'Explore',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid,
    agent_id: 'tracked-agent', agent_type: 'Explore', last_assistant_message: 'tracked done',
  });
  // Untracked with a transcript but no readable prompt: still recovered.
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid, agent_id: 'array-agent',
    agent_type: 'Explore', agent_transcript_path: arrayPath,
  });
  // A pending typeless dispatch must not be claimed by the transcript-less fork.
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'typeless-call',
    tool_name: 'Agent', tool_input: { prompt: 'typeless task' },
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid, agent_id: 'phantom-agent',
    agent_type: 'claude', last_assistant_message: 'push it',
  });
  const typelessPath = transcript.subagent('typeless-agent', userEntry('typeless task'));
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart', session_id: sid,
    agent_id: 'typeless-agent', agent_type: 'general-purpose',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop', session_id: sid, agent_id: 'typeless-agent',
    agent_type: 'general-purpose', agent_transcript_path: typelessPath,
  });
  await finish(daemon, sid);

  const spans = exporter.getFinishedSpans();
  const agents = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent'
    && span.attributes[ATTR.AGENT_NAME] !== 'claude-code');
  const spawningCalls = Object.fromEntries(agents.map(span => [
    span.attributes[ATTR.AGENT_ID],
    span.attributes[ATTR.FORGE_SUBAGENT_SPAWNING_TOOL_CALL_ID],
  ]));
  assert.deepEqual(spawningCalls, {
    'array-agent': undefined,
    'tracked-agent': 'tracked-call',
    'typeless-agent': 'typeless-call',
  });
  const arrayAgent = agents.find(span => span.attributes[ATTR.AGENT_ID] === 'array-agent');
  const arrayChats = spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'chat'
    && spanParentId(span) === arrayAgent?.spanContext().spanId);
  assert.equal(arrayChats.length, 1, 'recovered agent keeps its transcript chat span');
});
