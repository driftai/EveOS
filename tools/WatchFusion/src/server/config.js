import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '../..');
export const PUBLIC = path.join(PROJECT_ROOT, 'public');
export const PORT = parseInt(process.env.PORT || '9085', 10);
export const HOST = process.env.HOST || '127.0.0.1';
export const LAN_MODE = HOST === '0.0.0.0';

export const NUVIO_PATH_ENV = process.env.NUVIO_PATH ? path.resolve(process.env.NUVIO_PATH) : null;
export const NUVIO_ROOT = NUVIO_PATH_ENV || path.join(PROJECT_ROOT, 'nuvio');
export const NUVIO_DIST = path.join(NUVIO_ROOT, 'dist');

export const VOXELVISION_ROOT = path.join(PROJECT_ROOT, 'voxelvision');
export const VOXELVISION_PUBLIC = path.join(VOXELVISION_ROOT, 'public');

export const MAX_MESSAGES = 100;
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
export const MEMBER_STALE_MS = 120 * 1000;
