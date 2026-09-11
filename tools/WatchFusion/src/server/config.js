import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '../..');
export const PUBLIC = path.join(PROJECT_ROOT, 'public');

function validPort(value, label) {
  const port = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label} port: ${value}`);
  }
  return port;
}

function registeredPort(envName) {
  const eveosRoot = path.resolve(PROJECT_ROOT, '../..');
  const registryPath = path.join(eveosRoot, 'config', 'eveos-ports.json');
  const payload = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const entry = payload?.ports?.[envName];
  if (!entry || entry.port == null) {
    throw new Error(`Missing ${envName} in EveOS port registry: ${registryPath}`);
  }
  return validPort(entry.port, envName);
}

export const PORT = process.env.PORT
  ? validPort(process.env.PORT, 'PORT')
  : process.env.WATCHFUSION_PORT
    ? validPort(process.env.WATCHFUSION_PORT, 'WATCHFUSION_PORT')
    : registeredPort('WATCHFUSION_PORT');
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
