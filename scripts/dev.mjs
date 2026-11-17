// Runs the API server and the Vite dev server together.
import { spawn } from 'node:child_process';
const opts = { stdio: 'inherit', shell: true };
const procs = [
  spawn('node --watch server/index.mjs', opts),
  spawn('npx vite --host', opts),
];
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (c) => { if (c) { stop(); process.exit(c); } }));
