// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-claude-code

import type { TestContext } from 'node:test';
import {
  ATTR,
  MEMBER,
  TEAM,
  assert,
  assistantEntry,
  coordinator,
  dispatch,
  flushForge,
  initForgeInMemory,
  makeGenaiDaemon,
  makeTranscript,
  postDispatch,
  preDispatch,
  spanParentId,
  teammateEntries,
  test,
  userEntry,
} from './agent-team-test-helpers.ts';

const teamInput = (prompt: string): Record<string, unknown> => ({
  subagent_type: MEMBER,
  prompt,
  team_name: TEAM,
  name: MEMBER,
});

async function idle(
  t: TestContext,
  daemon: ReturnType<typeof makeGenaiDaemon>,
  label: string,
  text: string,
  responseId: string,
) {
  const sessionId = `${label}-member`;
  const transcript = makeTranscript(t, sessionId, label);
  transcript.append(...teammateEntries(sessionId, text, responseId));
  await daemon.routeEvent({
    hook_event_name: 'TeammateIdle',
    session_id: sessionId,
    transcript_path: transcript.file,
    team_name: TEAM,
    teammate_name: MEMBER,
  });
}

test('explicit team dispatch completes on TeammateIdle', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'direct-idle');
  await dispatch(daemon, sid, 'team-call', 'review');
  const teammate = makeTranscript(t, 'direct-idle-member', 'direct-idle-member');
  teammate.append(
    ...teammateEntries('direct-idle-member', 'review result', 'team-msg'),
    {
      type: 'user',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'team-read', content: 'contents' },
      ] },
    },
    assistantEntry('team-msg-2', { type: 'text', text: 'review summary' }),
  );
  const teammateIdle = {
    hook_event_name: 'TeammateIdle', session_id: 'direct-idle-member',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  };
  await daemon.routeEvent(teammateIdle);
  await dispatch(daemon, sid, 'team-continuation-call', 'continue review');
  teammate.append(assistantEntry('team-msg-2', { type: 'text', text: 'review continuation' }));
  await daemon.routeEvent(teammateIdle);
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    reason: 'clear',
  });
  await flushForge();

  const spans = exporter.getFinishedSpans();
  const agent = spans.find(span =>
    span.attributes[ATTR.FORGE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'team-call');
  assert.ok(agent);
  assert.equal(agent.attributes[ATTR.OUTPUT_MESSAGES], JSON.stringify([
    { role: 'assistant', content: 'review result\nreview summary' },
  ]));
  assert.ok(spans.some(span => span.attributes[ATTR.RESPONSE_ID] === 'team-msg'));
  assert.equal(spans.find(span => span.attributes[ATTR.RESPONSE_ID] === 'team-msg')
    ?.attributes[ATTR.INPUT_MESSAGES], JSON.stringify([
    { role: 'user', parts: [{ type: 'text', content: 'task: review result' }] },
  ]));
  const laterChats = spans.filter(span => span.attributes[ATTR.RESPONSE_ID] === 'team-msg-2');
  assert.equal(laterChats.length, 2);
  assert.equal(laterChats[0].attributes[ATTR.INPUT_MESSAGES], JSON.stringify([
    { role: 'tool', parts: [{ type: 'tool_call_response', id: 'team-read', response: 'contents' }] },
  ]));
  assert.equal(laterChats[1].attributes[ATTR.INPUT_MESSAGES], undefined);
  assert.equal(laterChats[1].attributes[ATTR.OUTPUT_MESSAGES], JSON.stringify([
    { role: 'assistant', parts: [{ type: 'text', content: 'review continuation' }] },
  ]));
  assert.ok(spans.some(span =>
    span.attributes[ATTR.AGENT_NAME] === MEMBER
    && span.attributes[ATTR.FORGE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === undefined));
});

test('an ordinary named background Agent completes through SubagentStop', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'named-background');
  const input = { description: 'background work', prompt: 'ordinary task', name: 'worker' };
  const agentId = 'ordinary-named-agent';
  const subPath = transcript.subagent(
    agentId,
    userEntry('ordinary task'),
    assistantEntry('ordinary-named-msg', { type: 'text', text: 'ordinary result' }),
  );
  await preDispatch(daemon, sid, 'ordinary-named-call', input);
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart',
    session_id: sid,
    agent_id: agentId,
    agent_type: 'general-purpose',
  });
  await postDispatch(daemon, sid, 'ordinary-named-call', input);
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop',
    session_id: sid,
    agent_id: agentId,
    agent_type: 'general-purpose',
    agent_transcript_path: subPath,
  });
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    reason: 'clear',
  });
  await flushForge();

  const agents = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.FORGE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'ordinary-named-call');
  assert.equal(agents.length, 1);
  assert.equal(agents[0].attributes[ATTR.FORGE_ORPHAN_REASON], undefined);
  assert.ok(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'ordinary-named-msg'));
});

test('each parsed teammate turn supplies its own chat prompt', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'two-prompts');
  await dispatch(daemon, sid, 'two-prompts-call', 'review');
  const teammate = makeTranscript(t, 'two-prompts-member', 'two-prompts-member');
  teammate.append(
    ...teammateEntries('two-prompts-member', 'first', 'first-prompt-msg'),
    userEntry('follow up'),
    assistantEntry('second-prompt-msg', { type: 'text', text: 'second' }),
  );
  await daemon.routeEvent({
    hook_event_name: 'TeammateIdle', session_id: 'two-prompts-member',
    transcript_path: teammate.file, team_name: TEAM, teammate_name: MEMBER,
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushForge();
  for (const [id, prompt] of [['first-prompt-msg', 'task: first'], ['second-prompt-msg', 'follow up']]) {
    const chat = exporter.getFinishedSpans().find(span => span.attributes[ATTR.RESPONSE_ID] === id);
    assert.ok(chat);
    assert.equal(chat.attributes[ATTR.INPUT_MESSAGES], JSON.stringify([
      { role: 'user', parts: [{ type: 'text', content: prompt }] },
    ]));
  }
});

test('an explicit Team call survives SessionEnd', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'session-end');
  await dispatch(daemon, sid, 'deferred-team-call', 'inspect');
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    reason: 'clear',
  });

  const internals = daemon as unknown as { hasInFlightWork(): boolean };
  assert.equal(internals.hasInFlightWork(), true);
  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.FORGE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'deferred-team-call'), false);

  await idle(t, daemon, 'session-end', 'inspection result', 'session-end-msg');
  await flushForge();

  const spans = exporter.getFinishedSpans();
  const agent = spans.find(span =>
    span.attributes[ATTR.FORGE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'deferred-team-call');
  assert.ok(agent);
  assert.equal(agent.attributes[ATTR.FORGE_ORPHAN_REASON], undefined);
  assert.equal(internals.hasInFlightWork(), false);
});

test('SessionEnd closes nested tools before retaining their Team Agent', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'nested-session-end');
  const input = teamInput('inspect');
  await preDispatch(daemon, sid, 'nested-team-call', input);
  const agentId = 'nested-team-agent';
  transcript.subagent(agentId, userEntry('inspect'));
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart',
    session_id: sid,
    agent_id: agentId,
    agent_type: MEMBER,
  });
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse',
    session_id: sid,
    agent_id: agentId,
    tool_use_id: 'nested-team-read',
    tool_name: 'Read',
    tool_input: { file_path: '/still-open.ts' },
  });
  await postDispatch(daemon, sid, 'nested-team-call', input);
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    reason: 'clear',
  });
  await flushForge();

  const nestedTool = exporter.getFinishedSpans().find(span =>
    span.attributes['gen_ai.tool.call.id'] === 'nested-team-read');
  assert.ok(nestedTool);
  assert.equal(nestedTool.attributes[ATTR.FORGE_ORPHAN_REASON], 'session_ended');
  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.FORGE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'nested-team-call'), false);

  await idle(t, daemon, 'nested-session-end', 'nested result', 'nested-team-msg');
  await flushForge();
  const agent = exporter.getFinishedSpans().find(span =>
    span.attributes[ATTR.FORGE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'nested-team-call');
  assert.ok(agent);
  assert.equal(agent.attributes[ATTR.FORGE_ORPHAN_REASON], undefined);
  assert.equal(spanParentId(nestedTool), agent.spanContext().spanId);
});

test('SessionEnd waits for an ordinary named Agent Stop and Post', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'named-session-end');
  const input = { description: 'background work', prompt: 'ordinary task', name: 'worker' };
  const agentId = 'ordinary-ended-agent';
  const subPath = transcript.subagent(
    agentId,
    userEntry('ordinary task'),
    assistantEntry('ordinary-ended-msg', { type: 'text', text: 'ordinary result' }),
  );
  await preDispatch(daemon, sid, 'ordinary-ended-call', input);
  await daemon.routeEvent({
    hook_event_name: 'SubagentStart',
    session_id: sid,
    agent_id: agentId,
    agent_type: 'general-purpose',
  });
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    reason: 'clear',
  });
  await daemon.routeEvent({
    hook_event_name: 'SubagentStop',
    session_id: sid,
    agent_id: agentId,
    agent_type: 'general-purpose',
    agent_transcript_path: subPath,
  });
  await postDispatch(daemon, sid, 'ordinary-ended-call', input);
  await flushForge();

  const agents = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.FORGE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'ordinary-ended-call');
  assert.equal(agents.length, 1);
  assert.equal(agents[0].attributes[ATTR.FORGE_ORPHAN_REASON], undefined);
  assert.ok(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'ordinary-ended-msg'));
});

test('new work cancels a deferred SessionEnd', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'resume-after-end');
  await dispatch(daemon, sid, 'resume-team-call', 'late review');
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    reason: 'clear',
  });

  transcript.append(userEntry('continue after resume'));
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit',
    session_id: sid,
    transcript_path: transcript.file,
    prompt_id: 'resumed-prompt',
    prompt: 'continue after resume',
  });
  await idle(t, daemon, 'resume-after-end', 'late result', 'resume-after-end-msg');
  await flushForge();

  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.AGENT_NAME] === 'claude-code'
    && String(span.attributes[ATTR.INPUT_MESSAGES]).includes('continue after resume')), false);

  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    prompt_id: 'resumed-prompt',
    reason: 'clear',
  });
  await flushForge();
  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.AGENT_NAME] === 'claude-code'
    && String(span.attributes[ATTR.INPUT_MESSAGES]).includes('continue after resume')), true);
});

test('a failed team spawn closes its deferred owner', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'failure');
  const input = teamInput('fail review');
  await preDispatch(daemon, sid, 'failed-team-call', input);
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    reason: 'clear',
  });
  assert.equal(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.FORGE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'failed-team-call'), false);

  await daemon.routeEvent({
    hook_event_name: 'PostToolUseFailure',
    session_id: sid,
    tool_use_id: 'failed-team-call',
    tool_name: 'Agent',
    tool_input: input,
    error: 'SpawnError: unavailable',
  });
  await flushForge();

  const spans = exporter.getFinishedSpans();
  const agent = spans.find(span =>
    span.attributes[ATTR.FORGE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'failed-team-call');
  assert.ok(agent);
  assert.equal(agent.attributes[ATTR.ERROR_TYPE], 'SpawnError');
  assert.equal(agent.attributes[ATTR.FORGE_ORPHAN_REASON], undefined);
  assert.ok(spans.some(span => span.attributes[ATTR.AGENT_NAME] === 'claude-code'));
});

test('legacy team work retains only its exact owning turn', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'legacy-owner-turn');
  await dispatch(daemon, sid, 'legacy-owner-call', 'background review');
  for (const prompt of ['second prompt', 'third prompt']) {
    transcript.append(userEntry(prompt));
    await daemon.routeEvent({
      hook_event_name: 'UserPromptSubmit',
      session_id: sid,
      transcript_path: transcript.file,
      prompt,
    });
  }

  const finishedRoots = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.AGENT_NAME] === 'claude-code');
  assert.equal(finishedRoots.length, 1);

  await idle(t, daemon, 'legacy-owner-turn', 'background result', 'legacy-owner-msg');
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    reason: 'clear',
  });
  await flushForge();
  assert.ok(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'legacy-owner-msg'));
});

test('legacy team work does not retain a later turn before an explicit prompt', async (t) => {
  const { exporter, daemon, sid, transcript } = await coordinator(t, 'mixed-owner-turn');
  await dispatch(daemon, sid, 'mixed-owner-call', 'background review');

  transcript.append(userEntry('second legacy prompt'));
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit',
    session_id: sid,
    transcript_path: transcript.file,
    prompt: 'second legacy prompt',
  });
  transcript.append(userEntry('third explicit prompt'));
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit',
    session_id: sid,
    transcript_path: transcript.file,
    prompt_id: 'third-prompt-id',
    prompt: 'third explicit prompt',
  });

  const finishedRoots = exporter.getFinishedSpans().filter(span =>
    span.attributes[ATTR.AGENT_NAME] === 'claude-code');
  assert.equal(finishedRoots.length, 1);
  assert.ok(String(finishedRoots[0].attributes[ATTR.INPUT_MESSAGES])
    .includes('second legacy prompt'));

  await idle(t, daemon, 'mixed-owner-turn', 'background result', 'mixed-owner-msg');
  await daemon.routeEvent({
    hook_event_name: 'SessionEnd',
    session_id: sid,
    prompt_id: 'third-prompt-id',
    reason: 'clear',
  });
  await flushForge();
  assert.ok(exporter.getFinishedSpans().some(span =>
    span.attributes[ATTR.RESPONSE_ID] === 'mixed-owner-msg'));
});

test('shutdown orphans an explicit Team Agent', async (t) => {
  const { exporter, daemon, sid } = await coordinator(t, 'shutdown');
  await dispatch(daemon, sid, 'shutdown-team-call', 'remote task');
  await daemon.drain('SIGTERM');
  await flushForge();

  const spans = exporter.getFinishedSpans();
  const root = spans.find(span => span.attributes[ATTR.AGENT_NAME] === 'claude-code');
  const agent = spans.find(span =>
    span.attributes[ATTR.FORGE_SUBAGENT_SPAWNING_TOOL_CALL_ID] === 'shutdown-team-call');
  assert.ok(root && agent);
  assert.equal(agent.attributes[ATTR.FORGE_ORPHAN_REASON], 'daemon_shutdown');
  assert.equal(spanParentId(agent), root.spanContext().spanId);
  assert.deepEqual(agent.endTime, root.endTime);
});
