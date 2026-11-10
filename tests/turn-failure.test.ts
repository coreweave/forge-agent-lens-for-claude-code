// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-claude-code

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SpanStatusCode } from '@opentelemetry/api';
import { ATTR } from '../src/genaiSpans.ts';
import { assistantEntry, flushForge, initForgeInMemory, makeGenaiDaemon, spanParentId } from './helpers.ts';

function transcript(t: TestContext, sessionId: string): string {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.forge-stopfailure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({
    type: 'user', message: { role: 'user', content: 'go' },
  }) + '\n');
  return file;
}

test('StopFailure marks the turn as failed', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'stopfailure-turn';
  const file = transcript(t, sessionId);
  const daemon = makeGenaiDaemon();
  const base = { session_id: sessionId, transcript_path: file };

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', ...base, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', ...base, prompt: 'go', prompt_id: 'p1',
  });
  await daemon.routeEvent({
    hook_event_name: 'StopFailure', ...base, prompt_id: 'p1',
    error: 'rate_limit', error_details: '429 from the API after 3 retries',
    last_assistant_message: 'Let me check that file.',
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', ...base, reason: 'clear' });
  await flushForge();

  const [turn] = exporter.getFinishedSpans()
    .filter(s => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent');
  assert.ok(turn, 'the turn exists');
  assert.equal(turn.status.code, 2, 'the span is marked ERROR');
  assert.equal(turn.status.message, '429 from the API after 3 retries');
  await daemon.drain('test cleanup');
  await flushForge();
  assert.equal(exporter.getFinishedSpans().filter(s => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent').length, 1);
});

test('StopFailure after Stop exports an ERROR child under the original root', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'stopfailure-after-stop';
  const file = transcript(t, sessionId);
  const daemon = makeGenaiDaemon();
  const base = { session_id: sessionId, transcript_path: file, prompt_id: 'p1' };
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', ...base, prompt: 'go' });
  fs.appendFileSync(file, JSON.stringify(assistantEntry('response', { type: 'text', text: 'done' })) + '\n');
  await daemon.routeEvent({ hook_event_name: 'Stop', ...base });
  await flushForge();
  const roots = exporter.getFinishedSpans()
    .filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent');
  assert.equal(roots.length, 1);

  await daemon.routeEvent({
    hook_event_name: 'StopFailure', ...base,
    error: 'rate_limit', error_details: '429 after a blocked Stop',
    last_assistant_message: 'done',
  });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', ...base, reason: 'clear' });
  await daemon.drain('test cleanup');
  await flushForge();

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.filter(span => span.attributes[ATTR.OPERATION_NAME] === 'invoke_agent').length, 1);
  const failures = spans.filter(span => span.attributes['gen_ai.tool.name'] === 'turn.failure');
  assert.equal(failures.length, 1);
  const [failure] = failures;
  assert.equal(spanParentId(failure), roots[0].spanContext().spanId);
  assert.equal(failure.spanContext().traceId, roots[0].spanContext().traceId);
  assert.equal(failure.status.code, SpanStatusCode.ERROR);
  assert.equal(failure.status.message, '429 after a blocked Stop');
  assert.equal(failure.attributes[ATTR.ERROR_TYPE], 'rate_limit');
  const exception = failure.events.find(event => event.name === 'exception');
  assert.equal(exception?.attributes?.['exception.message'], '429 after a blocked Stop');
});

test('a successful Stop leaves the turn unerrored', async (t) => {
  const exporter = await initForgeInMemory();
  exporter.reset();
  const sessionId = 'stopfailure-control';
  const file = transcript(t, sessionId);
  const daemon = makeGenaiDaemon();
  const base = { session_id: sessionId, transcript_path: file };

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', ...base, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', ...base, prompt: 'go', prompt_id: 'p1',
  });
  await daemon.routeEvent({ hook_event_name: 'Stop', ...base, prompt_id: 'p1' });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', ...base, reason: 'clear' });
  await flushForge();

  const [turn] = exporter.getFinishedSpans()
    .filter(s => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent');
  assert.ok(turn);
  assert.notEqual(turn.status.code, 2);
});

test('the plugin forwards StopFailure hooks to the daemon', () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'),
  ) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
  const commands = manifest.hooks?.['StopFailure']
    ?.flatMap(group => group.hooks ?? [])
    .map(hook => hook.command);

  assert.ok(commands?.some(command => command?.includes('/hooks/hook-handler.sh')));
});
