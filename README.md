# Stiker WA Maker (PWA)

Bikin stiker WhatsApp **diam atau gerak (seperti GIF)** dari **foto, video, dan GIF**. Video TikTok / Reels / X juga bisa: simpan videonya ke galeri dulu, lalu pilih di app.

- Semua proses jalan **di browser**, tidak ada yang di-upload ke server. Cukup hosting statis (Vercel).
- Output: WebP 512×512 sesuai aturan WhatsApp — diam ≤ 100 KB, animasi ≤ 500 KB & ≤ 10 detik. Kualitas/FPS diatur otomatis supaya muat.
- Editor: crop/zoom/geser, latar transparan/putih/hitam, sudut bulat/lingkaran, outline putih ala die-cut, teks (Meme / Gendut / Ketik, gaya garis atau label), filmstrip trimmer untuk pilih durasi video, FPS 8–15.
- Album tersimpan di perangkat (IndexedDB), bisa export `.wastickers` (3–30 stiker) atau `.zip`.
- PWA: bisa di-install, jalan offline, dan muncul di **share sheet Android** — share foto/video dari galeri langsung ke app ini.

## Menjalankan

Butuh Node 20+.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # hasil di dist/
npm run preview    # coba hasil build di http://localhost:8787
```

> PWA (install, share target, service worker) butuh **HTTPS** kalau dibuka dari HP — pakai URL Vercel atau domain sendiri.

## Deploy ke Vercel

Konfigurasi ada di `vercel.json` (Vite, output `dist`, header untuk service worker).

```bash
vercel --prod
```

Atau import repo ini di vercel.com — tiap push ke `main` otomatis deploy. Domain sendiri: Project → Settings → Domains → tambah domain, lalu ikuti instruksi DNS (CNAME / A record) yang ditampilkan.

## Cara masuk ke WhatsApp

- **Android:** tombol *Kirim ke WhatsApp* → pilih chat → terkirim sebagai stiker → tap → *Tambah ke Favorit*.
- **WhatsApp Web/Desktop:** download `.webp`, seret ke chat.
- **Pack:** export `.wastickers`, buka dengan app importer pack stiker.

Website tidak bisa langsung menambah pack ke WhatsApp (itu hanya bisa lewat app native), jadi alurnya lewat kirim ke chat / favorit.

Hormati hak cipta konten yang kamu jadikan stiker.

## Struktur

```
src/main.ts            UI & alur aplikasi
src/lib/render.ts      gambar frame 512×512 (crop, zoom, teks, sudut, outline)
src/lib/sources.ts     loader foto / video / GIF (ImageDecoder)
src/lib/encode.ts      encoder WebP + pengatur ukuran otomatis (native / wasm untuk Safari)
src/lib/webp-anim.ts   muxer animated WebP (VP8X/ANIM/ANMF)
src/lib/zip.ts         penulis ZIP (untuk .wastickers)
src/sw.ts              service worker (offline + share target)
```
