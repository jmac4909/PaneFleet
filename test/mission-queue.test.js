import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function unusedLoopbackPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function installBlockedTool(binDir, name) {
  const executable = path.join(binDir, name);
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$ORCH_TOOL_LOG"\nexit 97\n`,
    { mode: 0o755 }
  );
  chmodSync(executable, 0o755);
}

function installFakeTool(binDir, name, source) {
  const executable = path.join(binDir, name);
  writeFileSync(executable, source, { mode: 0o755 });
  chmodSync(executable, 0o755);
}

function installDispatchTools(fixture) {
  installFakeTool(fixture.binDir, 'tmux', `#!/bin/sh
if [ "$1" = "-L" ] && [ "$2" = "host-control-managed" ]; then
  printf 'tmux:managed:%s\n' "$3" >> "$ORCH_TOOL_LOG"
  exit 1
fi
case "$1" in
  list-panes)
    if [ "$2" = "-a" ]; then
      state="idle"
      if [ -f "$MISSION_TMUX_STATE_PATH" ]; then state="$(cat "$MISSION_TMUX_STATE_PATH")"; fi
      pane_command="\${MISSION_PANE_COMMAND:-node}"
      global_tmux_pane_id='%77'
      global_pane_pid='4100'
      pane_dead='0'
      pane_dead_status=''
      if [ "$state" = "dead" ]; then pane_dead='1'; pane_dead_status='70'; fi
      if [ "$MISSION_SUBMIT_BEHAVIOR" = "replacement" ] && [ "$state" = "accepted" ]; then
        global_tmux_pane_id='%88'
        global_pane_pid='4300'
      fi
      printf '%s|%s|0|0|0|1|%s|/dev/pts/77|%s|%s|%s|%s|%s|Codex Worker\\n' \
        'codex-worker' "\${MISSION_SESSION_CREATED:-1700000000}" "$global_pane_pid" "$global_tmux_pane_id" "$pane_dead" "$pane_dead_status" "$pane_command" "$MISSION_FAKE_WORKSPACE"
      if [ -n "$MISSION_EXTRA_WORKSPACE" ]; then
        printf '%s|%s|0|0|0|1|4200|/dev/pts/78|%%78|0||node|%s|Other Codex Worker\\n' \
          'codex-other' '1700000000' "$MISSION_EXTRA_WORKSPACE"
      fi
      printf '%s\\n' 'tmux:list-all' >> "$ORCH_TOOL_LOG"
    elif [ "$2" = "-t" ] && [ "$3" = "=codex-other" ] && [ -n "$MISSION_EXTRA_WORKSPACE" ]; then
      printf '%s|%s|0|0|1|%s|%s|%s|%s|0|\n' \
        'codex-other' '1700000000' 'node' "$MISSION_EXTRA_WORKSPACE" '%78' '4200'
      printf '%s\n' 'tmux:list-exact-other' >> "$ORCH_TOOL_LOG"
    elif [ "$2" = "-t" ] && [ "$3" = "=codex-worker" ]; then
      state="idle"
      if [ -f "$MISSION_TMUX_STATE_PATH" ]; then state="$(cat "$MISSION_TMUX_STATE_PATH")"; fi
      pane_command="\${MISSION_PANE_COMMAND:-node}"
      tmux_pane_id='%77'
      pane_pid='4100'
      pane_dead='0'
      pane_dead_status=''
      if [ "$state" = "dead" ]; then pane_dead='1'; pane_dead_status='70'; fi
      if [ "$MISSION_SUBMIT_BEHAVIOR" = "replacement" ] && [ "$state" = "accepted" ]; then
        tmux_pane_id='%88'
        pane_pid='4300'
      fi
      printf '%s|%s|0|0|1|%s|%s|%s|%s|%s|%s\\n' \
        'codex-worker' "\${MISSION_SESSION_CREATED:-1700000000}" "$pane_command" "$MISSION_FAKE_WORKSPACE" "$tmux_pane_id" "$pane_pid" "$pane_dead" "$pane_dead_status"
      printf '%s\\n' 'tmux:list-exact' >> "$ORCH_TOOL_LOG"
    else
      printf '%s\\n' 'tmux:unexpected-list' >> "$ORCH_TOOL_LOG"
      exit 97
    fi
    ;;
  set-option)
    printf 'tmux:protect-pane:%s:%s:%s\\n' "$4" "$5" "$6" >> "$ORCH_TOOL_LOG"
    if [ "$2" != "-p" ] || [ "$3" != "-t" ] || { [ "$4" != "%77" ] && [ "$4" != "%78" ]; } || [ "$5" != "remain-on-exit" ] || [ "$6" != "on" ]; then
      printf '%s\\n' 'tmux:unexpected-protection' >> "$ORCH_TOOL_LOG"
      exit 97
    fi
    if [ "$MISSION_LIFECYCLE_GUARD_FAIL" = "1" ]; then exit 96; fi
    ;;
  capture-pane)
    if [ -n "$MISSION_CAPTURE_DELAY" ]; then sleep "$MISSION_CAPTURE_DELAY"; fi
    state="idle"
    if [ -f "$MISSION_TMUX_STATE_PATH" ]; then state="$(cat "$MISSION_TMUX_STATE_PATH")"; fi
    if [ "$MISSION_SUBMIT_BEHAVIOR" = "capture-failure" ] && [ "$state" = "accepted" ]; then
      printf '%s\\n' 'tmux:capture-failed' >> "$ORCH_TOOL_LOG"
      exit 96
    fi
    if [ -n "$MISSION_CAPTURE_OUTPUT" ]; then
      printf '%s\\n' "$MISSION_CAPTURE_OUTPUT"
    else
      case "$state" in
        typed)
          render_count=0
          if [ -f "$MISSION_TMUX_RENDER_COUNT_PATH" ]; then render_count="$(cat "$MISSION_TMUX_RENDER_COUNT_PATH")"; fi
          render_count=$((render_count + 1))
          printf '%s\\n' "$render_count" > "$MISSION_TMUX_RENDER_COUNT_PATH"
          printf '%s\\n' 'OpenAI Codex'
          if [ -n "$MISSION_STALE_WORKING" ]; then printf '%s\\n' 'Working (old output)'; fi
          if [ "$render_count" -ge "\${MISSION_LITERAL_VISIBLE_AFTER:-1}" ]; then
            if [ "$MISSION_PAD_QUEUE_MARKER" = "1" ]; then
              printf '› %s\\n' "$(sed 's/Queue Dispatch/Queue  Dispatch/' "$MISSION_TMUX_INPUT_PATH")"
            else
              printf '› %s\\n' "$(cat "$MISSION_TMUX_INPUT_PATH")"
            fi
          else
            printf '%s\\n' '› input still rendering'
          fi
          printf '%s\\n' 'gpt-test-alpha ultra · 100% left'
          ;;
        accepted)
          printf '%s\\n' 'OpenAI Codex'
          capture_lines="$(printf '%s' "$6" | tr -d '-')"
          if [ "$MISSION_HIDE_MARKER_BELOW_CAPTURE" = "1" ] && [ "$capture_lines" -lt 300 ]; then
            printf '%s\\n' 'Earlier accepted prompt is outside this shallow capture.'
          elif [ "$MISSION_PAD_QUEUE_MARKER" = "1" ]; then
            printf '› %s\\n' "$(sed 's/Queue Dispatch/Queue  Dispatch/' "$MISSION_TMUX_INPUT_PATH")"
          else
            printf '› %s\\n' "$(cat "$MISSION_TMUX_INPUT_PATH")"
          fi
          printf '%s\\n' 'Working (1s)'
          printf '%s\\n' 'esc to interrupt'
          ;;
        transient)
          confirm_count=0
          if [ -f "$MISSION_TMUX_CONFIRM_COUNT_PATH" ]; then confirm_count="$(cat "$MISSION_TMUX_CONFIRM_COUNT_PATH")"; fi
          confirm_count=$((confirm_count + 1))
          printf '%s\\n' "$confirm_count" > "$MISSION_TMUX_CONFIRM_COUNT_PATH"
          printf '%s\\n' 'OpenAI Codex'
          printf '› %s\\n' "$(cat "$MISSION_TMUX_INPUT_PATH")"
          if [ "$confirm_count" -eq 1 ]; then printf '%s\\n' 'Working (1s)'; fi
          printf '%s\\n' 'gpt-test-alpha ultra · 100% left'
          ;;
        complete)
          printf '%s\\n' 'OpenAI Codex'
          printf '› %s\\n' "$(cat "$MISSION_TMUX_INPUT_PATH")"
          printf '%s\\n' '──────────────────────────────────────────────────────────'
          printf '%s\\n' '• Focused work completed and ready for review.'
          printf '%s\\n' 'STATUS: complete'
          printf '%s\\n' 'RESULT: focused work completed'
          printf '%s\\n' 'EVIDENCE: focused tests passed'
          printf '%s\\n' 'NEXT ACTION: verify independently'
          printf '%s\\n' '─ Worked for 1m 04s ──────────────────────────────────────'
          printf '%s\\n' '› Ask Codex anything'
          printf '%s\\n' 'gpt-test-alpha ultra · 95% left'
          ;;
        long-complete)
          printf '%s\\n' 'OpenAI Codex'
          printf '› %s\\n' "$(cat "$MISSION_TMUX_INPUT_PATH")"
          printf '%s\\n' '──────────────────────────────────────────────────────────'
          printf '%s\\n' 'STATUS: complete'
          printf '%s' 'RESULT: OPENAI_API_KEY=fixture-secret-value remained private in a long completed response '
          field_index=0
          while [ "$field_index" -lt 60 ]; do printf '%s' 'result-detail '; field_index=$((field_index + 1)); done
          printf '\\n'
          printf '%s' 'EVIDENCE: '
          field_index=0
          while [ "$field_index" -lt 100 ]; do printf '%s' 'verified-evidence '; field_index=$((field_index + 1)); done
          printf '\\n'
          printf '%s' 'NEXT ACTION: inspect OPENAI_API_KEY=fixture-secret-value only in the sanitized ticket '
          field_index=0
          while [ "$field_index" -lt 60 ]; do printf '%s' 'review-next '; field_index=$((field_index + 1)); done
          printf '\\n'
          detail_index=0
          while [ "$detail_index" -lt 140 ]; do
            printf 'Evidence detail %03d confirms bounded completion capture without terminal input or retry.\\n' "$detail_index"
            detail_index=$((detail_index + 1))
          done
          printf '%s\\n' 'Sanitization witness OPENAI_API_KEY=fixture-secret-value remains private near the final boundary'
          printf '%s\\n' '─ Worked for 12m 34s ─────────────────────────────────────'
          printf '%s\\n' '› Ask Codex anything'
          printf '%s\\n' 'gpt-test-alpha ultra · 91% left'
          ;;
        complete-then-busy)
          runtime_count=0
          if [ -f "$MISSION_TMUX_CONFIRM_COUNT_PATH" ]; then runtime_count="$(cat "$MISSION_TMUX_CONFIRM_COUNT_PATH")"; fi
          runtime_count=$((runtime_count + 1))
          printf '%s\\n' "$runtime_count" > "$MISSION_TMUX_CONFIRM_COUNT_PATH"
          printf '%s\\n' 'OpenAI Codex'
          printf '› %s\\n' "$(cat "$MISSION_TMUX_INPUT_PATH")"
          printf '%s\\n' '──────────────────────────────────────────────────────────'
          printf '%s\\n' '• Prior queued work completed before a newer turn began.'
          printf '%s\\n' 'STATUS: complete'
          printf '%s\\n' 'RESULT: prior queued work completed'
          printf '%s\\n' 'EVIDENCE: exact final boundary remains visible'
          printf '%s\\n' 'NEXT ACTION: continue the newer manual turn'
          printf '%s\\n' '─ Worked for 2m 03s ──────────────────────────────────────'
          printf '%s\\n' '› A newer manually entered prompt is now running'
          printf 'Working (%ss)\\n' "$runtime_count"
          printf '%s\\n' 'gpt-test-alpha ultra · 94% left'
          ;;
        intermediate-ready)
          printf '%s\\n' 'OpenAI Codex'
          printf '%s\\n' '    118 +  assert.match(app, /Repeats create normal queue items only when due/);'
          printf '%s\\n' 'Still waiting for a Worked for boundary before this ticket can complete.'
          printf '%s\\n' '  └ node --test test/mission-queue.test.js test/ui-shell.test.js'
          printf '%s\\n' '› Ask Codex anything'
          printf '%s\\n' 'gpt-test-alpha ultra · 95% left'
          ;;
        idle-after-accepted)
          printf '%s\\n' 'OpenAI Codex'
          printf '› %s\\n' "$(cat "$MISSION_TMUX_INPUT_PATH")"
          printf '%s\\n' '  └ Earlier tool output should not enter the retained final message.'
          printf '%s\\n' '──────────────────────────────────────────────────────────'
          printf '%s\\n' '• The accepted turn returned to the composer without a final footer.'
          printf '%s\\n' '    > Preserve this quoted response detail as content, not a composer.'
          printf '%s\\n' '──────────────────────────────────────────────────────────'
          printf '%s\\n' '› Ask Codex anything'
          printf '%s\\n' 'gpt-test-alpha ultra · 95% left'
          ;;
        return-then-newer-idle)
          printf '%s\\n' 'OpenAI Codex'
          printf '› %s\\n' "$(cat "$MISSION_TMUX_INPUT_PATH")"
          printf '%s\\n' 'The queued turn returned without a footer.'
          printf '%s\\n' '› A newer manually entered prompt'
          printf '%s\\n' 'The newer manual turn also returned.'
          printf '%s\\n' '› Ask Codex anything'
          printf '%s\\n' 'gpt-test-alpha ultra · 95% left'
          ;;
        marker-lost-idle)
          printf '%s\\n' 'OpenAI Codex'
          printf '%s\\n' 'The original dispatch marker is outside bounded capture.'
          printf '%s\\n' '› Ask Codex anything'
          printf '%s\\n' 'gpt-test-alpha ultra · 95% left'
          ;;
        marker-beyond-primary-complete)
          capture_lines="$(printf '%s' "$6" | tr -d '-')"
          printf '%s\\n' 'OpenAI Codex'
          if [ "$capture_lines" -ge 2000 ]; then
            printf '› %s\\n' "$(cat "$MISSION_TMUX_INPUT_PATH")"
            printf '%s\\n' '──────────────────────────────────────────────────────────'
            printf '%s\\n' 'STATUS: complete'
            printf '%s\\n' 'RESULT: recovered from the exact deeper boundary'
            printf '%s\\n' 'EVIDENCE: focused recovery test passed'
            printf '%s\\n' 'NEXT ACTION: advance the exact terminal line'
            printf '%s\\n' '─ Worked for 19m 04s ─────────────────────────────────────'
          else
            printf '%s\\n' 'The exact dispatch marker is older than the primary capture.'
          fi
          printf '%s\\n' '› Ask Codex anything'
          printf '%s\\n' 'gpt-test-alpha ultra · 95% left'
          ;;
        goal-achieved)
          printf '%s\\n' 'OpenAI Codex'
          printf '%s\\n' 'Goal achieved'
          printf '%s\\n' '› Ask Codex anything'
          printf '%s\\n' 'gpt-test-alpha ultra · 95% left'
          ;;
        background-working)
          printf '%s\\n' 'OpenAI Codex'
          printf '%s\\n' '› Ask Codex anything'
          printf '%s\\n' 'Waiting for background terminal (2m 17s) · node --test'
          printf '%s\\n' 'gpt-test-alpha ultra · 95% left · Goal achieved (15m)'
          ;;
        pursuing-stale-ready)
          printf '%s\\n' 'OpenAI Codex'
          printf '%s\\n' 'Working (old output)'
          printf '%s\\n' '› Ask Codex anything'
          printf '%s\\n' 'gpt-test-alpha ultra · Pursuing goal (2m 17s)'
          ;;
        pursuing-active)
          runtime_count=0
          if [ -f "$MISSION_TMUX_CONFIRM_COUNT_PATH" ]; then runtime_count="$(cat "$MISSION_TMUX_CONFIRM_COUNT_PATH")"; fi
          runtime_count=$((runtime_count + 1))
          printf '%s\\n' "$runtime_count" > "$MISSION_TMUX_CONFIRM_COUNT_PATH"
          printf '%s\\n' 'OpenAI Codex'
          printf 'Working (%ss)\\n' "$runtime_count"
          printf '%s\\n' '› Ask Codex anything'
          printf 'gpt-test-alpha ultra · Pursuing goal (%ss)\\n' "$runtime_count"
          ;;
        idle-placeholder)
          printf '%s\\n' 'OpenAI Codex'
          printf '› %s\\n' "$(cat "$MISSION_TMUX_INPUT_PATH")"
          printf '%s\\n' '› Implement {feature}'
          printf '%s\\n' 'gpt-test-alpha ultra · 100% left'
          ;;
        dead)
          printf '%s\\n' 'OpenAI Codex'
          printf '› %s\\n' "$(cat "$MISSION_TMUX_INPUT_PATH")"
          printf '%s\\n' 'Codex process exited'
          ;;
        *)
          printf '%s\\n' 'OpenAI Codex'
          printf '%s\\n' '› Ask Codex anything'
          printf '%s\\n' 'gpt-test-alpha ultra · 100% left'
          ;;
      esac
    fi
    capture_lines="$(printf '%s' "$6" | tr -d '-')"
    printf 'tmux:capture-lines:%s\\n' "$capture_lines" >> "$ORCH_TOOL_LOG"
    printf '%s\\n' 'tmux:capture' >> "$ORCH_TOOL_LOG"
    ;;
  send-keys)
    printf 'tmux:send-target:%s:%s\\n' "$3" "$4" >> "$ORCH_TOOL_LOG"
    if [ "$2" != "-t" ] || { [ "$3" != "codex-worker:0.0" ] && [ "$3" != "%77" ] && [ "$3" != "codex-other:0.0" ] && [ "$3" != "%78" ]; }; then
      printf '%s\\n' 'tmux:unexpected-target' >> "$ORCH_TOOL_LOG"
      exit 97
    fi
    if [ "$4" = "-l" ] && [ "$#" -eq 5 ]; then
      case "$5" in
        '[PaneFleet Mission '* )
          if ! grep -q '"status": "dispatching"' "$MISSION_QUEUE_PATH" || \
             ! grep -q '"assignedPaneId": "codex-worker:0.0"' "$MISSION_QUEUE_PATH" || \
             ! grep -q '"activeAttempt": {' "$MISSION_QUEUE_PATH"; then
            printf '%s\\n' 'tmux:unexpected-undurable-claim' >> "$ORCH_TOOL_LOG"
            exit 97
          fi
          : > "$MISSION_TMUX_INPUT_PATH"
          ;;
        '[PaneFleet Queued Prompt '* )
          if ! grep -q '"status": "dispatching"' "$PROMPT_QUEUE_PATH" || \
             ! grep -q '"paneId": "codex-worker:0.0"' "$PROMPT_QUEUE_PATH" || \
             ! grep -q '"attemptId": "queue-attempt-' "$PROMPT_QUEUE_PATH"; then
            printf '%s\n' 'tmux:unexpected-undurable-prompt-claim' >> "$ORCH_TOOL_LOG"
            exit 97
          fi
          : > "$MISSION_TMUX_INPUT_PATH"
          ;;
      esac
      case "$5" in
        *'
'*) printf '%s\\n' 'tmux:unexpected-multiline-prompt' >> "$ORCH_TOOL_LOG"; exit 97 ;;
      esac
      if [ -n "$MISSION_MAX_LITERAL_CHUNK" ] && [ "\${#5}" -gt "$MISSION_MAX_LITERAL_CHUNK" ]; then
        printf 'tmux:oversized-literal:%s\\n' "\${#5}" >> "$ORCH_TOOL_LOG"
        exit 97
      fi
      printf 'tmux:send-literal:%s\\n' "\${#5}" >> "$ORCH_TOOL_LOG"
      printf '%s' "$5" >> "$MISSION_TMUX_INPUT_PATH"
      printf '%s\\n' 'typed' > "$MISSION_TMUX_STATE_PATH"
      if [ "$MISSION_TMUX_FAILURE" = "literal" ]; then exit 96; fi
    elif [ "$4" = "C-m" ] && [ "$#" -eq 4 ]; then
      printf '%s\\n' 'tmux:send-enter:C-m' >> "$ORCH_TOOL_LOG"
      if [ "$MISSION_TMUX_FAILURE" = "enter" ] || { [ "$MISSION_FAIL_OTHER_ENTER" = "1" ] && [ "$3" = "codex-other:0.0" ]; }; then exit 96; fi
      case "$MISSION_SUBMIT_BEHAVIOR" in
        ignored) ;;
        transient) printf '%s\\n' 'transient' > "$MISSION_TMUX_STATE_PATH" ;;
        complete) printf '%s\\n' 'complete' > "$MISSION_TMUX_STATE_PATH" ;;
        long-complete) printf '%s\\n' 'long-complete' > "$MISSION_TMUX_STATE_PATH" ;;
        idle-placeholder) printf '%s\\n' 'idle-placeholder' > "$MISSION_TMUX_STATE_PATH" ;;
        exit-after-enter) printf '%s\\n' 'dead' > "$MISSION_TMUX_STATE_PATH" ;;
        *) printf '%s\\n' 'accepted' > "$MISSION_TMUX_STATE_PATH" ;;
      esac
      if [ "$MISSION_BREAK_PERSIST_AFTER_ENTER" = "1" ]; then
        rm -f "$MISSION_QUEUE_PATH.tmp"
        mkdir "$MISSION_QUEUE_PATH.tmp"
      fi
      if [ "$PROMPT_QUEUE_BREAK_PERSIST_AFTER_ENTER" = "1" ]; then
        rm -f "$PROMPT_QUEUE_PATH.tmp"
        mkdir "$PROMPT_QUEUE_PATH.tmp"
      fi
    else
      printf '%s\\n' 'tmux:unexpected-send' >> "$ORCH_TOOL_LOG"
      exit 97
    fi
    ;;
  *)
    printf 'tmux:unexpected:%s\\n' "$1" >> "$ORCH_TOOL_LOG"
    exit 97
    ;;
esac
`);

  installFakeTool(fixture.binDir, 'ps', `#!/bin/sh
if [ "$2" = "pid,ppid,tty,stat,pcpu,pmem,rss,cmd" ]; then
  printf '%s\\n' 'PID PPID TT STAT %CPU %MEM RSS CMD'
  printf '%s\\n' '4100 1 pts/77 Ss 0.0 0.1 1000 bash'
  state="idle"
  if [ -f "$MISSION_TMUX_STATE_PATH" ]; then state="$(cat "$MISSION_TMUX_STATE_PATH")"; fi
  if [ "$MISSION_NO_CODEX_PROCESS" != "1" ] && [ "$state" != "dead" ]; then
    printf '%s\\n' '4101 4100 pts/77 S+ 0.0 0.2 2000 node codex'
    printf '%s\\n' '4201 4200 pts/78 S+ 0.0 0.2 2000 node codex'
  fi
  printf '%s\\n' 'ps:tty' >> "$ORCH_TOOL_LOG"
elif [ "$2" = "pid,ppid,stat,etime,pcpu,pmem,rss,cmd" ]; then
  printf '%s\\n' 'PID PPID STAT ELAPSED %CPU %MEM RSS CMD'
  printf '%s\\n' '4101 4100 S+ 00:01 0.0 0.2 2000 node codex'
  printf '%s\\n' '4201 4200 S+ 00:01 0.0 0.2 2000 node codex'
  printf '%s\\n' 'ps:top' >> "$ORCH_TOOL_LOG"
else
  printf '%s\\n' 'ps:unexpected' >> "$ORCH_TOOL_LOG"
  exit 97
fi
`);

  installFakeTool(fixture.binDir, 'ss', `#!/bin/sh
if [ "$1" = "-ltnp" ]; then
  printf '%s\\n' 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process'
  printf '%s\\n' 'ss:listeners' >> "$ORCH_TOOL_LOG"
elif [ "$1" = "-Htn" ]; then
  printf '%s\\n' 'ss:ssh-peers' >> "$ORCH_TOOL_LOG"
else
  printf '%s\\n' 'ss:unexpected' >> "$ORCH_TOOL_LOG"
  exit 97
fi
`);
}

function installReviewTools(fixture) {
  installDispatchTools(fixture);
  installFakeTool(fixture.binDir, 'tmux', `#!/bin/sh
printf 'tmux:%s\n' "$*" >> "$ORCH_TOOL_LOG"
if [ "$1" = "list-panes" ]; then
  exit 0
fi
if [ "$1" != "-L" ] || [ "$2" != "host-control-managed" ]; then
  exit 97
fi
case "$3" in
  list-panes) exit 1 ;;
  has-session|kill-session|new-session|set-option) exit 0 ;;
  *) exit 97 ;;
esac
`);
}

function createFixture() {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'agent-orchestrator-missions-'));
  const codexHome = path.join(fixtureDir, 'codex-home');
  const projectsRoot = path.join(fixtureDir, 'projects');
  const alphaWorkspace = path.join(projectsRoot, 'alpha');
  const betaWorkspace = path.join(projectsRoot, 'beta');
  const agentWorkspacesRoot = path.join(projectsRoot, 'agent-workspaces');
  const extraWorkspaceRoot = path.join(fixtureDir, 'extra-workspace');
  const publicDir = path.join(fixtureDir, 'public');
  const binDir = path.join(fixtureDir, 'blocked-bin');
  const toolLogPath = path.join(fixtureDir, 'external-tools.log');

  for (const directory of [
    codexHome,
    alphaWorkspace,
    betaWorkspace,
    agentWorkspacesRoot,
    extraWorkspaceRoot,
    publicDir,
    binDir
  ]) mkdirSync(directory, { recursive: true });

  copyFileSync(path.join(projectDir, 'test', 'services.fixture.json'), path.join(fixtureDir, 'services.json'));
  writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>Mission Queue Test</title>\n');
  writeFileSync(path.join(fixtureDir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(codexHome, 'models_cache.json'), '{"models":[]}\n');

  // Queue CRUD must remain pure filesystem work. Any accidental host inspection
  // is contained, logged, and fails the test.
  for (const name of ['aws', 'curl', 'ps', 'ss', 'tmux']) installBlockedTool(binDir, name);

  return {
    fixtureDir,
    codexHome,
    projectsRoot,
    alphaWorkspace,
    betaWorkspace,
    agentWorkspacesRoot,
    extraWorkspaceRoot,
    binDir,
    toolLogPath,
    queuePath: path.join(fixtureDir, 'data', 'mission-queue.json'),
    promptQueuePath: path.join(fixtureDir, 'data', 'prompt-queue.json'),
    tmuxInputPath: path.join(fixtureDir, 'tmux-input')
  };
}

async function startServer(fixture, envOverrides = {}) {
  const port = await unusedLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
    cwd: fixture.fixtureDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      ORCHESTRATOR_RUNTIME_ROOT: fixture.fixtureDir,
      CODEX_HOME: fixture.codexHome,
      PATH: `${fixture.binDir}:${process.env.PATH || ''}`,
      ORCH_TOOL_LOG: fixture.toolLogPath,
      ORCHESTRATOR_PROJECTS_ROOT: fixture.projectsRoot,
      ORCHESTRATOR_AGENT_WORKSPACES_ROOT: fixture.agentWorkspacesRoot,
      ORCHESTRATOR_EXTRA_WORKSPACE_ROOTS: fixture.extraWorkspaceRoot,
      MISSION_FAKE_WORKSPACE: fixture.alphaWorkspace,
      MISSION_QUEUE_PATH: fixture.queuePath,
      PROMPT_QUEUE_PATH: fixture.promptQueuePath,
      MISSION_TMUX_STATE_PATH: path.join(fixture.fixtureDir, 'tmux-state'),
      MISSION_TMUX_INPUT_PATH: path.join(fixture.fixtureDir, 'tmux-input'),
      MISSION_TMUX_RENDER_COUNT_PATH: path.join(fixture.fixtureDir, 'tmux-render-count'),
      MISSION_TMUX_CONFIRM_COUNT_PATH: path.join(fixture.fixtureDir, 'tmux-confirm-count'),
      MISSION_LITERAL_CONFIRM_MS: '400',
      MISSION_SUBMIT_CONFIRM_MS: '500',
      MISSION_CONFIRM_SAMPLE_MS: '20',
      PROMPT_QUEUE_READY_MIN_MS: '20',
      CODEX_RUNTIME_SETTLE_MS: '20',
      ORCH_CONTROL_PLANE_MODE: 'foreground',
      SNAPSHOT_EVENT_MS: '3600000',
      SSH_RESCUE_MONITOR_MS: '3600000',
      ...envOverrides
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const rawRequest = async (pathname, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      return await fetch(`${baseUrl}${pathname}`, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const deadline = Date.now() + 10000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`isolated server exited early (${child.exitCode ?? child.signalCode})\n${output}`);
    }
    try {
      const response = await rawRequest('/healthz');
      if (response.status === 200) {
        ready = true;
        break;
      }
    } catch {
      // The child may still be binding its loopback listener.
    }
    await delay(50);
  }
  if (!ready) {
    throw new Error(`isolated server did not become ready\n${output}`);
  }

  const index = await rawRequest('/');
  const cookie = (index.headers.get('set-cookie') || '').split(';', 1)[0];
  assert.match(cookie, /^host_control_session=/);

  const request = (pathname, body) => rawRequest(pathname, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  return {
    child,
    request,
    cookie,
    postWithCookie(pathname, body, cookieOverride = '') {
      return rawRequest(pathname, {
        method: 'POST',
        headers: { cookie: cookieOverride, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
    },
    get(pathname, { authenticated = true, cookieOverride = null } = {}) {
      const requestCookie = cookieOverride === null ? (authenticated ? cookie : '') : cookieOverride;
      return rawRequest(pathname, { headers: requestCookie ? { cookie: requestCookie } : {} });
    },
    output: () => output,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await Promise.race([exited, delay(2000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([exited, delay(2000)]);
      }
      assert.equal(
        child.exitCode !== null || child.signalCode !== null,
        true,
        `isolated server did not stop\n${output}`
      );
    }
  };
}

function readQueue(fixture) {
  return JSON.parse(readFileSync(fixture.queuePath, 'utf8'));
}

function toolLog(fixture) {
  return existsSync(fixture.toolLogPath) ? readFileSync(fixture.toolLogPath, 'utf8') : '';
}

async function responseJson(response) {
  return JSON.parse(await response.text());
}

function missionBody(workspace, overrides = {}) {
  return {
    title: 'Ship a durable queue slice',
    goal: 'Implement the requested queue behavior and leave focused validation evidence.',
    verificationCriteria: 'Focused tests pass and the durable record contains the expected state.',
    priority: 'normal',
    workspace,
    ...overrides
  };
}

function adoptionBody(expectedRevision, overrides = {}) {
  return {
    expectedRevision,
    confirm: 'adopt-existing',
    session: 'codex-worker',
    sessionCreatedAt: '2023-11-14T22:13:20.000Z',
    paneId: 'codex-worker:0.0',
    tmuxPaneId: '%77',
    panePid: 4100,
    ...overrides
  };
}

function promptQueueBody(text, overrides = {}) {
  return {
    session: 'codex-worker',
    sessionCreatedAt: '2023-11-14T22:13:20.000Z',
    paneId: 'codex-worker:0.0',
    tmuxPaneId: '%77',
    panePid: 4100,
    text,
    ...overrides
  };
}

function multiPromptTargets(overrides = {}) {
  return [
    {
      session: 'codex-worker',
      sessionCreatedAt: '2023-11-14T22:13:20.000Z',
      paneId: 'codex-worker:0.0',
      tmuxPaneId: '%77',
      panePid: 4100
    },
    {
      session: 'codex-other',
      sessionCreatedAt: '2023-11-14T22:13:20.000Z',
      paneId: 'codex-other:0.0',
      tmuxPaneId: '%78',
      panePid: 4200,
      ...overrides
    }
  ];
}

function readPromptQueue(fixture) {
  return JSON.parse(readFileSync(fixture.promptQueuePath, 'utf8'));
}

function recurringPromptSchedule(overrides = {}) {
  const timestamp = '2026-07-14T12:00:00.000Z';
  return {
    id: 'schedule-recurring-12345678',
    revision: 1,
    enabled: true,
    session: 'codex-worker',
    sessionCreatedAt: '2023-11-14T22:13:20.000Z',
    paneId: 'codex-worker:0.0',
    tmuxPaneId: '%77',
    panePid: 4100,
    text: 'Inspect current project health and report only actionable changes.',
    cron: '* * * * *',
    nextRunAt: timestamp,
    lastRunAt: null,
    lastScheduledFor: null,
    lastOutcome: '',
    runCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

test('a ready mission persists across restart without automatic dispatch', async () => {
  const fixture = createFixture();
  let server;
  try {
    server = await startServer(fixture);
    const createdResponse = await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace));
    assert.equal(createdResponse.status, 200);
    const created = await responseJson(createdResponse);
    assert.equal(created.ok, true);
    assert.equal(created.job.status, 'ready');
    assert.equal(created.job.revision, 1);
    assert.equal(created.job.assignedSession, '');
    assert.equal(created.job.activeAttempt, null);

    await delay(200);
    const beforeRestart = readQueue(fixture);
    assert.equal(beforeRestart.version, 1);
    assert.equal(beforeRestart.revision, 1);
    assert.equal(beforeRestart.jobs.length, 1);
    assert.equal(beforeRestart.jobs[0].id, created.job.id);
    assert.equal(beforeRestart.jobs[0].status, 'ready');
    assert.equal(beforeRestart.events.at(-1)?.kind, 'mission.created');
    assert.equal(statSync(fixture.queuePath).mode & 0o777, 0o600);
    assert.equal(existsSync(`${fixture.queuePath}.tmp`), false);
    assert.equal(toolLog(fixture), '');

    await server.stop();
    server = await startServer(fixture);
    const transitionedResponse = await server.request(
      `/api/missions/${created.job.id}/transition`,
      { expectedRevision: 1, to: 'backlog' }
    );
    assert.equal(transitionedResponse.status, 200);
    const transitioned = await responseJson(transitionedResponse);
    assert.equal(transitioned.job.status, 'backlog');
    assert.equal(transitioned.job.revision, 2);

    const afterRestart = readQueue(fixture);
    assert.equal(afterRestart.jobs.length, 1);
    assert.equal(afterRestart.jobs[0].status, 'backlog');
    assert.deepEqual(afterRestart.events.map((event) => event.kind), [
      'mission.created',
      'mission.backlog'
    ]);
    assert.equal(toolLog(fixture), '');
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('moving queued missions is durable and rejects stale revisions without mutation', async () => {
  const fixture = createFixture();
  let server;
  try {
    server = await startServer(fixture);
    const firstResponse = await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      title: 'First mission'
    }));
    const secondResponse = await server.request('/api/missions/create', missionBody(fixture.betaWorkspace, {
      title: 'Second mission'
    }));
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    const first = (await responseJson(firstResponse)).job;
    const second = (await responseJson(secondResponse)).job;

    let queue = readQueue(fixture);
    assert.deepEqual(queue.jobs.map((job) => [job.title, job.position, job.revision]), [
      ['First mission', 1, 1],
      ['Second mission', 2, 1]
    ]);

    const movedResponse = await server.request(`/api/missions/${second.id}/move`, {
      expectedRevision: second.revision,
      direction: 'up'
    });
    assert.equal(movedResponse.status, 200);
    const moved = await responseJson(movedResponse);
    assert.equal(moved.job.id, second.id);
    assert.equal(moved.job.position, 1);
    assert.equal(moved.job.revision, 2);

    queue = readQueue(fixture);
    const ordered = [...queue.jobs].sort((left, right) => left.position - right.position);
    assert.deepEqual(ordered.map((job) => [job.title, job.position, job.revision]), [
      ['Second mission', 1, 2],
      ['First mission', 2, 2]
    ]);
    assert.equal(queue.revision, 3);
    const durableBeforeConflict = readFileSync(fixture.queuePath, 'utf8');

    const staleResponse = await server.request(`/api/missions/${second.id}/move`, {
      expectedRevision: second.revision,
      direction: 'down'
    });
    assert.equal(staleResponse.status, 409);
    const stale = await responseJson(staleResponse);
    assert.equal(stale.error, 'mission_revision_conflict');
    assert.equal(stale.job.id, second.id);
    assert.equal(stale.job.revision, 2);
    assert.equal(readFileSync(fixture.queuePath, 'utf8'), durableBeforeConflict);
    assert.equal(toolLog(fixture), '');
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('Today separates dispatchable Ready work from held Backlog work', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const firstReady = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      title: 'Ready first'
    })))).job;
    const later = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.betaWorkspace, {
      title: 'Held for later',
      status: 'backlog'
    })))).job;
    const secondReady = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.betaWorkspace, {
      title: 'Ready second'
    })))).job;

    const snapshot = await responseJson(await server.get('/api/snapshot'));
    assert.equal(snapshot.missions.counts.upNext, 2);
    assert.equal(snapshot.missions.counts.ready, 2);
    assert.equal(snapshot.missions.counts.backlog, 1);
    assert.equal(snapshot.missions.counts.queued, 3);
    assert.deepEqual(
      snapshot.missions.jobs.filter((job) => job.status === 'ready').map((job) => job.id),
      [firstReady.id, secondReady.id]
    );
    assert.deepEqual(
      snapshot.missions.jobs.filter((job) => job.status === 'backlog').map((job) => job.id),
      [later.id]
    );

    const movedResponse = await server.request(`/api/missions/${firstReady.id}/move`, {
      expectedRevision: firstReady.revision,
      direction: 'down'
    });
    assert.equal(movedResponse.status, 200);
    const queue = readQueue(fixture);
    assert.deepEqual(
      queue.jobs.filter((job) => job.status === 'ready').sort((left, right) => left.position - right.position).map((job) => job.id),
      [secondReady.id, firstReady.id]
    );
    assert.equal(queue.jobs.find((job) => job.id === later.id).position, 2);

    const appSource = readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
    assert.match(appSource, /const upNext = jobs\.filter\(\(job\) => job\.status === 'ready'\)/);
    assert.match(appSource, /const later = jobs\.filter\(\(job\) => job\.status === 'backlog'\)/);
    assert.match(appSource, /missionLane\('Up Next',[\s\S]*missionLane\('Later'/);
    assert.equal(toolLog(fixture).split('\n').some((line) => line.startsWith('tmux:send-')), false);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('mission creation validates workspace and sensitive text before persistence', async () => {
  const fixture = createFixture();
  let server;
  try {
    server = await startServer(fixture);
    const outsideResponse = await server.request('/api/missions/create', missionBody(os.tmpdir()));
    assert.equal(outsideResponse.status, 400);
    assert.deepEqual(await responseJson(outsideResponse), { error: 'invalid_workspace' });

    const sensitiveName = ['OPENAI', 'API', 'KEY'].join('_');
    const sensitiveValue = ['definitely', 'not', 'a', 'real', 'value'].join('-');
    const sensitiveResponse = await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      goal: `Use ${sensitiveName}=${sensitiveValue} to finish the task.`
    }));
    assert.equal(sensitiveResponse.status, 400);
    assert.deepEqual(await responseJson(sensitiveResponse), { error: 'mission_sensitive_content_not_allowed' });

    const queue = readQueue(fixture);
    assert.equal(queue.revision, 0);
    assert.deepEqual(queue.jobs, []);
    assert.deepEqual(queue.events, []);
    assert.equal(toolLog(fixture), '');
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('dispatch claims durably, then sends literal text and Enter to one idle existing worker', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const createdResponse = await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      title: 'Dispatch through the safe terminal path'
    }));
    assert.equal(createdResponse.status, 200);
    const created = (await responseJson(createdResponse)).job;

    const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    const dispatched = await responseJson(dispatchResponse);
    assert.equal(dispatchResponse.status, 200, JSON.stringify(dispatched));
    assert.equal(dispatched.ok, true);
    assert.equal(dispatched.session, 'codex-worker');
    assert.equal(dispatched.job.status, 'running');
    assert.equal(dispatched.job.revision, 3);
    assert.equal(dispatched.job.assignedSession, 'codex-worker');
    assert.equal(dispatched.job.assignedSessionCreatedAt, '2023-11-14T22:13:20.000Z');
    assert.equal(dispatched.job.assignedPaneId, 'codex-worker:0.0');
    assert.equal(dispatched.job.assignedTmuxPaneId, '%77');
    assert.equal(dispatched.job.assignedPanePid, 4100);

    const queue = readQueue(fixture);
    const job = queue.jobs.find((item) => item.id === created.id);
    assert.equal(job.status, 'running');
    assert.equal(job.activeAttempt.status, 'running');
    assert.equal(job.activeAttempt.session, 'codex-worker');
    assert.equal(job.activeAttempt.tmuxPaneId, '%77');
    assert.equal(job.activeAttempt.panePid, 4100);
    assert.equal(job.activeAttempt.confirmationMarker, `[PaneFleet Dispatch ${job.activeAttempt.id}]`);
    assert.match(job.activeAttempt.submittedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(queue.events.map((event) => event.kind), [
      'mission.created',
      'mission.dispatching',
      'mission.running'
    ]);

    const operations = toolLog(fixture).trim().split('\n');
    assert.equal(operations.some((operation) => operation.includes('unexpected')), false);
    assert.equal(operations.includes('aws'), false);
    assert.equal(operations.includes('curl'), false);
    const literalOperations = operations.filter((operation) => operation.startsWith('tmux:send-literal:'));
    const enterOperations = operations.filter((operation) => operation === 'tmux:send-enter:C-m');
    assert.equal(literalOperations.length, 1);
    assert.equal(enterOperations.length, 1);
    assert.equal(operations.includes('tmux:send-target:%77:-l'), true);
    assert.equal(operations.includes('tmux:send-target:%77:C-m'), true);
    assert.ok(operations.indexOf(literalOperations[0]) < operations.indexOf('tmux:send-enter:C-m'));
    assert.ok(operations.filter((operation) => operation === 'tmux:capture').length >= 5);
    const literalOperation = operations.find((operation) => operation.startsWith('tmux:send-literal:'));
    assert.ok(Number(literalOperation?.split(':').at(-1)) > 0);

    const beforeUnlinkedInput = toolLog(fixture);
    const unlinkedInput = await server.request('/api/agent/send', {
      session: 'codex-worker',
      text: 'Continue with an unrelated task.'
    });
    assert.equal(unlinkedInput.status, 409);
    assert.equal((await responseJson(unlinkedInput)).error, 'mission_context_required');
    assert.equal(toolLog(fixture), beforeUnlinkedInput);

    const linkedInput = await server.request('/api/agent/send', {
      session: 'codex-worker',
      text: 'Continue this mission with the requested validation.',
      missionId: created.id
    });
    assert.equal(linkedInput.status, 200);
    assert.equal((await responseJson(linkedInput)).missionId, created.id);

    const unconfirmedRelease = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: dispatched.job.revision,
      to: 'canceled',
      note: 'Canceled by operator.'
    });
    assert.equal(unconfirmedRelease.status, 400);
    assert.equal((await responseJson(unconfirmedRelease)).error, 'mission_lock_release_confirmation_required');

    const confirmedRelease = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: dispatched.job.revision,
      to: 'canceled',
      note: 'Canceled by operator.',
      confirm: 'inspected-release'
    });
    assert.equal(confirmedRelease.status, 200);
    const canceled = (await responseJson(confirmedRelease)).job;
    assert.equal(canceled.status, 'canceled');

    const requeuedResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: canceled.revision,
      to: 'ready'
    });
    assert.equal(requeuedResponse.status, 200);
    const requeued = (await responseJson(requeuedResponse)).job;
    assert.equal(requeued.status, 'ready');
    assert.equal(requeued.activeAttempt, null);
    assert.equal(requeued.attempts.length, 1);
    assert.equal(requeued.attempts[0].status, 'canceled');
    assert.match(requeued.attempts[0].finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(requeued.outcomes.map((outcome) => outcome.status), ['canceled']);
    assert.equal(requeued.outcomes[0].note, 'Canceled by operator.');
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('a post-Enter persistence failure is never retried and restart reconciles without resending', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { MISSION_BREAK_PERSIST_AFTER_ENTER: '1' });
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      title: 'Preserve uncertain delivery across a write failure'
    })))).job;

    const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    const failed = await responseJson(dispatchResponse);
    assert.equal(dispatchResponse.status, 500);
    assert.equal(failed.error, 'internal_error');
    assert.doesNotMatch(JSON.stringify(failed), /Preserve uncertain delivery/);

    const firstOperations = toolLog(fixture).trim().split('\n');
    assert.equal(firstOperations.filter((operation) => operation.startsWith('tmux:send-literal:')).length, 1);
    assert.equal(firstOperations.filter((operation) => operation === 'tmux:send-enter:C-m').length, 1);
    const claimed = readQueue(fixture).jobs[0];
    assert.equal(claimed.status, 'dispatching');
    assert.equal(claimed.activeAttempt.status, 'dispatching');
    assert.equal(claimed.activeAttempt.submittedAt, null);

    await server.stop();
    server = null;
    rmSync(`${fixture.queuePath}.tmp`, { recursive: true, force: true });
    writeFileSync(fixture.toolLogPath, '');

    server = await startServer(fixture);
    const snapshot = await responseJson(await server.get('/api/snapshot'));
    const reconciled = snapshot.missions.jobs.find((job) => job.id === created.id);
    assert.equal(reconciled.status, 'reconcile_required');
    assert.equal(reconciled.activeAttempt.status, 'outcome_unknown');
    assert.match(reconciled.blocker, /will not resend/i);
    assert.equal(toolLog(fixture).split('\n').some((operation) => operation.startsWith('tmux:send-')), false);

    const durable = readQueue(fixture).jobs[0];
    assert.equal(durable.status, 'reconcile_required');
    assert.equal(durable.activeAttempt.status, 'outcome_unknown');
    assert.equal(readQueue(fixture).events.at(-1)?.kind, 'mission.reconcile_required');
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('long mission prompts are typed in bounded literal chunks before one Enter', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { MISSION_MAX_LITERAL_CHUNK: '384' });
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      title: 'Dispatch a long mission without dropping terminal input',
      goal: `Implement and verify the bounded terminal delivery path. ${'evidence '.repeat(190)}`
    })))).job;

    const response = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    const result = await responseJson(response);
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.job.status, 'running');

    const operations = toolLog(fixture).trim().split('\n');
    const literalOperations = operations.filter((operation) => operation.startsWith('tmux:send-literal:'));
    assert.ok(literalOperations.length > 1);
    assert.equal(literalOperations.every((operation) => Number(operation.split(':').at(-1)) <= 384), true);
    assert.equal(operations.some((operation) => operation.startsWith('tmux:oversized-literal:')), false);
    assert.equal(operations.filter((operation) => operation === 'tmux:send-enter:C-m').length, 1);
    assert.ok(operations.indexOf('tmux:send-enter:C-m') > operations.lastIndexOf(literalOperations.at(-1)));

    const renderedInput = readFileSync(fixture.tmuxInputPath, 'utf8');
    assert.match(renderedInput, new RegExp(`^\\[PaneFleet Mission ${created.id}\\]`));
    assert.match(renderedInput, /Dispatch a long mission without dropping terminal input/);
    assert.match(renderedInput, new RegExp(`\\[PaneFleet Dispatch ${readQueue(fixture).jobs[0].activeAttempt.id}\\]$`));
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('multi-agent queue creation is confirmation-gated, exact-target-bound, and atomic', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'background-working\n');
  let server;
  try {
    server = await startServer(fixture, { MISSION_EXTRA_WORKSPACE: fixture.betaWorkspace });
    const targets = multiPromptTargets();
    const text = 'Inspect your assigned project and report the next concrete action.';

    const unconfirmed = await server.request('/api/prompt-queue/batch', { targets, text });
    assert.equal(unconfirmed.status, 400);
    assert.equal((await responseJson(unconfirmed)).error, 'confirmation_required');
    assert.deepEqual(readPromptQueue(fixture).items, []);

    const duplicate = await server.request('/api/prompt-queue/batch', {
      confirm: 'queue-multiple',
      targets: [targets[0], targets[0]],
      text
    });
    assert.equal(duplicate.status, 400);
    assert.equal((await responseJson(duplicate)).error, 'multi_agent_prompt_duplicate_target');

    const overLimit = await server.request('/api/prompt-queue/batch', {
      confirm: 'queue-multiple',
      targets: Array.from({ length: 13 }, () => targets[0]),
      text
    });
    assert.equal(overLimit.status, 400);
    assert.deepEqual(await responseJson(overLimit), {
      error: 'multi_agent_prompt_target_limit',
      maxTargets: 12
    });
    assert.deepEqual(readPromptQueue(fixture).items, []);

    const stale = await server.request('/api/prompt-queue/batch', {
      confirm: 'queue-multiple',
      targets: multiPromptTargets({ panePid: 9999 }),
      text
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(await responseJson(stale), {
      error: 'multi_agent_prompt_target_missing_or_replaced',
      session: 'codex-other'
    });
    assert.deepEqual(readPromptQueue(fixture).items, []);

    const response = await server.request('/api/prompt-queue/batch', {
      confirm: 'queue-multiple',
      targets,
      text
    });
    const body = await responseJson(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'queue');
    assert.equal(body.count, 2);
    assert.deepEqual(body.items.map((item) => item.session), ['codex-worker', 'codex-other']);

    const durable = readPromptQueue(fixture);
    assert.equal(durable.revision, 1);
    assert.deepEqual(durable.items.map((item) => item.session), ['codex-worker', 'codex-other']);
    assert.deepEqual(durable.items.map((item) => item.text), [text, text]);
    assert.equal(new Set(durable.items.map((item) => item.position)).size, 2);
    assert.equal(toolLog(fixture).includes('tmux:send-literal:'), false);
    assert.equal(toolLog(fixture).includes('tmux:send-enter:'), false);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('multi-agent immediate send submits literal text plus one Enter to every exact pane', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'idle\n');
  let server;
  try {
    server = await startServer(fixture, { MISSION_EXTRA_WORKSPACE: fixture.betaWorkspace });
    const response = await server.request('/api/agent/send-batch', {
      confirm: 'send-multiple',
      targets: multiPromptTargets(),
      text: 'Return one concise status line from this exact terminal.'
    });
    const body = await responseJson(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual({ ok: body.ok, successCount: body.successCount, failedCount: body.failedCount }, {
      ok: true,
      successCount: 2,
      failedCount: 0
    });
    assert.deepEqual(body.results.map((result) => [result.session, result.ok]), [
      ['codex-worker', true],
      ['codex-other', true]
    ]);
    const operations = toolLog(fixture).trim().split('\n');
    assert.equal(operations.filter((operation) => operation === 'tmux:send-target:codex-worker:0.0:-l').length, 1);
    assert.equal(operations.filter((operation) => operation === 'tmux:send-target:codex-other:0.0:-l').length, 1);
    assert.equal(operations.filter((operation) => operation === 'tmux:send-target:codex-worker:0.0:C-m').length, 1);
    assert.equal(operations.filter((operation) => operation === 'tmux:send-target:codex-other:0.0:C-m').length, 1);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('multi-agent immediate send reports partial delivery per target without retrying', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'idle\n');
  let server;
  try {
    server = await startServer(fixture, {
      MISSION_EXTRA_WORKSPACE: fixture.betaWorkspace,
      MISSION_FAIL_OTHER_ENTER: '1'
    });
    const response = await server.request('/api/agent/send-batch', {
      confirm: 'send-multiple',
      targets: multiPromptTargets(),
      text: 'Run this once and never retry an uncertain target.'
    });
    const body = await responseJson(response);
    assert.equal(response.status, 207, JSON.stringify(body));
    assert.equal(body.ok, false);
    assert.equal(body.successCount, 1);
    assert.equal(body.failedCount, 1);
    assert.deepEqual(body.results.map((result) => [result.session, result.ok, result.error || '']), [
      ['codex-worker', true, ''],
      ['codex-other', false, 'terminal_submit_failed']
    ]);
    const operations = toolLog(fixture).trim().split('\n');
    assert.equal(operations.filter((operation) => operation === 'tmux:send-target:codex-worker:0.0:C-m').length, 1);
    assert.equal(operations.filter((operation) => operation === 'tmux:send-target:codex-other:0.0:C-m').length, 1);
    assert.equal(operations.filter((operation) => operation === 'tmux:send-enter:C-m').length, 2);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('prompt queue waits through blue and sends once after two stable green samples', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'accepted\n');
  writeFileSync(fixture.tmuxInputPath, 'prior prompt');
  let server;
  try {
    server = await startServer(fixture);
    const promptText = 'Review the current diff and report the smallest safe next change.';
    const createdResponse = await server.request('/api/prompt-queue', promptQueueBody(promptText));
    const created = await responseJson(createdResponse);
    assert.equal(createdResponse.status, 200, JSON.stringify(created));
    assert.equal(created.item.status, 'queued');
    assert.equal(created.item.target.state, 'busy');

    await server.get('/api/snapshot');
    await delay(30);
    const blueSnapshot = await responseJson(await server.get('/api/snapshot'));
    assert.equal(blueSnapshot.promptQueue.items[0].status, 'queued');
    assert.equal(toolLog(fixture).includes('tmux:send-enter:C-m'), false);

    writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'idle\n');
    const firstGreen = await responseJson(await server.get('/api/snapshot'));
    assert.equal(firstGreen.promptQueue.items[0].status, 'queued');
    assert.equal(firstGreen.promptQueue.items[0].target.green, true);
    assert.equal(toolLog(fixture).includes('tmux:send-enter:C-m'), false);

    await delay(30);
    const secondGreen = await responseJson(await server.get('/api/snapshot'));
    assert.equal(secondGreen.promptQueue.items[0].status, 'sent');
    assert.equal(secondGreen.promptQueue.counts.pending, 1);
    assert.equal(secondGreen.promptQueue.counts.finishing, 1);

    const operations = toolLog(fixture).trim().split('\n');
    assert.equal(operations.filter((line) => line === 'tmux:send-enter:C-m').length, 1);
    const rendered = readFileSync(fixture.tmuxInputPath, 'utf8');
    assert.match(rendered, /^\[PaneFleet Queued Prompt prompt-/);
    assert.match(rendered, new RegExp(promptText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(rendered, /\[PaneFleet Queue Dispatch queue-attempt-/);

    const durable = readPromptQueue(fixture);
    assert.equal(durable.items[0].status, 'sent');
    assert.match(durable.items[0].sentAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(statSync(fixture.promptQueuePath).mode & 0o777, 0o600);
    const audit = readFileSync(path.join(fixture.fixtureDir, 'data', 'actions.jsonl'), 'utf8');
    assert.doesNotMatch(audit, /Review the current diff/);
    assert.match(audit, /"action":"prompt_queue\.sent"/);
    assert.match(audit, /no_retry=true/);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('a queued prompt post-Enter write failure parks on restart without resending', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'idle\n');
  let server;
  try {
    server = await startServer(fixture, { PROMPT_QUEUE_BREAK_PERSIST_AFTER_ENTER: '1' });
    const promptText = 'Preserve this queued delivery through a synthetic write failure.';
    const createdResponse = await server.request('/api/prompt-queue', promptQueueBody(promptText));
    const created = await responseJson(createdResponse);
    assert.equal(createdResponse.status, 200, JSON.stringify(created));
    assert.equal(created.item.status, 'queued');

    await server.get('/api/snapshot');
    await delay(30);
    const dispatchResponse = await server.get('/api/snapshot');
    const failed = await responseJson(dispatchResponse);
    assert.equal(dispatchResponse.status, 500);
    assert.equal(failed.error, 'internal_error');
    assert.doesNotMatch(JSON.stringify(failed), /Preserve this queued delivery/);

    const firstOperations = toolLog(fixture).trim().split('\n');
    assert.equal(firstOperations.filter((operation) => operation.startsWith('tmux:send-literal:')).length, 1);
    assert.equal(firstOperations.filter((operation) => operation === 'tmux:send-enter:C-m').length, 1);
    const claimed = readPromptQueue(fixture).items[0];
    assert.equal(claimed.status, 'dispatching');
    assert.match(claimed.attemptId, /^queue-attempt-/);
    assert.equal(claimed.sentAt, null);

    await server.stop();
    server = null;
    rmSync(`${fixture.promptQueuePath}.tmp`, { recursive: true, force: true });
    writeFileSync(fixture.toolLogPath, '');

    server = await startServer(fixture);
    const snapshot = await responseJson(await server.get('/api/snapshot'));
    const reviewed = snapshot.promptQueue.items.find((item) => item.id === created.item.id);
    assert.equal(reviewed.status, 'needs_review');
    assert.equal(reviewed.deliveryStage, 'restart_reconciliation');
    assert.match(reviewed.blocker, /will not be resent automatically/i);
    assert.equal(toolLog(fixture).split('\n').some((operation) => operation.startsWith('tmux:send-')), false);

    const durable = readPromptQueue(fixture).items[0];
    assert.equal(durable.status, 'needs_review');
    assert.equal(durable.summaryState, 'unavailable');
    const audit = readFileSync(path.join(fixture.fixtureDir, 'data', 'actions.jsonl'), 'utf8');
    assert.match(audit, /restart_during_dispatch=true/);
    assert.match(audit, /no_resend=true/);
    assert.doesNotMatch(audit, /Preserve this queued delivery/);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('prompt queue preserves and reports an exact pane whose Codex process exits after Enter', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'idle\n');
  let server;
  try {
    server = await startServer(fixture, { MISSION_SUBMIT_BEHAVIOR: 'exit-after-enter' });
    const createdResponse = await server.request('/api/prompt-queue', promptQueueBody(
      'Reply once so the queue can verify process-exit handling.'
    ));
    assert.equal(createdResponse.status, 200);

    await server.get('/api/snapshot');
    await delay(30);
    const dispatched = await responseJson(await server.get('/api/snapshot'));
    const reviewed = dispatched.promptQueue.items[0];
    assert.equal(reviewed.status, 'needs_review');
    assert.equal(reviewed.deliveryStage, 'confirmation');
    assert.match(reviewed.blocker, /worker stopped or changed/i);

    const operations = toolLog(fixture).trim().split('\n');
    const guardIndex = operations.indexOf('tmux:protect-pane:%77:remain-on-exit:on');
    const literalIndex = operations.findIndex((line) => line.startsWith('tmux:send-literal:'));
    const enterIndex = operations.indexOf('tmux:send-enter:C-m');
    assert.ok(guardIndex >= 0 && guardIndex < literalIndex);
    assert.ok(literalIndex < enterIndex);
    assert.equal(operations.filter((line) => line === 'tmux:send-enter:C-m').length, 1);
    assert.equal(operations.some((line) => /kill-session|respawn-pane|kill-server/.test(line)), false);

    const stopped = await responseJson(await server.get('/api/snapshot'));
    const stoppedAgent = stopped.agents.find((agent) => agent.session === 'codex-worker');
    const stoppedItem = stopped.promptQueue.items[0];
    assert.equal(stoppedAgent.dead, true);
    assert.equal(stoppedAgent.deadStatus, 70);
    assert.equal(stoppedAgent.canSend, false);
    assert.equal(stoppedAgent.queueReady, false);
    assert.equal(stoppedAgent.agentStatus.state, 'stopped');
    assert.match(stoppedAgent.agentStatus.reason, /exit 70/i);
    assert.equal(stoppedItem.target.present, true);
    assert.equal(stoppedItem.target.identityMatches, true);
    assert.equal(stoppedItem.target.green, false);
    assert.equal(stoppedItem.target.state, 'stopped');

    await server.get('/api/snapshot');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 1);
    assert.equal(readPromptQueue(fixture).items[0].status, 'needs_review');
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('prompt queue fails closed before typing when exact-pane exit preservation cannot be armed', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'idle\n');
  let server;
  try {
    server = await startServer(fixture, { MISSION_LIFECYCLE_GUARD_FAIL: '1' });
    const createdResponse = await server.request('/api/prompt-queue', promptQueueBody(
      'This prompt must not be typed without the lifecycle guard.'
    ));
    assert.equal(createdResponse.status, 200);

    await server.get('/api/snapshot');
    await delay(30);
    const stopped = await responseJson(await server.get('/api/snapshot'));
    const item = stopped.promptQueue.items[0];
    assert.equal(item.status, 'needs_review');
    assert.equal(item.deliveryStage, 'lifecycle_guard');
    assert.match(item.blocker, /sent no input/i);

    const operations = toolLog(fixture).trim().split('\n');
    assert.equal(operations.filter((line) => line === 'tmux:protect-pane:%77:remain-on-exit:on').length, 1);
    assert.equal(operations.some((line) => line.startsWith('tmux:send-literal:')), false);
    assert.equal(operations.includes('tmux:send-enter:C-m'), false);

    await server.get('/api/snapshot');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:protect-pane:%77:remain-on-exit:on').length, 1);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('queued prompt failure stages park the exact terminal line without automatic retry', async (t) => {
  const cases = [
    {
      name: 'literal write uncertainty',
      env: { MISSION_TMUX_FAILURE: 'literal' },
      stage: 'literal_unknown',
      blocker: /automatic delivery stopped/i,
      expectedEnters: 0
    },
    {
      name: 'incomplete literal rendering',
      env: { MISSION_LITERAL_VISIBLE_AFTER: '99' },
      stage: 'literal_confirmation',
      blocker: /Enter was not sent/i,
      expectedEnters: 0
    },
    {
      name: 'Enter write failure',
      env: { MISSION_TMUX_FAILURE: 'enter' },
      stage: 'submit',
      blocker: /Enter failed/i,
      expectedEnters: 1
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = createFixture();
      installDispatchTools(fixture);
      writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'idle\n');
      let server;
      try {
        server = await startServer(fixture, testCase.env);
        const promptText = `Exercise the ${testCase.name} queue safety path.`;
        const createdResponse = await server.request('/api/prompt-queue', promptQueueBody(promptText));
        assert.equal(createdResponse.status, 200);

        await server.get('/api/snapshot');
        await delay(30);
        const attempted = await responseJson(await server.get('/api/snapshot'));
        const reviewed = attempted.promptQueue.items[0];
        assert.equal(reviewed.status, 'needs_review');
        assert.equal(reviewed.deliveryStage, testCase.stage);
        assert.match(reviewed.blocker, testCase.blocker);
        assert.equal(reviewed.summaryState, 'unavailable');

        const operationsAfterAttempt = toolLog(fixture).trim().split('\n');
        const literalCount = operationsAfterAttempt.filter((operation) => operation.startsWith('tmux:send-literal:')).length;
        const enterCount = operationsAfterAttempt.filter((operation) => operation === 'tmux:send-enter:C-m').length;
        assert.equal(literalCount, 1);
        assert.equal(enterCount, testCase.expectedEnters);

        await delay(30);
        await server.get('/api/snapshot');
        await delay(30);
        await server.get('/api/snapshot');
        const operationsAfterRepeatedGreen = toolLog(fixture).trim().split('\n');
        assert.equal(operationsAfterRepeatedGreen.filter((operation) => operation.startsWith('tmux:send-literal:')).length, 1);
        assert.equal(operationsAfterRepeatedGreen.filter((operation) => operation === 'tmux:send-enter:C-m').length, testCase.expectedEnters);

        const durable = readPromptQueue(fixture).items[0];
        assert.equal(durable.status, 'needs_review');
        assert.equal(durable.deliveryStage, testCase.stage);
        const audit = readFileSync(path.join(fixture.fixtureDir, 'data', 'actions.jsonl'), 'utf8');
        assert.match(audit, /"action":"prompt_queue\.needs_review"/);
        assert.match(audit, /no_retry=true/);
        assert.doesNotMatch(audit, new RegExp(testCase.name, 'i'));
      } finally {
        if (server) await server.stop();
        rmSync(fixture.fixtureDir, { recursive: true, force: true });
      }
    });
  }
});

test('recurring prompt schedules validate cron and support pause, resume, and explicit delete without terminal input', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'background-working\n');
  let server;
  try {
    server = await startServer(fixture);
    const invalidResponse = await server.request('/api/prompt-schedules', promptQueueBody('Never schedule invalid cron.', {
      cron: '61 * * * *'
    }));
    assert.equal(invalidResponse.status, 400);
    assert.equal((await responseJson(invalidResponse)).error, 'prompt_schedule_cron_invalid');

    const createdResponse = await server.request('/api/prompt-schedules', promptQueueBody(
      'Review project health and leave a concise status report.',
      { cron: '*/15 * * * *' }
    ));
    const created = await responseJson(createdResponse);
    assert.equal(createdResponse.status, 200, JSON.stringify(created));
    assert.equal(created.schedule.enabled, true);
    assert.equal(created.schedule.cron, '*/15 * * * *');
    assert.match(created.schedule.nextRunAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(created.schedule.runCount, 0);
    assert.equal(created.schedule.occurrenceCount, 0);
    assert.equal(created.schedule.coalescedCount, 0);
    assert.equal(created.schedule.skippedCount, 0);
    assert.equal(toolLog(fixture).split('\n').some((line) => line.startsWith('tmux:send-')), false);

    const visible = await responseJson(await server.get('/api/snapshot'));
    assert.equal(visible.promptQueue.counts.scheduled, 1);
    assert.equal(visible.promptQueue.schedules[0].target.identityMatches, true);

    const pausedResponse = await server.request(`/api/prompt-schedules/${created.schedule.id}/toggle`, {
      expectedRevision: created.schedule.revision,
      enabled: false
    });
    const paused = await responseJson(pausedResponse);
    assert.equal(pausedResponse.status, 200, JSON.stringify(paused));
    assert.equal(paused.schedule.enabled, false);

    const resumedResponse = await server.request(`/api/prompt-schedules/${created.schedule.id}/toggle`, {
      expectedRevision: paused.schedule.revision,
      enabled: true
    });
    const resumed = await responseJson(resumedResponse);
    assert.equal(resumedResponse.status, 200, JSON.stringify(resumed));
    assert.equal(resumed.schedule.enabled, true);
    assert.ok(Date.parse(resumed.schedule.nextRunAt) > Date.now());

    const unconfirmedDelete = await server.request(`/api/prompt-schedules/${created.schedule.id}/delete`, {
      expectedRevision: resumed.schedule.revision,
      confirm: ''
    });
    assert.equal(unconfirmedDelete.status, 400);
    assert.equal(readPromptQueue(fixture).schedules.length, 1);

    const deletedResponse = await server.request(`/api/prompt-schedules/${created.schedule.id}/delete`, {
      expectedRevision: resumed.schedule.revision,
      confirm: 'delete-schedule'
    });
    assert.equal(deletedResponse.status, 200);
    assert.equal(readPromptQueue(fixture).schedules.length, 0);
    assert.equal(readPromptQueue(fixture).items.length, 0);
    assert.equal(toolLog(fixture).split('\n').some((line) => line.startsWith('tmux:send-')), false);

    const audit = readFileSync(path.join(fixture.fixtureDir, 'data', 'actions.jsonl'), 'utf8');
    assert.match(audit, /"action":"prompt_schedule\.create"/);
    assert.match(audit, /"action":"prompt_schedule\.pause"/);
    assert.match(audit, /"action":"prompt_schedule\.resume"/);
    assert.match(audit, /"action":"prompt_schedule\.delete"/);
    assert.doesNotMatch(audit, /Review project health/);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('due schedules enqueue once, coalesce while pending, and skip a replaced exact pane', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'background-working\n');
  mkdirSync(path.dirname(fixture.promptQueuePath), { recursive: true });
  writeFileSync(fixture.promptQueuePath, JSON.stringify({
    version: 1,
    revision: 1,
    items: [],
    schedules: [recurringPromptSchedule()]
  }), { mode: 0o600 });

  let server;
  try {
    server = await startServer(fixture);
    const first = await responseJson(await server.get('/api/snapshot'));
    assert.equal(first.promptQueue.items.length, 1);
    assert.equal(first.promptQueue.items[0].status, 'queued');
    assert.equal(first.promptQueue.items[0].scheduleId, 'schedule-recurring-12345678');
    assert.equal(first.promptQueue.items[0].scheduledFor, '2026-07-14T12:00:00.000Z');
    assert.equal(first.promptQueue.schedules[0].lastOutcome, 'queued');
    assert.equal(first.promptQueue.schedules[0].runCount, 1);
    assert.equal(first.promptQueue.schedules[0].occurrenceCount, 1);
    assert.equal(first.promptQueue.schedules[0].coalescedCount, 0);
    assert.equal(first.promptQueue.schedules[0].skippedCount, 0);
    assert.ok(Date.parse(first.promptQueue.schedules[0].nextRunAt) > Date.parse(first.promptQueue.schedules[0].lastRunAt));
    assert.equal(toolLog(fixture).split('\n').some((line) => line.startsWith('tmux:send-')), false);

    await server.stop();
    server = null;
    const coalesceStore = readPromptQueue(fixture);
    coalesceStore.schedules[0].nextRunAt = '2026-07-14T12:01:00.000Z';
    writeFileSync(fixture.promptQueuePath, JSON.stringify(coalesceStore), { mode: 0o600 });
    server = await startServer(fixture);
    const coalesced = await responseJson(await server.get('/api/snapshot'));
    assert.equal(coalesced.promptQueue.items.length, 1);
    assert.equal(coalesced.promptQueue.schedules[0].lastOutcome, 'coalesced_existing_pending');
    assert.equal(coalesced.promptQueue.schedules[0].runCount, 1);
    assert.equal(coalesced.promptQueue.schedules[0].occurrenceCount, 2);
    assert.equal(coalesced.promptQueue.schedules[0].coalescedCount, 1);
    assert.equal(coalesced.promptQueue.schedules[0].skippedCount, 0);
    assert.equal(toolLog(fixture).split('\n').some((line) => line.startsWith('tmux:send-')), false);

    await server.stop();
    server = null;
    const replacedStore = readPromptQueue(fixture);
    replacedStore.schedules[0].nextRunAt = '2026-07-14T12:02:00.000Z';
    writeFileSync(fixture.promptQueuePath, JSON.stringify(replacedStore), { mode: 0o600 });
    server = await startServer(fixture, { MISSION_SESSION_CREATED: '1700000001' });
    const replaced = await responseJson(await server.get('/api/snapshot'));
    assert.equal(replaced.promptQueue.items.length, 1);
    assert.equal(replaced.promptQueue.schedules[0].lastOutcome, 'skipped_target_unavailable');
    assert.equal(replaced.promptQueue.schedules[0].runCount, 1);
    assert.equal(replaced.promptQueue.schedules[0].occurrenceCount, 3);
    assert.equal(replaced.promptQueue.schedules[0].coalescedCount, 1);
    assert.equal(replaced.promptQueue.schedules[0].skippedCount, 1);
    assert.equal(replaced.promptQueue.schedules[0].target.identityMatches, false);
    assert.equal(toolLog(fixture).split('\n').some((line) => line.startsWith('tmux:send-')), false);
    assert.equal(statSync(fixture.promptQueuePath).mode & 0o777, 0o600);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('legacy recurring schedules recover occurrence counters from the audit log', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  mkdirSync(path.dirname(fixture.promptQueuePath), { recursive: true });
  const schedule = recurringPromptSchedule({
    nextRunAt: '2099-07-14T12:00:00.000Z',
    lastRunAt: '2026-07-14T12:15:00.000Z',
    lastScheduledFor: '2026-07-14T12:15:00.000Z',
    updatedAt: '2026-07-14T12:15:00.000Z',
    lastOutcome: 'coalesced_existing_pending',
    runCount: 1,
    revision: 3
  });
  writeFileSync(fixture.promptQueuePath, JSON.stringify({ version: 1, revision: 1, items: [], schedules: [schedule] }), { mode: 0o600 });
  writeFileSync(path.join(fixture.fixtureDir, 'data', 'actions.jsonl'), [
    '',
    '{invalid audit json',
    JSON.stringify({ time: '2026-07-14T11:58:00.000Z', action: 'service.start', target: 'codex-worker', ok: true, detail: 'schedule=schedule-recurring-12345678' }),
    JSON.stringify({ time: '2026-07-14T11:59:00.000Z', action: 'prompt_schedule.queued', target: 'codex-worker', ok: true, detail: 'schedule=schedule-foreign-12345678; outcome=queued' }),
    JSON.stringify({ time: '2026-07-14T12:00:00.000Z', action: 'prompt_schedule.queued', target: 'codex-worker', ok: true, detail: 'schedule=schedule-recurring-12345678; outcome=queued' }),
    JSON.stringify({ time: '2026-07-14T12:15:00.000Z', action: 'prompt_schedule.coalesced', target: 'codex-worker', ok: true, detail: 'schedule=schedule-recurring-12345678; outcome=coalesced_existing_pending' }),
    JSON.stringify({ time: '2026-07-14T12:30:00.000Z', action: 'prompt_schedule.skipped', target: 'codex-worker', ok: true, detail: 'schedule=schedule-recurring-12345678; outcome=skipped_target_unavailable' })
  ].join('\n') + '\n', { mode: 0o600 });

  let server;
  try {
    server = await startServer(fixture);
    const snapshot = await responseJson(await server.get('/api/snapshot'));
    const migrated = snapshot.promptQueue.schedules[0];
    assert.equal(migrated.occurrenceCount, 3);
    assert.equal(migrated.runCount, 1);
    assert.equal(migrated.coalescedCount, 1);
    assert.equal(migrated.skippedCount, 1);
    const durable = readPromptQueue(fixture).schedules[0];
    assert.equal(durable.occurrenceCount, 3);
    assert.equal(durable.coalescedCount, 1);
    assert.equal(durable.skippedCount, 1);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('replacement panes can explicitly retarget never-sent prompts and schedules without input or lost counters', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'background-working\n');
  let server;
  try {
    server = await startServer(fixture);
    const initial = await responseJson(await server.get('/api/snapshot'));
    const originalAgent = initial.agents.find((agent) => agent.session === 'codex-worker');
    const createdItem = await responseJson(await server.request('/api/prompt-queue', {
      session: originalAgent.session,
      sessionCreatedAt: originalAgent.sessionCreatedAt,
      paneId: originalAgent.id,
      tmuxPaneId: originalAgent.tmuxPaneId,
      panePid: originalAgent.panePid,
      text: 'Keep this never-sent prompt through a pane replacement.'
    }));
    const createdSchedule = await responseJson(await server.request('/api/prompt-schedules', {
      session: originalAgent.session,
      sessionCreatedAt: originalAgent.sessionCreatedAt,
      paneId: originalAgent.id,
      tmuxPaneId: originalAgent.tmuxPaneId,
      panePid: originalAgent.panePid,
      text: 'Keep this recurring prompt through a pane replacement.',
      cron: '0 9 * * 1-5'
    }));

    await server.stop();
    server = null;
    const durable = readPromptQueue(fixture);
    durable.schedules[0].occurrenceCount = 9;
    durable.schedules[0].runCount = 4;
    durable.schedules[0].coalescedCount = 3;
    durable.schedules[0].skippedCount = 2;
    durable.schedules[0].nextRunAt = '2099-07-14T12:00:00.000Z';
    writeFileSync(fixture.promptQueuePath, JSON.stringify(durable), { mode: 0o600 });

    server = await startServer(fixture, { MISSION_SESSION_CREATED: '1700000001' });
    const replaced = await responseJson(await server.get('/api/snapshot'));
    const replacement = replaced.agents.find((agent) => agent.session === 'codex-worker');
    assert.notEqual(replacement.sessionCreatedAt, originalAgent.sessionCreatedAt);
    const staleItem = replaced.promptQueue.items.find((item) => item.id === createdItem.item.id);
    const staleSchedule = replaced.promptQueue.schedules.find((schedule) => schedule.id === createdSchedule.schedule.id);
    assert.equal(staleItem.target.identityMatches, false);
    assert.equal(staleSchedule.target.identityMatches, false);

    const identity = {
      session: replacement.session,
      sessionCreatedAt: replacement.sessionCreatedAt,
      paneId: replacement.id,
      tmuxPaneId: replacement.tmuxPaneId,
      panePid: replacement.panePid
    };
    const retargetedItemResponse = await server.request('/api/prompt-queue/' + staleItem.id + '/retarget', {
      expectedRevision: staleItem.revision,
      confirm: 'retarget-queued-prompt',
      ...identity
    });
    const retargetedItem = await responseJson(retargetedItemResponse);
    assert.equal(retargetedItemResponse.status, 200, JSON.stringify(retargetedItem));
    assert.equal(retargetedItem.item.status, 'queued');
    assert.equal(retargetedItem.item.target.identityMatches, true);
    assert.equal(retargetedItem.item.sessionCreatedAt, replacement.sessionCreatedAt);

    const retargetedScheduleResponse = await server.request('/api/prompt-schedules/' + staleSchedule.id + '/retarget', {
      expectedRevision: staleSchedule.revision,
      confirm: 'retarget-schedule',
      ...identity
    });
    const retargetedSchedule = await responseJson(retargetedScheduleResponse);
    assert.equal(retargetedScheduleResponse.status, 200, JSON.stringify(retargetedSchedule));
    assert.equal(retargetedSchedule.schedule.target.identityMatches, true);
    assert.equal(retargetedSchedule.schedule.lastOutcome, 'retargeted');
    assert.equal(retargetedSchedule.schedule.occurrenceCount, 9);
    assert.equal(retargetedSchedule.schedule.runCount, 4);
    assert.equal(retargetedSchedule.schedule.coalescedCount, 3);
    assert.equal(retargetedSchedule.schedule.skippedCount, 2);
    assert.ok(Date.parse(retargetedSchedule.schedule.nextRunAt) > Date.now());
    assert.equal(toolLog(fixture).split('\n').some((line) => line.startsWith('tmux:send-')), false);

    const audit = readFileSync(path.join(fixture.fixtureDir, 'data', 'actions.jsonl'), 'utf8');
    assert.match(audit, /"action":"prompt_queue\.retarget"/);
    assert.match(audit, /never_sent=true; no_input=true/);
    assert.match(audit, /"action":"prompt_schedule\.retarget"/);
    assert.match(audit, /counters_preserved=true; no_input=true/);
    assert.doesNotMatch(audit, /Keep this never-sent prompt/);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('a delivered queued prompt captures one bounded finish summary from the same exact pane', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { MISSION_SUBMIT_BEHAVIOR: 'complete' });
    const created = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Finish this focused task and leave a concise result.')
    ));
    assert.equal(created.item.summaryState, 'pending');

    await server.get('/api/snapshot');
    await delay(30);
    const delivered = await responseJson(await server.get('/api/snapshot'));
    assert.equal(delivered.promptQueue.items[0].status, 'sent');
    assert.equal(delivered.promptQueue.items[0].summaryState, 'pending');

    await delay(30);
    await server.get('/api/snapshot');
    await delay(30);
    const completed = await responseJson(await server.get('/api/snapshot'));
    const item = completed.promptQueue.items[0];
    assert.equal(item.status, 'sent');
    assert.equal(item.summaryState, 'captured');
    assert.match(item.completionSnapshot, /^─{20,}/);
    assert.match(item.completionSnapshot, /• Focused work completed and ready for review\./);
    assert.match(item.completionSnapshot, /─ Worked for 1m 04s ─/);
    assert.ok(item.completionSnapshot.length <= 4000);
    assert.match(item.completionSummary, /Result: focused work completed/);
    assert.match(item.completionSummary, /Evidence: focused tests passed/);
    assert.match(item.completionSummary, /Next: verify independently/);
    assert.ok(item.completionSummary.length <= 1200);
    assert.match(item.completedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 1);

    const durable = readPromptQueue(fixture).items[0];
    assert.equal(durable.summaryState, 'captured');
    assert.equal(durable.completionSummary, item.completionSummary);
    assert.equal(durable.completionSnapshot, item.completionSnapshot);
    const audit = readFileSync(path.join(fixture.fixtureDir, 'data', 'actions.jsonl'), 'utf8');
    assert.match(audit, /"action":"prompt_queue\.summary_captured"/);
    assert.doesNotMatch(audit, /focused work completed/);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('oversized completion evidence is bounded and redacted before ticket persistence', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { MISSION_SUBMIT_BEHAVIOR: 'long-complete' });
    const created = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Capture this oversized completion without retaining sensitive values.')
    ));
    assert.equal(created.item.summaryState, 'pending');

    await server.get('/api/snapshot');
    await delay(30);
    const delivered = await responseJson(await server.get('/api/snapshot'));
    assert.equal(delivered.promptQueue.items[0].status, 'sent');
    assert.equal(delivered.promptQueue.items[0].summaryState, 'pending');

    await delay(30);
    await server.get('/api/snapshot');
    await delay(30);
    const completed = await responseJson(await server.get('/api/snapshot'));
    const item = completed.promptQueue.items[0];
    assert.equal(item.summaryState, 'captured');
    assert.equal(item.completionSummary.length, 1200);
    assert.match(item.completionSummary, /…$/);
    assert.match(item.completionSummary, /OPENAI_API_KEY\[REDACTED\]/);
    assert.doesNotMatch(item.completionSummary, /fixture-secret-value/);
    assert.equal(item.completionSnapshot.length, 4000);
    assert.match(item.completionSnapshot, /^…\n/);
    assert.match(item.completionSnapshot, /OPENAI_API_KEY\[REDACTED\]/);
    assert.match(item.completionSnapshot, /─ Worked for 12m 34s ─/);
    assert.doesNotMatch(item.completionSnapshot, /fixture-secret-value/);
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 1);

    const durable = readPromptQueue(fixture).items[0];
    assert.equal(durable.completionSummary, item.completionSummary);
    assert.equal(durable.completionSnapshot, item.completionSnapshot);
    const audit = readFileSync(path.join(fixture.fixtureDir, 'data', 'actions.jsonl'), 'utf8');
    assert.match(audit, /"action":"prompt_queue\.summary_captured"/);
    assert.doesNotMatch(audit, /fixture-secret-value/);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('queue history cleanup is revision-checked and never removes active or queued work', async () => {
  const fixture = createFixture();
  const dataDir = path.dirname(fixture.promptQueuePath);
  mkdirSync(dataDir, { recursive: true });
  const timestamp = '2026-07-15T08:00:00.000Z';
  const record = (id, overrides = {}) => ({
    id,
    revision: 2,
    position: 1,
    status: 'sent',
    session: 'codex-worker',
    sessionCreatedAt: '2023-11-14T22:13:20.000Z',
    paneId: 'codex-worker:0.0',
    tmuxPaneId: '%77',
    panePid: 4100,
    text: `Private prompt ${id}`,
    attemptId: `queue-attempt-${id.slice(7)}`,
    blocker: '',
    deliveryStage: 'accepted',
    createdAt: timestamp,
    updatedAt: timestamp,
    claimedAt: timestamp,
    sentAt: timestamp,
    completionSummary: '',
    completionSnapshot: '',
    summaryState: 'pending',
    completedAt: null,
    ...overrides
  });
  writeFileSync(fixture.promptQueuePath, JSON.stringify({
    version: 1,
    revision: 9,
    items: [
      record('prompt-clear-complete-12345678', {
        position: 1,
        summaryState: 'captured',
        completionSummary: 'Bounded completion.',
        completionSnapshot: '─ Worked for 1m 00s ─',
        completedAt: timestamp
      }),
      record('prompt-clear-pending-12345678', { position: 2 }),
      record('prompt-clear-queued-12345678', {
        position: 3,
        status: 'queued',
        attemptId: null,
        deliveryStage: '',
        claimedAt: null,
        sentAt: null
      }),
      record('prompt-clear-unconfirmed-12345678', {
        position: 4,
        summaryState: 'unavailable',
        completionSummary: 'No trustworthy final boundary.',
        completedAt: timestamp
      }),
      record('prompt-clear-canceled-12345678', {
        position: 5,
        status: 'canceled',
        attemptId: null,
        deliveryStage: '',
        claimedAt: null,
        sentAt: null,
        summaryState: 'unavailable'
      })
    ],
    schedules: []
  }), { mode: 0o600 });

  let server;
  try {
    server = await startServer(fixture);
    const stale = await server.request('/api/prompt-queue/clear-completed', {
      expectedRevision: 8,
      confirm: 'clear-completed'
    });
    assert.equal(stale.status, 409);
    assert.equal(readPromptQueue(fixture).items.length, 5);

    const unconfirmed = await server.request('/api/prompt-queue/clear-completed', {
      expectedRevision: 9,
      confirm: 'no'
    });
    assert.equal(unconfirmed.status, 400);
    assert.equal(readPromptQueue(fixture).items.length, 5);

    const clearedResponse = await server.request('/api/prompt-queue/clear-completed', {
      expectedRevision: 9,
      confirm: 'clear-completed'
    });
    const cleared = await responseJson(clearedResponse);
    assert.equal(clearedResponse.status, 200);
    assert.equal(cleared.removed, 1);
    const durable = readPromptQueue(fixture);
    assert.equal(durable.revision, 10);
    assert.deepEqual(durable.items.map((item) => item.id), [
      'prompt-clear-pending-12345678',
      'prompt-clear-queued-12345678',
      'prompt-clear-unconfirmed-12345678',
      'prompt-clear-canceled-12345678'
    ]);
    assert.equal(toolLog(fixture).split('\n').some((line) => line.startsWith('tmux:send-')), false);
    const audit = readFileSync(path.join(dataDir, 'actions.jsonl'), 'utf8');
    assert.match(audit, /"action":"prompt_queue\.completed_cleared"/);
    assert.match(audit, /removed=1; active_unchanged=true; no_input=true/);
    assert.doesNotMatch(audit, /Private prompt/);

    const historyResponse = await server.request('/api/prompt-queue/clear-history', {
      expectedRevision: 10,
      confirm: 'clear-history'
    });
    const history = await responseJson(historyResponse);
    assert.equal(historyResponse.status, 200);
    assert.equal(history.removed, 2);
    const afterHistory = readPromptQueue(fixture);
    assert.equal(afterHistory.revision, 11);
    assert.deepEqual(afterHistory.items.map((item) => item.id), [
      'prompt-clear-pending-12345678',
      'prompt-clear-queued-12345678'
    ]);
    const finalAudit = readFileSync(path.join(dataDir, 'actions.jsonl'), 'utf8');
    assert.match(finalAudit, /"action":"prompt_queue\.history_cleared"/);
    assert.match(finalAudit, /removed=2; active_unchanged=true; schedules_unchanged=true; no_input=true/);
    assert.doesNotMatch(finalAudit, /Private prompt/);
    assert.equal(toolLog(fixture).split('\n').some((line) => line.startsWith('tmux:send-')), false);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('an intermediate green-looking composer cannot complete a ticket or release its next prompt', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const first = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Implement the feature and finish all required verification.')
    ));
    await server.get('/api/snapshot');
    await delay(30);
    const delivered = await responseJson(await server.get('/api/snapshot'));
    assert.equal(delivered.promptQueue.items.find((item) => item.id === first.item.id).status, 'sent');

    const second = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Start only after the prior agent turn has a real final response.')
    ));
    writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'intermediate-ready\n');
    await server.get('/api/snapshot');
    await delay(30);
    const intermediate = await responseJson(await server.get('/api/snapshot'));
    const intermediateFirst = intermediate.promptQueue.items.find((item) => item.id === first.item.id);
    const intermediateSecond = intermediate.promptQueue.items.find((item) => item.id === second.item.id);
    assert.equal(intermediateFirst.summaryState, 'pending');
    assert.equal(intermediateFirst.completedAt, null);
    assert.equal(intermediateSecond.status, 'queued');
    assert.equal(intermediate.promptQueue.counts.finishing, 1);
    assert.equal(intermediate.promptQueue.counts.pending, 2);
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 1);

    writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'complete\n');
    await server.get('/api/snapshot');
    await delay(30);
    const completed = await responseJson(await server.get('/api/snapshot'));
    assert.equal(completed.promptQueue.items.find((item) => item.id === first.item.id).summaryState, 'captured');
    assert.equal(completed.promptQueue.items.find((item) => item.id === second.item.id).status, 'queued');

    await delay(30);
    const released = await responseJson(await server.get('/api/snapshot'));
    assert.equal(released.promptQueue.items.find((item) => item.id === second.item.id).status, 'sent');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 2);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('a newer busy turn does not leave the prior exact queued ticket waiting for final response', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const created = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Complete this queued task before the next manual turn.')
    ));
    await server.get('/api/snapshot');
    await delay(30);
    const delivered = await responseJson(await server.get('/api/snapshot'));
    assert.equal(delivered.promptQueue.items.find((item) => item.id === created.item.id).summaryState, 'pending');

    writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'complete-then-busy\n');
    await server.get('/api/snapshot');
    await delay(30);
    const completed = await responseJson(await server.get('/api/snapshot'));
    const item = completed.promptQueue.items.find((candidate) => candidate.id === created.item.id);
    const agent = completed.agents.find((candidate) => candidate.session === 'codex-worker');
    assert.equal(agent.agentStatus.state, 'busy');
    assert.equal(agent.queueReady, false);
    assert.equal(item.summaryState, 'captured');
    assert.match(item.completionSnapshot, /Prior queued work completed/);
    assert.match(item.completionSnapshot, /─ Worked for 2m 03s ─/);
    assert.doesNotMatch(item.completionSnapshot, /newer manually entered prompt/i);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('stable green with a safe return boundary records the turn without claiming task completion and releases the line', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { PROMPT_QUEUE_MISSING_FINAL_MS: '60' });
    const first = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Complete this task and return a trustworthy final response.')
    ));
    await server.get('/api/snapshot');
    await delay(30);
    const delivered = await responseJson(await server.get('/api/snapshot'));
    assert.equal(delivered.promptQueue.items.find((item) => item.id === first.item.id).status, 'sent');

    const second = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Send only after the prior turn has safely returned.')
    ));
    writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'idle-after-accepted\n');
    await delay(70);
    await server.get('/api/snapshot');
    await delay(30);
    const returned = await responseJson(await server.get('/api/snapshot'));
    const returnedFirst = returned.promptQueue.items.find((item) => item.id === first.item.id);
    const returnedSecond = returned.promptQueue.items.find((item) => item.id === second.item.id);
    assert.equal(returnedFirst.status, 'sent');
    assert.equal(returnedFirst.summaryState, 'returned');
    assert.equal(returnedFirst.deliveryStage, 'returned_to_ready');
    assert.match(returnedFirst.completedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(returnedFirst.completionSnapshot, /accepted turn returned to the composer/i);
    assert.match(returnedFirst.completionSnapshot, /> Preserve this quoted response detail/);
    assert.doesNotMatch(returnedFirst.completionSnapshot, /Earlier tool output/);
    assert.doesNotMatch(returnedFirst.completionSummary, /task completed/i);
    assert.equal(returnedFirst.blocker, '');
    assert.equal(returnedSecond.status, 'queued');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 1);

    await delay(30);
    const released = await responseJson(await server.get('/api/snapshot'));
    assert.equal(released.promptQueue.items.find((item) => item.id === second.item.id).status, 'sent');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 2);
    const audit = readFileSync(path.join(fixture.fixtureDir, 'data', 'actions.jsonl'), 'utf8');
    assert.match(audit, /"action":"prompt_queue\.turn_returned"/);
    assert.match(audit, /footer=false; stable_idle=true; exact_pane=true; semantic_completion=false; no_input=true/);
    assert.doesNotMatch(audit, /Complete this task/);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('stable green with multiple later prompt boundaries pauses until an operator releases the line without claiming completion', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { PROMPT_QUEUE_MISSING_FINAL_MS: '60' });
    const first = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Return from this turn without a footer before a newer manual turn.')
    ));
    await server.get('/api/snapshot');
    await delay(30);
    await server.get('/api/snapshot');
    const second = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Wait until the prior review is explicitly released.')
    ));
    writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'return-then-newer-idle\n');
    await delay(70);
    await server.get('/api/snapshot');
    await delay(30);
    const reviewed = await responseJson(await server.get('/api/snapshot'));
    const reviewedFirst = reviewed.promptQueue.items.find((item) => item.id === first.item.id);
    assert.equal(reviewedFirst.status, 'needs_review');
    assert.equal(reviewedFirst.summaryState, 'unavailable');
    assert.equal(reviewedFirst.deliveryStage, 'final_boundary_missing');
    assert.equal(reviewedFirst.completedAt, null);
    assert.match(reviewedFirst.blocker, /release the queue after review or cancel/i);
    assert.equal(reviewed.promptQueue.items.find((item) => item.id === second.item.id).status, 'queued');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 1);

    const releaseResponse = await server.request(`/api/prompt-queue/${first.item.id}/release`, {
      expectedRevision: reviewedFirst.revision,
      confirm: 'release-after-review'
    });
    const release = await responseJson(releaseResponse);
    assert.equal(releaseResponse.status, 200);
    assert.equal(release.item.status, 'sent');
    assert.equal(release.item.summaryState, 'operator_released');
    assert.equal(release.item.deliveryStage, 'operator_released');
    assert.match(release.item.completionSummary, /does not claim/i);
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 1);

    await server.get('/api/snapshot');
    await delay(30);
    const released = await responseJson(await server.get('/api/snapshot'));
    assert.equal(released.promptQueue.items.find((item) => item.id === second.item.id).status, 'sent');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 2);
    const audit = readFileSync(path.join(fixture.fixtureDir, 'data', 'actions.jsonl'), 'utf8');
    assert.match(audit, /stage=final_boundary_missing; marker_visible=true; stable_idle=true; no_retry=true; no_input=true/);
    assert.match(audit, /"action":"prompt_queue\.review_released"/);
    assert.match(audit, /operator_released=true; semantic_completion=false; no_input=true/);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('a previously paused footerless item recovers when its exact return boundary becomes safely unique', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { PROMPT_QUEUE_MISSING_FINAL_MS: '60' });
    const first = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Recover this prior review only from a unique exact-pane boundary.')
    ));
    await server.get('/api/snapshot');
    await delay(30);
    await server.get('/api/snapshot');
    const second = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Wait behind the recoverable review.')
    ));
    writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'return-then-newer-idle\n');
    await delay(70);
    await server.get('/api/snapshot');
    await delay(30);
    const reviewed = await responseJson(await server.get('/api/snapshot'));
    assert.equal(reviewed.promptQueue.items.find((item) => item.id === first.item.id).status, 'needs_review');

    writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'idle-after-accepted\n');
    await server.get('/api/snapshot');
    await delay(30);
    const recovered = await responseJson(await server.get('/api/snapshot'));
    const recoveredFirst = recovered.promptQueue.items.find((item) => item.id === first.item.id);
    assert.equal(recoveredFirst.status, 'sent');
    assert.equal(recoveredFirst.summaryState, 'returned');
    assert.equal(recoveredFirst.deliveryStage, 'returned_to_ready');
    assert.equal(recovered.promptQueue.items.find((item) => item.id === second.item.id).status, 'queued');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 1);

    await delay(30);
    const advanced = await responseJson(await server.get('/api/snapshot'));
    assert.equal(advanced.promptQueue.items.find((item) => item.id === second.item.id).status, 'sent');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 2);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('a sent ticket with a marker outside bounded capture moves to review after stable ready instead of hanging', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { PROMPT_QUEUE_MISSING_FINAL_MS: '60' });
    const first = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Produce enough output that the exact marker leaves bounded capture.')
    ));
    await server.get('/api/snapshot');
    await delay(30);
    await server.get('/api/snapshot');
    const second = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Stay queued behind the expired capture boundary.')
    ));
    writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'marker-lost-idle\n');
    await delay(70);
    await server.get('/api/snapshot');
    await delay(30);
    const reviewed = await responseJson(await server.get('/api/snapshot'));
    const reviewedFirst = reviewed.promptQueue.items.find((item) => item.id === first.item.id);
    assert.equal(reviewedFirst.status, 'needs_review');
    assert.equal(reviewedFirst.summaryState, 'unavailable');
    assert.equal(reviewedFirst.deliveryStage, 'completion_marker_missing');
    assert.match(reviewedFirst.blocker, /bounded capture/i);
    assert.equal(reviewed.promptQueue.items.find((item) => item.id === second.item.id).status, 'queued');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 1);
    const audit = readFileSync(path.join(fixture.fixtureDir, 'data', 'actions.jsonl'), 'utf8');
    assert.match(audit, /stage=completion_marker_missing; marker_visible=false; stable_idle=true; no_retry=true; no_input=true/);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('a marker beyond the primary capture recovers from review only through a deeper exact-pane boundary', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { PROMPT_QUEUE_MISSING_FINAL_MS: '60' });
    const first = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Recover this long exact-pane turn without resending it.')
    ));
    await server.get('/api/snapshot');
    await delay(30);
    const delivered = await responseJson(await server.get('/api/snapshot'));
    assert.equal(delivered.promptQueue.items.find((item) => item.id === first.item.id).status, 'sent');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 1);
    assert.doesNotMatch(toolLog(fixture), /tmux:capture-lines:2400/);

    const second = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Wait until the exact recovered completion releases this line.')
    ));
    writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'marker-lost-idle\n');
    await delay(70);
    await server.get('/api/snapshot');
    await delay(30);
    const reviewed = await responseJson(await server.get('/api/snapshot'));
    const reviewedFirst = reviewed.promptQueue.items.find((item) => item.id === first.item.id);
    assert.equal(reviewedFirst.status, 'needs_review');
    assert.equal(reviewedFirst.deliveryStage, 'completion_marker_missing');
    assert.match(toolLog(fixture), /tmux:capture-lines:2400/);
    assert.equal(reviewed.promptQueue.items.find((item) => item.id === second.item.id).status, 'queued');

    await server.stop();
    server = null;
    writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'marker-beyond-primary-complete\n');
    server = await startServer(fixture, { PROMPT_QUEUE_MISSING_FINAL_MS: '60' });
    await server.get('/api/snapshot');
    await delay(30);
    const recovered = await responseJson(await server.get('/api/snapshot'));
    const recoveredFirst = recovered.promptQueue.items.find((item) => item.id === first.item.id);
    assert.equal(recoveredFirst.status, 'sent');
    assert.equal(recoveredFirst.summaryState, 'captured');
    assert.equal(recoveredFirst.deliveryStage, 'completion_recovered');
    assert.equal(recoveredFirst.blocker, '');
    assert.match(recoveredFirst.completionSnapshot, /recovered from the exact deeper boundary/);
    assert.equal(recovered.promptQueue.items.find((item) => item.id === second.item.id).status, 'queued');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 1);

    await delay(30);
    const advanced = await responseJson(await server.get('/api/snapshot'));
    assert.equal(advanced.promptQueue.items.find((item) => item.id === second.item.id).status, 'sent');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 2);
    const audit = readFileSync(path.join(fixture.fixtureDir, 'data', 'actions.jsonl'), 'utf8');
    assert.match(audit, /"action":"prompt_queue\.summary_captured"/);
    assert.match(audit, /captureLines=2400; recovered=true; exact_pane=true; no_input=true/);
    assert.doesNotMatch(audit, /Recover this long exact-pane turn/);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('newer manual input supersedes an unresolved queue ticket without attributing or resending that work', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const first = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Keep this ticket unresolved until its own exact finish is visible.')
    ));
    await server.get('/api/snapshot');
    await delay(30);
    await server.get('/api/snapshot');
    const second = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Do not attribute newer manual work to the prior ticket.')
    ));
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 1);

    const manualSend = await server.request('/api/agent/send', {
      session: 'codex-worker',
      text: 'This is a newer operator turn, separate from the queued ticket.'
    });
    assert.equal(manualSend.status, 200);
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 2);

    const reviewed = await responseJson(await server.get('/api/snapshot'));
    const reviewedFirst = reviewed.promptQueue.items.find((item) => item.id === first.item.id);
    assert.equal(reviewedFirst.status, 'needs_review');
    assert.equal(reviewedFirst.summaryState, 'unavailable');
    assert.equal(reviewedFirst.deliveryStage, 'completion_superseded');
    assert.match(reviewedFirst.blocker, /newer manual activity/i);
    assert.equal(reviewed.promptQueue.items.find((item) => item.id === second.item.id).status, 'queued');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 2);
    const audit = readFileSync(path.join(fixture.fixtureDir, 'data', 'actions.jsonl'), 'utf8');
    assert.match(audit, /stage=completion_superseded; newer_interaction=agent.send; semantic_completion=false; no_retry=true; no_input=true/);
    assert.doesNotMatch(audit, /This is a newer operator turn/);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('prompt queue confirms display-padded witness markers before one Enter', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { MISSION_PAD_QUEUE_MARKER: '1' });
    const created = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Verify wrapped queue markers without dropping Enter.')
    ));
    assert.equal(created.item.status, 'queued');

    await server.get('/api/snapshot');
    await delay(30);
    const released = await responseJson(await server.get('/api/snapshot'));
    assert.equal(released.promptQueue.items[0].status, 'sent');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 1);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('prompt queue releases from the server monitor without an open snapshot stream', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { PROMPT_QUEUE_MONITOR_MS: '25' });
    const created = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Continue safely when this exact terminal is ready.')
    ));
    assert.equal(created.item.status, 'queued');

    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && readPromptQueue(fixture).items[0].status !== 'sent') {
      await delay(25);
    }
    assert.equal(readPromptQueue(fixture).items[0].status, 'sent');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 1);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('a visible goal-achieved composer is green and releases its queued prompt', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'goal-achieved\n');
  let server;
  try {
    server = await startServer(fixture);
    const created = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Start the next queued task from the completed composer.')
    ));
    assert.equal(created.item.target.state, 'idle');
    assert.equal(created.item.target.reason, 'goal achieved');
    assert.equal(created.item.target.green, true);

    await server.get('/api/snapshot');
    await delay(30);
    const released = await responseJson(await server.get('/api/snapshot'));
    assert.equal(released.promptQueue.items[0].status, 'sent');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 1);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('a stale pursuing-goal timer without an interrupt signal does not mask a ready composer', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'pursuing-stale-ready\n');
  let server;
  try {
    server = await startServer(fixture);
    const created = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Send after the stale goal timer yields to the ready composer.')
    ));
    assert.equal(created.item.target.state, 'busy');
    assert.equal(created.item.target.green, false);

    await delay(30);
    const settled = await responseJson(await server.get('/api/snapshot'));
    const worker = settled.agents.find((agent) => agent.session === 'codex-worker');
    assert.equal(worker.agentStatus.state, 'idle');
    assert.equal(worker.agentStatus.reason, 'prompt ready');
    assert.equal(worker.queueReady, true);
    assert.equal(settled.promptQueue.items[0].status, 'queued');

    await delay(30);
    const released = await responseJson(await server.get('/api/snapshot'));
    assert.equal(released.promptQueue.items[0].status, 'sent');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 1);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('a changing work timer stays blue even though the composer remains visible', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'pursuing-active\n');
  let server;
  try {
    server = await startServer(fixture);
    const created = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Never send while the exact pane work timer is still advancing.')
    ));
    assert.equal(created.item.target.state, 'busy');
    assert.equal(created.item.target.green, false);

    await delay(30);
    const sampled = await responseJson(await server.get('/api/snapshot'));
    const worker = sampled.agents.find((agent) => agent.session === 'codex-worker');
    assert.equal(worker.agentStatus.state, 'busy');
    assert.equal(worker.queueReady, false);
    await delay(30);
    await server.get('/api/snapshot');
    assert.equal(readPromptQueue(fixture).items[0].status, 'queued');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 0);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('a visible composer stays blue while foreground or background work is active', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'background-working\n');
  let server;
  try {
    server = await startServer(fixture);
    const created = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Do not send this while background work is active.')
    ));
    assert.equal(created.item.target.state, 'busy');
    assert.match(created.item.target.reason, /background terminal/);
    assert.equal(created.item.target.green, false);

    const snapshot = await responseJson(await server.get('/api/snapshot'));
    const worker = snapshot.agents.find((agent) => agent.session === 'codex-worker');
    assert.equal(worker.promptReady, false);
    assert.equal(worker.queueReady, false);
    await delay(30);
    await server.get('/api/snapshot');
    assert.equal(readPromptQueue(fixture).items[0].status, 'queued');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 0);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('an uncertain queued prompt pauses its terminal line and is never resent', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { MISSION_SUBMIT_BEHAVIOR: 'ignored' });
    const created = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Inspect the terminal state once and stop if delivery is uncertain.')
    ));
    assert.equal(created.item.status, 'queued');

    await server.get('/api/snapshot');
    await delay(30);
    const attempted = await responseJson(await server.get('/api/snapshot'));
    assert.equal(attempted.promptQueue.items[0].status, 'needs_review');
    assert.match(attempted.promptQueue.items[0].blocker, /will not retry/i);
    const entersAfterAttempt = toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length;
    assert.equal(entersAfterAttempt, 1);

    await delay(30);
    await server.get('/api/snapshot');
    await delay(30);
    await server.get('/api/snapshot');
    const entersAfterRepeatedGreen = toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length;
    assert.equal(entersAfterRepeatedGreen, 1);
    assert.equal(readPromptQueue(fixture).items[0].status, 'needs_review');
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('queue acceptance uses the same bounded deep capture that confirmed the rendered prompt', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { MISSION_HIDE_MARKER_BELOW_CAPTURE: '1' });
    const created = await responseJson(await server.request(
      '/api/prompt-queue',
      promptQueueBody('Confirm this accepted turn without falling into a false review state.')
    ));
    assert.equal(created.item.status, 'queued');

    await server.get('/api/snapshot');
    await delay(30);
    const delivered = await responseJson(await server.get('/api/snapshot'));
    assert.equal(delivered.promptQueue.items[0].status, 'sent');
    assert.equal(delivered.promptQueue.items[0].deliveryStage, 'accepted');
    assert.equal(delivered.promptQueue.items[0].summaryState, 'pending');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 1);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('a later stable acceptance witness recovers review without another Enter', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  const timestamp = new Date().toISOString();
  const itemId = 'prompt-late-acceptance-12345678';
  const attemptId = 'queue-attempt-late-acceptance-12345678';
  const promptText = 'Synthetic recovery prompt.';
  mkdirSync(path.dirname(fixture.promptQueuePath), { recursive: true });
  writeFileSync(fixture.promptQueuePath, JSON.stringify({
    version: 1,
    revision: 3,
    items: [{
      id: itemId,
      revision: 3,
      position: 1,
      status: 'needs_review',
      session: 'codex-worker',
      sessionCreatedAt: '2023-11-14T22:13:20.000Z',
      paneId: 'codex-worker:0.0',
      tmuxPaneId: '%77',
      panePid: 4100,
      text: promptText,
      attemptId,
      blocker: 'Enter was sent, but acceptance could not be confirmed.',
      deliveryStage: 'confirmation',
      createdAt: timestamp,
      updatedAt: timestamp,
      claimedAt: timestamp,
      sentAt: null,
      completionSummary: '',
      completionSnapshot: '',
      summaryState: 'unavailable',
      completedAt: null
    }],
    schedules: []
  }));
  writeFileSync(path.join(fixture.fixtureDir, 'tmux-state'), 'accepted\n');
  writeFileSync(
    fixture.tmuxInputPath,
    '[PaneFleet Queued Prompt ' + itemId + '] ' + promptText + ' [PaneFleet Queue Dispatch ' + attemptId + ']'
  );

  let server;
  try {
    server = await startServer(fixture);
    const first = await responseJson(await server.get('/api/snapshot'));
    assert.equal(first.promptQueue.items[0].status, 'needs_review');
    await delay(30);
    const recovered = await responseJson(await server.get('/api/snapshot'));
    assert.equal(recovered.promptQueue.items[0].status, 'sent');
    assert.equal(recovered.promptQueue.items[0].deliveryStage, 'accepted_late');
    assert.equal(recovered.promptQueue.items[0].summaryState, 'pending');
    assert.equal(recovered.promptQueue.items[0].blocker, '');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line === 'tmux:send-enter:C-m').length, 0);
    const audit = readFileSync(path.join(fixture.fixtureDir, 'data', 'actions.jsonl'), 'utf8');
    assert.match(audit, /"action":"prompt_queue\.acceptance_recovered"/);
    assert.match(audit, /no_retry=true; no_input=true/);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('restart reconciliation parks an in-flight queued prompt without resending it', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  const dataDir = path.dirname(fixture.promptQueuePath);
  mkdirSync(dataDir, { recursive: true });
  const timestamp = '2026-07-14T12:00:00.000Z';
  writeFileSync(fixture.promptQueuePath, JSON.stringify({
    version: 1,
    revision: 1,
    items: [{
      id: 'prompt-restart-12345678',
      revision: 2,
      position: 1,
      status: 'dispatching',
      session: 'codex-worker',
      sessionCreatedAt: '2023-11-14T22:13:20.000Z',
      paneId: 'codex-worker:0.0',
      tmuxPaneId: '%77',
      panePid: 4100,
      text: 'Synthetic queued prompt for restart reconciliation.',
      attemptId: 'queue-attempt-restart-12345678',
      blocker: '',
      deliveryStage: 'dispatching',
      createdAt: timestamp,
      updatedAt: timestamp,
      claimedAt: timestamp,
      sentAt: null
    }]
  }));

  let server;
  try {
    server = await startServer(fixture);
    const afterRestart = await responseJson(await server.get('/api/snapshot'));
    assert.equal(afterRestart.promptQueue.items[0].status, 'needs_review');
    assert.equal(afterRestart.promptQueue.items[0].deliveryStage, 'restart_reconciliation');
    assert.match(afterRestart.promptQueue.items[0].blocker, /will not be resent/i);

    await delay(30);
    await server.get('/api/snapshot');
    await delay(30);
    await server.get('/api/snapshot');
    assert.equal(toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length, 0);
    assert.equal(readPromptQueue(fixture).items[0].status, 'needs_review');
    assert.equal(statSync(fixture.promptQueuePath).mode & 0o777, 0o600);

    const audit = readFileSync(path.join(dataDir, 'actions.jsonl'), 'utf8');
    assert.match(audit, /restart_during_dispatch=true/);
    assert.match(audit, /no_resend=true/);
    assert.doesNotMatch(audit, /Synthetic queued prompt/);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('restart reconciliation removes a captured completion that lacks a final-response boundary', async () => {
  const fixture = createFixture();
  const dataDir = path.dirname(fixture.promptQueuePath);
  mkdirSync(dataDir, { recursive: true });
  const timestamp = '2026-07-15T08:05:35.000Z';
  writeFileSync(fixture.promptQueuePath, JSON.stringify({
    version: 1,
    revision: 1,
    items: [{
      id: 'prompt-premature-12345678',
      revision: 2,
      position: 1,
      status: 'sent',
      session: 'codex-worker',
      sessionCreatedAt: '2023-11-14T22:13:20.000Z',
      paneId: 'codex-worker:0.0',
      tmuxPaneId: '%77',
      panePid: 4100,
      text: 'Finish the complete feature and all required verification.',
      attemptId: 'queue-attempt-premature-12345678',
      blocker: '',
      deliveryStage: 'accepted',
      createdAt: timestamp,
      updatedAt: timestamp,
      claimedAt: timestamp,
      sentAt: timestamp,
      completionSummary: 'Intermediate test output was incorrectly captured.',
      completionSnapshot: '118 + assert.match(app, /partial test output/);',
      summaryState: 'captured',
      completedAt: timestamp
    }],
    schedules: []
  }), { mode: 0o600 });

  let server;
  try {
    server = await startServer(fixture);
    const item = readPromptQueue(fixture).items[0];
    assert.equal(item.status, 'needs_review');
    assert.equal(item.summaryState, 'unavailable');
    assert.equal(item.completionSnapshot, '');
    assert.match(item.completionSummary, /no longer labels this work completed/i);
    assert.equal(item.completedAt, null);
    assert.match(item.blocker, /later prompts stay blocked/i);
    assert.equal(toolLog(fixture).split('\n').some((line) => line.startsWith('tmux:send-')), false);
    const audit = readFileSync(path.join(dataDir, 'actions.jsonl'), 'utf8');
    assert.match(audit, /"action":"prompt_queue\.completion_reconciled"/);
    assert.match(audit, /missing_final_boundary=true/);
    assert.doesNotMatch(audit, /Intermediate test output/);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('Ready work can adopt an exact live Codex pane without terminal input', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      title: 'Adopt work already underway'
    })))).job;
    const sendsBefore = toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length;

    const response = await server.request(`/api/missions/${created.id}/adopt`, adoptionBody(created.revision));
    const result = await responseJson(response);
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.job.status, 'running');
    assert.equal(result.job.worker.identityMatches, true);
    assert.equal(result.job.assignedSession, 'codex-worker');
    assert.equal(result.job.assignedSessionCreatedAt, '2023-11-14T22:13:20.000Z');
    assert.equal(result.job.assignedPaneId, 'codex-worker:0.0');
    assert.equal(result.job.assignedTmuxPaneId, '%77');
    assert.equal(result.job.assignedPanePid, 4100);

    const queue = readQueue(fixture);
    const job = queue.jobs[0];
    assert.equal(job.attempts.length, 1);
    assert.equal(job.activeAttempt.kind, 'adoption');
    assert.equal(job.activeAttempt.status, 'running_adopted');
    assert.equal(job.activeAttempt.promptChars, 0);
    assert.equal(job.activeAttempt.submittedAt, null);
    assert.equal('confirmationMarker' in job.activeAttempt, false);
    assert.deepEqual(queue.events.map((event) => event.kind), ['mission.created', 'mission.adopted']);
    assert.match(queue.events.at(-1).detail, /no_prompt=true; no_resend=true/);
    assert.equal(
      toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length,
      sendsBefore
    );
    const audit = readFileSync(path.join(fixture.fixtureDir, 'data', 'actions.jsonl'), 'utf8');
    assert.match(audit, /"action":"mission\.adopt"/);
    assert.match(audit, /no_input=true; no_prompt=true; no_resend=true/);

    const appSource = readFileSync(path.join(projectDir, 'public', 'app.js'), 'utf8');
    assert.match(appSource, /data-action="mission-adopt"/);
    assert.match(appSource, /confirm: 'adopt-existing'/);
    assert.match(appSource, /It will not send a prompt, Enter, or any terminal input/);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('Needs You adoption preserves the lost attempt and replaces it with a no-resend attempt', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
    await server.stop();
    server = null;
    const queueBeforeAdoption = readQueue(fixture);
    const lostJob = queueBeforeAdoption.jobs[0];
    const originalAttemptId = 'attempt-lostworker-12345678';
    const lostAttempt = {
      id: originalAttemptId,
      status: 'needs_you',
      session: 'codex-lost',
      sessionCreatedAt: '2023-11-14T22:13:19.000Z',
      paneId: 'codex-lost:0.0',
      tmuxPaneId: '%70',
      panePid: 4000,
      confirmationMarker: `[Host Control Dispatch ${originalAttemptId}]`,
      promptChars: 400,
      claimedAt: '2026-07-13T12:00:00.000Z',
      submittedAt: '2026-07-13T12:00:01.000Z',
      finishedAt: null
    };
    lostJob.status = 'needs_you';
    lostJob.revision += 1;
    lostJob.updatedAt = '2026-07-13T12:05:00.000Z';
    lostJob.startedAt = '2026-07-13T12:00:01.000Z';
    lostJob.needsYouAt = '2026-07-13T12:05:00.000Z';
    lostJob.assignedSession = lostAttempt.session;
    lostJob.assignedSessionCreatedAt = lostAttempt.sessionCreatedAt;
    lostJob.assignedPaneId = lostAttempt.paneId;
    lostJob.assignedTmuxPaneId = lostAttempt.tmuxPaneId;
    lostJob.assignedPanePid = lostAttempt.panePid;
    lostJob.activeAttempt = { ...lostAttempt };
    lostJob.attempts = [{ ...lostAttempt }];
    lostJob.blocker = 'The original worker identity was lost.';
    queueBeforeAdoption.revision += 1;
    writeFileSync(fixture.queuePath, `${JSON.stringify(queueBeforeAdoption, null, 2)}\n`, { mode: 0o600 });

    server = await startServer(fixture);
    const sendsBefore = toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length;
    const response = await server.request(`/api/missions/${created.id}/adopt`, adoptionBody(lostJob.revision));
    const result = await responseJson(response);
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.job.status, 'running');

    const job = readQueue(fixture).jobs[0];
    assert.equal(job.attempts.length, 2);
    assert.equal(job.attempts[0].id, originalAttemptId);
    assert.equal(job.attempts[0].status, 'superseded_by_adoption');
    assert.match(job.attempts[0].finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.notEqual(job.activeAttempt.id, originalAttemptId);
    assert.equal(job.activeAttempt.kind, 'adoption');
    assert.equal(job.activeAttempt.promptChars, 0);
    assert.equal(
      toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length,
      sendsBefore
    );
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('adoption fails closed for missing confirmation, stale identity, stopped workers, workspace mismatch, and worker locks', async (t) => {
  await t.test('confirmation, revision, and state are explicit', async () => {
    const fixture = createFixture();
    installDispatchTools(fixture);
    let server;
    try {
      server = await startServer(fixture);
      const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
      const before = readFileSync(fixture.queuePath, 'utf8');
      const unconfirmed = await server.request(`/api/missions/${created.id}/adopt`, adoptionBody(created.revision, { confirm: '' }));
      assert.equal(unconfirmed.status, 400);
      assert.equal((await responseJson(unconfirmed)).error, 'mission_adoption_confirmation_required');
      const stale = await server.request(`/api/missions/${created.id}/adopt`, adoptionBody(0));
      assert.equal(stale.status, 409);
      assert.equal((await responseJson(stale)).error, 'mission_revision_conflict');
      assert.equal(readFileSync(fixture.queuePath, 'utf8'), before);

      const backlog = (await responseJson(await server.request(`/api/missions/${created.id}/transition`, {
        expectedRevision: created.revision,
        to: 'backlog'
      }))).job;
      const wrongState = await server.request(`/api/missions/${created.id}/adopt`, adoptionBody(backlog.revision));
      assert.equal(wrongState.status, 409);
      assert.equal((await responseJson(wrongState)).error, 'mission_not_adoptable');
      assert.equal(toolLog(fixture).split('\n').some((line) => line.startsWith('tmux:send-')), false);
    } finally {
      if (server) await server.stop();
      rmSync(fixture.fixtureDir, { recursive: true, force: true });
    }
  });

  for (const testCase of [
    {
      name: 'missing pane',
      env: {},
      body: { session: 'codex-missing', paneId: 'codex-missing:0.0' },
      error: 'mission_worker_missing_or_replaced'
    },
    {
      name: 'replacement identity',
      env: { MISSION_SESSION_CREATED: '1700000001' },
      body: {},
      error: 'mission_worker_missing_or_replaced'
    },
    {
      name: 'stopped Codex process',
      env: { MISSION_NO_CODEX_PROCESS: '1' },
      body: {},
      error: 'mission_worker_stopped'
    },
    {
      name: 'workspace mismatch',
      env: {},
      body: {},
      error: 'mission_worker_workspace_mismatch',
      workerWorkspace: 'beta'
    }
  ]) {
    await t.test(testCase.name, async () => {
      const fixture = createFixture();
      installDispatchTools(fixture);
      let server;
      try {
        const env = { ...testCase.env };
        if (testCase.workerWorkspace) env.MISSION_FAKE_WORKSPACE = fixture.betaWorkspace;
        server = await startServer(fixture, env);
        const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
        const before = readFileSync(fixture.queuePath, 'utf8');
        const response = await server.request(`/api/missions/${created.id}/adopt`, adoptionBody(created.revision, testCase.body));
        assert.equal(response.status, 409);
        assert.equal((await responseJson(response)).error, testCase.error);
        assert.equal(readFileSync(fixture.queuePath, 'utf8'), before);
        assert.equal(toolLog(fixture).split('\n').some((line) => line.startsWith('tmux:send-')), false);
      } finally {
        if (server) await server.stop();
        rmSync(fixture.fixtureDir, { recursive: true, force: true });
      }
    });
  }

  await t.test('worker already locked by another mission', async () => {
    const fixture = createFixture();
    installDispatchTools(fixture);
    let server;
    try {
      server = await startServer(fixture);
      const owner = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
        title: 'Current worker owner'
      })))).job;
      const adoptedOwner = await server.request(`/api/missions/${owner.id}/adopt`, adoptionBody(owner.revision));
      assert.equal(adoptedOwner.status, 200);
      const contender = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.betaWorkspace, {
        title: 'Conflicting worker claim'
      })))).job;
      const response = await server.request(`/api/missions/${contender.id}/adopt`, adoptionBody(contender.revision));
      assert.equal(response.status, 409);
      assert.equal((await responseJson(response)).error, 'mission_worker_locked');
      assert.equal(toolLog(fixture).split('\n').some((line) => line.startsWith('tmux:send-')), false);
    } finally {
      if (server) await server.stop();
      rmSync(fixture.fixtureDir, { recursive: true, force: true });
    }
  });
});

test('dispatch failure stages never auto-retry uncertain terminal input', async () => {
  for (const failure of ['literal', 'enter']) {
    const fixture = createFixture();
    installDispatchTools(fixture);
    let server;
    try {
      server = await startServer(fixture, { MISSION_TMUX_FAILURE: failure });
      const createdResponse = await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
        title: `Exercise ${failure} dispatch failure`
      }));
      assert.equal(createdResponse.status, 200);
      const created = (await responseJson(createdResponse)).job;

      const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
        expectedRevision: created.revision,
        session: 'codex-worker'
      });
      const result = await responseJson(dispatchResponse);
      const operations = toolLog(fixture).trim().split('\n');
      const literalSends = operations.filter((operation) => operation.startsWith('tmux:send-literal:')).length;
      const enterSends = operations.filter((operation) => operation === 'tmux:send-enter:C-m').length;
      assert.equal(literalSends, 1);

      if (failure === 'literal') {
        assert.equal(dispatchResponse.status, 409);
        assert.equal(result.stage, 'literal_unknown');
        assert.equal(result.job.status, 'reconcile_required');
        assert.equal(enterSends, 0);
        assert.equal(readQueue(fixture).jobs[0].activeAttempt.status, 'outcome_unknown');
      } else {
        assert.equal(dispatchResponse.status, 409);
        assert.equal(result.stage, 'submit');
        assert.equal(result.job.status, 'reconcile_required');
        assert.equal(enterSends, 1);
        assert.equal(readQueue(fixture).jobs[0].activeAttempt.status, 'outcome_unknown');

        const logBeforeRestart = toolLog(fixture);
        await server.stop();
        server = await startServer(fixture);
        assert.equal(readQueue(fixture).jobs[0].status, 'reconcile_required');
        assert.equal(toolLog(fixture), logBeforeRestart);
        const reconcileRevision = readQueue(fixture).jobs[0].revision;

        const unconfirmedReady = await server.request(`/api/missions/${created.id}/transition`, {
          expectedRevision: reconcileRevision,
          to: 'ready'
        });
        assert.equal(unconfirmedReady.status, 400);
        assert.equal((await responseJson(unconfirmedReady)).error, 'mission_lock_release_confirmation_required');

        const unconfirmedRunning = await server.request(`/api/missions/${created.id}/transition`, {
          expectedRevision: reconcileRevision,
          to: 'running'
        });
        assert.equal(unconfirmedRunning.status, 400);
        assert.equal((await responseJson(unconfirmedRunning)).error, 'reconcile_confirmation_required');

        const confirmedReady = await server.request(`/api/missions/${created.id}/transition`, {
          expectedRevision: reconcileRevision,
          to: 'ready',
          confirm: 'inspected-release'
        });
        assert.equal(confirmedReady.status, 200);
        assert.equal((await responseJson(confirmedReady)).job.status, 'ready');
        assert.equal(toolLog(fixture), logBeforeRestart);
      }
    } finally {
      if (server) await server.stop();
      rmSync(fixture.fixtureDir, { recursive: true, force: true });
    }
  }
});

test('a successful tmux Enter is not Running until Codex visibly accepts it', async (t) => {
  const cases = [
    { name: 'ignored Enter', behavior: 'ignored', expectedError: 'terminal_submit_unconfirmed' },
    { name: 'one transient working sample', behavior: 'transient', expectedError: 'terminal_submit_unconfirmed' },
    { name: 'capture failure after Enter', behavior: 'capture-failure', expectedError: 'terminal_confirmation_capture_failed' },
    { name: 'pane replacement after Enter', behavior: 'replacement', expectedError: 'mission_worker_identity_changed' },
    { name: 'idle composer after Enter', behavior: 'idle-placeholder', expectedError: 'terminal_submit_unconfirmed' },
    { name: 'stale working text before the marker', behavior: 'ignored', staleWorking: '1', expectedError: 'terminal_submit_unconfirmed' }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = createFixture();
      installDispatchTools(fixture);
      let server;
      try {
        server = await startServer(fixture, {
          MISSION_SUBMIT_BEHAVIOR: testCase.behavior,
          MISSION_STALE_WORKING: testCase.staleWorking || ''
        });
        const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
        const response = await server.request(`/api/missions/${created.id}/dispatch`, {
          expectedRevision: created.revision,
          session: 'codex-worker'
        });
        const result = await responseJson(response);
        assert.equal(response.status, 409);
        assert.equal(result.stage, 'confirmation');
        assert.equal(result.error, testCase.expectedError);
        assert.equal(result.job.status, 'reconcile_required');
        assert.equal(result.job.activeAttempt.status, 'outcome_unknown');
        assert.equal(result.job.activeAttempt.submittedAt, null);

        const operations = toolLog(fixture).trim().split('\n');
        assert.equal(operations.filter((operation) => operation.startsWith('tmux:send-literal:')).length, 1);
        assert.equal(operations.filter((operation) => operation === 'tmux:send-enter:C-m').length, 1);
      } finally {
        if (server) await server.stop();
        rmSync(fixture.fixtureDir, { recursive: true, force: true });
      }
    });
  }
});

test('dispatch waits for complete literal rendering and never sends Enter when rendering is uncertain', async () => {
  for (const visibleAfter of ['3', '99']) {
    const fixture = createFixture();
    installDispatchTools(fixture);
    let server;
    try {
      server = await startServer(fixture, {
        MISSION_LITERAL_VISIBLE_AFTER: visibleAfter,
        ...(visibleAfter === '3' ? {
          MISSION_LITERAL_CONFIRM_MS: '2000',
          MISSION_SUBMIT_CONFIRM_MS: '2000'
        } : {})
      });
      const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
      const response = await server.request(`/api/missions/${created.id}/dispatch`, {
        expectedRevision: created.revision,
        session: 'codex-worker'
      });
      const result = await responseJson(response);
      const operations = toolLog(fixture).trim().split('\n');
      const literalIndex = operations.findIndex((operation) => operation.startsWith('tmux:send-literal:'));
      const enterIndex = operations.indexOf('tmux:send-enter:C-m');
      assert.ok(literalIndex >= 0);
      if (visibleAfter === '3') {
        assert.equal(response.status, 200, JSON.stringify(result));
        assert.equal(result.job.status, 'running');
        assert.ok(enterIndex > literalIndex);
        assert.ok(operations.slice(literalIndex, enterIndex).filter((operation) => operation === 'tmux:capture').length >= 4);
      } else {
        assert.equal(response.status, 409);
        assert.equal(result.stage, 'literal_confirmation');
        assert.equal(result.job.status, 'reconcile_required');
        assert.equal(enterIndex, -1);
      }
      assert.equal(operations.filter((operation) => operation.startsWith('tmux:send-literal:')).length, 1);
      assert.ok(operations.filter((operation) => operation === 'tmux:send-enter:C-m').length <= 1);
    } finally {
      if (server) await server.stop();
      rmSync(fixture.fixtureDir, { recursive: true, force: true });
    }
  }
});

test('a fast completed response after the unique dispatch marker confirms submission', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { MISSION_SUBMIT_BEHAVIOR: 'complete' });
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
    const response = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    const result = await responseJson(response);
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.job.status, 'running');
    const operations = toolLog(fixture).trim().split('\n');
    assert.equal(operations.filter((operation) => operation.startsWith('tmux:send-literal:')).length, 1);
    assert.equal(operations.filter((operation) => operation === 'tmux:send-enter:C-m').length, 1);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('Mission Supervisor requires stable report samples and moves completion only to Verifying', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
    const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    assert.equal(dispatchResponse.status, 200);
    const running = (await responseJson(dispatchResponse)).job;
    assert.equal(running.status, 'running');
    const prompt = readFileSync(path.join(fixture.fixtureDir, 'tmux-input'), 'utf8');
    const sendCountBefore = toolLog(fixture).split('\n').filter((line) => /^tmux:send-(?:literal|enter):/.test(line)).length;

    await server.stop();
    server = await startServer(fixture, {
      MISSION_SUPERVISOR_MIN_DELAY_MS: '20',
      MISSION_CAPTURE_OUTPUT: [
        `› ${prompt}`,
        'STATUS: complete',
        'RESULT: unified attention work completed',
        'EVIDENCE: focused supervisor tests passed',
        'NEXT ACTION: verify independently',
        '› ',
        'gpt-test-alpha ultra · 95% left'
      ].join('\n')
    });

    const firstSnapshot = await responseJson(await server.get('/api/snapshot'));
    const firstSample = firstSnapshot.missions.jobs.find((job) => job.id === created.id);
    assert.equal(firstSample.status, 'running');
    assert.equal(firstSample.worker.identityMatches, true);
    await delay(30);
    const secondSnapshot = await responseJson(await server.get('/api/snapshot'));
    const verifying = secondSnapshot.missions.jobs.find((job) => job.id === created.id);
    assert.equal(verifying.status, 'verifying');
    assert.equal(verifying.status === 'done', false);
    assert.equal(verifying.finishedAt, null);
    assert.deepEqual(verifying.outcomes, []);
    assert.equal(verifying.activeAttempt.status, 'verifying');
    assert.equal(verifying.verification.status, 'pending');
    assert.equal(verifying.verification.note, 'focused supervisor tests passed');
    assert.match(verifying.resultSummary, /unified attention work completed/);
    assert.equal(
      secondSnapshot.notifications.items.find((item) => item.missionId === created.id)?.kind,
      'verification_ready'
    );

    const queue = readQueue(fixture);
    const event = queue.events.at(-1);
    assert.equal(event.kind, 'mission.verifying');
    assert.equal(event.from, 'running');
    assert.equal(event.to, 'verifying');
    assert.match(event.detail, /^source=supervisor; supervisor=verification_ready$/);
    const sendCountAfter = toolLog(fixture).split('\n').filter((line) => /^tmux:send-(?:literal|enter):/.test(line)).length;
    assert.equal(sendCountAfter, sendCountBefore);
    assert.equal(toolLog(fixture).includes('tmux:unexpected:'), false);
    assert.equal(toolLog(fixture).split('\n').some((line) => ['aws', 'curl'].includes(line)), false);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('Mission Supervisor routes stable waiting, error, stale, and identity failures to Needs You without input', async (t) => {
  const cases = [
    {
      name: 'waiting report',
      reason: 'waiting',
      output(prompt) {
        return [
          `› ${prompt}`,
          'STATUS: waiting for approval',
          'RESULT: implementation is paused',
          'EVIDENCE: the approval boundary was reached',
          'NEXT ACTION: needs input from the operator'
        ].join('\n');
      }
    },
    {
      name: 'error report',
      reason: 'error',
      output(prompt) {
        return [
          `› ${prompt}`,
          'STATUS: failed',
          'RESULT: focused validation failed',
          'EVIDENCE: the test command returned an error',
          'NEXT ACTION: inspect the failure'
        ].join('\n');
      }
    },
    {
      name: 'idle without report',
      reason: 'idle',
      idleStaleMs: '0',
      output(prompt) {
        return [`› ${prompt}`, '› Ask Codex anything', 'gpt-test-alpha ultra · 95% left'].join('\n');
      }
    },
    {
      name: 'recycled session creation',
      reason: 'replaced',
      sessionCreated: '1700000001'
    },
    {
      name: 'replaced intrinsic pane',
      reason: 'replaced',
      submitBehavior: 'replacement'
    },
    {
      name: 'missing assigned coordinate',
      reason: 'missing',
      mutateQueue(queue) {
        const job = queue.jobs[0];
        job.assignedPaneId = 'codex-worker:9.9';
        job.activeAttempt.paneId = job.assignedPaneId;
        const attempt = job.attempts.find((item) => item.id === job.activeAttempt.id);
        attempt.paneId = job.assignedPaneId;
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = createFixture();
      installDispatchTools(fixture);
      let server;
      try {
        server = await startServer(fixture);
        const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
        const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
          expectedRevision: created.revision,
          session: 'codex-worker'
        });
        assert.equal(dispatchResponse.status, 200);
        const prompt = readFileSync(path.join(fixture.fixtureDir, 'tmux-input'), 'utf8');
        const sendCountBefore = toolLog(fixture).split('\n').filter((line) => /^tmux:send-(?:literal|enter):/.test(line)).length;
        await server.stop();
        server = null;

        if (testCase.mutateQueue) {
          const queue = readQueue(fixture);
          testCase.mutateQueue(queue);
          writeFileSync(fixture.queuePath, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 });
        }
        server = await startServer(fixture, {
          MISSION_SUPERVISOR_MIN_DELAY_MS: '20',
          MISSION_SUPERVISOR_IDLE_STALE_MS: testCase.idleStaleMs || '120000',
          MISSION_CAPTURE_OUTPUT: testCase.output ? testCase.output(prompt) : '',
          MISSION_SESSION_CREATED: testCase.sessionCreated || '1700000000',
          MISSION_SUBMIT_BEHAVIOR: testCase.submitBehavior || ''
        });

        const firstSnapshot = await responseJson(await server.get('/api/snapshot'));
        const firstSample = firstSnapshot.missions.jobs.find((job) => job.id === created.id);
        assert.equal(firstSample.status, 'running');
        assert.equal(
          firstSample.worker.identityMatches,
          !['replaced', 'missing'].includes(testCase.reason)
        );
        await delay(30);
        const secondSnapshot = await responseJson(await server.get('/api/snapshot'));
        const needsYou = secondSnapshot.missions.jobs.find((job) => job.id === created.id);
        assert.equal(needsYou.status, 'needs_you');
        assert.equal(needsYou.finishedAt, null);
        assert.deepEqual(needsYou.outcomes, []);
        assert.equal(needsYou.activeAttempt.status, 'needs_you');
        assert.ok(needsYou.blocker.startsWith('Mission Supervisor'));

        const event = readQueue(fixture).events.at(-1);
        assert.equal(event.kind, 'mission.needs_you');
        assert.equal(event.from, 'running');
        assert.equal(event.to, 'needs_you');
        assert.equal(event.detail, `source=supervisor; supervisor=${testCase.reason}`);
        const expectedNotificationKind = testCase.reason === 'error'
          ? 'failure'
          : ['idle', 'replaced', 'missing'].includes(testCase.reason) ? 'stale' : 'needs_you';
        const notification = secondSnapshot.notifications.items.find((item) => item.missionId === created.id);
        assert.equal(notification?.kind, expectedNotificationKind);
        const sendCountAfter = toolLog(fixture).split('\n').filter((line) => /^tmux:send-(?:literal|enter):/.test(line)).length;
        assert.equal(sendCountAfter, sendCountBefore);
        assert.equal(toolLog(fixture).includes('tmux:unexpected:'), false);
        assert.equal(toolLog(fixture).split('\n').some((line) => ['aws', 'curl'].includes(line)), false);
      } finally {
        if (server) await server.stop();
        rmSync(fixture.fixtureDir, { recursive: true, force: true });
      }
    });
  }
});

test('Mission Supervisor ignores a completed report that predates the active dispatch marker', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
    const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    assert.equal(dispatchResponse.status, 200);
    const prompt = readFileSync(path.join(fixture.fixtureDir, 'tmux-input'), 'utf8');
    await server.stop();
    server = await startServer(fixture, {
      MISSION_SUPERVISOR_MIN_DELAY_MS: '20',
      MISSION_CAPTURE_OUTPUT: [
        'STATUS: complete',
        'RESULT: stale earlier work',
        'EVIDENCE: stale earlier evidence',
        'NEXT ACTION: verify stale result',
        `› ${prompt}`,
        'Working (1s)',
        'esc to interrupt'
      ].join('\n')
    });

    await server.get('/api/snapshot');
    await delay(30);
    const snapshot = await responseJson(await server.get('/api/snapshot'));
    assert.equal(snapshot.missions.jobs.find((job) => job.id === created.id).status, 'running');
    assert.equal(readQueue(fixture).events.some((event) => event.kind === 'mission.verifying'), false);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('restart reconciles a durable dispatch claim without sending terminal input', async () => {
  const fixture = createFixture();
  let server;
  try {
    server = await startServer(fixture);
    const createdResponse = await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace));
    assert.equal(createdResponse.status, 200);
    const created = (await responseJson(createdResponse)).job;
    await server.stop();
    server = null;

    const queue = readQueue(fixture);
    const job = queue.jobs[0];
    const claimedAt = new Date().toISOString();
    const attempt = {
      id: 'attempt-seeded1234',
      status: 'dispatching',
      session: 'codex-worker',
      sessionCreatedAt: '2023-11-14T22:13:20.000Z',
      paneId: 'codex-worker:0.0',
      promptChars: 500,
      claimedAt,
      submittedAt: null,
      finishedAt: null
    };
    job.status = 'dispatching';
    job.revision = created.revision + 1;
    job.updatedAt = claimedAt;
    job.assignedSession = 'codex-worker';
    job.assignedSessionCreatedAt = attempt.sessionCreatedAt;
    job.assignedPaneId = attempt.paneId;
    job.activeAttempt = { ...attempt };
    job.attempts = [{ ...attempt }];
    queue.revision += 1;
    writeFileSync(fixture.queuePath, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 });

    installDispatchTools(fixture);
    server = await startServer(fixture);
    const reconciled = readQueue(fixture);
    assert.equal(reconciled.jobs[0].status, 'reconcile_required');
    assert.equal(reconciled.jobs[0].activeAttempt.status, 'outcome_unknown');
    assert.equal(reconciled.events.at(-1)?.kind, 'mission.reconcile_required');
    assert.equal(toolLog(fixture), '');
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('completion requires the verifying gate and durable evidence', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const createdResponse = await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace));
    const created = (await responseJson(createdResponse)).job;
    const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    assert.equal(dispatchResponse.status, 200);
    const running = (await responseJson(dispatchResponse)).job;

    const directDone = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: running.revision,
      to: 'done',
      note: 'This must not bypass verification.'
    });
    assert.equal(directDone.status, 409);
    assert.equal((await responseJson(directDone)).error, 'invalid_mission_transition');

    const verifyingResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: running.revision,
      to: 'verifying'
    });
    assert.equal(verifyingResponse.status, 200);
    const verifying = (await responseJson(verifyingResponse)).job;
    assert.equal(verifying.status, 'verifying');
    const durableBeforeMissingEvidence = readFileSync(fixture.queuePath, 'utf8');

    const missingEvidence = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: verifying.revision,
      to: 'done',
      note: ''
    });
    assert.equal(missingEvidence.status, 400);
    assert.equal((await responseJson(missingEvidence)).error, 'mission_note_required');
    assert.equal(readFileSync(fixture.queuePath, 'utf8'), durableBeforeMissingEvidence);

    const evidence = 'Focused mission tests passed and the durable queue record was inspected.';
    const doneResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: verifying.revision,
      to: 'done',
      note: evidence
    });
    assert.equal(doneResponse.status, 200);
    const done = (await responseJson(doneResponse)).job;
    assert.equal(done.status, 'done');
    assert.deepEqual(done.verification, { status: 'passed', note: evidence, at: done.finishedAt });
    assert.equal(done.resultSummary, evidence);
    assert.equal(done.outcomes.at(-1)?.status, 'done');
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('operator recovery resumes only the same worker and preserves failed work through requeue', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      title: 'Recover and preserve a failed mission'
    })))).job;
    const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    assert.equal(dispatchResponse.status, 200);
    const running = (await responseJson(dispatchResponse)).job;
    const terminalWritesAfterDispatch = toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length;

    const durableBeforeStaleTransition = readFileSync(fixture.queuePath, 'utf8');
    const stale = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: running.revision - 1,
      to: 'needs_you',
      note: 'This stale update must not win.'
    });
    assert.equal(stale.status, 409);
    assert.equal((await responseJson(stale)).error, 'mission_revision_conflict');
    assert.equal(readFileSync(fixture.queuePath, 'utf8'), durableBeforeStaleTransition);

    const needsYouResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: running.revision,
      to: 'needs_you',
      note: 'Inspect the exact worker before continuing.'
    });
    assert.equal(needsYouResponse.status, 200);
    const needsYou = (await responseJson(needsYouResponse)).job;
    assert.equal(needsYou.status, 'needs_you');
    assert.equal(needsYou.activeAttempt.status, 'needs_you');
    assert.equal(needsYou.blocker, 'Inspect the exact worker before continuing.');

    const resumedResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: needsYou.revision,
      to: 'running'
    });
    assert.equal(resumedResponse.status, 200);
    const resumed = (await responseJson(resumedResponse)).job;
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.activeAttempt.status, 'running');
    assert.equal(resumed.blocker, '');

    const failureNote = 'Focused recovery verification found a reproducible fixture failure.';
    const durableBeforeUnconfirmedFailure = readFileSync(fixture.queuePath, 'utf8');
    const unconfirmedFailure = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: resumed.revision,
      to: 'failed',
      note: failureNote
    });
    assert.equal(unconfirmedFailure.status, 400);
    assert.equal((await responseJson(unconfirmedFailure)).error, 'mission_lock_release_confirmation_required');
    assert.equal(readFileSync(fixture.queuePath, 'utf8'), durableBeforeUnconfirmedFailure);

    const failedResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: resumed.revision,
      to: 'failed',
      note: failureNote,
      confirm: 'inspected-release'
    });
    assert.equal(failedResponse.status, 200);
    const failed = (await responseJson(failedResponse)).job;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.blocker, failureNote);
    assert.equal(failed.resultSummary, failureNote);
    assert.match(failed.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(failed.activeAttempt.status, 'failed');
    assert.equal(failed.activeAttempt.finishedAt, failed.finishedAt);
    assert.deepEqual(failed.outcomes.at(-1), {
      status: 'failed',
      note: failureNote,
      at: failed.finishedAt
    });

    const requeuedResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: failed.revision,
      to: 'ready'
    });
    assert.equal(requeuedResponse.status, 200);
    const requeued = (await responseJson(requeuedResponse)).job;
    assert.equal(requeued.status, 'ready');
    assert.equal(requeued.assignedSession, '');
    assert.equal(requeued.activeAttempt, null);
    assert.equal(requeued.blocker, '');
    assert.equal(requeued.resultSummary, '');
    assert.equal(requeued.finishedAt, null);
    assert.deepEqual(requeued.verification, { status: 'pending', note: '', at: null });
    assert.equal(requeued.attempts.at(-1).status, 'failed');
    assert.equal(requeued.outcomes.at(-1).status, 'failed');
    assert.equal(
      toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length,
      terminalWritesAfterDispatch
    );
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('active missions lock both their worker and workspace before tmux input', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const first = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      title: 'Own the alpha workspace'
    })))).job;
    const firstDispatch = await server.request(`/api/missions/${first.id}/dispatch`, {
      expectedRevision: first.revision,
      session: 'codex-worker'
    });
    assert.equal(firstDispatch.status, 200);

    const sameWorkspace = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      title: 'Conflict with alpha workspace'
    })))).job;
    const beforeWorkspaceConflict = toolLog(fixture);
    const workspaceConflict = await server.request(`/api/missions/${sameWorkspace.id}/dispatch`, {
      expectedRevision: sameWorkspace.revision,
      session: 'codex-other'
    });
    assert.equal(workspaceConflict.status, 409);
    assert.equal((await responseJson(workspaceConflict)).error, 'mission_workspace_locked');
    assert.equal(toolLog(fixture), beforeWorkspaceConflict);

    const sameWorker = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.betaWorkspace, {
      title: 'Conflict with worker'
    })))).job;
    const beforeWorkerConflict = toolLog(fixture);
    const workerConflict = await server.request(`/api/missions/${sameWorker.id}/dispatch`, {
      expectedRevision: sameWorker.revision,
      session: 'codex-worker'
    });
    assert.equal(workerConflict.status, 409);
    assert.equal((await responseJson(workerConflict)).error, 'mission_worker_locked');
    assert.equal(toolLog(fixture), beforeWorkerConflict);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('a recycled tmux session name cannot inherit an active mission', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
    const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    assert.equal(dispatchResponse.status, 200);
    const literalCountBeforeRestart = toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-literal:')).length;

    await server.stop();
    server = await startServer(fixture, { MISSION_SESSION_CREATED: '1700000001' });
    const linkedInput = await server.request('/api/agent/send', {
      session: 'codex-worker',
      text: 'This must not reach a replacement session.',
      missionId: created.id
    });
    assert.equal(linkedInput.status, 409);
    assert.equal((await responseJson(linkedInput)).error, 'agent_session_replaced');
    const literalCountAfterRestart = toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-literal:')).length;
    assert.equal(literalCountAfterRestart, literalCountBeforeRestart);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('mission continuation refuses a replacement pane even when the session name and creation time match', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
    const dispatched = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    assert.equal(dispatched.status, 200);
    const running = (await responseJson(dispatched)).job;

    await server.stop();
    server = await startServer(fixture, { MISSION_SUBMIT_BEHAVIOR: 'replacement' });
    const needsYouResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: running.revision,
      to: 'needs_you',
      note: 'Inspect the recovered worker identity.'
    });
    assert.equal(needsYouResponse.status, 200);
    const needsYou = (await responseJson(needsYouResponse)).job;
    const sendsBeforeResume = toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length;

    const resumeResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: needsYou.revision,
      to: 'running'
    });
    assert.equal(resumeResponse.status, 409);
    assert.equal((await responseJson(resumeResponse)).error, 'mission_worker_missing_or_replaced');
    assert.equal(readQueue(fixture).jobs[0].status, 'needs_you');
    assert.equal(readQueue(fixture).jobs[0].revision, needsYou.revision);
    assert.equal(
      toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length,
      sendsBeforeResume
    );
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('legacy missions without intrinsic pane identity cannot be resumed into a same-name worker', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture);
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
    const dispatched = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    assert.equal(dispatched.status, 200);
    const running = (await responseJson(dispatched)).job;
    await server.stop();
    server = null;

    const queue = readQueue(fixture);
    queue.jobs[0].assignedTmuxPaneId = null;
    queue.jobs[0].assignedPanePid = null;
    writeFileSync(fixture.queuePath, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 });

    server = await startServer(fixture);
    const needsYouResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: running.revision,
      to: 'needs_you',
      note: 'Recover this legacy mission safely.'
    });
    assert.equal(needsYouResponse.status, 200);
    const needsYou = (await responseJson(needsYouResponse)).job;

    const snapshot = await responseJson(await server.get('/api/snapshot'));
    const visibleMission = snapshot.missions.jobs.find((job) => job.id === created.id);
    assert.equal(visibleMission.worker.present, true);
    assert.equal(visibleMission.worker.identityMatches, false);
    assert.equal(visibleMission.worker.identityState, 'unavailable');

    const sendsBeforeResume = toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length;
    const resumeResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: needsYou.revision,
      to: 'running'
    });
    assert.equal(resumeResponse.status, 409);
    assert.equal((await responseJson(resumeResponse)).error, 'mission_worker_identity_unavailable');
    assert.equal(readQueue(fixture).jobs[0].status, 'needs_you');
    assert.equal(
      toolLog(fixture).split('\n').filter((line) => line.startsWith('tmux:send-')).length,
      sendsBeforeResume
    );
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('normal text and picker keys cannot interleave with a reserved dispatch', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { MISSION_CAPTURE_DELAY: '0.1' });
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
    const dispatchPromise = server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });

    const deadline = Date.now() + 1500;
    while (!toolLog(fixture).includes('tmux:list-exact') && Date.now() < deadline) await delay(20);
    assert.equal(toolLog(fixture).includes('tmux:list-exact'), true);

    const [textRace, keyRace] = await Promise.all([
      server.request('/api/agent/send', { session: 'codex-worker', text: 'Do not interleave this text.' }),
      server.request('/api/agent/ui-key', { session: 'codex-worker', key: 'down' })
    ]);
    assert.equal(textRace.status, 409);
    assert.equal((await responseJson(textRace)).error, 'mission_dispatch_in_progress');
    assert.equal(keyRace.status, 409);
    assert.equal((await responseJson(keyRace)).error, 'mission_dispatch_in_progress');

    const dispatchResponse = await dispatchPromise;
    assert.equal(dispatchResponse.status, 200);
    const sendOperations = toolLog(fixture).split('\n').filter((line) =>
      line.startsWith('tmux:send-literal:') || line === 'tmux:send-enter:C-m'
    );
    assert.equal(sendOperations.length, 2);
    assert.equal(sendOperations[0].startsWith('tmux:send-literal:'), true);
    assert.equal(sendOperations[1], 'tmux:send-enter:C-m');
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('an unqueued live Codex pane blocks parent-child workspace collisions', async () => {
  const fixture = createFixture();
  const nestedWorkspace = path.join(fixture.alphaWorkspace, 'nested');
  mkdirSync(nestedWorkspace, { recursive: true });
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { MISSION_EXTRA_WORKSPACE: nestedWorkspace });
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace)))).job;
    const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    const result = await responseJson(dispatchResponse);
    assert.equal(dispatchResponse.status, 409);
    assert.equal(result.error, 'mission_workspace_agent_conflict');
    assert.equal(result.conflictingSession, 'codex-other');
    assert.equal(readQueue(fixture).jobs[0].status, 'ready');
    assert.equal(toolLog(fixture).includes('tmux:send-literal:'), false);
    assert.equal(toolLog(fixture).includes('tmux:send-enter:C-m'), false);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('new Codex sessions get a startup grace period before they are labeled stopped', async () => {
  for (const testCase of [
    { ageSeconds: 1, expected: 'starting' },
    { ageSeconds: 30, expected: 'stopped' }
  ]) {
    const fixture = createFixture();
    installDispatchTools(fixture);
    let server;
    try {
      server = await startServer(fixture, {
        MISSION_PANE_COMMAND: 'bash',
        MISSION_NO_CODEX_PROCESS: '1',
        MISSION_SESSION_CREATED: String(Math.floor(Date.now() / 1000) - testCase.ageSeconds)
      });
      const snapshot = await responseJson(await server.get('/api/snapshot'));
      const worker = snapshot.agents.find((agent) => agent.session === 'codex-worker');
      assert.equal(worker.agentStatus.state, testCase.expected);
    } finally {
      if (server) await server.stop();
      rmSync(fixture.fixtureDir, { recursive: true, force: true });
    }
  }
});

test('Codex idle prompts ignore permission metadata without masking real input requests', async (t) => {
  const cases = [
    {
      name: 'idle startup metadata',
      expectedState: 'idle',
      expectedTone: 'good',
      expectedReason: 'prompt ready',
      output: [
        'OpenAI Codex',
        'model: gpt-test-alpha ultra',
        'directory: ~/projects/alpha',
        'permissions: full access',
        '',
        '› Ask Codex anything',
        'gpt-test-alpha ultra · 100% left'
      ].join('\n')
    },
    {
      name: 'model picker',
      expectedState: 'waiting',
      expectedTone: 'warn',
      expectedReason: 'input needed',
      output: [
        'Select a model and reasoning effort',
        '› 1. gpt-test-alpha  ultra',
        '  2. gpt-test-beta max',
        'Press enter to select'
      ].join('\n')
    },
    {
      name: 'command approval',
      expectedState: 'waiting',
      expectedTone: 'warn',
      expectedReason: 'input needed',
      output: [
        'Do you want to run this command?',
        '› 1. Yes, proceed',
        '  2. No, and tell Codex what to do differently',
        'Press enter to confirm'
      ].join('\n')
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = createFixture();
      installDispatchTools(fixture);
      let server;
      try {
        server = await startServer(fixture, { MISSION_CAPTURE_OUTPUT: testCase.output });
        const snapshotResponse = await server.get('/api/snapshot');
        assert.equal(snapshotResponse.status, 200);
        const snapshot = await responseJson(snapshotResponse);
        const agent = snapshot.agents.find((item) => item.session === 'codex-worker');
        assert.ok(agent, 'expected the fake Codex worker in the snapshot');
        assert.equal(agent.agentStatus?.state, testCase.expectedState);
        assert.equal(agent.agentStatus?.tone, testCase.expectedTone);
        assert.equal(agent.agentStatus?.reason, testCase.expectedReason);
      } finally {
        if (server) await server.stop();
        rmSync(fixture.fixtureDir, { recursive: true, force: true });
      }
    });
  }
});

test('structured agent status replies drive good, warning, and failure operator tones', async (t) => {
  const cases = [
    {
      name: 'completed without blockers',
      status: 'complete',
      blockers: 'none',
      expectedTone: 'good',
      expectedAttention: false
    },
    {
      name: 'paused for input',
      status: 'paused',
      blockers: 'needs input',
      expectedTone: 'warn',
      expectedAttention: true
    },
    {
      name: 'failed turn',
      status: 'failed',
      blockers: 'queue verification error',
      expectedTone: 'bad',
      expectedAttention: true
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const fixture = createFixture();
      installDispatchTools(fixture);
      let server;
      try {
        const output = [
          `Status: ${testCase.status}`,
          'Current work: Checked the synthetic queue fixture',
          `Blockers: ${testCase.blockers}`,
          'Next: none',
          '',
          '› Ask Codex anything',
          'gpt-test-alpha ultra · 100% left'
        ].join('\n');
        server = await startServer(fixture, { MISSION_CAPTURE_OUTPUT: output });
        const snapshot = await responseJson(await server.get('/api/snapshot'));
        const brief = snapshot.orchestration.agents.find((item) => item.session === 'codex-worker');
        assert.ok(brief, 'expected an orchestration brief for the synthetic worker');
        assert.equal(brief.statusReply.status, testCase.status);
        assert.equal(brief.statusReply.blockers, testCase.blockers);
        assert.equal(brief.tone, testCase.expectedTone);
        assert.equal(brief.needsAttention, testCase.expectedAttention);
      } finally {
        if (server) await server.stop();
        rmSync(fixture.fixtureDir, { recursive: true, force: true });
      }
    });
  }
});

test('Today attention and notification outbox stay decision-only, deduplicated, snoozable, and stale-cookie safe', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, {
      MISSION_LITERAL_CONFIRM_MS: '500',
      MISSION_SUBMIT_CONFIRM_MS: '500',
      MISSION_CONFIRM_SAMPLE_MS: '20'
    });
    const created = (await responseJson(await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace, {
      title: 'Verify the Today feed'
    })))).job;
    const dispatchResponse = await server.request(`/api/missions/${created.id}/dispatch`, {
      expectedRevision: created.revision,
      session: 'codex-worker'
    });
    assert.equal(dispatchResponse.status, 200);
    const running = (await responseJson(dispatchResponse)).job;
    const verifyingResponse = await server.request(`/api/missions/${created.id}/transition`, {
      expectedRevision: running.revision,
      to: 'verifying'
    });
    assert.equal(verifyingResponse.status, 200);

    const firstSnapshot = await responseJson(await server.get('/api/snapshot'));
    const missionAttention = firstSnapshot.attention.items.filter((item) => item.missionId === created.id);
    assert.equal(missionAttention.length, 1);
    assert.equal(missionAttention[0].status, 'verifying');
    assert.equal(missionAttention[0].requiresDecision, true);
    assert.equal(
      firstSnapshot.attention.decisionCount,
      firstSnapshot.attention.items.filter((item) => item.requiresDecision).length
    );
    assert.equal(firstSnapshot.notifications.items.length, 1);
    const notification = firstSnapshot.notifications.items[0];
    assert.equal(notification.kind, 'verification_ready');
    assert.equal(notification.missionId, created.id);
    assert.match(notification.openEndpoint, new RegExp(`^/api/notifications/${notification.id}/open$`));
    assert.match(notification.snoozeEndpoint, new RegExp(`^/api/notifications/${notification.id}/snooze$`));

    const repeatedSnapshot = await responseJson(await server.get('/api/snapshot'));
    assert.deepEqual(repeatedSnapshot.notifications.items.map((item) => item.id), [notification.id]);

    const staleCookie = server.cookie;
    await server.stop();
    server = await startServer(fixture, {
      MISSION_LITERAL_CONFIRM_MS: '500',
      MISSION_SUBMIT_CONFIRM_MS: '500',
      MISSION_CONFIRM_SAMPLE_MS: '20'
    });
    const staleSnooze = await server.postWithCookie(notification.snoozeEndpoint, { minutes: 15 }, staleCookie);
    assert.equal(staleSnooze.status, 401);
    assert.deepEqual(await responseJson(staleSnooze), { error: 'control_session_required' });

    const snoozed = await server.request(notification.snoozeEndpoint, { minutes: 15 });
    assert.equal(snoozed.status, 200);
    assert.equal((await responseJson(snoozed)).action, 'snooze');
    const snoozedSnapshot = await responseJson(await server.get('/api/snapshot'));
    assert.deepEqual(snoozedSnapshot.notifications.items, []);

    const opened = await server.request(notification.openEndpoint, {});
    assert.equal(opened.status, 200);
    assert.equal((await responseJson(opened)).action, 'open');
    const openedSnapshot = await responseJson(await server.get('/api/snapshot'));
    assert.deepEqual(openedSnapshot.notifications.items, []);
    assert.equal(statSync(path.join(fixture.fixtureDir, 'data', 'notification-state.json')).mode & 0o777, 0o600);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('Today attention merges a waiting unassigned agent as one operator decision', async () => {
  const fixture = createFixture();
  installDispatchTools(fixture);
  let server;
  try {
    server = await startServer(fixture, {
      MISSION_CAPTURE_OUTPUT: [
        'Select a model and reasoning effort',
        '› 1. gpt-test-alpha ultra',
        'Press enter to select'
      ].join('\n')
    });
    const snapshot = await responseJson(await server.get('/api/snapshot'));
    const workerItems = snapshot.attention.items.filter((item) => item.session === 'codex-worker');
    assert.equal(workerItems.length, 1);
    assert.equal(workerItems[0].kind, 'agent');
    assert.equal(workerItems[0].status, 'waiting');
    assert.equal(workerItems[0].requiresDecision, true);
    assert.equal(snapshot.attention.decisionCount, 1);
    assert.deepEqual(snapshot.notifications.items, []);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('snapshot reports control-plane mode and legacy tmux adds one non-decision Today warning', async (t) => {
  for (const mode of ['systemd-user', 'foreground', 'tmux-legacy']) {
    await t.test(mode, async () => {
      const fixture = createFixture();
      installDispatchTools(fixture);
      let server;
      try {
        server = await startServer(fixture, { ORCH_CONTROL_PLANE_MODE: mode });
        const snapshot = await responseJson(await server.get('/api/snapshot'));
        assert.equal(snapshot.host.controlPlane.mode, mode);
        assert.equal(snapshot.host.app.controlPlaneMode, mode);
        assert.equal(snapshot.capabilities.controlPlaneMode, mode);
        assert.equal(snapshot.capabilities.controlPlaneIsolated, mode !== 'tmux-legacy');

        const warnings = snapshot.security.warnings.filter((item) => item.id === 'legacy-control-plane');
        const todayWarnings = snapshot.attention.items.filter((item) => item.id === 'attention:system:legacy-control-plane');
        assert.equal(warnings.length, mode === 'tmux-legacy' ? 1 : 0);
        assert.equal(todayWarnings.length, mode === 'tmux-legacy' ? 1 : 0);
        if (mode === 'tmux-legacy') {
          assert.equal(warnings[0].requiresDecision, false);
          assert.equal(todayWarnings[0].requiresDecision, false);
          assert.match(todayWarnings[0].title, /shares the workload tmux server/i);
        }
        assert.equal(
          snapshot.attention.decisionCount,
          snapshot.attention.items.filter((item) => item.requiresDecision).length
        );
      } finally {
        if (server) await server.stop();
        rmSync(fixture.fixtureDir, { recursive: true, force: true });
      }
    });
  }
});

test('ephemeral review replacement is confined to the managed tmux socket', async () => {
  const fixture = createFixture();
  installReviewTools(fixture);
  let server;
  try {
    server = await startServer(fixture, { ORCH_CONTROL_PLANE_MODE: 'foreground' });
    const response = await server.request('/api/review/start', {});
    assert.equal(response.status, 200);
    const body = await responseJson(response);
    assert.equal(body.session, 'codex-orchestrator-review');
    assert.equal(body.tmuxSocket, 'host-control-managed');

    const operations = toolLog(fixture).trim().split('\n').filter(Boolean);
    const lifecycle = operations.filter((line) => /(?:has-session|kill-session|new-session|set-option)/.test(line));
    assert.equal(lifecycle.length, 4);
    assert.equal(lifecycle.every((line) => line.startsWith('tmux:-L host-control-managed ')), true);
    assert.equal(operations.some((line) => /^tmux:(?!-L host-control-managed ).*kill-session/.test(line)), false);
    assert.equal(operations.some((line) => line.includes('kill-server')), false);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});

test('all operational snapshots require the same-page control session', async () => {
  const fixture = createFixture();
  let server;
  try {
    server = await startServer(fixture);
    const createdResponse = await server.request('/api/missions/create', missionBody(fixture.alphaWorkspace));
    assert.equal(createdResponse.status, 200);
    const created = (await responseJson(createdResponse)).job;

    const publicSnapshotResponse = await server.get('/api/snapshot', { authenticated: false });
    assert.equal(publicSnapshotResponse.status, 401);
    assert.deepEqual(await responseJson(publicSnapshotResponse), { error: 'control_session_required' });

    const publicMissionsResponse = await server.get('/api/missions', { authenticated: false });
    assert.equal(publicMissionsResponse.status, 401);
    assert.deepEqual(await responseJson(publicMissionsResponse), { error: 'control_session_required' });

    const publicEventsResponse = await server.get('/api/events', { authenticated: false });
    assert.equal(publicEventsResponse.status, 401);
    assert.deepEqual(await responseJson(publicEventsResponse), { error: 'control_session_required' });

    const controlledMissionsResponse = await server.get('/api/missions');
    assert.equal(controlledMissionsResponse.status, 200);
    const controlledMissions = await responseJson(controlledMissionsResponse);
    assert.equal(controlledMissions.missions.jobs.some((job) => job.id === created.id), true);

    const staleCookie = server.cookie;
    await server.stop();
    server = await startServer(fixture);
    const staleSnapshotResponse = await server.get('/api/snapshot', { cookieOverride: staleCookie });
    assert.equal(staleSnapshotResponse.status, 401);
    assert.deepEqual(await responseJson(staleSnapshotResponse), { error: 'control_session_required' });

    const refreshedSnapshotResponse = await server.get('/api/snapshot');
    assert.equal(refreshedSnapshotResponse.status, 200);
    const refreshedSnapshot = await responseJson(refreshedSnapshotResponse);
    assert.equal(refreshedSnapshot.missions.jobs.some((job) => job.id === created.id), true);
  } finally {
    if (server) await server.stop();
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
});
