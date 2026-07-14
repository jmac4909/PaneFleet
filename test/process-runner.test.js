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
