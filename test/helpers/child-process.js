import { once } from 'node:events';
import { withTimeout } from './timing.js';

const delay = (milliseconds) => new Promise((resolve) => {
  const timer = setTimeout(resolve, milliseconds);
  timer.unref();
});

function childRunning(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

export async function waitForChildExit(child, {
  timeoutMs = 5000,
  label = 'fixture child'
} = {}) {
  if (!child || typeof child.once !== 'function') throw new TypeError('Child process is required');
  if (!childRunning(child)) return [child.exitCode, child.signalCode];
  return withTimeout(() => once(child, 'exit'), {
    timeoutMs,
    label: `${label} exit`
  });
}

export async function stopChildProcess(
  child,
  timeoutMs = process.env.NODE_V8_COVERAGE ? 15_000 : 2_000
) {
  if (!childRunning(child)) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, delay(timeoutMs)]);
  if (childRunning(child)) {
    child.kill('SIGKILL');
    await Promise.race([exited, delay(timeoutMs)]);
  }
  if (childRunning(child)) throw new Error('fixture child did not stop');
}
