import { URL } from 'node:url';
import { isPublicHttpUrl } from './public-url.js';

const HLS_RE = /\.m3u8(?:$|[?#])/i;
const VIDEO_RE = /\.(?:mp4|webm|ogg|mov)(?:$|[?#])/i;
const TEXT_RE = /\.(?:vtt|srt)(?:$|[?#])/i;
const SAFE_PAGE_PROTOCOLS = new Set(['http:', 'https:']);
const MIRURO_SERVERS = new Map([
  ['kiwi', 'kiwi'], ['pewe', 'pewe'], ['bee', 'bee'], ['be', 'bee'],
  ['bonk', 'bonk'], ['bun', 'bun'], ['ally', 'ally'], ['nun', 'nun'],
  ['twin', 'twin'], ['cog', 'cog'], ['moo', 'moo'], ['hop', 'hop'], ['telli', 'telli']
]);

export function classifyMediaUrl(input) {
  const value = String(input || '').trim();
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!SAFE_PAGE_PROTOCOLS.has(url.protocol) || url.username || url.password) return null;
  if (HLS_RE.test(url.href)) return { kind: 'hls', url: url.href };
  if (VIDEO_RE.test(url.href)) return { kind: 'file', url: url.href };
  return { kind: 'page', url: url.href };
}

export function normalizeCapturedMedia(url, extra = {}) {
  const parsed = classifyMediaUrl(url);
  if (!parsed || parsed.kind === 'page') return null;
  const label = cleanLabel(extra.label);
  return {
    url: parsed.url,
    type: parsed.kind,
    quality: extra.quality || inferQuality(label || parsed.url),
    server: normalizeServerName(extra.server) || inferServer(parsed.url),
    provider: normalizeServerName(extra.provider) || extra.provider || null,
    label,
    title: extra.title || null,
    audio: normalizeAudio(extra.audio) || inferAudio(label),
    subtitles: Array.isArray(extra.subtitles) ? extra.subtitles : [],
    referer: extra.referer || null
  };
}

function normalizeAudio(value) {
  const lower = String(value || '').trim().toLowerCase();
  if (/\b(?:dub|dubbed|english)\b/.test(lower)) return 'dub';
  if (/\b(?:sub|subbed|subtitle)\b/.test(lower)) return 'sub';
  return null;
}

function normalizeServerName(value) {
  const raw = cleanLabel(value).toLowerCase();
  if (!raw) return null;
  if (MIRURO_SERVERS.has(raw)) return MIRURO_SERVERS.get(raw);
  const token = raw.match(/\b(?:kiwi|pewe|bee|be|bonk|bun|ally|nun|twin|cog|moo|hop|telli)\b/)?.[0];
  return token ? MIRURO_SERVERS.get(token) : cleanLabel(value);
}

function looksLikeVideoRequest(request, contentType = '') {
  const url = request.url();
  const type = String(request.resourceType() || '');
  return HLS_RE.test(url) || VIDEO_RE.test(url) || /(?:mpegurl|application\/x-mpegurl|video\/)/i.test(contentType) || type === 'media';
}

function looksLikeSubtitleRequest(request, contentType = '') {
  const url = request.url();
  const type = String(request.resourceType() || '');
  return TEXT_RE.test(url) || /text\/vtt|application\/x-subrip|subrip/i.test(contentType) || type === 'texttrack';
}

function inferServer(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

function inferAudio(text) {
  return normalizeAudio(text);
}

function inferQuality(text) {
  return String(text || '').match(/\b(2160p|1440p|1080p|720p|576p|480p|360p)\b/i)?.[1] || null;
}

function cleanLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function isCdnHostname(s) {
  return !s || s.includes('.') || /^(?:s[0-9]+\.|www\.)/i.test(s);
}

function mergeCandidate(existing, normalized) {
  if (!existing) return normalized;
  const preferredServer = isCdnHostname(existing.server) && !isCdnHostname(normalized.server)
    ? normalized.server
    : (isCdnHostname(normalized.server) && !isCdnHostname(existing.server) ? existing.server : (normalized.server || existing.server));
  return {
    ...existing,
    ...normalized,
    server: preferredServer,
    provider: normalized.provider || existing.provider || preferredServer,
    label: normalized.label || existing.label,
    quality: normalized.quality || existing.quality,
    audio: normalized.audio || existing.audio,
    subtitles: existing.subtitles?.length ? existing.subtitles : normalized.subtitles
  };
}

async function inspectPageMetadata(page) {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('button,[role="button"],a,select option,[data-server],[data-source],[data-provider],[data-quality],[data-audio],[class*="item"],[class*="trigger"]'));
    const buttons = nodes.map(node => ({
      text: (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim(),
      aria: String(node.getAttribute('aria-label') || '').trim(),
      title: String(node.getAttribute('title') || '').trim(),
      server: String(node.getAttribute('data-server') || node.getAttribute('data-source') || '').trim(),
      provider: String(node.getAttribute('data-provider') || '').trim(),
      quality: String(node.getAttribute('data-quality') || '').trim(),
      audio: String(node.getAttribute('data-audio') || '').trim(),
      active: node.getAttribute('aria-selected') === 'true' || node.getAttribute('aria-pressed') === 'true' || node.getAttribute('data-state') === 'active' || node.classList.contains('active') || node.classList.contains('selected') || node.classList.contains('current') || /itemActive/i.test(node.className),
      href: String(node.getAttribute('href') || '').trim()
    })).filter(item => item.text || item.aria || item.title || item.server || item.provider || item.quality || item.audio || item.href);

    const providerTrigger = document.querySelector('button[aria-label="Provider"], [class*="trigger"][aria-label*="Provider"]');
    const languageTrigger = document.querySelector('button[aria-label="Language"], [class*="trigger"][aria-label*="Language"]');
    const activeProvider = providerTrigger ? (providerTrigger.innerText || providerTrigger.textContent || '').trim() : '';
    const activeLanguage = languageTrigger ? (languageTrigger.innerText || languageTrigger.textContent || '').trim() : '';

    const tracks = Array.from(document.querySelectorAll('track')).map(node => ({
      file: node.src,
      label: node.label || node.srclang || 'English'
    })).filter(item => item.file);
    const media = Array.from(document.querySelectorAll('video,source')).map(node => node.currentSrc || node.src).filter(Boolean);
    return { title: document.title || '', text: document.body?.innerText || '', buttons, tracks, media, activeProvider, activeLanguage };
  });
}

function visibleLabel(item) {
  if (!item) return '';
  return cleanLabel(item.text || item.aria || item.title || item.provider || item.server);
}

function metadataContext(meta, fallback = {}) {
  const controls = meta.buttons || [];
  const activeLang = normalizeAudio(meta.activeLanguage);
  const active = controls.find(item => item.active && normalizeAudio(item.audio || visibleLabel(item)));
  const explicit = controls.find(item => normalizeAudio(item.audio || visibleLabel(item)));
  const audio = activeLang || (active ? normalizeAudio(active.audio || visibleLabel(active)) : null) || (explicit ? normalizeAudio(explicit.audio || visibleLabel(explicit)) : null) || fallback.audio || null;
  const activeProv = normalizeServerName(meta.activeProvider);
  const server = activeProv || fallback.server || null;
  return { ...fallback, audio, server, provider: server };
}

function classifyControls(meta) {
  const controls = [];
  const seen = new Set();
  for (const item of meta.buttons || []) {
    const label = visibleLabel(item);
    if (!label) continue;
    const audio = normalizeAudio(item.audio || label);
    const serverName = normalizeServerName(item.server || item.provider || label);
    const isServer = MIRURO_SERVERS.has(String(serverName || '').toLowerCase());
    const isAudio = !!audio;
    const isOtherControl = /\b(?:server|source|mirror|stream|play|watch)\b/i.test(label);

    if (isAudio && !seen.has('audio:' + label.toLowerCase())) {
      seen.add('audio:' + label.toLowerCase());
      controls.push({ kind: 'audio', label, audio, server: serverName, provider: serverName, quality: item.quality || inferQuality(label) || null });
    }
    if (isServer && !seen.has('server:' + label.toLowerCase())) {
      seen.add('server:' + label.toLowerCase());
      controls.push({ kind: 'server', label, audio, server: serverName, provider: serverName, quality: item.quality || inferQuality(label) || null });
    }
    if (!isAudio && !isServer && isOtherControl && !seen.has('other:' + label.toLowerCase())) {
      seen.add('other:' + label.toLowerCase());
      controls.push({ kind: 'server', label, audio: null, server: null, provider: null, quality: item.quality || inferQuality(label) || null });
    }
  }
  return controls;
}

async function exploratoryClick(page, label, kind = '') {
  try {
    if (kind === 'server') {
      const trigger = page.locator('button[aria-label="Provider"], button[class*="trigger"]').first();
      if (await trigger.count()) await trigger.click({ timeout: 1000, force: true }).catch(() => {});
    } else if (kind === 'audio') {
      const trigger = page.locator('button[aria-label="Language"], button[class*="trigger"]').first();
      if (await trigger.count()) await trigger.click({ timeout: 1000, force: true }).catch(() => {});
    }
    const locator = page.locator('button, [role="button"], a, option, [data-server], [data-source], [data-provider], [class*="item"], span').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`, 'i') }).first();
    await locator.click({ timeout: 2000, force: true });
    await page.waitForTimeout(750);
    return true;
  } catch { return false; }
}

export async function resolveMediaPage(pageUrl, options = {}) {
  const timeoutMs = Math.max(3000, Math.min(30000, Number(options.timeoutMs) || 12000));
  const maxResults = Math.max(1, Math.min(20, Number(options.maxResults) || 12));
  let playwright;
  try { playwright = await import('playwright'); }
  catch { return { ok: false, code: 'PLAYWRIGHT_UNAVAILABLE', message: 'Media page inspection requires Playwright on the host. Install project dependencies first.' }; }

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36' });
  const page = await context.newPage();
  const allowLocal = !!options.allowLocal || process.env.ALLOW_LOCAL_RESOLVER_FIXTURE === '1';
  await page.route('**/*', async route => {
    const target = route.request().url();
    try {
      const parsed = new URL(target);
      if (!SAFE_PAGE_PROTOCOLS.has(parsed.protocol)) return route.continue();
      if (!allowLocal && !await isPublicHttpUrl(parsed)) return route.abort('blockedbyclient');
      return route.continue();
    } catch { return route.abort('blockedbyclient'); }
  });

  const candidates = new Map();
  const subtitles = new Map();
  let captureContext = {};

  const add = (url, extra = {}) => {
    const normalized = normalizeCapturedMedia(url, {
      ...captureContext,
      ...extra,
      referer: extra.referer || pageUrl
    });
    if (!normalized) return;
    candidates.set(normalized.url, mergeCandidate(candidates.get(normalized.url), normalized));
  };

  const addSubtitle = (url, label = 'English') => {
    try {
      const parsed = new URL(url);
      if (!SAFE_PAGE_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password) return;
      subtitles.set(parsed.href, { file: parsed.href, label: cleanLabel(label) || 'English' });
    } catch {}
  };

  page.on('request', request => {
    if (looksLikeVideoRequest(request)) add(request.url());
    else if (looksLikeSubtitleRequest(request)) addSubtitle(request.url());
  });
  page.on('response', response => {
    const contentType = String(response.headers()['content-type'] || '');
    const request = response.request();
    if (looksLikeVideoRequest(request, contentType)) add(response.url());
    else if (looksLikeSubtitleRequest(request, contentType)) addSubtitle(response.url());
  });

  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 6000) }).catch(() => {});
    await page.waitForTimeout(1200);

    let meta = await inspectPageMetadata(page);
    const pageTitle = cleanLabel(meta.title);
    const initialLang = normalizeAudio(meta.activeLanguage) || 'sub';
    const initialProv = normalizeServerName(meta.activeProvider) || 'bee';
    captureContext = { title: pageTitle, audio: initialLang, server: initialProv, provider: initialProv };
    for (const track of meta.tracks) addSubtitle(track.file, track.label);
    for (const url of meta.media) add(url, { title: pageTitle, audio: initialLang, server: initialProv, subtitles: [...subtitles.values()] });

    const controls = classifyControls(meta);
    const audioControls = controls.filter(item => item.kind === 'audio').slice(0, 2);
    const serverControls = controls.filter(item => item.kind === 'server').slice(0, 16);
    const audioPasses = audioControls.length ? audioControls : [{ audio: initialLang, label: '' }];

    for (const audioControl of audioPasses) {
      if (audioControl.label) await exploratoryClick(page, audioControl.label, 'audio');
      meta = await inspectPageMetadata(page);
      const currentLang = audioControl.audio || normalizeAudio(meta.activeLanguage) || captureContext.audio || 'sub';
      const currentProv = normalizeServerName(meta.activeProvider) || captureContext.server || 'bee';
      captureContext = {
        title: pageTitle,
        audio: currentLang,
        server: currentProv,
        provider: currentProv
      };
      for (const track of meta.tracks) addSubtitle(track.file, track.label);
      for (const url of meta.media) add(url, { title: pageTitle, audio: currentLang, server: currentProv, subtitles: [...subtitles.values()] });

      const refreshedServers = classifyControls(meta).filter(item => item.kind === 'server');
      const passes = (refreshedServers.length ? refreshedServers : serverControls).slice(0, 16);
      for (const serverControl of passes) {
        const before = new Set(candidates.keys());
        captureContext = { ...captureContext, server: serverControl.server, provider: serverControl.provider || serverControl.server, quality: serverControl.quality, label: serverControl.label };
        if (!await exploratoryClick(page, serverControl.label, 'server')) continue;
        meta = await inspectPageMetadata(page);
        for (const track of meta.tracks) addSubtitle(track.file, track.label);
        for (const url of meta.media) add(url, { title: pageTitle, audio: currentLang, server: serverControl.server, subtitles: [...subtitles.values()] });
        for (const [url, item] of candidates) {
          if (before.has(url)) continue;
          candidates.set(url, mergeCandidate(item, {
            ...item,
            server: serverControl.server,
            provider: serverControl.provider || serverControl.server,
            audio: currentLang,
            quality: serverControl.quality || item.quality,
            label: serverControl.label
          }));
        }
      }
    }

    for (const item of candidates.values()) {
      item.title ||= pageTitle || null;
      item.audio = normalizeAudio(item.audio) || 'sub';
      item.quality ||= inferQuality(item.url);
      item.subtitles = item.subtitles?.length ? item.subtitles : [...subtitles.values()];
      if (isCdnHostname(item.server)) {
        item.server = item.audio === 'dub' ? 'pewe' : 'bee';
      } else {
        item.server = normalizeServerName(item.server) || inferServer(item.url);
      }
      item.provider = normalizeServerName(item.provider) || item.server || null;
    }

    const results = [...candidates.values()].slice(0, maxResults);
    return {
      ok: results.length > 0,
      pageUrl,
      title: pageTitle,
      audio: captureContext.audio || null,
      results,
      message: results.length
        ? `Discovered ${results.length} playable media source${results.length === 1 ? '' : 's'} from the host browser session.`
        : 'No directly playable media URL was observed from the page session. The site may require a protected, encrypted, credentialed, or otherwise non-browser-visible source.'
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
