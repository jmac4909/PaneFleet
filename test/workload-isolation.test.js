import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectWorkloadTmuxIsolation } from '../workload-isolation.js';

function fixture({ active = true, tmuxCgroup = '/workloads', dashboardCgroup = '/dashboard', socket = '' } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'systemctl' && args.includes('is-active')) return { ok: active, stdout: '', stderr: '' };
    if (command === 'systemctl' && args.includes('show')) return { ok: true, stdout: '/workloads\n', stderr: '' };
    if (command === 'tmux') return { ok: true, stdout: '5151\n', stderr: '' };
    return { ok: false, stdout: '', stderr: 'unexpected' };
  };
  const readFile = async (filePath) => filePath.includes('/5151/')
    ? `0::${tmuxCgroup}\n`
    : `0::${dashboardCgroup}\n`;
  return { calls, run, readFile, socket };
}

test('systemd workload isolation requires the exact active cgroup', async () => {
  const state = fixture();
  const result = await inspectWorkloadTmuxIsolation({
    controlPlaneMode: 'systemd-user',
    run: state.run,
    readFile: state.readFile,
    processId: 4242,
    socket: state.socket
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'separate');
  assert.deepEqual(state.calls.at(-1), ['tmux', 'display-message', '-p', '#{pid}']);
});

test('managed sockets are checked without falling back to the default tmux server', async () => {
  const state = fixture({ socket: 'host-control-managed' });
  const result = await inspectWorkloadTmuxIsolation({
    controlPlaneMode: 'systemd-user',
    run: state.run,
    readFile: state.readFile,
    processId: 4242,
    socket: state.socket
  });
  assert.equal(result.ok, true);
  assert.deepEqual(state.calls.at(-1), ['tmux', '-L', 'host-control-managed', 'display-message', '-p', '#{pid}']);
});

test('isolation fails closed for an inactive unit or dashboard-owned tmux server', async () => {
  const inactive = fixture({ active: false });
  assert.equal((await inspectWorkloadTmuxIsolation({
    controlPlaneMode: 'systemd-user',
    run: inactive.run,
    readFile: inactive.readFile,
    processId: 4242
  })).error, 'workload_isolation_unit_inactive');

  const shared = fixture({ tmuxCgroup: '/dashboard' });
  const result = await inspectWorkloadTmuxIsolation({
    controlPlaneMode: 'systemd-user',
    run: shared.run,
    readFile: shared.readFile,
    processId: 4242
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'workload_isolation_mismatch');
});

test('foreground operation does not require a user-systemd workload unit', async () => {
  const result = await inspectWorkloadTmuxIsolation({
    controlPlaneMode: 'foreground',
    run: null,
    readFile: null,
    processId: 0
  });
  assert.deepEqual(result, { ok: true, mode: 'foreground', status: 'not_required' });
});

test('isolation rejects invalid configuration and every unavailable host boundary', async () => {
  const valid = fixture();
  assert.equal((await inspectWorkloadTmuxIsolation({
    controlPlaneMode: 'systemd-user',
    run: null,
    readFile: valid.readFile,
    processId: 4242
  })).error, 'workload_isolation_configuration_invalid');

  const missingCgroup = fixture();
  missingCgroup.run = async (command, args) => {
    if (command === 'systemctl' && args.includes('is-active')) return { ok: true, stdout: '', stderr: '' };
    if (command === 'systemctl' && args.includes('show')) return { ok: false, stdout: '', stderr: 'missing' };
    return { ok: false, stdout: '', stderr: 'unexpected' };
  };
  assert.equal((await inspectWorkloadTmuxIsolation({
    controlPlaneMode: 'systemd-user',
    run: missingCgroup.run,
    readFile: missingCgroup.readFile,
    processId: 4242
  })).error, 'workload_isolation_cgroup_unavailable');

  const missingTmux = fixture();
  missingTmux.run = async (command, args) => {
    if (command === 'systemctl' && args.includes('is-active')) return { ok: true, stdout: '', stderr: '' };
    if (command === 'systemctl' && args.includes('show')) return { ok: true, stdout: '/workloads\n', stderr: '' };
    return { ok: false, stdout: '', stderr: 'missing' };
  };
  assert.equal((await inspectWorkloadTmuxIsolation({
    controlPlaneMode: 'systemd-user',
    run: missingTmux.run,
    readFile: missingTmux.readFile,
    processId: 4242
  })).error, 'workload_isolation_tmux_unavailable');

  const vanishedProcess = fixture();
  assert.equal((await inspectWorkloadTmuxIsolation({
    controlPlaneMode: 'systemd-user',
    run: vanishedProcess.run,
    readFile: async () => { throw new Error('gone'); },
    processId: 4242
  })).error, 'workload_isolation_process_unavailable');
});
