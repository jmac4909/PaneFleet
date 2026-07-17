import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forbiddenProcessInvocation, run } from '../process-runner.js';

test('central process runner permanently rejects direct and named-socket tmux kill-server commands', async () => {
  assert.equal(forbiddenProcessInvocation('tmux', ['kill-server']), 'tmux_kill_server_forbidden');
  assert.equal(
    forbiddenProcessInvocation('/usr/bin/tmux', ['-L', 'host-control-managed', 'kill-server']),
    'tmux_kill_server_forbidden'
  );
  assert.equal(forbiddenProcessInvocation('tmux', ['list-sessions']), '');

  const result = await run('/definitely-not-installed/tmux', ['-L', 'default', 'kill-server']);
  assert.deepEqual(result, {
    ok: false,
    code: 126,
    signal: null,
    stdout: '',
    stderr: 'tmux_kill_server_forbidden',
    error: 'tmux_kill_server_forbidden'
  });
});

test('central process runner returns normalized success and failure results', async () => {
  assert.equal(forbiddenProcessInvocation('', null), '');
  assert.equal(forbiddenProcessInvocation('node', 'not-an-array'), '');
  assert.equal(forbiddenProcessInvocation('tmux', null), '');

  const success = await run(process.execPath, ['-e', 'process.stdout.write("runner-ok")']);
  assert.deepEqual(success, {
    ok: true,
    code: 0,
    signal: null,
    stdout: 'runner-ok',
    stderr: '',
    error: null
  });

  const failure = await run(process.execPath, [
    '-e',
    'process.stderr.write("runner-failed"); process.exit(7)'
  ]);
  assert.equal(failure.ok, false);
  assert.equal(failure.code, 7);
  assert.equal(failure.signal, null);
  assert.equal(failure.stdout, '');
  assert.equal(failure.stderr, 'runner-failed');
  assert.match(failure.error, /command failed/i);

  const missing = await run('/definitely-not-installed/panefleet-fixture', []);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, null);
  assert.equal(missing.signal, null);
  assert.match(missing.error, /ENOENT/);

  const signaled = await run(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"]);
  assert.equal(signaled.ok, false);
  assert.equal(signaled.code, null);
  assert.equal(signaled.signal, 'SIGTERM');
  assert.match(signaled.error, /SIGTERM/);
});
