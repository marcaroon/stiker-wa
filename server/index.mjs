// Backend: downloads videos from TikTok / Instagram Reels / X with yt-dlp and
// streams them to the browser (which can't fetch them itself because of CORS).
// Also serves the built PWA from ./dist in production.

import express from 'express';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);
const MAX_MB = Number(process.env.MAX_DOWNLOAD_MB || 80);
const COOKIES = process.env.YTDLP_COOKIES; // optional Netscape cookies.txt (helps with Instagram)
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 3);

const ALLOWED_HOSTS = [
  'tiktok.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'fxtwitter.com',
  'vxtwitter.com',
  'fixupx.com',
];

/* ---------- locate yt-dlp & ffmpeg ---------- */
function works(cmd, args) {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore', timeout: 15000 }).status === 0;
  } catch {
    return false;
  }
}
const YTDLP = (() => {
  if (process.env.YTDLP_BIN) return [process.env.YTDLP_BIN];
  if (works('yt-dlp', ['--version'])) return ['yt-dlp'];
  for (const py of ['python3', 'python', 'py']) if (works(py, ['-m', 'yt_dlp', '--version'])) return [py, '-m', 'yt_dlp'];
  return null;
})();
const FFMPEG = works(process.env.FFMPEG_BIN || 'ffmpeg', ['-version']) ? process.env.FFMPEG_BIN || 'ffmpeg' : null;

console.log(`yt-dlp: ${YTDLP ? YTDLP.join(' ') : 'TIDAK DITEMUKAN (fitur link nonaktif)'}`);
console.log(`ffmpeg: ${FFMPEG ?? 'tidak ada (video HEVC tidak bisa dikonversi)'}`);

/* ---------- helpers ---------- */
function allowedUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return null;
  return u.toString();
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out, err: String(e) });
    });
  });
}

function friendlyError(stderr) {
  const s = stderr.toLowerCase();
  if (s.includes('login') || s.includes('cookies') || s.includes('rate-limit'))
    return 'Platform minta login / membatasi akses. (Instagram sering begini — admin server bisa pasang cookies.)';
  if (s.includes('private')) return 'Postingan ini privat.';
  if (s.includes('no video') || s.includes('there\'s no video') || s.includes('no media'))
    return 'Tidak ada video di link ini.';
  if (s.includes('unsupported url')) return 'Link tidak didukung.';
  if (s.includes('larger than max-filesize') || s.includes('file is larger')) return `Video terlalu besar (> ${MAX_MB} MB).`;
  if (s.includes('404') || s.includes('not found') || s.includes('unavailable')) return 'Video tidak ditemukan / sudah dihapus.';
  return 'Gagal mengambil video dari link ini.';
}

// Browsers can't decode H.265 (TikTok sometimes serves it), so prefer H.264.
// We don't need audio, so video-only streams are fine (no merge → no ffmpeg needed).
const FORMAT = [
  'bv*[height<=720][vcodec^=avc]',
  'bv*[height<=720][vcodec^=h264]',
  'b[height<=720][vcodec^=h264]',
  'bv*[height<=720][vcodec^=vp]',
  'bv*[height<=1080][vcodec^=avc]',
  'bv*[height<=720]',
  'b[height<=720]',
  'bv*',
  'b',
].join('/');

let active = 0;
const hits = new Map(); // ip -> timestamps

/* ---------- app ---------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '8kb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, ytdlp: !!YTDLP, ffmpeg: !!FFMPEG }));

app.post('/api/fetch', async (req, res) => {
  if (!YTDLP) return res.status(503).json({ error: 'yt-dlp belum terpasang di server.' });
  const url = allowedUrl(String(req.body?.url || '').trim());
  if (!url) return res.status(400).json({ error: 'Link harus dari TikTok, Instagram (Reels) atau X/Twitter.' });

  // simple rate limit: 12 requests / minute / IP
  const now = Date.now();
  const list = (hits.get(req.ip) || []).filter((t) => now - t < 60000);
  if (list.length >= 12) return res.status(429).json({ error: 'Terlalu banyak permintaan, tunggu sebentar.' });
  list.push(now);
  hits.set(req.ip, list);

  if (active >= MAX_CONCURRENT) return res.status(503).json({ error: 'Server sedang sibuk, coba lagi sebentar.' });
  active++;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stiker-'));
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }, () => {});
  try {
    const args = [
      ...YTDLP.slice(1),
      '--no-playlist',
      '-I', '1',
      '--use-extractors', 'default,-generic',
      '--no-warnings',
      '--no-part',
      '--no-mtime',
      '--socket-timeout', '20',
      '--max-filesize', `${MAX_MB}M`,
      '-f', FORMAT,
      '-o', path.join(dir, 'video.%(ext)s'),
      '--print', 'after_move:%(vcodec)s',
      '--print', 'after_move:filepath',
    ];
    if (COOKIES) args.push('--cookies', COOKIES);
    args.push('--', url);

    const r = await run(YTDLP[0], args, 120000);
    const lines = r.out.trim().split(/\r?\n/).filter(Boolean);
    let file = lines.at(-1);
    const vcodec = (lines.at(-2) || '').toLowerCase();
    if (r.code !== 0 || !file || !fs.existsSync(file)) {
      console.warn('[yt-dlp]', url, r.code, r.err.slice(-600));
      cleanup();
      return res.status(422).json({ error: friendlyError(r.err) });
    }

    // Transcode HEVC → H.264 (first 30 s, no audio) so every browser can decode it
    if (/hevc|h265|hvc1|hev1|bytevc1/.test(vcodec)) {
      if (!FFMPEG) {
        cleanup();
        return res.status(422).json({ error: 'Video memakai codec HEVC dan server tidak punya ffmpeg untuk konversi.' });
      }
      const out = path.join(dir, 'h264.mp4');
      const t = await run(
        FFMPEG,
        ['-y', '-i', file, '-t', '30', '-an', '-vf', "scale='min(720,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
        120000,
      );
      if (t.code !== 0) {
        cleanup();
        return res.status(500).json({ error: 'Gagal konversi video.' });
      }
      file = out;
    }

    const ext = path.extname(file).slice(1).toLowerCase();
    const type = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4' }[ext] || 'video/mp4';
    res.setHeader('content-type', type);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-length', fs.statSync(file).size);
    const stream = fs.createReadStream(file);
    stream.pipe(res);
    res.on('close', cleanup);
  } catch (e) {
    console.error(e);
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: 'Terjadi kesalahan di server.' });
  } finally {
    active--;
  }
});

/* ---------- static PWA ---------- */
const DIST = path.join(ROOT, 'dist');
if (fs.existsSync(DIST)) {
  app.use(
    express.static(DIST, {
      setHeaders(res, file) {
        if (file.endsWith('sw.js') || file.endsWith('.html') || file.endsWith('.webmanifest'))
          res.setHeader('cache-control', 'no-cache');
        else if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      },
    }),
  );
  // share target fallback when the service worker isn't installed yet
  app.post('/share-target', express.urlencoded({ extended: false }), (req, res) => {
    const q = new URLSearchParams({ text: [req.body?.text, req.body?.url].filter(Boolean).join(' ') });
    res.redirect(303, '/?' + q);
  });
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

app.listen(PORT, () => console.log(`Server jalan di http://localhost:${PORT}`));
