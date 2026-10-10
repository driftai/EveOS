'use strict';

// Deterministic Playwright/engine stand-ins shared by the managed Spotify lifecycle smokes.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const never = () => new Promise(() => {});
const EMBED = 'https://open.spotify.com/embed/track/';

function fakeEngine(initial = {}) {
    const st = { generation: 1, spotifyId: 'aaa', status: 'loaded', playRequested: false,
        paused: true, currentTime: 0, ...initial };
    const engine = {
        ready: true, st, commands: [], acks: [],
        snapshot: () => ({ ...st }),
        command(action, data = {}) {
            engine.commands.push(action);
            if (action === 'load') Object.assign(st, { generation: data.generation, spotifyId: data.spotifyId,
                status: 'loaded', playRequested: false });
            if (action === 'play') Object.assign(st, { playRequested: true, status: 'starting' });
            if (action === 'pause') Object.assign(st, { playRequested: false, status: 'paused' });
            return { ...st };
        },
        acknowledgeMediaSeek(target) { engine.acks.push(target); return { ...st }; },
        quiesce({ generation }) {
            if (Number(generation) !== st.generation) return { ...st, quiesced: false };
            return { ...engine.command('pause'), quiesced: true };
        }
    };
    return engine;
}

function fakeButton(hooks = {}) {
    const button = {
        clicks: 0,
        getAttribute: async name => (name === 'aria-label' ? 'Play' : name === 'data-testid' ? 'play-pause-button' : ''),
        innerText: async () => '',
        isVisible: async () => { if (hooks.onVisible) await hooks.onVisible(); return true; },
        click: async (opts = {}) => {
            await actionable(hooks.clickDelay, opts.timeout);
            button.clicks += 1; if (hooks.onClick) await hooks.onClick();
        },
        dispatchEvent: async (_type, _init, opts = {}) => {
            await actionable(hooks.dispatchDelay, opts.timeout);
            button.clicks += 1; button.dispatches = (button.dispatches || 0) + 1;
        }
    };
    return button;
}

// Mirrors Playwright: an action waits for actionability up to its timeout, then either lands
// or throws a TimeoutError without mutating. Timeout 0/undefined means Playwright's default (30s).
async function actionable(delayMs = 0, timeoutMs) {
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000;
    if (Number(delayMs) > limit) {
        await sleep(limit);
        const error = new Error(`Timeout ${limit}ms exceeded.`); error.name = 'TimeoutError'; throw error;
    }
    await sleep(Number(delayMs) || 0);
}

function fakePage(engine, frames = []) {
    const page = {
        closed: false,
        isClosed: () => page.closed,
        frames: () => frames,
        waitForFunction: async () => true,
        evaluate: async (fn, arg) => { global.window = { EveAudioflixSpotifyEngine: engine }; return fn(arg); }
    };
    return page;
}

function fakeFrame(id, button, seek) {
    return {
        url: () => `${EMBED}${id}`,
        locator: (selector) => {
            if (selector === 'body') return { count: async () => 1, hover: async () => {} };
            return { count: async () => (button ? 1 : 0), nth: () => button, first: () => button };
        },
        evaluate: async (fn, arg) => (seek ? seek(arg) : null)
    };
}

function options(page, extra = {}) {
    const notes = [];
    return {
        notes,
        page, runtime: { playbackKickCount: 0, lastPlaybackKickAt: 0 },
        spotifySnapshots: async () => [], isSpotifyEmbedUrl: url => String(url).startsWith(EMBED),
        normalizeTrackId: value => String(value || ''), note: (kind, message) => notes.push([kind, message]),
        ...extra
    };
}

module.exports = { sleep, never, EMBED, fakeEngine, fakeButton, actionable, fakePage, fakeFrame, options };
