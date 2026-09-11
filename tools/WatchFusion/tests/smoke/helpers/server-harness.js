import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

export async function startServer({ port = 19085, host = '127.0.0.1', lan = false, env = {} } = {}) {
  const args = ['server.js'];
  if (lan) args.push('--lan');

  const child = spawn(process.execPath, args, {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: host,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });

  const baseUrl = `http://127.0.0.1:${port}`;

  // Poll until ready
  const started = Date.now();
  let ready = false;

  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode}.\nStderr: ${stderr}\nStdout: ${stdout}`);
    }
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`${baseUrl}/api/health`, { timeout: 1000 }, res => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`Status ${res.statusCode}`));
          }
        });
        req.on('error', reject);
        req.end();
      });
      ready = true;
      break;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  if (!ready) {
    child.kill();
    throw new Error(`Server on port ${port} failed to become ready within 10s.\nStderr: ${stderr}\nStdout: ${stdout}`);
  }

  return {
    port,
    baseUrl,
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
    async stop() {
      if (child.exitCode === null) {
        child.kill();
        await new Promise(resolve => {
          child.once('exit', resolve);
          setTimeout(resolve, 2000);
        });
      }
    }
  };
}
