import path from 'node:path';
import { execFile } from 'node:child_process';

const FORBIDDEN_TMUX_COMMANDS = new Set(['kill-server']);

export function forbiddenProcessInvocation(command, args = []) {
  if (path.basename(String(command || '')) !== 'tmux') return '';
  return (Array.isArray(args) ? args : []).some((arg) => FORBIDDEN_TMUX_COMMANDS.has(String(arg)))
    ? 'tmux_kill_server_forbidden'
    : '';
}

export function run(command, args, options = {}) {
  const forbidden = forbiddenProcessInvocation(command, args);
  if (forbidden) {
    return Promise.resolve({
      ok: false,
      code: 126,
      signal: null,
      stdout: '',
      stderr: forbidden,
      error: forbidden
    });
  }

  return new Promise((resolve) => {
    execFile(command, args, { timeout: options.timeout || 8000, maxBuffer: 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        signal: error?.signal || null,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error ? String(error.message) : null
      });
    });
  });
}
