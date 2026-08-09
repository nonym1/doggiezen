# Checklist Deploy DoggieZen ke Netlify (frontend + backend jadi satu)

Sekarang backend (Netlify Functions + Netlify Blobs) dan frontend (`public/index.html`)
di-deploy bareng sebagai satu situs Netlify — tidak perlu Railway/Render lagi, dan tidak
perlu daftar database eksternal apa pun.

## 1. Ambil token bot baru
BotFather -> `/mybots` -> `@doggiezenbot` -> API Token -> **Revoke current token**,
salin token baru.

## 2. Push folder ini ke GitHub
```bash
git init
git add .
git commit -m "Deploy DoggieZen ke Netlify"
git remote add origin <url-repo-github-kamu>
git push -u origin main
```
`.env` tidak ikut ter-push (sudah diblokir `.gitignore`) — memang harus begitu.

## 3. Deploy ke Netlify
1. https://app.netlify.com -> **Add new site** -> **Import an existing project** -> pilih
   repo ini.
2. Netlify otomatis membaca `netlify.toml`:
   - situs statis di-serve dari folder `public/`
   - fungsi backend di-serve dari `netlify/functions/api.js`
   - `npm install` jalan otomatis sebelum build (menginstal `@netlify/blobs` dan
     `serverless-http` yang dipakai fungsi tsb)
3. Klik **Deploy site**. Netlify Blobs otomatis aktif untuk situs ini — tidak ada langkah
   setup tambahan, tidak ada akun/API key pihak ketiga.
4. Domain situs ini: `https://doggiezen.netlify.app` (atau domain custom kalau nanti kamu
   sambungkan salah satu).

## 4. Isi Environment Variables
**Site settings -> Environment variables** (bukan file `.env` — file itu cuma dipakai kalau
menjalankan `node server.js` di komputer sendiri):

| Nama variabel | Wajib? | Isi dengan |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **Wajib** | token dari langkah 1 |
| `ALLOWED_ORIGIN` | Sangat disarankan | `https://doggiezen.netlify.app` |
| `TELEGRAM_CHANNEL_USERNAME` | Opsional | username channel (tanpa `@`) untuk misi "Join Telegram"; bot harus jadi admin channel itu |
| `ZEN_PASS_WALLET` | Opsional | wallet TON penerima pembayaran Zen Pass — kosongkan dulu kalau belum siap, fitur ini otomatis nonaktif (503) sampai diisi |
| `TONCENTER_API_KEY` | Opsional | API key TonCenter (rate limit lebih longgar untuk verifikasi pembayaran) |
| `TON_NETWORK` | Opsional | `mainnet` (default) atau `testnet` |
| `ADMIN_TOKEN` | Opsional | secret panjang buat buka `/api/admin/flagged` |

Setelah mengisi/mengubah variabel, klik **Trigger deploy** supaya fungsi backend
membacanya ulang.

## 5. Domain sudah tersambung
`public/index.html` dan `public/tonconnect-manifest.json` sudah diisi dengan
`https://doggiezen.netlify.app` di semua 6 tempat (meta `og:url`/`og:image`,
`TONCONNECT_MANIFEST_URL`, dan isi `tonconnect-manifest.json`) — tidak perlu diedit lagi,
kecuali nanti kamu pindah ke domain custom. `API_BASE_URL` di HTML sudah diset kosong
(`''`) secara sengaja — karena frontend & backend sekarang satu origin, itu sudah benar dan
tidak perlu diubah.

## 6. Cek jalan atau tidak
- Buka `https://<domain-netlify-kamu>/health` di browser -> harus muncul `{"ok":true}`.
- Buka Mini App dari Telegram (bukan browser biasa) -> mainkan sekali -> buka panel
  Leaderboard. Kalau skor & nama muncul di sana, backend + Netlify Blobs sudah tersambung
  ke akun Telegram player dengan benar.

## Catatan soal Netlify Blobs (dibanding SQLite/Postgres)
Leaderboard & panel admin "flagged" sekarang dilayani dari satu index kecil di Blobs
(lihat komentar di `db-blobs.js`), bukan query SQL ter-index — cukup cepat untuk game
kasual, tapi bukan dirancang untuk ribuan pemain aktif bersamaan menulis skor di detik yang
sama. Kalau nanti butuh leaderboard presisi di skala besar, tinggal ganti `db-blobs.js`
dengan implementasi database eksternal (mis. Neon Postgres) — bentuk interface-nya
(`getPlayer`, `topPlayers`, dst.) sudah sama persis, jadi `server.js` tidak perlu disentuh
lagi.

## File lama (Railway/Render) yang sudah tidak dipakai
`railway.json`, `Procfile`, dan `DEPLOY.md` masih ada di repo untuk referensi kalau suatu
saat pindah host lagi, tapi tidak lagi relevan untuk deploy Netlify — aman diabaikan atau
dihapus.
