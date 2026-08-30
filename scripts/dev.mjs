import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electronBinary = require('electron');

const viteCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const viteArgs = process.platform === 'win32' ? ['/c', 'npm', 'run', 'dev:renderer'] : ['run', 'dev:renderer'];

let electron = null;
let started = false;
let viteOut = '';

const vite = spawn(viteCommand, viteArgs, {
  cwd: path.resolve(root, '..'),
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe']
});

function tryStartElectron(url) {
  if (started) {
    return;
  }
  started = true;
  console.log('[dev] starting Electron with renderer at', url);
  const env = {
    ...process.env,
    ELECTRON_START_URL: url
  };
  electron = spawn(electronBinary, ['.'], {
    cwd: path.resolve(root, '..'),
    env,
    stdio: 'inherit'
  });
  electron.on('exit', (code) => {
    if (vite.exitCode === null) {
      vite.kill();
    }
    process.exit(code ?? 0);
  });
}

vite.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  viteOut += chunk.toString();
  const clean = viteOut.replace(/\x1b\[[0-9;]*m/g, '');
  const match = clean.match(/Local:\s+(https?:\/\/[^\s]+)/);
  if (match) {
    tryStartElectron(match[1]);
  }
});

vite.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
});

vite.on('exit', (code) => {
  if (!started) {
    console.error('[dev] Vite exited before reporting its URL; aborting.');
    process.exit(code ?? 1);
  }
});

const shutdown = () => {
  if (electron && electron.exitCode === null) {
    electron.kill();
  }
  if (vite.exitCode === null) {
    vite.kill();
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
