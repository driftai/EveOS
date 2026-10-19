'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function createSupervisedLiveView({ fsImpl = fs, spawnImpl = spawn, platform = process.platform,
  repoRoot = path.resolve(__dirname, '..', '..', '..') } = {}) {
  const base = path.join(repoRoot, 'data', 'runtime', 'nexus-browser', 'terminal-views');
  const viewer = path.join(repoRoot, 'tools', 'Nexus-Browser', 'scripts', 'tlo-recovery-terminal-view.ps1');
  const MAX_LOG_BYTES = 2 * 1024 * 1024;
  function start({ jobId, command }) {
    if (platform !== 'win32' || !/^machine-job-[A-Za-z0-9_-]{6,125}$/.test(String(jobId || ''))) return null;
    fsImpl.mkdirSync(base, { recursive: true });
    const logPath = path.join(base, `${jobId}.log`), donePath = path.join(base, `${jobId}.done`);
    try { fsImpl.rmSync(donePath, { force: true }); } catch {}
    // Render only safe display text. Do not echo arbitrary terminal escape codes.
    const clean = (value) => String(value || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x1b]/g, '');
    fsImpl.writeFileSync(logPath, `EveOS supervised TLO recovery\r\nJob: ${jobId}\r\nCommand: ${clean(command).slice(0, 1000)}\r\n\r\n`, 'utf8');
    let written = fsImpl.statSync(logPath).size, truncated = false;
    const append = (message) => {
      if (truncated) return;
      const body = Buffer.from(clean(message), 'utf8');
      const remaining = Math.max(0, MAX_LOG_BYTES - written);
      if (remaining > 0) { const slice = body.subarray(0, remaining); fsImpl.appendFileSync(logPath, slice); written += slice.length; }
      if (body.length > remaining) { truncated = true; fsImpl.appendFileSync(logPath, '\r\n[VIEW_TRUNCATED: see authoritative output spool]\r\n', 'utf8'); }
    };
    const child = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', viewer,
      '-LogPath', logPath, '-DonePath', donePath, '-Title', `EveOS TLO Recovery ${jobId.slice(-8)}`],
    { cwd: repoRoot, detached: true, windowsHide: false, stdio: 'ignore' });
    child.once?.('error', () => {}); child.unref?.();
    return {
      write(detail) { try { append(`[${detail?.stream === 'stderr' ? 'stderr' : 'stdout'}] ${detail?.text || ''}`); } catch {} },
      finish(result, error = null) {
        try {
          // Reserve the final status even when the streaming observer was truncated.
          fsImpl.appendFileSync(logPath, `\r\nEveOS result: ${error ? 'FAILED TO START' : clean(result?.state || 'unknown')}${error ? ' · ' + clean(error.message).slice(0, 240) : ''}\r\n`, 'utf8');
          fsImpl.writeFileSync(donePath, new Date().toISOString(), 'utf8');
        } catch {}
      },
      logPath, donePath
    };
  }
  return { start };
}
module.exports = { createSupervisedLiveView };
