import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  attentionForSession,
  nextDrawer,
  terminalLayoutSlots
} from '../public/ui-state.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');

async function uiSource(name) {
  return readFile(path.join(publicDir, name), 'utf8');
}

test('live entrypoint loads the terminal-first shell', async () => {
  const index = await uiSource('index.html');

  assert.match(index, /<title>PaneFleet — Terminal Workspace<\/title>/);
  assert.match(index, /<span class="brand-mark" aria-hidden="true">PF<\/span>/);
  assert.match(index, /<div><h1>PaneFleet<\/h1><p>Terminal workspace<\/p><\/div>/);
  assert.match(index, /id="agents-tab" class="tab active"[^>]*><span>Terminals<\/span>/);
  assert.match(index, /href="\/styles\.css"/);
  assert.match(index, /src="\/app\.js"/);
  assert.match(index, /id="queue-drawer"[^>]*class="control-drawer queue-drawer hidden"/);
  assert.match(index, /id="tools-drawer"[^>]*class="control-drawer tools-drawer hidden"/);
  assert.match(index, /id="terminal-stage"/);
  assert.match(index, /id="session-list"/);
  assert.match(index, /data-layout="free"/);
  assert.match(index, /data-layout="focus"/);
  assert.match(index, /data-layout="split"/);
  assert.match(index, /data-layout="grid"/);
  assert.match(index, /data-action="terminal-full-height"[^>]*aria-pressed="false"/);
  assert.match(index, /id="project-desk" class="project-desk hidden"/);
  assert.match(index, /id="project-notes"/);
  assert.match(index, /id="project-artifacts"/);
  assert.match(index, /id="project-artifact-count"/);
  assert.match(index, /id="scratchpad-text"[^>]*maxlength="4000"/);
  assert.match(index, /id="scratchpad-review-panel" class="scratchpad-review-panel hidden"/);
  assert.match(index, /data-action="scratchpad-send-confirm"/);

  const workspaceIndex = index.indexOf('id="terminal-stage"');
  const mainEndIndex = index.indexOf('</main>');
  const layerIndex = index.indexOf('id="terminal-layer"');
  assert.ok(workspaceIndex < mainEndIndex && mainEndIndex < layerIndex);
});

test('drawer state is exclusive and exact-session attention never leaks across workers', () => {
  assert.equal(nextDrawer(null, 'queue'), 'queue');
  assert.equal(nextDrawer('queue', 'queue'), null);
  assert.equal(nextDrawer('queue', 'tools'), 'tools');
  assert.equal(nextDrawer('tools', 'invalid'), null);

  const items = [
    { id: 'one', session: 'codex' },
    { id: 'two', session: 'codex2' },
    { id: 'host-only' }
  ];
  assert.deepEqual(attentionForSession(items, 'codex').map((item) => item.id), ['one']);
  assert.deepEqual(attentionForSession(items, 'codex2').map((item) => item.id), ['two']);
  assert.deepEqual(attentionForSession(items, ''), []);
});

test('terminal layouts produce bounded 1, 2, and 4 pane slots', () => {
  assert.deepEqual(terminalLayoutSlots('free', 4, 1000, 700), []);
  assert.equal(terminalLayoutSlots('focus', 4, 1000, 700).length, 1);

  const split = terminalLayoutSlots('split', 4, 1000, 700, 10);
  assert.equal(split.length, 2);
  assert.deepEqual(split[0], { left: 0, top: 0, width: 495, height: 700 });
  assert.deepEqual(split[1], { left: 505, top: 0, width: 495, height: 700 });

  const grid = terminalLayoutSlots('grid', 8, 1000, 700, 10);
  assert.equal(grid.length, 4);
  assert.deepEqual(grid[3], { left: 505, top: 355, width: 495, height: 345 });
});

test('live UI keeps terminal controls and literal-send safety paths while adding terminal workflow features', async () => {
  const app = await uiSource('app.js');

  assert.doesNotMatch(app, /if \(missionCapability\) switchView\('queue'\)/);
  assert.match(app, /switchView\('agents'\)/);
  assert.match(app, /data-action="terminal-minimize"/);
  assert.match(app, /data-action="terminal-maximize"/);
  assert.match(app, /data-action="terminal-close"/);
  assert.match(app, /data-terminal-resize="nw"/);
  assert.match(app, /class="terminal-send-text"/);
  assert.match(app, /data-command="\/model"/);
  assert.match(app, /data-action="terminal-ui-key" data-key="select"/);
  assert.match(app, /api\('\/api\/agent\/send'/);
  assert.match(app, /api\('\/api\/agent\/ui-key'/);
  assert.match(app, /persistTerminalDraft/);
  assert.match(app, /navigateTerminalHistory/);
  assert.match(app, /previewTerminalPaste/);
  assert.match(app, /terminalWorkspace\.classList\.toggle\('has-open-terminals', count > 0\)/);
  assert.match(app, /syncProjectDesk\(\)/);
  assert.match(app, /\/api\/project-desk\/\$\{encodeURIComponent\(target\.session\)\}/);
  assert.match(app, /\/artifacts\/\$\{encodeURIComponent\(artifact\.id\)\}/);
  assert.match(app, /class="project-artifact-row"/);
  assert.match(app, /data-action="project-artifact-download"/);
  assert.match(app, /data-artifact-url="\$\{escapeHtml\(url\)\}"/);
  assert.match(app, /data-artifact-name="\$\{escapeHtml\(artifact\.name\)\}"/);
  assert.match(app, /state\.snapshot\?\.capabilities\?\.projectArtifacts === true/);
  assert.match(app, /function projectArtifactTimestamp\(value\)/);
  assert.match(app, /modified \? `Modified \$\{modified\}` : ''/);
  assert.match(app, /async function projectArtifactDownload\(button\)/);
  assert.match(app, /response\.headers\.get\('content-type'\)/);
  assert.match(app, /contentType !== 'application\/pdf'/);
  assert.match(app, /URL\.createObjectURL\(blob\)/);
  assert.match(app, /URL\.revokeObjectURL\(objectUrl\)/);
  const artifactDownloadStart = app.indexOf('async function projectArtifactDownload(button)');
  const artifactDownloadEnd = app.indexOf('function renderProjectMission', artifactDownloadStart);
  const artifactDownloadSource = app.slice(artifactDownloadStart, artifactDownloadEnd);
  assert.ok(artifactDownloadStart >= 0 && artifactDownloadEnd > artifactDownloadStart);
  assert.match(artifactDownloadSource, /data\.error === 'control_session_required' && attempt === 0/);
  assert.match(artifactDownloadSource, /await refreshControlSession\(controller\.signal\)/);
  assert.match(artifactDownloadSource, /credentials: 'same-origin'/);
  assert.match(artifactDownloadSource, /headers: \{ accept: 'application\/pdf' \}/);
  assert.doesNotMatch(app, /file:\/\//);
  assert.match(app, /scratchpadDraftKey/);
  assert.match(app, /SCRATCHPAD_SNIPPETS_KEY/);
  assert.match(app, /sameExactTarget/);
  assert.match(app, /state\.snapshot\?\.capabilities\?\.projectDesk === true/);
  assert.match(app, /restart PaneFleet to enable exact-target Review and Send/);
  assert.match(app, /sessionCreatedAt: target\.sessionCreatedAt/);
  assert.match(app, /paneId: target\.paneId/);
  assert.match(app, /tmuxPaneId: target\.tmuxPaneId/);
  assert.match(app, /panePid: target\.panePid/);
  assert.match(app, /case 'terminal-layout'/);
  assert.match(app, /case 'terminal-full-height'/);
  assert.match(app, /function setTerminalFullHeight/);
  assert.match(app, /terminalFullHeightBounds/);
  assert.match(app, /case 'drawer-toggle'/);
  assert.match(app, /class="tool-panel tools-notifications"/);
  assert.match(app, /event\.isComposing/);
  assert.match(app, /event\.shiftKey \|\| event\.altKey \|\| event\.ctrlKey \|\| event\.metaKey/);

  const reviewStart = app.indexOf('function openScratchpadReview()');
  const reviewEnd = app.indexOf('function togglePinnedSession', reviewStart);
  const reviewSource = app.slice(reviewStart, reviewEnd);
  assert.ok(reviewStart >= 0 && reviewEnd > reviewStart);
  assert.doesNotMatch(reviewSource, /api\('/);
  assert.match(app, /async function confirmScratchpadSend\(\)[\s\S]*sendTerminalTextValue\(item, review\.text/);
});

test('live responsive CSS floats desktop windows across the viewport and shows only one phone terminal', async () => {
  const styles = await uiSource('styles.css');
  assert.match(styles, /\.terminal-home\s*\{[\s\S]*grid-template-columns: 230px minmax\(520px, 1fr\) 300px/);
  assert.match(styles, /\.terminal-layer\s*\{\s*position: fixed/);
  assert.match(styles, /\.terminal-window\s*\{\s*position: fixed/);
  assert.match(styles, /\.terminal-workspace\.has-open-terminals\s*\{[\s\S]*align-self: stretch/);
  assert.match(styles, /\.terminal-workspace\.has-open-terminals \.terminal-stage\s*\{[\s\S]*display: block/);
  assert.match(styles, /\.terminal-window\.is-full-height :is\([\s\S]*\.resize-n/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.terminal-full-height-button\s*\{\s*display: none/);
  assert.match(styles, /\.project-desk\s*\{[\s\S]*min-height: 100%/);
  assert.match(styles, /\.project-artifact-row\s*\{/);
  assert.match(styles, /\.project-artifact-row\s*\{[\s\S]*cursor: pointer/);
  assert.match(styles, /\.project-artifact-row\[aria-busy="true"\]/);
  assert.match(styles, /\.scratchpad-review-panel\s*\{[\s\S]*border: 2px solid/);
  assert.match(styles, /\.terminal-stage\s*\{[\s\S]*grid-row: 3/);
  assert.match(styles, /\.terminal-window\.is-layout-hidden\s*\{\s*display: none/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.terminal-window\s*\{\s*position: fixed/);
  assert.match(styles, /\.control-drawer\s*\{[\s\S]*position: fixed/);
});

test('mobile terminal typing is protected from focus-destroying dashboard renders', async () => {
  const [app, styles] = await Promise.all([uiSource('app.js'), uiSource('styles.css')]);

  assert.match(app, /const protectedTerminalEditor = preserveActiveEditor[\s\S]*\.terminal-window textarea/);
  assert.match(app, /syncOpenTerminalWindows\(\{ protectedEditor: protectedTerminalEditor \}\)/);
  assert.match(app, /item\.sendText !== protectedEditor\) updateTerminalSendForm\(item\)/);
  assert.match(app, /if \(protectedEditor\?\.isConnected\) return/);
  assert.match(app, /const alreadyActive = state\.activeTerminalId === item\.id[\s\S]*if \(alreadyActive\) return/);
  assert.match(app, /const terminalEditor = event\.target\.closest\('\.terminal-send-form, input, textarea, select, \[contenteditable="true"\]'\)/);
  assert.match(app, /if \(item\.sendText\.readOnly !== promptDisabled\) item\.sendText\.readOnly = promptDisabled/);
  assert.match(styles, /@media \(max-width: 759px\) \{\s*\.terminal-layer \{\s*z-index: 1000/);
  assert.match(styles, /@media \(max-width: 759px\)[\s\S]*\.terminal-dock \{\s*z-index: 1001/);
});
