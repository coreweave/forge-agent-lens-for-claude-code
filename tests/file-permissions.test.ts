// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: Apache-2.0
// SPDX-PackageName: forge-agent-lens-for-claude-code

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createConfig } from '../src/setup.ts';
import { appendToLog } from '../src/utils.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.join(HERE, '..', 'hooks', 'hook-handler.sh');
const FAKE_BIN_DIR = path.join(HERE, 'fixtures', 'fake-forge-agent-lens-for-claude-code-bin');

let scratch: string;
before(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'file-permissions-')); });
after(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

test('createConfig makes the config and log dirs owner-only and settings.json 0600', () => {
  const configDir = path.join(scratch, 'fresh', '.forge-agent-lens-for-claude-code');
  const { settingsFile, logFile } = createConfig(configDir);

  assert.equal(mode(configDir), 0o700);
  assert.equal(mode(path.dirname(logFile)), 0o700);
  assert.equal(mode(settingsFile), 0o600);
});

test('createConfig tightens config and log dirs that already exist', () => {
  const configDir = path.join(scratch, 'existing', '.forge-agent-lens-for-claude-code');
  const logDir = path.join(configDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o755 });
  fs.chmodSync(configDir, 0o755);

  createConfig(configDir);

  assert.equal(mode(configDir), 0o700);
  assert.equal(mode(logDir), 0o700);
});

test('appendToLog creates its directory 0700 and the log file 0600', () => {
  const logFile = path.join(scratch, 'append', 'logs', 'daemon.log');
  appendToLog(logFile, 'INFO', 'hello');

  assert.equal(mode(path.dirname(logFile)), 0o700);
  assert.equal(mode(logFile), 0o600);
});

test('hook-handler.sh creates the log dir 0700 and hook-errors.log 0600', () => {
  const home = fs.mkdtempSync(path.join(scratch, 'hook-'));
  const result = spawnSync('bash', [HOOK_SCRIPT], {
    input: '{}',
    env: { ...process.env, HOME: home, PATH: `${FAKE_BIN_DIR}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0);

  const configDir = path.join(home, '.forge-agent-lens-for-claude-code');
  assert.equal(mode(configDir), 0o700);
  assert.equal(mode(path.join(configDir, 'logs')), 0o700);
  assert.equal(mode(path.join(configDir, 'logs', 'hook-errors.log')), 0o600);
});
