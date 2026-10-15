# LOEWI RACE 7

Aplikasi leaderboard web untuk mencatat ranking, level HC, dan poin peserta. Stack: Node.js, Express, SQLite via sql.js, session admin, ekspor PDF/CSV.

## Kebutuhan
- Node.js 18 atau lebih baru
- Browser modern
- Tidak perlu install PostgreSQL/MySQL

## Menjalankan di Windows
1. Ekstrak ZIP ke folder, misalnya `C:\LOEWI-RACE-7`.
2. Buka folder itu di VS Code atau buka Command Prompt di folder tersebut.
3. Salin `.env.example` menjadi `.env`.
4. Edit `.env`, terutama `SESSION_SECRET` dan `ADMIN_PASSWORD`. Gunakan password unik yang kuat.
5. Jalankan:
   ```bat
   npm install
   npm start
   ```
6. Buka `http://localhost:3000`.

Admin awal memakai nilai `ADMIN_USERNAME` dan `ADMIN_PASSWORD` dari `.env`. Kalau tidak diubah, default pengembangan adalah:
- Username: `admin`
- Password: `ChangeMe-Immediately-123!`

**Ganti password default sebelum aplikasi dipublikasikan.** Password admin dibuat saat pertama kali aplikasi dijalankan; mengganti `.env` setelah admin sudah ada tidak otomatis mengganti hash password di database.

Database dibuat otomatis di `data/loewi_race7.db`. Seed peserta awal hanya dilakukan jika tabel peserta kosong. Data akan tetap ada setelah server direstart selama folder `data` tidak dihapus.

## Fitur
- Leaderboard publik, pencarian, filter level, pagination.
- Login/logout admin.
- Tambah, edit nama/level, atur total poin atau tambah/kurangi poin, hapus peserta.
- Riwayat perubahan poin dan audit log.
- Ekspor CSV, PDF, dan backup database SQLite.
- Server memeriksa session admin dan CSRF token pada endpoint mutasi.

## Endpoint utama
- `GET /api/participants` — daftar publik
- `GET /api/levels` — daftar level
- `POST /api/login`, `POST /api/logout`
- `POST /api/participants`
- `PUT /api/participants/:id`
- `PATCH /api/participants/:id/points`
- `DELETE /api/participants/:id`
- `GET /api/history`, `GET /api/audit`
- `GET /api/export.csv`, `/api/export.pdf`, `/api/backup`

Semua endpoint mutasi data mewajibkan sesi admin dan header `x-csrf-token` yang diberikan setelah login.

## Catatan deployment
Untuk dipakai banyak perangkat melalui internet:
- Host di server yang dapat diakses publik dengan disk persisten.
- Gunakan HTTPS dan `NODE_ENV=production`.
- Isi `SESSION_SECRET` dengan nilai acak yang panjang.
- Gunakan reverse proxy HTTPS (misalnya Caddy/Nginx) dan atur kepercayaan proxy dengan benar bila diperlukan.
- Backup database secara berkala.
- SQLite cocok untuk aplikasi kecil dengan satu server. Jangan jalankan beberapa instance aplikasi yang menulis ke file database berbeda.
- Express MemoryStore untuk session adalah penyimpanan sesi bawaan yang sesuai untuk pengembangan/demo, bukan deployment skala produksi. Untuk produksi, ganti session store dengan store persisten yang sesuai.


## Publikasikan ke internet (Render)

Proyek ini sudah menyertakan `render.yaml` untuk deployment di Render dengan disk persisten agar file SQLite tidak hilang saat server restart/deploy. Disk persisten Render umumnya memerlukan paket berbayar.

1. Upload folder proyek ini ke repository GitHub baru (jangan upload `.env`, `node_modules`, atau file database).
2. Masuk ke https://render.com dan hubungkan repository GitHub tersebut.
3. Pilih **New + → Blueprint** lalu pilih repository yang berisi `render.yaml`.
4. Saat diminta, isi `ADMIN_PASSWORD` dengan password admin yang kuat. `SESSION_SECRET` dibuat otomatis oleh Render.
5. Deploy dan tunggu sampai status layanan menjadi Live. Render akan memberikan URL HTTPS seperti `https://nama-layanan.onrender.com`.
6. Buka URL tersebut dari HP atau komputer mana pun. Semua perangkat mengakses database SQLite yang sama pada disk persisten server.

Catatan: `ADMIN_PASSWORD` hanya digunakan untuk membuat admin pertama kali. Jika admin sudah pernah dibuat, mengganti environment variable saja tidak mengubah password yang tersimpan; lakukan perubahan password melalui mekanisme admin yang tersedia atau reset database hanya jika memang ingin menghapus seluruh data. Jangan menggunakan `localhost` sebagai URL publik.
