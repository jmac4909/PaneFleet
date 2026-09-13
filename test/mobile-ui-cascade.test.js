import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  effectiveCssDeclarations,
  exactDuplicateCssRules
} from './helpers/css-cascade.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiSource = (filename) => readFile(path.join(root, 'public', filename), 'utf8');
const zoomSafeEditorSelectors = Object.freeze([
  '.session-search input',
  '.create-agent-form input',
  '.create-agent-form textarea',
  '.create-agent-form select',
  '.prompt-target-mobile-picker select',
  '.prompt-queue-form :is(select, input, textarea)',
  '.prompt-history-search-form input',
  '.idea-queue-form :is(input, textarea)',
  '.mission-create-form input',
  '.mission-create-form select',
  '.mission-create-form textarea',
  '.mission-worker-field select',
  '.delivery-plan-create-form textarea',
  '.delivery-plan-edit-form textarea',
  '.delivery-run-verification-form :is(select, textarea)',
  '.code-city-picker select',
  '.project-desk :is(input, textarea, select)',
  '.terminal-mobile-select',
  '.terminal-find-input',
  '.send-form textarea'
]);
const touchSizedEditorSelectors = Object.freeze([
  '.session-search input',
  '.create-agent-form input',
  '.create-agent-form select',
  '.project-desk :is(input, select)',
  '.code-city-picker select',
  '.prompt-history-search-form input',
  '.idea-queue-form input'
]);
const componentSpecificTouchSelectors = Object.freeze([
  '.terminal-tab > button:first-child',
  '.snippet-tools .action-button',
  '.terminal-resume-panel button',
  '.prompt-queue-draft-actions .action-button',
  '.prompt-history-search-form .action-button'
]);

test('device login stays iPhone zoom-safe, touch-sized, and short-landscape scrollable', async () => {
  const styles = await uiSource('login.css');
  assert.match(styles, /\.login-shell\s*\{[\s\S]*min-height: 100dvh;/);
  assert.match(styles, /env\(safe-area-inset-top\)/);
  assert.match(styles, /env\(safe-area-inset-right\)/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /env\(safe-area-inset-left\)/);
  assert.match(styles, /input\[type="text"\],[\s\S]*input\[type="password"\][\s\S]*min-height: 50px;[\s\S]*font-size: 16px;/);
  assert.match(styles, /button\s*\{[\s\S]*min-height: 52px;/);
  assert.match(styles, /@media \(max-height: 620px\) and \(orientation: landscape\)[\s\S]*place-items: start center;/);
});

test('CSS cascade checks resolve matching media rules in source order', () => {
  const styles = `
    .sample { display: block; color: red; }
    .controls :is(input, textarea, select), .fallback { font-size: 14px; }
    @media (max-width: 600px) { .sample { display: grid; } }
    @media (max-width: 600px) { .controls :is(input, textarea, select) { font-size: 16px; } }
    @media (pointer: coarse) { .sample { color: blue; } }
    @media (max-height: 500px) { .sample { overflow: auto; } }
    @media (prefers-reduced-motion: reduce) { .sample { transition: none; } }
    @media (min-width: 601px) { .sample { display: flex; } }
  `;

  assert.deepEqual(
    effectiveCssDeclarations(styles, '.sample', { width: 390, pointer: 'coarse' }),
    { display: 'grid', color: 'blue' }
  );
  assert.deepEqual(
    effectiveCssDeclarations(styles, '.sample', { width: 1024, pointer: 'fine' }),
    { display: 'flex', color: 'red' }
  );
  assert.equal(
    effectiveCssDeclarations(styles, '.sample', { width: 844, height: 390, pointer: 'coarse' }).overflow,
    'auto'
  );
  assert.equal(
    effectiveCssDeclarations(styles, '.sample', { width: 390, height: 844, pointer: 'coarse' }).overflow,
    undefined
  );
  assert.equal(
    effectiveCssDeclarations(styles, '.sample', { width: 1024, height: 768, reducedMotion: true }).transition,
    'none'
  );
  assert.deepEqual(
    effectiveCssDeclarations(styles, '.controls :is(input, textarea, select)', { width: 390, pointer: 'coarse' }),
    { 'font-size': '16px' }
  );
});

test('CSS cascade checks preserve important declarations against later normal overrides', () => {
  const styles = `
    .sample { color: red !important; display: block; opacity: 0.5 !IMPORTANT; }
    .sample { color: blue; display: grid; opacity: 0.7; }
    @media (max-width: 600px) { .sample { color: green !important; display: flex; } }
  `;

  assert.deepEqual(
    effectiveCssDeclarations(styles, '.sample', { width: 1024, pointer: 'fine' }),
    { color: 'red', display: 'grid', opacity: '0.5' }
  );
  assert.deepEqual(
    effectiveCssDeclarations(styles, '.sample', { width: 390, pointer: 'coarse' }),
    { color: 'green', display: 'flex', opacity: '0.5' }
  );
});

test('the winning phone cascade keeps navigation fixed, sessions vertical, and the topbar uncluttered', async () => {
  const [styles, index] = await Promise.all([uiSource('styles.css'), uiSource('index.html')]);
  const phone = { width: 390, pointer: 'coarse' };
  const desktop = { width: 1024, pointer: 'fine' };

  assert.deepEqual(
    {
      position: effectiveCssDeclarations(styles, '.sidebar', phone).position,
      inset: effectiveCssDeclarations(styles, '.sidebar', phone).inset,
      zIndex: effectiveCssDeclarations(styles, '.sidebar', phone)['z-index']
    },
    {
      position: 'fixed',
      inset: 'auto max(8px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left))',
      zIndex: '900'
    }
  );

  const appShell = effectiveCssDeclarations(styles, '.app-shell', phone);
  assert.equal(appShell.display, 'block');
  assert.match(appShell.padding, /82px \+ env\(safe-area-inset-bottom\)/);

  assert.deepEqual(
    {
      minWidth: effectiveCssDeclarations(styles, '.topbar', phone)['min-width'],
      minHeight: effectiveCssDeclarations(styles, '.topbar', phone)['min-height'],
      marginBottom: effectiveCssDeclarations(styles, '.topbar', phone)['margin-bottom'],
      borderRadius: effectiveCssDeclarations(styles, '.topbar', phone)['border-radius'],
      padding: effectiveCssDeclarations(styles, '.topbar', phone).padding
    },
    { minWidth: '0', minHeight: '56px', marginBottom: '6px', borderRadius: '13px', padding: '8px 10px' }
  );

  assert.deepEqual(
    {
      display: effectiveCssDeclarations(styles, '.session-list', phone).display,
      overflowX: effectiveCssDeclarations(styles, '.session-list', phone)['overflow-x'],
      overflowY: effectiveCssDeclarations(styles, '.session-list', phone)['overflow-y'],
      snap: effectiveCssDeclarations(styles, '.session-list', phone)['scroll-snap-type']
    },
    { display: 'grid', overflowX: 'hidden', overflowY: 'auto', snap: 'y proximity' }
  );

  assert.match(index, /class="icon-button shortcut-help-button" data-action="shortcut-help-open"/);
  assert.equal(effectiveCssDeclarations(styles, '.shortcut-help-button', phone).display, 'none');
  assert.notEqual(effectiveCssDeclarations(styles, '.shortcut-help-button', desktop).display, 'none');
});

test('the 320px bottom bar matches its six destinations and preserves touch-sized navigation', async () => {
  const [styles, index] = await Promise.all([uiSource('styles.css'), uiSource('index.html')]);
  const compactPhone = { width: 320, pointer: 'coarse' };
  const declarations = (selector) => effectiveCssDeclarations(styles, selector, compactPhone);
  const navStart = index.indexOf('<nav class="tabs primary-nav"');
  const navEnd = index.indexOf('</nav>', navStart);
  const navSource = index.slice(navStart, navEnd);
  const destinationCount = [...navSource.matchAll(/<button\b/g)].length;

  assert.ok(navStart >= 0 && navEnd > navStart);
  assert.equal(destinationCount, 6);
  assert.equal(
    declarations('.sidebar .tabs')['grid-template-columns'],
    `repeat(${destinationCount}, minmax(0, 1fr))`
  );
  assert.deepEqual(
    {
      minHeight: declarations('.sidebar .tab')['min-height'],
      touchAction: declarations('.sidebar .tab')['touch-action'],
      brandDisplay: declarations('.sidebar .brand-block').display,
      summaryDisplay: declarations('.sidebar .summary-grid').display
    },
    { minHeight: '54px', touchAction: 'manipulation', brandDisplay: 'none', summaryDisplay: 'none' }
  );
});

test('the winning phone cascade preserves touch targets regardless of pointer reporting and prevents terminal-picker zoom', async () => {
  const styles = await uiSource('styles.css');
  const phone = { width: 390, pointer: 'coarse' };
  const minimumPixels = (selector, property, minimum, viewport = phone) => {
    const value = effectiveCssDeclarations(styles, selector, viewport)[property];
    assert.match(value || '', /^\d+(?:\.\d+)?px$/, `${selector} is missing ${property}`);
    assert.ok(Number.parseFloat(value) >= minimum, `${selector} ${property} is below ${minimum}px`);
  };

  for (const [selector, properties] of [
    ['.drawer-close', ['width', 'height']],
    ['.terminal-mobile-switcher button', ['min-width', 'min-height']]
  ]) {
    for (const property of properties) minimumPixels(selector, property, 44);
  }

  minimumPixels('.terminal-mobile-select', 'min-height', 44);
  assert.equal(effectiveCssDeclarations(styles, '.terminal-mobile-select', phone)['font-size'], '16px');

  for (const pointer of ['fine', 'coarse']) {
    for (const selector of ['.action-button', '.primary-button', '.layout-button', '.tool-tab']) {
      minimumPixels(selector, 'min-height', 44, { width: 390, pointer });
      minimumPixels(selector, 'font-size', 11, { width: 390, pointer });
    }
  }
});

test('square controls preserve 44px touch targets in portrait and landscape phone layouts', async () => {
  const styles = await uiSource('styles.css');
  const phoneLayouts = [
    { label: 'portrait', viewport: { width: 390, height: 844, pointer: 'fine' } },
    { label: 'short landscape', viewport: { width: 844, height: 390, pointer: 'coarse' } }
  ];
  const squareControlSelectors = [
    '.icon-button',
    '.tool-button',
    '.terminal-tab > button',
    '.terminal-control',
    '.terminal-command-bar button',
    '.terminal-picker-bar button',
    '.terminal-signal-bar button',
    '.notice-dismiss',
    '.drawer-close',
    '.session-pin'
  ];

  for (const { label, viewport } of phoneLayouts) {
    for (const selector of squareControlSelectors) {
      const declarations = effectiveCssDeclarations(styles, selector, viewport);
      for (const [property, dimension] of [['min-width', 'narrow'], ['min-height', 'short']]) {
        const value = declarations[property];
        assert.match(value || '', /^\d+(?:\.\d+)?px$/, `${selector} has no ${property} in ${label}`);
        assert.ok(Number.parseFloat(value) >= 44, `${selector} is too ${dimension} in ${label}`);
      }
    }
  }
});

test('component-specific rules cannot shrink mobile actions below the shared touch target', async () => {
  const styles = await uiSource('styles.css');
  const phoneLayouts = [
    { label: 'portrait', viewport: { width: 390, height: 844, pointer: 'fine' } },
    { label: 'short landscape', viewport: { width: 844, height: 390, pointer: 'coarse' } }
  ];

  for (const { label, viewport } of phoneLayouts) {
    for (const selector of componentSpecificTouchSelectors) {
      const declarations = effectiveCssDeclarations(styles, selector, viewport);
      assert.equal(declarations['min-height'], '44px', `${selector} is not touch-sized in ${label}`);
      assert.equal(declarations['touch-action'], 'manipulation', `${selector} delays touch handling in ${label}`);
    }
  }
});

test('coarse-pointer navigation and terminal usage remain touch-sized beyond portrait breakpoints', async () => {
  const styles = await uiSource('styles.css');
  const touchLayouts = [
    { label: 'short landscape', viewport: { width: 844, height: 390, pointer: 'coarse' } },
    { label: 'touch tablet', viewport: { width: 1024, height: 768, pointer: 'coarse' } }
  ];

  for (const { label, viewport } of touchLayouts) {
    for (const selector of ['.tab', '.session-filter', '.prompt-history-origin-filter', '.terminal-header-usage']) {
      const declarations = effectiveCssDeclarations(styles, selector, viewport);
      for (const property of ['min-width', 'min-height']) {
        const value = declarations[property];
        assert.match(value || '', /^\d+(?:\.\d+)?px$/, `${selector} has no ${property} in ${label}`);
        assert.ok(Number.parseFloat(value) >= 44, `${selector} ${property} is below 44px in ${label}`);
      }
    }
  }
});

test('dynamically rendered artifact, attention, and disclosure controls remain touch-sized', async () => {
  const styles = await uiSource('styles.css');
  const touchLayouts = [
    { label: 'portrait phone', viewport: { width: 390, height: 844, pointer: 'coarse' } },
    { label: 'short landscape phone', viewport: { width: 844, height: 390, pointer: 'coarse' } }
  ];

  for (const { label, viewport } of touchLayouts) {
    for (const selector of ['.project-artifact-row', '.inspector-attention-item', 'details > summary']) {
      const declarations = effectiveCssDeclarations(styles, selector, viewport);
      for (const property of ['min-width', 'min-height']) {
        const value = declarations[property];
        assert.match(value || '', /^\d+(?:\.\d+)?px$/, `${selector} has no ${property} in ${label}`);
        assert.ok(Number.parseFloat(value) >= 44, `${selector} ${property} is below 44px in ${label}`);
      }
      assert.equal(declarations['touch-action'], 'manipulation', `${selector} has delayed touch handling in ${label}`);
    }
  }
});

test('dynamic Project Desk and attention labels stay readable on phones without inflating desktop density', async () => {
  const styles = await uiSource('styles.css');
  const phoneLayouts = [
    { label: 'portrait phone', viewport: { width: 390, height: 844, pointer: 'coarse' } },
    { label: 'short landscape phone', viewport: { width: 844, height: 390, pointer: 'coarse' } }
  ];
  const mobileFontMinimums = new Map([
    ['.project-artifact-row strong', 12],
    ['.project-artifact-row small', 11],
    ['.project-artifact-action', 11],
    ['.inspector-attention-item strong', 12],
    ['.inspector-attention-item span', 11],
    ['.project-card-head p', 10],
    ['.project-card-head > span', 10],
    ['.project-context-state', 10],
    ['.project-facts dt', 10],
    ['.project-detail-row code', 10],
    ['.project-instruction code', 10],
    ['.project-detail-row small', 10],
    ['.project-card-copy span', 10],
    ['.project-instruction p', 10],
    ['.snippet-tools > label', 10],
    ['.scratchpad-actions span', 10],
    ['.scratchpad-review-actions span', 10]
  ]);

  for (const { label, viewport } of phoneLayouts) {
    for (const [selector, minimum] of mobileFontMinimums) {
      const value = effectiveCssDeclarations(styles, selector, viewport)['font-size'];
      assert.match(value || '', /^\d+(?:\.\d+)?px$/, `${selector} has no font-size in ${label}`);
      assert.ok(Number.parseFloat(value) >= minimum, `${selector} is below ${minimum}px in ${label}`);
    }
  }

  const desktop = { width: 1024, height: 768, pointer: 'fine' };
  assert.equal(effectiveCssDeclarations(styles, '.project-artifact-row strong', desktop)['font-size'], '10px');
  assert.equal(effectiveCssDeclarations(styles, '.project-artifact-row small', desktop)['font-size'], '9px');
  assert.equal(effectiveCssDeclarations(styles, '.inspector-attention-item strong', desktop)['font-size'], '10px');
  assert.equal(effectiveCssDeclarations(styles, '.inspector-attention-item span', desktop)['font-size'], '9px');
  assert.equal(effectiveCssDeclarations(styles, '.project-facts dt', desktop)['font-size'], '8px');
  assert.equal(effectiveCssDeclarations(styles, '.snippet-tools > label', desktop)['font-size'], '8px');
});

test('touch layouts disable terminal dragging chrome without removing fine-pointer desktop movement', async () => {
  const styles = await uiSource('styles.css');
  const touchLayouts = [
    { label: 'portrait', viewport: { width: 390, height: 844, pointer: 'fine' } },
    { label: 'short landscape', viewport: { width: 844, height: 390, pointer: 'coarse' } }
  ];

  for (const { label, viewport } of touchLayouts) {
    const header = effectiveCssDeclarations(styles, '.terminal-header', viewport);
    assert.equal(
      effectiveCssDeclarations(styles, '.terminal-resize-handle', viewport).display,
      'none',
      `${label} exposes a tiny terminal resize target`
    );
    assert.equal(header.cursor, 'default', `${label} still advertises desktop dragging`);
    assert.equal(header['touch-action'], 'manipulation', `${label} blocks normal touch panning`);
  }
  const desktopViewport = { width: 1024, height: 768, pointer: 'fine' };
  assert.equal(effectiveCssDeclarations(styles, '.terminal-resize-handle', desktopViewport).display, 'block');
  const desktopHeader = effectiveCssDeclarations(styles, '.terminal-header', desktopViewport);
  assert.equal(desktopHeader.cursor, 'grab');
  assert.equal(desktopHeader['touch-action'], 'none');
});

test('coarse-phone editors remain protected from focus zoom in portrait and landscape', async () => {
  const styles = await uiSource('styles.css');
  const phoneOrientations = [
    { label: 'portrait', viewport: { width: 390, pointer: 'coarse' } },
    { label: 'landscape', viewport: { width: 844, pointer: 'coarse' } }
  ];

  for (const { label, viewport } of phoneOrientations) {
    for (const selector of zoomSafeEditorSelectors) {
      assert.equal(
        effectiveCssDeclarations(styles, selector, viewport)['font-size'],
        '16px',
        `${selector} can trigger focus zoom in ${label}`
      );
    }
  }
});

test('phone search and form controls retain touch-sized heights in both orientations', async () => {
  const styles = await uiSource('styles.css');
  const phoneOrientations = [
    { label: 'portrait', viewport: { width: 390, height: 844, pointer: 'coarse' } },
    { label: 'landscape', viewport: { width: 844, height: 390, pointer: 'coarse' } }
  ];

  for (const { label, viewport } of phoneOrientations) {
    for (const selector of touchSizedEditorSelectors) {
      const value = effectiveCssDeclarations(styles, selector, viewport)['min-height'];
      assert.match(value || '', /^\d+(?:\.\d+)?px$/, `${selector} has no minimum height in ${label}`);
      assert.ok(Number.parseFloat(value) >= 44, `${selector} is below 44px in ${label}`);
    }
  }
});

test('Delivery Run QA remains single-column, touch-sized, and zoom-safe on phones', async () => {
  const styles = await uiSource('styles.css');
  const phoneLayouts = [
    { label: 'portrait', viewport: { width: 390, height: 844, pointer: 'coarse' } },
    { label: 'short landscape', viewport: { width: 844, height: 390, pointer: 'coarse' } }
  ];

  for (const { label, viewport } of phoneLayouts) {
    assert.equal(
      effectiveCssDeclarations(styles, '.delivery-run-criteria fieldset', viewport)['grid-template-columns'],
      'minmax(0, 1fr)',
      `${label} QA criteria are not single-column`
    );
    for (const selector of [
      '.delivery-run-verification-form :is(select, textarea)',
      '.delivery-run-verification-actions button',
      '.delivery-run-task-actions button',
      '.delivery-run-reconcile button'
    ]) {
      assert.equal(effectiveCssDeclarations(styles, selector, viewport)['min-height'], '44px', `${selector} is not touch-sized in ${label}`);
    }
    assert.equal(
      effectiveCssDeclarations(styles, '.delivery-run-verification-form :is(select, textarea)', viewport)['font-size'],
      '16px',
      `${label} QA controls can trigger focus zoom`
    );
  }
});

test('Planning Run review stays single-column, readable, and touch-sized on phones', async () => {
  const [styles, app] = await Promise.all([uiSource('styles.css'), uiSource('app.js')]);
  const phoneLayouts = [
    { label: 'portrait', viewport: { width: 390, height: 844, pointer: 'coarse' } },
    { label: 'short landscape', viewport: { width: 844, height: 390, pointer: 'coarse' } }
  ];

  for (const { label, viewport } of phoneLayouts) {
    for (const selector of [
      '.planning-run-empty',
      '.planning-role-grid',
      '.planning-candidate-columns',
      '.planning-run-findings'
    ]) {
      assert.equal(
        effectiveCssDeclarations(styles, selector, viewport)['grid-template-columns'],
        'minmax(0, 1fr)',
        `${selector} is not single-column in ${label}`
      );
    }
    assert.equal(effectiveCssDeclarations(styles, '.planning-run-head', viewport).display, 'grid', `${label} planning header is not stacked`);
    assert.equal(
      effectiveCssDeclarations(styles, '.planning-worker-identity', viewport)['grid-template-columns'],
      'minmax(0, 1fr)',
      `${label} worker identity is not single-column`
    );
    assert.equal(effectiveCssDeclarations(styles, '.planning-worker-identity', viewport)['overflow-wrap'], 'anywhere');
    assert.equal(effectiveCssDeclarations(styles, '.planning-candidate-change pre', viewport)['overflow-x'], 'auto');
    assert.equal(effectiveCssDeclarations(styles, '.planning-run-actions > .planning-run-recovery-note', viewport)['font-size'], '10px');
    assert.equal(effectiveCssDeclarations(styles, '.planning-run-terminate', viewport)['flex-direction'], 'column');
    assert.equal(effectiveCssDeclarations(styles, '.aap-conversation > header', viewport).display, 'grid');
    assert.equal(effectiveCssDeclarations(styles, '.aap-chat-message', viewport).width, '100%');
    assert.equal(effectiveCssDeclarations(styles, '.aap-workshop-message-form textarea', viewport)['font-size'], '16px');
    for (const selector of ['.planning-run-actions button', '.planning-run-terminate button', '.planning-run-empty button', '.aap-workshop-message-form button']) {
      assert.equal(effectiveCssDeclarations(styles, selector, viewport)['min-height'], '44px', `${selector} is not touch-sized in ${label}`);
      assert.equal(effectiveCssDeclarations(styles, selector, viewport)['touch-action'], 'manipulation', `${selector} blocks normal touch behavior in ${label}`);
    }
  }
  assert.match(app, /class="action-button danger" data-action="planning-run-cancel"/);
  assert.match(app, /class="planning-run-terminate"[\s\S]*data-action="planning-run-terminate-provisional-worker"/);
  assert.doesNotMatch(app, /data-action="planning-run-continue"[^>]*>Terminate stuck planning worker/);
  assert.match(app, /data-planning-continue-kind="\$\{escapeHtml\(continueKind\)\}"/);
});

test('New Agent uses safe-area sheet controls in portrait and short landscape phone layouts', async () => {
  const styles = await uiSource('styles.css');
  const phoneLayouts = [
    { label: 'portrait', viewport: { width: 390, height: 844, pointer: 'coarse' } },
    { label: 'short landscape', viewport: { width: 844, height: 390, pointer: 'coarse' } }
  ];

  for (const { label, viewport } of phoneLayouts) {
    const panel = effectiveCssDeclarations(styles, '.new-agent-container .new-agent-panel[open]', viewport);
    const actions = effectiveCssDeclarations(styles, '.new-agent-container .new-agent-panel[open] .launcher-actions', viewport);
    assert.deepEqual(
      {
        inset: panel.inset,
        width: panel.width,
        maxHeight: panel['max-height'],
        transform: panel.transform
      },
      {
        inset: 'max(7px, env(safe-area-inset-top)) max(7px, env(safe-area-inset-right)) max(7px, env(safe-area-inset-bottom)) max(7px, env(safe-area-inset-left))',
        width: 'auto',
        maxHeight: 'none',
        transform: 'none'
      },
      `${label} launcher does not stay inside the safe viewport`
    );
    assert.equal(actions.display, 'grid', `${label} launcher actions are not touch-friendly`);
    assert.equal(actions['grid-template-columns'], 'repeat(2, minmax(0, 1fr))');
    assert.equal(
      effectiveCssDeclarations(styles, '.new-agent-container .launcher-shortcut', viewport).display,
      'none',
      `${label} launcher still shows a desktop-only shortcut`
    );
  }
});

test('the compact-phone cascade preserves actions without wrapping topbar chrome', async () => {
  const styles = await uiSource('styles.css');
  const compactPhone = { width: 360, pointer: 'coarse' };
  const declarations = (selector) => effectiveCssDeclarations(styles, selector, compactPhone);

  assert.equal(declarations('.topbar .eyebrow').display, 'none');
  assert.equal(declarations('.topbar p').display, 'none');
  assert.deepEqual(
    {
      gap: declarations('.topbar').gap,
      paddingInline: declarations('.topbar')['padding-inline'],
      actionGap: declarations('.topbar-actions').gap
    },
    { gap: '6px', paddingInline: '8px', actionGap: '4px' }
  );
  assert.deepEqual(
    {
      overflow: declarations('.topbar h2').overflow,
      fontSize: declarations('.topbar h2')['font-size'],
      textOverflow: declarations('.topbar h2')['text-overflow'],
      whiteSpace: declarations('.topbar h2')['white-space']
    },
    { overflow: 'hidden', fontSize: '14px', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
  );
  assert.equal(declarations('.connection-pill').width, '40px');
  assert.equal(declarations('.topbar-actions .action-button.new-agent-action').width, '44px');
  assert.equal(declarations('.topbar .icon-button').width, '44px');
  assert.equal(declarations('.shortcut-help-button').display, 'none');
});

test('short-landscape phones hide keyboard-only navigation and search chrome', async () => {
  const styles = await uiSource('styles.css');
  const shortLandscapePhone = { width: 844, height: 390, pointer: 'coarse' };
  const desktop = { width: 1024, height: 768, pointer: 'fine' };
  const phoneDeclarations = (selector) => effectiveCssDeclarations(styles, selector, shortLandscapePhone);
  const desktopDeclarations = (selector) => effectiveCssDeclarations(styles, selector, desktop);

  assert.equal(phoneDeclarations('.primary-nav .tab')['padding-right'], '6px');
  assert.equal(phoneDeclarations('.primary-nav .tab::after').display, 'none');
  assert.equal(phoneDeclarations('.session-search input')['padding-right'], '10px');
  assert.equal(phoneDeclarations('.session-search-shortcut').display, 'none');
  assert.equal(phoneDeclarations('.shortcut-help-button').display, 'none');
  assert.equal(phoneDeclarations('.prompt-queue-input-meta kbd').display, 'none');

  assert.equal(desktopDeclarations('.primary-nav .tab')['padding-right'], '48px');
  assert.notEqual(desktopDeclarations('.primary-nav .tab::after').display, 'none');
  assert.equal(desktopDeclarations('.session-search input')['padding-right'], '52px');
  assert.notEqual(desktopDeclarations('.shortcut-help-button').display, 'none');
  assert.notEqual(desktopDeclarations('.prompt-queue-input-meta kbd').display, 'none');
});

test('short-landscape phone workspace respects every safe-area edge', async () => {
  const styles = await uiSource('styles.css');
  const shortLandscapePhone = { width: 844, height: 390, pointer: 'coarse' };
  const desktop = { width: 1024, height: 768, pointer: 'fine' };

  assert.equal(
    effectiveCssDeclarations(styles, '.app-shell', shortLandscapePhone).padding,
    'max(7px, env(safe-area-inset-top)) max(7px, env(safe-area-inset-right)) max(7px, env(safe-area-inset-bottom)) max(7px, env(safe-area-inset-left))'
  );
  assert.equal(effectiveCssDeclarations(styles, '.app-shell', desktop).padding, '10px');
});

test('the 320px terminal chrome preserves a flexible title and reachable labeled controls', async () => {
  const styles = await uiSource('styles.css');
  const compactPhone = { width: 320, pointer: 'coarse' };
  const declarations = (selector) => effectiveCssDeclarations(styles, selector, compactPhone);

  assert.equal(declarations('.terminal-heading')['min-width'], '0');
  assert.equal(declarations('.terminal-window-actions').gap, '4px');
  assert.equal(declarations('.terminal-model-control').display, 'none');
  assert.equal(declarations('.terminal-maximize').display, 'none');
  assert.deepEqual(
    {
      toolsDisplay: declarations('.terminal-tools-toggle:not(.hidden)').display,
      toolsMinWidth: declarations('.terminal-tools-toggle:not(.hidden)')['min-width'],
      backDisplay: declarations('.terminal-minimize').display,
      backMinWidth: declarations('.terminal-minimize')['min-width'],
      labelDisplay: declarations('.terminal-control-label-mobile').display
    },
    {
      toolsDisplay: 'inline-flex',
      toolsMinWidth: '56px',
      backDisplay: 'inline-flex',
      backMinWidth: '56px',
      labelDisplay: 'inline'
    }
  );
  assert.deepEqual(
    {
      columns: declarations('.terminal-mobile-switcher:not(.hidden)')['grid-template-columns'],
      minHeight: declarations('.terminal-mobile-switcher:not(.hidden)')['min-height'],
      selectFontSize: declarations('.terminal-mobile-select')['font-size'],
      selectTextAlign: declarations('.terminal-mobile-select')['text-align-last']
    },
    {
      columns: '52px minmax(0, 1fr) 52px',
      minHeight: '46px',
      selectFontSize: '16px',
      selectTextAlign: 'center'
    }
  );
});

test('mobile telemetry summary and expanded details remain readable at each phone layout', async () => {
  const styles = await uiSource('styles.css');
  const compactPhone = { width: 320, height: 700, pointer: 'coarse' };
  const standardPhone = { width: 390, height: 844, pointer: 'coarse' };
  const landscapePhone = { width: 844, height: 390, pointer: 'coarse' };

  assert.equal(
    effectiveCssDeclarations(styles, '.terminal-mobile-telemetry:not(.hidden)', compactPhone)['grid-template-columns'],
    'repeat(2, minmax(0, 1fr))'
  );
  assert.equal(
    effectiveCssDeclarations(styles, '.terminal-mobile-telemetry:not(.hidden)', standardPhone)['grid-template-columns'],
    'repeat(4, minmax(0, 1fr))'
  );
  assert.equal(
    effectiveCssDeclarations(styles, '.terminal-telemetry-grid', standardPhone)['grid-template-columns'],
    'repeat(2, minmax(0, 1fr))'
  );
  assert.equal(
    effectiveCssDeclarations(styles, '.terminal-telemetry-grid', landscapePhone)['grid-template-columns'],
    'repeat(4, minmax(0, 1fr))'
  );

  for (const [selector, minimum] of [
    ['.terminal-mobile-telemetry small', 9],
    ['.terminal-mobile-telemetry strong', 11],
    ['.terminal-mobile-telemetry-foot', 10]
  ]) {
    for (const [label, viewport] of [['compact phone', compactPhone], ['standard phone', standardPhone]]) {
      const value = effectiveCssDeclarations(styles, selector, viewport)['font-size'];
      assert.match(value || '', /^\d+(?:\.\d+)?px$/, `${selector} has no font-size on ${label}`);
      assert.ok(Number.parseFloat(value) >= minimum, `${selector} is below ${minimum}px on ${label}`);
    }
  }

  for (const [selector, minimum] of [
    ['.terminal-telemetry-grid span', 10],
    ['.terminal-telemetry-grid strong', 11],
    ['.terminal-telemetry-grid small', 10],
    ['.terminal-telemetry-note', 10],
    ['.terminal-telemetry-pending', 10]
  ]) {
    for (const [label, viewport] of [['standard phone', standardPhone], ['short landscape phone', landscapePhone]]) {
      const value = effectiveCssDeclarations(styles, selector, viewport)['font-size'];
      assert.match(value || '', /^\d+(?:\.\d+)?px$/, `${selector} has no font-size on ${label}`);
      assert.ok(Number.parseFloat(value) >= minimum, `${selector} is below ${minimum}px on ${label}`);
    }
  }
});

test('short landscape touch uses one full-screen terminal with direct switching', async () => {
  const styles = await uiSource('styles.css');
  const landscapePhone = { width: 844, height: 390, pointer: 'coarse' };
  const declarations = (selector) => effectiveCssDeclarations(styles, selector, landscapePhone);
  const terminal = declarations('.terminal-window');

  assert.deepEqual(
    {
      left: terminal.left,
      top: terminal.top,
      right: terminal.right,
      bottom: terminal.bottom,
      width: terminal.width,
      height: terminal.height,
      minWidth: terminal['min-width'],
      minHeight: terminal['min-height'],
      maxWidth: terminal['max-width'],
      maxHeight: terminal['max-height']
    },
    {
      left: 'max(6px, env(safe-area-inset-left))',
      top: 'max(6px, env(safe-area-inset-top))',
      right: 'max(6px, env(safe-area-inset-right))',
      bottom: 'max(6px, env(safe-area-inset-bottom))',
      width: 'auto',
      height: 'auto',
      minWidth: '0',
      minHeight: '0',
      maxWidth: 'none',
      maxHeight: 'none'
    }
  );
  assert.equal(declarations('.terminal-window.is-layout-hidden').display, 'none');
  assert.equal(declarations('.terminal-mobile-switcher:not(.hidden)').display, 'grid');
  assert.equal(declarations('.terminal-mobile-switcher:not(.hidden)')['grid-template-columns'], '52px minmax(0, 1fr) 52px');
  assert.equal(declarations('.terminal-maximize').display, 'none');
  assert.equal(declarations('.terminal-model-control').display, 'none');
  assert.equal(declarations('.terminal-tools-toggle:not(.hidden)').display, 'inline-flex');
  assert.equal(declarations('.terminal-minimize').display, 'inline-flex');
  assert.equal(declarations('.terminal-control-label-mobile').display, 'inline');
  assert.deepEqual(
    {
      display: declarations('.terminal-command-bar').display,
      overflowX: declarations('.terminal-command-bar')['overflow-x'],
      overflowY: declarations('.terminal-command-bar')['overflow-y']
    },
    { display: 'grid', overflowX: 'hidden', overflowY: 'auto' }
  );
  assert.equal(
    declarations('.terminal-command-bar > span.terminal-tool-group')['grid-template-columns'],
    'repeat(3, minmax(0, 1fr))'
  );
  assert.equal(declarations('.terminal-command-bar .terminal-tool-group > button')['min-height'], '44px');
  assert.equal(declarations('.terminal-tool-group-label').display, 'block');
});

test('Prompt Queue keeps single-target mobile controls in portrait and short landscape', async () => {
  const styles = await uiSource('styles.css');
  const phoneLayouts = [
    { label: 'portrait', viewport: { width: 390, height: 844, pointer: 'coarse' } },
    { label: 'short landscape', viewport: { width: 844, height: 390, pointer: 'coarse' } }
  ];

  for (const { label, viewport } of phoneLayouts) {
    assert.equal(
      effectiveCssDeclarations(styles, '.prompt-target-mobile-picker:not(.hidden)', viewport).display,
      'grid',
      `${label} hides the single-target picker`
    );
    assert.equal(
      effectiveCssDeclarations(styles, '.prompt-target-grid', viewport)['grid-auto-flow'],
      'column',
      `${label} does not preserve the swipeable target rail`
    );
    assert.equal(
      effectiveCssDeclarations(styles, '.prompt-target-desktop-actions', viewport).display,
      'none',
      `${label} exposes desktop bulk selection by default`
    );
    assert.equal(
      effectiveCssDeclarations(styles, '.prompt-target-mobile-actions', viewport).display,
      'grid',
      `${label} hides the explicit multi-select control`
    );
  }

  const desktop = { width: 1024, height: 768, pointer: 'fine' };
  assert.equal(effectiveCssDeclarations(styles, '.prompt-target-mobile-picker:not(.hidden)', desktop).display, undefined);
  assert.equal(effectiveCssDeclarations(styles, '.prompt-target-desktop-actions', desktop).display, 'flex');
});

test('Recurring schedule details stay readable and use phone-sized fact rows', async () => {
  const styles = await uiSource('styles.css');
  const portrait = { width: 390, height: 844, pointer: 'coarse' };
  const landscape = { width: 844, height: 390, pointer: 'coarse' };
  const desktop = { width: 1024, height: 768, pointer: 'fine' };
  const selectors = [
    '.prompt-queue-schedule-field > span',
    '.prompt-queue-schedule-field > small',
    '.prompt-schedule-paused-head p',
    '.prompt-schedule-cron small',
    '.prompt-schedule-facts b',
    '.prompt-schedule-facts small',
    '.prompt-schedule-pending',
    '.prompt-schedule-card .status'
  ];

  for (const [label, viewport] of [['portrait', portrait], ['short landscape', landscape]]) {
    for (const selector of selectors) {
      assert.equal(
        effectiveCssDeclarations(styles, selector, viewport)['font-size'],
        '10px',
        `${selector} is unreadable in ${label}`
      );
    }
  }

  assert.equal(
    effectiveCssDeclarations(styles, '.prompt-schedule-facts', portrait)['grid-template-columns'],
    'repeat(2, minmax(0, 1fr))'
  );
  assert.equal(
    effectiveCssDeclarations(styles, '.prompt-schedule-facts', landscape)['grid-template-columns'],
    'repeat(4, minmax(0, 1fr))'
  );
  assert.equal(
    effectiveCssDeclarations(styles, '.prompt-schedule-facts', desktop)['grid-template-columns'],
    'repeat(4, minmax(0, 1fr))'
  );
  assert.equal(effectiveCssDeclarations(styles, '.prompt-schedule-facts b', desktop)['font-size'], '8px');
  assert.equal(effectiveCssDeclarations(styles, '.prompt-schedule-pending', desktop)['font-size'], '9px');
});

test('Idea Queue keeps decision copy readable and prioritizes approval on phones', async () => {
  const styles = await uiSource('styles.css');
  const portrait = { width: 390, height: 844, pointer: 'coarse' };
  const landscape = { width: 844, height: 390, pointer: 'coarse' };
  const desktop = { width: 1024, height: 768, pointer: 'fine' };

  for (const [label, viewport] of [['portrait', portrait], ['short landscape', landscape]]) {
    for (const selector of ['.idea-refinement strong', '.idea-card-actions > span', '.idea-agent-format code']) {
      assert.equal(
        effectiveCssDeclarations(styles, selector, viewport)['font-size'],
        '10px',
        `${selector} is unreadable in ${label}`
      );
    }
  }

  const actions = effectiveCssDeclarations(styles, '.idea-card-actions', portrait);
  const actionButton = effectiveCssDeclarations(styles, '.idea-card-actions .action-button', portrait);
  assert.deepEqual(
    { display: actions.display, columns: actions['grid-template-columns'], alignItems: actions['align-items'] },
    { display: 'grid', columns: 'repeat(2, minmax(0, 1fr))', alignItems: 'stretch' }
  );
  assert.equal(effectiveCssDeclarations(styles, '.idea-card-actions > span', portrait)['grid-column'], '1 / -1');
  assert.equal(
    effectiveCssDeclarations(styles, '.idea-card-actions [data-action="idea-approve"]', portrait)['grid-column'],
    '1 / -1'
  );
  assert.deepEqual(
    { minWidth: actionButton['min-width'], minHeight: actionButton['min-height'] },
    { minWidth: '0', minHeight: '44px' }
  );
  assert.equal(effectiveCssDeclarations(styles, '.status', portrait)['font-size'], '10px');
  assert.equal(effectiveCssDeclarations(styles, '.status', landscape)['font-size'], '11px');
  assert.equal(effectiveCssDeclarations(styles, '.idea-card-actions', landscape).display, 'flex');
  assert.equal(effectiveCssDeclarations(styles, '.idea-card-actions', desktop).display, 'flex');
  assert.equal(effectiveCssDeclarations(styles, '.idea-refinement strong', desktop)['font-size'], '9px');
});

test('Queue section navigation matches its five destinations and stays touchable in both phone orientations', async () => {
  const [styles, app] = await Promise.all([uiSource('styles.css'), uiSource('app.js')]);
  const sections = [...app.matchAll(/data-action="prompt-queue-jump" data-queue-section="([^"]+)"/g)]
    .map((match) => match[1]);
  const desktopNav = effectiveCssDeclarations(styles, '.prompt-queue-jump-nav', { width: 1024, pointer: 'fine' });
  const portrait = { width: 390, height: 844, pointer: 'coarse' };
  const landscape = { width: 844, height: 390, pointer: 'coarse' };
  const phoneNav = effectiveCssDeclarations(styles, '.prompt-queue-jump-nav', portrait);
  const phoneButton = effectiveCssDeclarations(styles, '.prompt-queue-jump-nav button', portrait);
  const landscapeNav = effectiveCssDeclarations(styles, '.prompt-queue-jump-nav', landscape);
  const landscapeButton = effectiveCssDeclarations(styles, '.prompt-queue-jump-nav button', landscape);

  assert.deepEqual(sections, ['compose', 'ideas', 'active', 'schedules', 'history']);
  assert.equal(desktopNav['grid-template-columns'], `repeat(${sections.length}, minmax(0, 1fr))`);
  assert.deepEqual(
    {
      display: phoneNav.display,
      overflowX: phoneNav['overflow-x'],
      overscroll: phoneNav['overscroll-behavior-inline'],
      snap: phoneNav['scroll-snap-type']
    },
    { display: 'flex', overflowX: 'auto', overscroll: 'contain', snap: 'inline proximity' }
  );
  assert.deepEqual(
    {
      flex: phoneButton.flex,
      minHeight: phoneButton['min-height'],
      snap: phoneButton['scroll-snap-align'],
      touchAction: phoneButton['touch-action']
    },
    { flex: '1 0 84px', minHeight: '44px', snap: 'start', touchAction: 'manipulation' }
  );
  assert.equal(landscapeNav['grid-template-columns'], `repeat(${sections.length}, minmax(0, 1fr))`);
  assert.deepEqual(
    { minHeight: landscapeButton['min-height'], touchAction: landscapeButton['touch-action'] },
    { minHeight: '44px', touchAction: 'manipulation' }
  );
});

test('SDLC role workflow becomes a readable single-column planning session on phones', async () => {
  const styles = await uiSource('styles.css');
  const desktopWorkshop = effectiveCssDeclarations(styles, '.aap-workshop-loop', { width: 1280, pointer: 'fine' });
  const landscapeWorkshop = effectiveCssDeclarations(styles, '.aap-workshop-loop', { width: 844, height: 390, pointer: 'coarse' });
  const portraitView = effectiveCssDeclarations(styles, '#sdlc-view.active.sdlc-workspace-view', { width: 390, height: 844, pointer: 'coarse' });
  const portraitStage = effectiveCssDeclarations(styles, '.sdlc-stage-track', { width: 390, height: 844, pointer: 'coarse' });
  const portraitWorkshop = effectiveCssDeclarations(styles, '.aap-workshop-loop', { width: 390, height: 844, pointer: 'coarse' });
  const portraitCenter = effectiveCssDeclarations(styles, '.aap-workshop-center', { width: 390, height: 844, pointer: 'coarse' });

  assert.equal(desktopWorkshop['grid-template-columns'], 'minmax(0, 1fr) minmax(220px, 0.82fr) minmax(0, 1fr)');
  assert.equal(landscapeWorkshop['grid-template-columns'], 'minmax(0, 1fr)');
  assert.deepEqual(
    { height: portraitView.height, maxWidth: portraitView['max-width'], overflowX: portraitView['overflow-x'], overflowY: portraitView['overflow-y'] },
    { height: 'auto', maxWidth: '100%', overflowX: 'clip', overflowY: 'visible' }
  );
  assert.equal(portraitStage['grid-template-columns'], 'minmax(0, 1fr)');
  assert.equal(portraitWorkshop['grid-template-columns'], 'minmax(0, 1fr)');
  assert.equal(portraitWorkshop['grid-template-areas'], '"center" "role1" "role2" "role3" "role4" "cycle"');
  assert.equal(portraitCenter['border-radius'], '16px');
  assert.equal(effectiveCssDeclarations(styles, '.delivery-plan-guided-create-form .aap-conversation-prompt textarea', { width: 390, height: 844, pointer: 'coarse' })['font-size'], '16px');
  for (const viewport of [
    { width: 320, height: 568, pointer: 'coarse' },
    { width: 390, height: 844, pointer: 'coarse' },
    { width: 844, height: 390, pointer: 'coarse' }
  ]) {
    const view = effectiveCssDeclarations(styles, '#sdlc-view.active.sdlc-workspace-view', viewport);
    const consoleLayout = effectiveCssDeclarations(styles, '.sdlc-console', viewport);
    const form = effectiveCssDeclarations(styles, '.delivery-plan-guided-create-form', viewport);
    assert.equal(view.height, 'auto');
    assert.equal(view['max-width'], '100%');
    assert.equal(view['overflow-y'], 'visible');
    assert.equal(consoleLayout.width, '100%');
    assert.equal(consoleLayout['max-width'], '100%');
    assert.equal(consoleLayout.overflow, 'clip');
    assert.equal(form.width, '100%');
    assert.equal(form['max-width'], '100%');
    assert.equal(effectiveCssDeclarations(styles, '.delivery-plan-counts', viewport).display, 'none');
    assert.equal(effectiveCssDeclarations(styles, '.delivery-plan-guided-actions button', viewport).width, '100%');
  }
  for (const selector of ['.sdlc-next-action button', '.delivery-plan-guided-create-form input', '.delivery-plan-guided-create-form select', '.delivery-plan-guided-create-form textarea', '.delivery-plan-guided-create-form button']) {
    assert.equal(effectiveCssDeclarations(styles, selector, { width: 390, height: 844, pointer: 'coarse' })['min-height'], '44px', `${selector} is not touch sized`);
  }
});

test('Code City remains selectable, readable, and touch-sized in both phone orientations', async () => {
  const styles = await uiSource('styles.css');
  for (const viewport of [
    { width: 390, height: 844, pointer: 'coarse' },
    { width: 844, height: 390, pointer: 'coarse' }
  ]) {
    assert.equal(effectiveCssDeclarations(styles, '.code-city-picker', viewport)['grid-template-columns'], 'minmax(0, 1fr)');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-picker select', viewport)['font-size'], '16px');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-picker select', viewport)['min-height'], '44px');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-zoom button', viewport)['min-height'], '44px');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-zoom .code-city-fit', viewport)['min-width'], '48px');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-building', viewport)['touch-action'], 'manipulation');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-scene', viewport)['min-width'], '0');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-stage', viewport)['max-height'], '62dvh');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-stage', viewport)['touch-action'], 'none');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-content', viewport)['grid-template-columns'], 'minmax(0, 1fr)');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-detail', viewport)['max-height'], '58dvh');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-detail', viewport).overflow, 'auto');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-analysis-grid', viewport).display, 'flex');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-analysis-grid', viewport)['overflow-x'], 'auto');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-analysis-grid button', viewport)['min-height'], '44px');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-mode-tabs', viewport).display, 'flex');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-mode-tabs', viewport)['overflow-x'], 'auto');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-mode-tabs button', viewport)['min-height'], '48px');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-filter-bar', viewport)['grid-template-columns'], 'minmax(0, 1fr) minmax(0, 1fr)');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-filter-bar input', viewport)['min-height'], '44px');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-neighbor-toggle', viewport)['min-height'], '44px');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-mode-insight > div', viewport).display, 'flex');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-mode-insight button', viewport)['min-height'], '44px');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-file-flows li button', viewport)['min-height'], '44px');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-pathway-direction details button', viewport)['min-height'], '44px');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-atlas-grid', viewport)['grid-template-columns'], 'minmax(0, 1fr)');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-atlas-summary', viewport)['grid-template-columns'], 'repeat(2, minmax(0, 1fr))');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-street-directory', viewport)['grid-template-columns'], 'minmax(0, 1fr)');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-street-directory button', viewport)['min-height'], '44px');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-module-directory', viewport)['grid-template-columns'], 'minmax(0, 1fr)');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-module-directory button', viewport)['min-height'], '44px');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-worksite > header', viewport)['flex-direction'], 'column');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-worksite > header > button', viewport)['min-height'], '44px');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-builder-roster', viewport)['grid-template-columns'], 'minmax(0, 1fr)');
    assert.equal(effectiveCssDeclarations(styles, '.code-city-worksite > footer', viewport)['grid-template-columns'], 'minmax(0, 1fr)');
  }
});

test('critical operational labels remain readable in both phone orientations', async () => {
  const styles = await uiSource('styles.css');
  const phoneLayouts = [
    { label: 'portrait', viewport: { width: 390, height: 844, pointer: 'coarse' } },
    { label: 'short landscape', viewport: { width: 844, height: 390, pointer: 'coarse' } }
  ];
  const selectors = [
    '.prompt-queue-jump-nav button',
    '.prompt-queue-jump-nav em',
    '.prompt-queue-counter',
    '.prompt-history-origin-filter em',
    '.prompt-history-origin',
    '.prompt-history-request b',
    '.prompt-history-finish > strong',
    '.prompt-history-meta small',
    '.prompt-history-unavailable',
    '.prompt-target-metrics span',
    '.prompt-target-card-head em',
    '.prompt-target-session',
    '.prompt-target-foot',
    '.terminal-capture-paused',
    '.terminal-header-status',
    '.terminal-header-usage',
    '.terminal-draft-state'
  ];

  for (const { label, viewport } of phoneLayouts) {
    for (const selector of selectors) {
      const value = effectiveCssDeclarations(styles, selector, viewport)['font-size'];
      assert.match(value || '', /^\d+(?:\.\d+)?px$/, `${selector} has no fixed readable size in ${label}`);
      assert.ok(Number.parseFloat(value) >= 10, `${selector} is below 10px in ${label}`);
    }
  }
});

test('Tools navigation matches its five panels and remains reachable in both phone orientations', async () => {
  const [styles, index, app] = await Promise.all([
    uiSource('styles.css'),
    uiSource('index.html'),
    uiSource('app.js')
  ]);
  const views = [...index.matchAll(/data-action="tool-view" data-tool-view="([^"]+)"/g)]
    .map((match) => match[1]);
  const desktopNav = effectiveCssDeclarations(styles, '.tool-tabs', { width: 1024, pointer: 'fine' });
  const phoneLayouts = [
    { label: 'portrait', viewport: { width: 390, height: 844, pointer: 'coarse' } },
    { label: 'short landscape', viewport: { width: 844, height: 390, pointer: 'coarse' } }
  ];

  assert.deepEqual(views, ['overview', 'usage', 'services', 'security', 'system']);
  assert.equal(desktopNav['grid-template-columns'], `repeat(${views.length}, minmax(0, 1fr))`);
  for (const { label, viewport } of phoneLayouts) {
    const drawer = effectiveCssDeclarations(styles, '.control-drawer', viewport);
    const close = effectiveCssDeclarations(styles, '.drawer-close', viewport);
    const phoneNav = effectiveCssDeclarations(styles, '.tool-tabs', viewport);
    const phoneTab = effectiveCssDeclarations(styles, '.tool-tab', viewport);
    assert.deepEqual(
      { left: drawer.left, width: drawer.width },
      { left: '0', width: '100vw' },
      `${label} Tools drawer does not use the reachable viewport`
    );
    assert.deepEqual(
      { width: close.width, height: close.height },
      { width: '44px', height: '44px' },
      `${label} Tools close target is undersized`
    );
    assert.deepEqual(
      { display: phoneNav.display, overflowX: phoneNav['overflow-x'], snap: phoneNav['scroll-snap-type'] },
      { display: 'flex', overflowX: 'auto', snap: 'inline proximity' }
    );
    assert.deepEqual(
      { flex: phoneTab.flex, minHeight: phoneTab['min-height'], snap: phoneTab['scroll-snap-align'] },
      { flex: '0 0 96px', minHeight: '44px', snap: 'start' }
    );
  }
  assert.match(app, /function openToolView[\s\S]*revealHorizontalItem\(activeTab\?\.parentElement, activeTab\)/);
});

test('Tools operational readouts stay readable on phones without inflating desktop density', async () => {
  const styles = await uiSource('styles.css');
  const phoneLayouts = [
    { label: 'portrait', viewport: { width: 390, height: 844, pointer: 'coarse' } },
    { label: 'short landscape', viewport: { width: 844, height: 390, pointer: 'coarse' } }
  ];
  const selectors = [
    '.tool-summary-card span',
    '.tool-summary-card small',
    '.usage-summary-card span',
    '.usage-agent-row span',
    '.usage-summary-card small',
    '.usage-agent-row small',
    '.usage-day-row small',
    '.network-metrics span',
    '.network-event small',
    '.app-port',
    '.host-listener-copy > small',
    '.host-process-row small',
    '.host-audit-row small',
    '.host-process-metrics',
    '.host-audit-row > details p'
  ];

  for (const { label, viewport } of phoneLayouts) {
    for (const selector of selectors) {
      assert.equal(
        effectiveCssDeclarations(styles, selector, viewport)['font-size'],
        '10px',
        `${selector} is unreadable in ${label}`
      );
    }
  }

  const desktop = { width: 1024, height: 768, pointer: 'fine' };
  assert.equal(effectiveCssDeclarations(styles, '.tool-summary-card small', desktop)['font-size'], '9px');
  assert.equal(effectiveCssDeclarations(styles, '.network-event small', desktop)['font-size'], '9px');
  assert.equal(effectiveCssDeclarations(styles, '.host-audit-row small', desktop)['font-size'], '9px');
});

test('Session filters match their four states and reveal a restored phone filter', async () => {
  const [styles, index, app] = await Promise.all([
    uiSource('styles.css'),
    uiSource('index.html'),
    uiSource('app.js')
  ]);
  const filters = [...index.matchAll(/data-action="session-filter" data-filter="([^"]+)"/g)]
    .map((match) => match[1]);
  const phoneFilters = effectiveCssDeclarations(styles, '.session-filters', { width: 390, pointer: 'coarse' });
  const phoneFilter = effectiveCssDeclarations(styles, '.session-filter', { width: 390, pointer: 'coarse' });

  assert.deepEqual(filters, ['all', 'needs', 'active', 'idle']);
  assert.deepEqual(
    {
      display: phoneFilters.display,
      overflowX: phoneFilters['overflow-x'],
      overscroll: phoneFilters['overscroll-behavior-inline'],
      snap: phoneFilters['scroll-snap-type']
    },
    { display: 'flex', overflowX: 'auto', overscroll: 'contain', snap: 'inline proximity' }
  );
  assert.deepEqual(
    { flex: phoneFilter.flex, minHeight: phoneFilter['min-height'], snap: phoneFilter['scroll-snap-align'] },
    { flex: '1 0 74px', minHeight: '44px', snap: 'start' }
  );
  assert.match(
    app,
    /function revealActiveSessionFilter\(\)[\s\S]*sessionFilterRevealKey[\s\S]*revealHorizontalItem\(activeFilter\?\.parentElement, activeFilter\)/
  );
  assert.match(app, /function filterSessionRail[\s\S]*renderSessionFilterChrome\(\);\s*revealActiveSessionFilter\(\);/);
  assert.match(app, /function handleTerminalViewportResize[\s\S]*renderTerminalChrome\(\);\s*revealActiveSessionFilter\(\);/);
});

test('Session rail state cues stay readable on phones without widening desktop rows', async () => {
  const styles = await uiSource('styles.css');
  const phoneLayouts = [
    { label: 'portrait', viewport: { width: 390, height: 844, pointer: 'coarse' } },
    { label: 'short landscape', viewport: { width: 844, height: 390, pointer: 'coarse' } }
  ];
  const selectors = [
    '.session-filter em',
    '.session-copy small',
    '.session-copy em',
    '.session-signal',
    '.session-attention'
  ];

  for (const { label, viewport } of phoneLayouts) {
    for (const selector of selectors) {
      assert.equal(
        effectiveCssDeclarations(styles, selector, viewport)['font-size'],
        '10px',
        `${selector} is unreadable in ${label}`
      );
    }
  }

  const desktop = { width: 1024, height: 768, pointer: 'fine' };
  assert.equal(effectiveCssDeclarations(styles, '.session-filter em', desktop)['font-size'], '9px');
  assert.equal(effectiveCssDeclarations(styles, '.session-copy small', desktop)['font-size'], '9px');
  assert.equal(effectiveCssDeclarations(styles, '.session-copy em', desktop)['font-size'], '9px');
  assert.equal(effectiveCssDeclarations(styles, '.session-signal', desktop)['font-size'], '8px');
  assert.equal(effectiveCssDeclarations(styles, '.session-attention', desktop)['font-size'], '9px');
});

test('the stylesheet has no exact duplicate rules inside one cascade scope', async () => {
  const styles = await uiSource('styles.css');
  assert.deepEqual(exactDuplicateCssRules(styles), []);
});
