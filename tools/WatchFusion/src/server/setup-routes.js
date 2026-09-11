import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { PROJECT_ROOT, NUVIO_ROOT, NUVIO_DIST, VOXELVISION_ROOT } from './config.js';
import { json, readBody } from './http-utils.js';
import { isNuvioBuilt, mergedNuvioConfig } from './nuvio-config.js';

const MODEL_PROFILES = Object.freeze([
  { key: 'enhanced', name: 'Depth Anything V3 Small', id: 'en970/depth-anything-v3-small-onnx', mode: 'browser-cache' },
  { key: 'balanced', name: 'Depth Anything V2 Small', id: 'onnx-community/depth-anything-v2-small-ONNX', mode: 'browser-cache' },
  { key: 'anime-mask', name: 'IS-Net Anime foreground mask', id: 'skytnt/anime-seg', mode: 'browser-cache', optional: true }
]);

let activeInstall = null;

function exists(...parts) {
  return fs.existsSync(path.join(...parts));
}

function isLoopback(req) {
  const raw = String(req.socket?.remoteAddress || '').toLowerCase();
  return raw === '127.0.0.1' || raw === '::1' || raw === '::ffff:127.0.0.1';
}

function commandWorks(command, args = []) {
  try {
    const result = spawnSync(command, args, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      stdio: 'ignore'
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function youtubeToolsStatus() {
  const tools = path.join(VOXELVISION_ROOT, 'tools');
  const localYtDlp = path.join(tools, 'yt-dlp.exe');
  const localFfmpeg = path.join(tools, 'ffmpeg.exe');
  const localFfprobe = path.join(tools, 'ffprobe.exe');
  const ytDlpReady = exists(localYtDlp) && commandWorks(localYtDlp, ['--version']);
  const ffmpegReady = exists(localFfmpeg) && commandWorks(localFfmpeg, ['-version']);
  const ffprobeReady = exists(localFfprobe) && commandWorks(localFfprobe, ['-version']);
  return {
    ytDlp: { ready: ytDlpReady, provider: ytDlpReady ? 'portable' : 'missing' },
    ffmpeg: { ready: ffmpegReady, provider: ffmpegReady ? 'portable' : 'missing' },
    ffprobe: { ready: ffprobeReady, provider: ffprobeReady ? 'portable' : 'missing' },
    ready: ytDlpReady && ffmpegReady && ffprobeReady
  };
}

async function setupStatus(req) {
  const nuvioSource = ['package.json', 'index.html', path.join('js', 'app.js')]
    .every(name => exists(NUVIO_ROOT, name));
  const nuvioBuilt = isNuvioBuilt(NUVIO_DIST);
  let nuvioConfigured = false;
  let nuvioKeySource = 'none';
  if (nuvioBuilt) {
    try {
      const config = await mergedNuvioConfig(NUVIO_DIST);
      nuvioConfigured = Boolean(config.merged?.NUVIO_SUPABASE_URL && config.merged?.NUVIO_SUPABASE_ANON_KEY);
      nuvioKeySource = config.keySource || 'none';
    } catch {}
  }

  const voxelSource = [
    'server.js',
    path.join('public', 'index.html'),
    path.join('public', 'js', 'depth-models.js')
  ].every(name => exists(VOXELVISION_ROOT, name));
  const youtube = youtubeToolsStatus();
  const runtimeDeps = ['ws', 'hls.js'].every(name => exists(PROJECT_ROOT, 'node_modules', name));
  const canInstall = process.platform === 'win32' && isLoopback(req);

  return {
    ok: true,
    service: 'watchfusion-setup',
    localRequest: isLoopback(req),
    canInstall,
    installing: activeInstall,
    components: {
      runtime: {
        key: 'runtime',
        label: 'WatchFusion runtime',
        ready: runtimeDeps,
        required: true,
        action: null,
        message: runtimeDeps ? 'Node runtime dependencies are ready.' : 'WatchFusion must be repaired from the EveOS outer workspace.'
      },
      nuvio: {
        key: 'nuvio',
        label: 'Nuvio',
        ready: nuvioBuilt,
        sourceReady: nuvioSource,
        built: nuvioBuilt,
        configured: nuvioConfigured,
        keySource: nuvioKeySource,
        required: false,
        action: canInstall ? 'nuvio' : null,
        message: nuvioBuilt
          ? (nuvioConfigured ? 'Nuvio browser build and public backend configuration are ready.' : 'Nuvio is built; account/QR backend configuration will use public discovery when available.')
          : nuvioSource ? 'Nuvio source is present but needs a fresh browser build.' : 'Nuvio is not installed in this WatchFusion copy.'
      },
      voxelvision: {
        key: 'voxelvision',
        label: 'VoxelVision',
        ready: voxelSource,
        required: true,
        action: null,
        message: voxelSource ? 'Bundled VoxelVision source is ready.' : 'Bundled VoxelVision source is incomplete.'
      },
      voxelYoutube: {
        key: 'voxel-youtube',
        label: 'VoxelVision YouTube helpers',
        ready: youtube.ready,
        required: false,
        action: canInstall ? 'voxel-youtube' : null,
        ...youtube,
        message: youtube.ready
          ? 'Portable yt-dlp, FFmpeg, and ffprobe are ready.'
          : 'Install portable yt-dlp, FFmpeg, and ffprobe for reliable YouTube import.'
      },
      browserModels: {
        key: 'browser-models',
        label: 'VoxelVision AI models',
        ready: null,
        required: false,
        browserManaged: true,
        models: MODEL_PROFILES,
        message: 'AI weights download lazily on first use and are cached by the browser profile.'
      }
    },
    recommendedReady: nuvioBuilt && voxelSource && youtube.ready
  };
}

function runProcess(command, args, { cwd = PROJECT_ROOT, env = process.env, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      shell: false
    });
    let output = '';
    const append = chunk => {
      output += String(chunk || '');
      if (output.length > 128 * 1024) output = output.slice(-128 * 1024);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Installer timed out after ${Math.round(timeoutMs / 60000)} minutes.`));
    }, timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve(output);
      reject(new Error(`Installer exited with code ${code}.\n${output.slice(-5000)}`));
    });
  });
}

async function installNuvio() {
  const env = { ...process.env, WATCHFUSION_NONINTERACTIVE: '1' };
  await runProcess('cmd.exe', ['/d', '/s', '/c', 'call', path.join(PROJECT_ROOT, 'scripts', 'GET-NUVIO.bat')], { env });
  await runProcess('cmd.exe', ['/d', '/s', '/c', 'call', path.join(PROJECT_ROOT, 'scripts', 'BUILD-NUVIO.bat')], { env });
}

async function installVoxelYoutube() {
  const script = path.join(VOXELVISION_ROOT, 'scripts', 'SETUP-YOUTUBE.ps1');
  await runProcess('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script
  ], { cwd: VOXELVISION_ROOT, timeoutMs: 20 * 60 * 1000 });
}

async function performInstall(component) {
  if (component === 'nuvio') return installNuvio();
  if (component === 'voxel-youtube') return installVoxelYoutube();
  if (component === 'all') {
    await installNuvio();
    return installVoxelYoutube();
  }
  throw new Error(`Unknown setup component: ${component}`);
}

async function handleInstall(req, res) {
  if (!isLoopback(req)) {
    json(res, 403, { ok: false, error: 'Install actions are available only from the host machine.' });
    return true;
  }
  if (process.platform !== 'win32') {
    json(res, 501, { ok: false, error: 'Integrated installers are currently Windows-only.' });
    return true;
  }
  if (activeInstall) {
    json(res, 409, { ok: false, error: `Setup is already running: ${activeInstall}` });
    return true;
  }
  const body = await readBody(req);
  const component = String(body?.component || '').trim();
  if (!['nuvio', 'voxel-youtube', 'all'].includes(component)) {
    json(res, 400, { ok: false, error: 'Unknown setup component.' });
    return true;
  }
  activeInstall = component;
  try {
    await performInstall(component);
    const status = await setupStatus(req);
    json(res, 200, { ...status, installed: component, message: `${component} setup completed.` });
  } catch (error) {
    json(res, 500, { ok: false, installed: component, error: error?.message || String(error) });
  } finally {
    activeInstall = null;
  }
  return true;
}

export async function handleSetupRoute(req, res, parts) {
  if (parts[0] !== 'api' || parts[1] !== 'setup') return false;
  if (req.method === 'GET' && parts[2] === 'status') {
    json(res, 200, await setupStatus(req));
    return true;
  }
  if (req.method === 'POST' && parts[2] === 'install') return handleInstall(req, res);
  json(res, 404, { ok: false, error: 'setup route not found' });
  return true;
}
