const UNIT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}\.service$/;
const SOCKET_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

function cgroupFromText(value) {
  for (const line of String(value || '').split('\n')) {
    const parts = line.split(':');
    if (parts[0] === '0' && parts.length >= 3) return parts.slice(2).join(':').trim();
  }
  return '';
}

export async function inspectWorkloadTmuxIsolation({
  controlPlaneMode,
  run,
  readFile,
  processId,
  workloadUnit = 'panefleet-workloads.service',
  socket = '',
  procRoot = '/proc'
}) {
  if (controlPlaneMode !== 'systemd-user') return { ok: true, mode: controlPlaneMode, status: 'not_required' };
  if (
    typeof run !== 'function' || typeof readFile !== 'function' ||
    !Number.isInteger(processId) || processId < 1 ||
    !UNIT_PATTERN.test(workloadUnit) ||
    (socket && !SOCKET_PATTERN.test(socket)) ||
    typeof procRoot !== 'string' || !procRoot.startsWith('/')
  ) {
    return { ok: false, error: 'workload_isolation_configuration_invalid' };
  }

  const active = await run('systemctl', ['--user', 'is-active', '--quiet', workloadUnit]);
  if (!active.ok) return { ok: false, error: 'workload_isolation_unit_inactive' };
  const unitState = await run('systemctl', ['--user', 'show', workloadUnit, '-p', 'ControlGroup', '--value']);
  const workloadCgroup = String(unitState.stdout || '').trim();
  if (!unitState.ok || !workloadCgroup.startsWith('/')) {
    return { ok: false, error: 'workload_isolation_cgroup_unavailable' };
  }
  const tmuxArgs = [...(socket ? ['-L', socket] : []), 'display-message', '-p', '#{pid}'];
  const tmuxState = await run('tmux', tmuxArgs);
  const tmuxPid = Number(String(tmuxState.stdout || '').trim());
  if (!tmuxState.ok || !Number.isInteger(tmuxPid) || tmuxPid < 1) {
    return { ok: false, error: 'workload_isolation_tmux_unavailable' };
  }
  let tmuxCgroup = '';
  let dashboardCgroup = '';
  try {
    [tmuxCgroup, dashboardCgroup] = await Promise.all([
      readFile(`${procRoot}/${tmuxPid}/cgroup`, 'utf8').then(cgroupFromText),
      readFile(`${procRoot}/${processId}/cgroup`, 'utf8').then(cgroupFromText)
    ]);
  } catch {
    return { ok: false, error: 'workload_isolation_process_unavailable' };
  }
  if (!tmuxCgroup || tmuxCgroup !== workloadCgroup || tmuxCgroup === dashboardCgroup) {
    return {
      ok: false,
      error: 'workload_isolation_mismatch',
      tmuxPid,
      workloadCgroup,
      tmuxCgroup,
      dashboardCgroup
    };
  }
  return { ok: true, status: 'separate', tmuxPid, workloadCgroup, tmuxCgroup, dashboardCgroup };
}
