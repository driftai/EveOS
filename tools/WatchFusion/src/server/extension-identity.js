import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECT_ROOT } from './config.js';

export function trustedExtensionIds() {
  return ['browser-extension/manifest.json', '../../extension/manifest.base.json'].flatMap(relative => {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.resolve(PROJECT_ROOT, relative), 'utf8'));
      if (!manifest.key) return [];
      const hex = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
      return [hex.replace(/[0-9a-f]/g, char => String.fromCharCode(97 + parseInt(char, 16)))];
    } catch { return []; }
  });
}
