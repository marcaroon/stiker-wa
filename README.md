# Stiker WA Maker (PWA)

Bikin stiker WhatsApp dari **foto, video, GIF**, atau langsung dari **link TikTok / Instagram Reels / X**.

- Semua proses gambar/video jalan **di browser** (tidak di-upload ke server).
- Output: WebP 512×512 sesuai aturan WhatsApp — diam ≤ 100 KB, animasi ≤ 500 KB & ≤ 10 detik. Kualitas/FPS diatur otomatis supaya muat.
- Editor: crop/zoom/geser, latar transparan/putih/hitam, sudut bulat/lingkaran, teks ala meme, potong video (mulai, durasi, FPS).
- Koleksi tersimpan di perangkat (IndexedDB), bisa export `.wastickers` (3–30 stiker) atau `.zip`.
- PWA: bisa di-install, jalan offline (kecuali fitur link), dan muncul di **share sheet Android** — share video/link dari TikTok langsung ke app ini.

Server kecil (Express + yt-dlp) hanya dipakai untuk mengunduh video dari link, karena browser tidak bisa mengambilnya langsung (CORS).

## Menjalankan

Butuh Node 20+, dan untuk fitur link: `yt-dlp` (`pip install -U yt-dlp`) + `ffmpeg` (opsional, untuk konversi video HEVC).

```bash
npm install
npm run dev        # Vite (5173) + API (8787)
```

Produksi:

```bash
npm run build
npm start          # http://localhost:8787 — serve PWA + API
```

Atau Docker: `docker build -t stiker-wa . && docker run -p 8787:8787 stiker-wa`

> PWA (install, share target, service worker) butuh **HTTPS** kalau dibuka dari HP. Deploy ke VPS/Railway/Render/Fly, atau untuk coba cepat pakai tunnel seperti `cloudflared tunnel --url http://localhost:8787`.

### Env server

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | 8787 | |
| `YTDLP_BIN` | auto | path yt-dlp (fallback `python -m yt_dlp`) |
| `YTDLP_COOKIES` | – | file cookies.txt (Netscape) — membantu Instagram yang sering minta login |
| `MAX_DOWNLOAD_MB` | 80 | |
| `MAX_CONCURRENT` | 3 | download paralel maksimum |

## Cara masuk ke WhatsApp

- **Android:** tombol *Kirim ke WhatsApp* → pilih chat → terkirim sebagai stiker → tap → *Tambah ke Favorit*.
- **WhatsApp Web/Desktop:** download `.webp`, seret ke chat.
- **Pack:** export `.wastickers`, buka dengan app importer pack stiker.

Website tidak bisa langsung menambah pack ke WhatsApp (itu hanya bisa lewat app native), jadi alurnya lewat kirim ke chat / favorit.

## Catatan

- TikTok & X umumnya lancar. Instagram sering memblokir tanpa login → isi `YTDLP_COOKIES`. Sebagian post TikTok dibatasi per wilayah.
- Update yt-dlp secara berkala (`pip install -U yt-dlp`) karena platform sering berubah.
- Hormati hak cipta konten yang kamu jadikan stiker.

## Struktur

```
src/main.ts            UI & alur aplikasi
src/lib/render.ts      gambar frame 512×512 (crop, zoom, teks, sudut)
src/lib/sources.ts     loader foto / video / GIF (ImageDecoder)
src/lib/encode.ts      encoder WebP + pengatur ukuran otomatis (native / wasm untuk Safari)
src/lib/webp-anim.ts   muxer animated WebP (VP8X/ANIM/ANMF)
src/lib/zip.ts         penulis ZIP (untuk .wastickers)
src/sw.ts              service worker (offline + share target)
server/index.mjs       API /api/fetch (yt-dlp) + serve dist
```
