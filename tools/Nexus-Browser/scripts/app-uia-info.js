'use strict';

const winapp = require('../app-targets/winapp-runner');
const uia = require('../app-targets/chatgpt-windows-uia');

function parseArgs(argv = process.argv.slice(2)) {
  const out = { app: '', contains: [], includeOffscreen: false, depth: 12, max: 120 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--app') out.app = String(argv[++i] || '');
    else if (arg === '--contains') out.contains.push(String(argv[++i] || ''));
    else if (arg === '--include-offscreen') out.includeOffscreen = true;
    else if (arg === '--depth') out.depth = Math.max(1, Number(argv[++i] || 12) || 12);
    else if (arg === '--max') out.max = Math.max(1, Number(argv[++i] || 120) || 120);
  }
  return out;
}

function chooseWindow(windows = [], query = '') {
  const needle = String(query || '').toLowerCase();
  return [...windows].filter(Boolean).sort((a, b) => {
    const ta = String(a.title || a.name || '').toLowerCase();
    const tb = String(b.title || b.name || '').toLowerCase();
    const ma = needle && ta.includes(needle) ? 1 : 0;
    const mb = needle && tb.includes(needle) ? 1 : 0;
    if (ma !== mb) return mb - ma;
    return uia.windowArea(b) - uia.windowArea(a);
  })[0] || null;
}

function summarize({ windowInfo, json, contains = [], includeOffscreen = false, max = 120 }) {
  const elements = uia.flattenElements(json);
  const inspectedWindow = uia.windowsFromEnvelope(json)[0] || {};
  const frameInfo = uia.authoritativeWindowFrame(windowInfo, inspectedWindow, elements);
  const needles = contains.map((value) => value.toLowerCase()).filter(Boolean);
  const nodes = [];
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    if (!includeOffscreen && (element.isOffscreen === true || uia.propertyText(element, 'IsOffscreen') === 'True')) continue;
    const text = uia.normalizeCandidate(uia.textOf(element));
    if (!text) continue;
    if (needles.length && !needles.some((needle) => text.toLowerCase().includes(needle))) continue;
    const geometry = uia.relativeGeometry(element, frameInfo);
    nodes.push({
      index,
      type: uia.controlType(element),
      text,
      selector: uia.selectorOf(element),
      offscreen: element.isOffscreen === true,
      rect: geometry.rect,
      xRatio: geometry.xRatio,
      yRatio: geometry.yRatio,
      widthRatio: geometry.widthRatio,
      heightRatio: geometry.heightRatio
    });
    if (nodes.length >= max) break;
  }
  return {
    window: {
      hwnd: uia.hwndOf(frameInfo),
      pid: uia.pidOf(frameInfo),
      title: String(frameInfo.title || frameInfo.name || ''),
      frame: uia.windowRect(frameInfo)
    },
    elementCount: elements.length,
    filters: { contains, includeOffscreen, max },
    nodes
  };
}

async function main() {
  const options = parseArgs();
  if (!options.app) throw new Error('Usage: node scripts/app-uia-info.js --app <window title/process query> [--contains text] [--include-offscreen]');
  const helper = await winapp.availability();
  if (!helper.available) throw new Error('winapp helper is unavailable.');
  const listed = await winapp.runJson(['ui', 'list-windows', '-a', options.app], { timeoutMs: 7000 });
  const windowInfo = chooseWindow(uia.windowsFromEnvelope(listed.json), options.app);
  if (!windowInfo) throw new Error('No matching application window found for: ' + options.app);
  const hwnd = uia.hwndOf(windowInfo);
  const args = ['ui', 'inspect', '-w', String(hwnd), '--depth', String(options.depth)];
  if (!options.includeOffscreen) args.push('--hide-offscreen');
  const inspected = await winapp.runJson(args, { timeoutMs: 12000 });
  process.stdout.write(JSON.stringify(summarize({
    windowInfo,
    json: inspected.json,
    contains: options.contains,
    includeOffscreen: options.includeOffscreen,
    max: options.max
  }), null, 2) + '\n');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message, code: error.code || 'APP_UIA_INFO_FAILED' }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, chooseWindow, summarize };
