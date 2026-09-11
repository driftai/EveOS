import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { canonicalYoutubeUrl, youtubeVideoId } from './public/js/youtube-source.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const IMPORTED_DIR = path.join(PUBLIC_DIR, 'media', 'imported');
const TOOLS_DIR = path.join(__dirname, 'tools');

fs.mkdirSync(IMPORTED_DIR, { recursive: true });
fs.mkdirSync(TOOLS_DIR, { recursive: true });

const PLAYABLE_MEDIA_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.mov']);

export const DEFAULT_YOUTUBE_QUALITY = '1080';
export const YOUTUBE_QUALITY_PROFILES = Object.freeze({
  '720': { id: '720', label: '720p', maxHeight: 720 },
  '1080': { id: '1080', label: '1080p', maxHeight: 1080 },
  '1440': { id: '1440', label: '1440p', maxHeight: 1440 },
  '2160': { id: '2160', label: '2160p / 4K', maxHeight: 2160 },
  max: { id: 'max', label: 'Source Max', maxHeight: null }
});

export function getYoutubeQualityProfiles() {
  return Object.values(YOUTUBE_QUALITY_PROFILES).map(profile => ({ ...profile }));
}

export function normalizeYoutubeQuality(value) {
  const id = String(value || '').trim().toLowerCase();
  return YOUTUBE_QUALITY_PROFILES[id] ? id : DEFAULT_YOUTUBE_QUALITY;
}

export function isSupportedYoutubeUrl(value) {
  return Boolean(youtubeVideoId(value));
}

function commandWorks(command, args = []) {
  const result = spawnSync(command, args, {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 8000
  });
  return !result.error && result.status === 0;
}

function findYtDlp() {
  const candidates = [
    { command: path.join(TOOLS_DIR, 'yt-dlp.exe'), prefix: [], label: 'bundled yt-dlp.exe' },
    { command: path.join(TOOLS_DIR, 'yt-dlp'), prefix: [], label: 'bundled yt-dlp' },
    { command: 'yt-dlp', prefix: [], label: 'yt-dlp' },
    { command: 'py', prefix: ['-m', 'yt_dlp'], label: 'py -m yt_dlp' },
    { command: 'python', prefix: ['-m', 'yt_dlp'], label: 'python -m yt_dlp' },
    { command: 'python3', prefix: ['-m', 'yt_dlp'], label: 'python3 -m yt_dlp' }
  ];

  for (const candidate of candidates) {
    if (commandWorks(candidate.command, [...candidate.prefix, '--version'])) return candidate;
  }
  return null;
}

function findFfmpeg() {
  const candidates = [
    { command: path.join(TOOLS_DIR, 'ffmpeg.exe'), label: 'bundled ffmpeg.exe' },
    { command: path.join(TOOLS_DIR, 'ffmpeg', 'bin', 'ffmpeg.exe'), label: 'bundled FFmpeg' },
    { command: 'ffmpeg', label: 'ffmpeg' }
  ];

  for (const candidate of candidates) {
    if (commandWorks(candidate.command, ['-version'])) return candidate;
  }
  return null;
}

function findFfprobe() {
  const candidates = [
    { command: path.join(TOOLS_DIR, 'ffprobe.exe'), label: 'bundled ffprobe.exe' },
    { command: path.join(TOOLS_DIR, 'ffmpeg', 'bin', 'ffprobe.exe'), label: 'bundled FFprobe' },
    { command: 'ffprobe', label: 'ffprobe' }
  ];

  for (const candidate of candidates) {
    if (commandWorks(candidate.command, ['-version'])) return candidate;
  }
  return null;
}

function filterForHeight(maxHeight) {
  return Number.isFinite(maxHeight) ? `[height<=${maxHeight}]` : '';
}

export function buildYoutubeStrategies(qualityId, { ffmpegCommand = null } = {}) {
  const normalized = normalizeYoutubeQuality(qualityId);
  const profile = YOUTUBE_QUALITY_PROFILES[normalized];
  const cap = filterForHeight(profile.maxHeight);
  const strategies = [];

  // Prefer adaptive video-only + audio-only streams when FFmpeg exists. This is
  // where YouTube normally exposes 1080p+ sources, and FFmpeg only remuxes them;
  // VoxelVision does not re-encode the video and therefore does not add loss.
  if (ffmpegCommand) {
    const adaptiveFormat = profile.maxHeight == null
      ? 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best'
      : `bestvideo${cap}[ext=mp4]+bestaudio[ext=m4a]/bestvideo${cap}+bestaudio/best${cap}/best`;

    strategies.push({
      name: 'adaptive-merge',
      format: adaptiveFormat,
      extraArgs: ['--merge-output-format', 'mp4', '--ffmpeg-location', ffmpegCommand]
    });
  }

  const combinedFormat = profile.maxHeight == null
    ? 'best[ext=mp4]/best'
    : `best${cap}[ext=mp4]/best${cap}/best`;

  strategies.push({
    name: 'combined-stream',
    format: combinedFormat,
    extraArgs: []
  });

  return strategies;
}

function cleanupJobFiles(jobId, keepName = null) {
  try {
    for (const name of fs.readdirSync(IMPORTED_DIR)) {
      if (!name.startsWith(`${jobId}.`) || name === keepName) continue;
      fs.rmSync(path.join(IMPORTED_DIR, name), { force: true });
    }
  } catch {
    // Best-effort cleanup only.
  }
}

function cleanProcessError(stderr, fallback) {
  const lines = String(stderr || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^Deprecated Feature: Support for Python version 3\.10/i.test(line));

  return lines.slice(-5).join(' ') || fallback;
}

function parseFrameRate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.includes('/')) {
    const [num, den] = text.split('/').map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den) return Math.round((num / den) * 100) / 100;
  }
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function labelFromDimensions(width, height) {
  if (!width || !height) return null;
  const shortSide = Math.min(width, height);
  const tiers = [4320, 2160, 1440, 1080, 720, 480, 360];
  const tier = tiers.find(value => shortSide >= value);
  return tier ? `${tier}p` : `${shortSide}p`;
}

function probeMedia(filePath) {
  const ffprobe = findFfprobe();
  if (!ffprobe) return null;

  const result = spawnSync(ffprobe.command, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,codec_name,pix_fmt',
    '-of', 'json',
    filePath
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 12000
  });

  if (result.error || result.status !== 0) return null;

  try {
    const parsed = JSON.parse(result.stdout || '{}');
    const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : null;
    if (!stream) return null;
    const width = Number(stream.width) || null;
    const height = Number(stream.height) || null;
    return {
      width,
      height,
      fps: parseFrameRate(stream.avg_frame_rate),
      codec: stream.codec_name || null,
      pixelFormat: stream.pix_fmt || null,
      qualityLabel: labelFromDimensions(width, height)
    };
  } catch {
    return null;
  }
}

function runYtDlpAttempt(ytDlp, sourceUrl, jobId, strategy) {
  return new Promise((resolve, reject) => {
    cleanupJobFiles(jobId);

    const outputTemplate = path.join(IMPORTED_DIR, `${jobId}.%(ext)s`);
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    const args = [
      ...ytDlp.prefix,
      '--no-playlist',
      '--no-progress',
      '--no-warnings',
      '--restrict-filenames',
      '--concurrent-fragments', '4',
      '--format', strategy.format,
      '--output', outputTemplate,
      '--print', 'before_dl:%(title)s',
      '--print', 'after_move:%(filepath)s',
      ...strategy.extraArgs
    ];

    if (Number.isFinite(nodeMajor) && nodeMajor >= 20) {
      args.push('--js-runtimes', 'node');
    }
    args.push(sourceUrl);

    const child = spawn(ytDlp.command, args, {
      cwd: __dirname,
      windowsHide: true,
      shell: false
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('error', err => {
      cleanupJobFiles(jobId);
      reject(new Error(`Could not start yt-dlp: ${err.message}`));
    });

    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(cleanProcessError(stderr, `yt-dlp exited with code ${code}`)));
        return;
      }

      const files = fs.readdirSync(IMPORTED_DIR)
        .filter(name => name.startsWith(`${jobId}.`))
        .filter(name => !name.endsWith('.part') && !name.endsWith('.ytdl'))
        .filter(name => PLAYABLE_MEDIA_EXTENSIONS.has(path.extname(name).toLowerCase()));

      if (!files.length) {
        reject(new Error('yt-dlp completed but no browser-playable media file was produced.'));
        return;
      }

      const fileName = files
        .map(name => ({ name, size: fs.statSync(path.join(IMPORTED_DIR, name)).size }))
        .sort((a, b) => b.size - a.size)[0].name;
      const filePath = path.join(IMPORTED_DIR, fileName);
      const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const title = lines[0] || 'YouTube video';
      const stat = fs.statSync(filePath);
      const mediaInfo = probeMedia(filePath);

      cleanupJobFiles(jobId, fileName);
      resolve({
        title,
        mediaUrl: `/media/imported/${encodeURIComponent(fileName)}`,
        fileName,
        fileSizeBytes: stat.size,
        sourceUrl,
        strategy: strategy.name,
        mediaInfo
      });
    });
  });
}

export function getYoutubeStatus() {
  const ytDlp = findYtDlp();
  const ffmpeg = findFfmpeg();
  const ffprobe = findFfprobe();
  return {
    available: Boolean(ytDlp),
    provider: ytDlp?.label || null,
    ffmpegAvailable: Boolean(ffmpeg),
    ffmpegProvider: ffmpeg?.label || null,
    ffprobeAvailable: Boolean(ffprobe),
    ffprobeProvider: ffprobe?.label || null,
    defaultQuality: DEFAULT_YOUTUBE_QUALITY,
    qualityProfiles: getYoutubeQualityProfiles()
  };
}

export async function runYoutubeImport(sourceUrl, qualityId = DEFAULT_YOUTUBE_QUALITY) {
  const ytDlp = findYtDlp();
  if (!ytDlp) {
    throw new Error('YouTube support is not installed. Run VoxelVision.bat and choose Setup / Update YouTube support.');
  }

  const requestedQuality = normalizeYoutubeQuality(qualityId);
  const canonicalSourceUrl = canonicalYoutubeUrl(sourceUrl);
  const profile = YOUTUBE_QUALITY_PROFILES[requestedQuality];
  const ffmpeg = findFfmpeg();
  const jobId = crypto.randomBytes(10).toString('hex');
  const strategies = buildYoutubeStrategies(requestedQuality, { ffmpegCommand: ffmpeg?.command || null });

  let lastError = null;
  for (const strategy of strategies) {
    try {
      const imported = await runYtDlpAttempt(ytDlp, canonicalSourceUrl, jobId, strategy);
      return {
        ...imported,
        requestedQuality,
        requestedQualityLabel: profile.label,
        ytDlpProvider: ytDlp.label,
        ffmpegProvider: ffmpeg?.label || null
      };
    } catch (error) {
      lastError = error;
    }
  }

  cleanupJobFiles(jobId);
  if (!ffmpeg && requestedQuality !== '720') {
    throw new Error(
      `High-quality YouTube import needs FFmpeg adaptive merge support. Run VoxelVision.bat option [4], then try again. ${lastError?.message || ''}`.trim()
    );
  }
  throw lastError || new Error('YouTube import failed.');
}
