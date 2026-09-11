import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');

export function getChangedFiles() {
  try {
    // Check uncommitted changes + differences with origin/main or HEAD
    const statusOut = execSync('git status --porcelain', { cwd: REPO_ROOT, encoding: 'utf8' });
    const uncommitted = statusOut
      .split('\n')
      .map(line => line.trim().slice(3))
      .filter(Boolean);

    let committedDiff = [];
    try {
      const diffOut = execSync('git diff --name-only origin/main...HEAD', { cwd: REPO_ROOT, encoding: 'utf8' });
      committedDiff = diffOut.split('\n').map(s => s.trim()).filter(Boolean);
    } catch {}

    const all = Array.from(new Set([...uncommitted, ...committedDiff]));
    return all.map(f => f.replace(/\\/g, '/'));
  } catch {
    return [];
  }
}

export function detectScope(changedFiles = null) {
  const files = changedFiles || getChangedFiles();
  const scopes = new Set();

  for (const file of files) {
    if (file.includes('server.js')) {
      scopes.add('server');
      scopes.add('rooms');
      scopes.add('sync');
      scopes.add('sse');
      scopes.add('reconnect');
      scopes.add('lan');
    }
    if (file.includes('public/app.js')) {
      scopes.add('ui');
      scopes.add('playback');
      scopes.add('sync');
      scopes.add('reconnect');
      scopes.add('chat');
      scopes.add('browser');
    }
    if (file.includes('public/index.html') || file.includes('public/style.css')) {
      scopes.add('ui');
      scopes.add('browser');
    }
    if (file.includes('scripts/')) {
      scopes.add('launcher');
      scopes.add('lan');
      scopes.add('remote');
    }
    if (file.includes('tools/')) {
      scopes.add('remote');
      scopes.add('cloudflared');
    }
    if (file.includes('package.json') || file.includes('playwright.config')) {
      scopes.add('test-harness');
    }
    if (file.includes('tests/')) {
      scopes.add('tests');
    }
  }

  return {
    changedFiles: files,
    scopes: Array.from(scopes)
  };
}
