# Checklist Deploy DoggieZen Backend

File-file di folder ini sudah disiapkan supaya kamu tinggal isi variabel, bukan
nulis konfigurasi dari nol. Ikuti urutan ini.

## 1. Ambil token bot baru
BotFather -> `/mybots` -> `@doggiezenbot` -> API Token -> **Revoke current token**,
lalu salin token baru yang muncul.

## 2. Push folder ini ke GitHub
Repo butuh minimal: `server.js`, `db.js`, `store.js`, `package.json`,
`railway.json`, `Procfile`, `.gitignore`.
(`.env` **tidak** ikut ter-push -- sudah diblokir oleh `.gitignore`, memang harus begitu.)

```bash
git init
git add .
git commit -m "Initial backend"
git remote add origin <url-repo-github-kamu>
git push -u origin main
```

## 3. Deploy ke Railway
1. https://railway.app -> **New Project** -> **Deploy from GitHub repo** -> pilih repo ini.
2. Railway otomatis mendeteksi `railway.json` dan menjalankan `npm install` lalu `npm start`.
3. Buka tab **Variables** di project Railway, isi:

   | Nama variabel | Isi dengan |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | token dari langkah 1 |
   | `PORT` | `3000` (opsional, Railway biasa set sendiri) |

4. Setelah deploy selesai, buka tab **Settings -> Networking -> Generate Domain**
   untuk dapat URL publik, contoh: `https://doggiezen-production.up.railway.app`

## 4. Sambungkan game ke backend
Di `doggiezen-2-7-1.html`, cari baris:
```js
const API_BASE_URL = 'https://your-server.com';
```
Ganti `'https://your-server.com'` dengan URL Railway dari langkah 3.

## 5. (Opsional, isi belakangan) Batasi CORS & misi channel
Kalau game sudah punya domain hosting tetap dan channel Telegram untuk misi "Join":
tambahkan di Railway Variables juga:

| Nama variabel | Isi dengan |
|---|---|
| `ALLOWED_ORIGIN` | domain tempat file `.html` di-hosting |
| `TELEGRAM_CHANNEL_USERNAME` | username channel (tanpa `@`), bot harus jadi admin channel itu |

## 6. Cek jalan atau tidak
Buka Mini App dari Telegram (bukan browser biasa) -> mainkan sekali -> buka
panel Leaderboard. Kalau skor & nama muncul di sana, backend sudah tersambung
ke akun Telegram player dengan benar.
