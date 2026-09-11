import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { once } from 'events';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const mediaDir = path.join(projectRoot, 'public', 'media');
const videoPath = path.join(mediaDir, 'voxelvision-demo.mp4');
const depthPath = path.join(mediaDir, 'voxelvision-demo.depth.bin.gz');
const metadataPath = path.join(mediaDir, 'voxelvision-demo.depth.json');

const width = 640;
const height = 360;
const videoFps = 24;
const duration = 12;
const depthFps = 4;
const depthCols = 128;
const depthRows = 72;

function clamp(value, low = 0, high = 1) {
  return Math.min(high, Math.max(low, value));
}

function sceneAt(x, y, seconds) {
  const phase = (seconds / duration) * Math.PI * 2;
  const orbX = 0.28 + Math.sin(phase) * 0.15;
  const orbY = 0.47 + Math.cos(phase * 1.7) * 0.12;
  const orbDistance = Math.hypot((x - orbX) * 1.35, y - orbY);
  const orb = clamp(1 - orbDistance / 0.19);
  const orbSoft = orb * orb * (3 - 2 * orb);

  const panelX = 0.68 + Math.cos(phase * 0.8) * 0.09;
  const panelY = 0.5 + Math.sin(phase * 1.25) * 0.1;
  const panelDx = Math.abs(x - panelX);
  const panelDy = Math.abs(y - panelY);
  const panel = clamp(1 - Math.max(panelDx / 0.14, panelDy / 0.22));
  const panelSoft = panel * panel * (3 - 2 * panel);

  const ripple = 0.5 + 0.5 * Math.sin((x * 4.2 + y * 2.3) * Math.PI + phase);
  const baseDepth = 0.1 + y * 0.12 + ripple * 0.025;
  const depth = clamp(baseDepth + orbSoft * 0.72 + panelSoft * 0.46);

  const grid = ((Math.floor(x * 20) + Math.floor(y * 12)) % 2) * 7;
  const glow = Math.round(70 * ripple);
  const red = clamp((13 + glow + grid + orbSoft * 210 + panelSoft * 25) / 255);
  const green = clamp((18 + glow * 0.45 + grid + orbSoft * 85 + panelSoft * 195) / 255);
  const blue = clamp((42 + glow * 0.75 + grid + orbSoft * 45 + panelSoft * 225) / 255);

  return { depth, red, green, blue };
}

function buildVideoFrame(frameIndex) {
  const frame = Buffer.allocUnsafe(width * height * 3);
  const seconds = frameIndex / videoFps;
  let offset = 0;

  for (let row = 0; row < height; row += 1) {
    const y = (row + 0.5) / height;
    for (let col = 0; col < width; col += 1) {
      const x = (col + 0.5) / width;
      const sample = sceneAt(x, y, seconds);
      frame[offset++] = Math.round(sample.red * 255);
      frame[offset++] = Math.round(sample.green * 255);
      frame[offset++] = Math.round(sample.blue * 255);
    }
  }

  return frame;
}

function buildDepthFrames() {
  const frameCount = duration * depthFps;
  const frames = Buffer.allocUnsafe(frameCount * depthCols * depthRows);
  let offset = 0;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const seconds = frameIndex / depthFps;
    for (let row = 0; row < depthRows; row += 1) {
      const y = (row + 0.5) / depthRows;
      for (let col = 0; col < depthCols; col += 1) {
        const x = (col + 0.5) / depthCols;
        frames[offset++] = Math.round(sceneAt(x, y, seconds).depth * 255);
      }
    }
  }

  return { frameCount, frames };
}

function resolveFfmpeg() {
  const bundled = path.join(projectRoot, 'tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  return fs.existsSync(bundled) ? bundled : 'ffmpeg';
}

async function generateVideo() {
  const ffmpeg = spawn(resolveFfmpeg(), [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo', '-pixel_format', 'rgb24',
    '-video_size', `${width}x${height}`, '-framerate', String(videoFps),
    '-i', 'pipe:0',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t', String(duration), '-shortest',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart', '-y', videoPath
  ], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });

  let errorOutput = '';
  ffmpeg.stderr.on('data', chunk => { errorOutput += chunk.toString(); });
  const totalFrames = duration * videoFps;

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    if (!ffmpeg.stdin.write(buildVideoFrame(frameIndex))) await once(ffmpeg.stdin, 'drain');
  }
  ffmpeg.stdin.end();

  const [exitCode] = await once(ffmpeg, 'close');
  if (exitCode !== 0) throw new Error(`FFmpeg failed (${exitCode}): ${errorOutput.trim()}`);
}

async function main() {
  fs.mkdirSync(mediaDir, { recursive: true });
  await generateVideo();
  const { frameCount, frames } = buildDepthFrames();
  fs.writeFileSync(depthPath, gzipSync(frames, { level: 9 }));
  fs.writeFileSync(metadataPath, `${JSON.stringify({
    version: 1,
    generator: 'scripts/generate-public-demo.mjs',
    source: path.basename(videoPath),
    sourceStart: 0,
    video: { width, height, fps: videoFps, duration },
    crop: null,
    grid: { cols: depthCols, rows: depthRows },
    keyframeRate: depthFps,
    frameCount,
    analysedDuration: duration,
    normalization: {
      lo: 0,
      hi: 1,
      note: 'Procedural normalized relief encoded directly as 0-255; larger = nearer'
    },
    sceneChanges: [],
    data: path.basename(depthPath)
  }, null, 2)}\n`);

  console.log(`Generated public demo: ${path.basename(videoPath)} + ${frameCount} depth frames.`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
