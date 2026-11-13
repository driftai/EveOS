'use strict';
const assert = require('node:assert/strict');

// Regresses a *connected* iframe, song cards, selected UI and navigation after
// AudioFlix's full rerender path. The fixture uses a real browser context: a
// detached HTML string check alone cannot prove iframe lifecycle continuity.
async function testPianoRetention(browser, retentionSource, uiSource, retentionCss = '') {
  assert(uiSource.includes('EveAudioflixPianoRetain?.patch?.(overlay, markup, activeTab)'),
    'AudioFlix full rerender must invoke Piano retention before replacing overlay HTML');
  const page = await browser.newPage();
  try {
    await page.goto('about:blank');
    await page.setContent(`<main id="overlay" class="audioflix-overlay"><div class="audioflix-panel" data-af-tab="piano" role="dialog">
      <header class="audioflix-header">Piano header</header><nav class="audioflix-tabs">Piano selected</nav>
      <div class="audioflix-settings-drawer">Settings</div><div class="audioflix-routing-drawer">Routing</div>
      <div class="audioflix-content"><section class="audioflix-piano" data-audioflix-piano data-running="true">
        <iframe data-piano-frame srcdoc="<!doctype html><html><body>live player</body></html>"></iframe>
        <div data-piano-frontend><article class="piano-frontend-song" data-song-id="one">Song One</article>
          <input data-piano-search value="my focus"></div></section></div>
      <div class="audioflix-modal-host"></div></div></main>`);
    await page.addStyleTag({ content: retentionCss });
    await page.addScriptTag({ content: retentionSource });
    await page.waitForFunction(() => document.querySelector('[data-piano-frame]')?.contentDocument?.readyState === 'complete');
    await page.evaluate(() => {
      window.__originalFrame = document.querySelector('[data-piano-frame]');
      window.__originalWindow = window.__originalFrame.contentWindow;
      window.__originalWindow.__playbackContinuity = 'still-running';
      window.__originalCard = document.querySelector('.piano-frontend-song');
      window.__originalCanvas = document.querySelector('[data-piano-frontend]');
      window.__originalFrame.addEventListener('load', () => { window.__reloadCount = (window.__reloadCount || 0) + 1; });
      window.__createAudioflix = (tab, iteration = 0) => `<div class="audioflix-panel" data-af-tab="${tab}" role="dialog">
        <header class="audioflix-header">Header ${iteration}</header><nav class="audioflix-tabs">${tab} active</nav>
        <div class="audioflix-settings-drawer">Settings ${iteration}</div><div class="audioflix-routing-drawer">Routing ${iteration}</div>
        <div class="audioflix-content">${tab === 'piano' ? '<div data-audioflix-piano>new iframe should NEVER mount</div>' : `<section class="other-tab" data-view="${tab}">${tab} content ${iteration}</section>`}</div>
        <div class="audioflix-modal-host">Modal ${iteration}</div></div>`;
    });
    // 20 tab changes, including repeated full renders while hidden.
    for (let i = 0; i < 20; i++) {
      const tab = i % 5 === 4 ? 'piano' : ['music', 'soundboard', 'soundlab', 'router'][i % 4];
      const check = await page.evaluate(({ tab, iteration }) => {
        const overlay = document.querySelector('#overlay');
        const result = window.EveAudioflixPianoRetain.patch(overlay, window.__createAudioflix(tab, iteration), tab);
        const retained = document.querySelector('[data-audioflix-piano]');
        const frame = document.querySelector('[data-piano-frame]');
        return {
          result, tab, panelTab: document.querySelector('.audioflix-panel')?.dataset.afTab,
          frameRetained: frame === window.__originalFrame,
          windowRetained: frame?.contentWindow === window.__originalWindow,
          playback: frame?.contentWindow?.__playbackContinuity,
          canvasRetained: document.querySelector('[data-piano-frontend]') === window.__originalCanvas,
          cardRetained: document.querySelector('.piano-frontend-song') === window.__originalCard,
          search: document.querySelector('[data-piano-search]')?.value,
          connected: retained?.isConnected, hidden: retained?.hidden,
          backgroundHost: retained?.classList.contains('is-background-playback-host'),
          rendered: getComputedStyle(retained).display !== 'none',
          offscreen: retained.getBoundingClientRect().right < 0,
          foreignVisible: !!document.querySelector(`[data-view="${tab}"]`),
          header: document.querySelector('.audioflix-header')?.textContent,
          frameCount: document.querySelectorAll('[data-piano-frame]').length
        };
      }, { tab, iteration: i });
      assert.equal(check.result, true);
      assert.equal(check.panelTab, tab);
      assert.equal(check.frameRetained, true, 'Piano iframe element must remain identical');
      assert.equal(check.windowRetained, true, 'Piano iframe browsing context must remain identical');
      assert.equal(check.playback, 'still-running', 'Piano iframe runtime state must not restart');
      assert.equal(check.canvasRetained, true, 'Piano frontend canvas must survive tab switches');
      assert.equal(check.cardRetained, true, 'song cards must never be recreated on tab switch');
      assert.equal(check.search, 'my focus', 'library search focus state must survive');
      assert.equal(check.connected, true, 'iframe must remain connected even when hidden');
      assert.equal(check.hidden, false, 'live Piano owner must remain rendered in background tabs');
      assert.equal(check.backgroundHost, tab !== 'piano');
      assert.equal(check.rendered, true, 'Piano must remain eligible for browser scheduling');
      assert.equal(check.offscreen, tab !== 'piano', 'hidden Piano must be rendered offscreen, not display:none');
      assert.equal(check.foreignVisible, tab !== 'piano', 'other AudioFlix tabs must still render');
      assert.equal(check.header, `Header ${i}`, 'ordinary AudioFlix controls must still rerender');
      assert.equal(check.frameCount, 1, 'only one live Piano iframe may exist');
    }
    assert.equal(await page.evaluate(() => window.__reloadCount || 0), 0,
      'tab switches must not trigger an iframe load event');
    const parked = await page.evaluate(() => {
      const overlay = document.querySelector('#overlay');
      const result = window.EveAudioflixPianoRetain.parkOverlay(overlay);
      const state = { result, hidden: overlay.hidden,
        parked: overlay.classList.contains('is-background-playback-host') };
      window.EveAudioflixPianoRetain.restoreOverlay(overlay);
      state.restored = !overlay.classList.contains('is-background-playback-host') && overlay.inert === false;
      return state;
    });
    assert.deepEqual(parked, { result: true, hidden: false, parked: true, restored: true },
      'closing Audioflix parks the active Piano owner instead of suspending its iframe');
    const failure = await page.evaluate(() => {
      const overlay = document.querySelector('#overlay');
      try { window.EveAudioflixPianoRetain.patch(overlay, '<div class="unrecognized"></div>', 'music'); return false; }
      catch (error) { return error.message.includes('refusing to unload'); }
    });
    assert.equal(failure, true, 'structural mismatch must fail closed without unloading Piano');
    assert.equal(await page.evaluate(() => document.querySelector('[data-piano-frame]') === window.__originalFrame), true);
    console.log('PIANO_FRONTEND_TAB_RETENTION_PASS repeated=20 iframe=STABLE playback=CONTINUOUS cards=STABLE');
  } finally { await page.close(); }
}

module.exports = { testPianoRetention };
