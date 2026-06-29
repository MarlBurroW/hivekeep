# Memulai Hivekeep — Panduan Cepat

Panduan menjalankan **Hivekeep** (v1.9.0) di mesin development ini. Hivekeep adalah platform self-hosted untuk tim AI Agent dengan memori persisten, kolaborasi multi-agent, dan tools.

---

## Spesifikasi & Prasyarat

| Kebutuhan | Detail |
|---|---|
| **Runtime** | Bun 1.3.13 (terinstall di `/home/pgun/.bun/bin/bun`) |
| **Node** | v22.22.2 |
| **CPU** | 1 core cukup (x86-64 / ARM64) |
| **RAM** | ~512 MB minimum, 1 GB+ nyaman |
| **Disk** | ~1 GB (aplikasi + database SQLite) |
| **GPU** | Tidak diperlukan (LLM inferensi di provider eksternal) |
| **Docker** | Opsional — tersedia v29.1.3 |

> **Catatan**: Hivekeep tidak menjalankan model AI secara lokal. Semua inferensi dikirim ke API provider eksternal (OpenAI, Anthropic, DeepSeek, dll.).

---

## Menjalankan Server

### 1. Pastikan dependencies terinstall

```bash
cd ~/dev/gezyhive
bun install
```

### 2. Siapkan database seed (opsional — untuk testing)

Database seed menyediakan admin user, contacts, dan vault secrets siap pakai:

```bash
bun scripts/seed-test-db.ts
# Output di: ~/.local/share/hivekeep-testdata/
```

### 3. Build frontend

```bash
bun run build
# Output di: dist/client/
```

### 4. Jalankan server

```bash
cd ~/dev/gezyhive

nohup env \
  NODE_ENV=production \
  DB_PATH=/tmp/hk-test-39223/hivekeep.db \
  HIVEKEEP_DATA_DIR=/tmp/hk-test-39223 \
  PORT=4178 \
  PUBLIC_URL=http://localhost:4178 \
  HIVEKEEP_PUBLIC_URL=http://localhost:4178 \
  TRUSTED_ORIGINS=http://localhost:4178 \
  HIVEKEEP_MODEL_REGISTRY=false \
  NODE_OPTIONS=--max-old-space-size=4096 \
  bun src/server/index.ts \
  > /tmp/hivekeep-server.log 2>&1 &

# Simpan PID
echo $! > /tmp/hivekeep-server.pid
```

> **Mengapa port 4178?** Port 3000 sudah dipakai `gezydoc-app` (production). Override `PORT` dan `TRUSTED_ORIGINS` agar tidak bentrok.

### 5. Verifikasi

```bash
# Health check API
curl -s http://localhost:4178/api/health
# → {"status":"ok","version":"1.9.0",...}

# Frontend
curl -s http://localhost:4178/ | head -3
# → <!DOCTYPE html>...
```

---

## Login

| Field | Nilai |
|---|---|
| **URL** | http://localhost:4178 |
| **Email** | `admin@local.test` |
| **Password** | `Password123!` |

---

## Yang Sudah Tersedia di Seed Database

- ✅ 269 native tools terdaftar
- ✅ 9 built-in toolboxes
- ✅ 1 admin user (`admin@local.test`)
- ✅ 25 kontak, 12 vault secrets, 10 webhooks
- ❌ **Belum ada AI provider** — tidak bisa chat sampai ditambahkan

---

## Menambahkan AI Provider

1. Buka **http://localhost:4178** → login
2. Masuk ke **Settings → Providers**
3. Tambahkan API key provider LLM (OpenAI, Anthropic, DeepSeek, Groq, Google, dll.)
4. Queenie (Agent konfigurator) akan memandu setup secara percakapan

**Provider yang didukung**: OpenAI, Anthropic, DeepSeek, Groq, xAI, Google Gemini, OpenRouter, Mistral, Together AI, Perplexity, dan banyak lagi.

---

## Menghentikan Server

```bash
# Cara aman — via PID yang disimpan
kill $(cat /tmp/hivekeep-server.pid)

# Atau langsung kill proses bun di port 4178
fuser -k 4178/tcp
```

---

## Menjalankan Ulang (Setelah Reboot)

Karena data di `/tmp/` akan hilang saat reboot, simpan setup persisten:

```bash
# 1. Buat direktori data persisten
mkdir -p ~/.local/share/hivekeep-dev

# 2. Generate seed database di lokasi persisten
TESTDATA_DIR=~/.local/share/hivekeep-dev bun scripts/seed-test-db.ts

# 3. Jalankan server dengan data persisten
cd ~/dev/gezyhive

nohup env \
  NODE_ENV=production \
  DB_PATH=$HOME/.local/share/hivekeep-dev/hivekeep.db \
  HIVEKEEP_DATA_DIR=$HOME/.local/share/hivekeep-dev \
  PORT=4178 \
  PUBLIC_URL=http://localhost:4178 \
  HIVEKEEP_PUBLIC_URL=http://localhost:4178 \
  TRUSTED_ORIGINS=http://localhost:4178 \
  HIVEKEEP_MODEL_REGISTRY=false \
  NODE_OPTIONS=--max-old-space-size=4096 \
  bun src/server/index.ts \
  > /tmp/hivekeep-server.log 2>&1 &

echo $! > /tmp/hivekeep-server.pid
```

---

## Perintah Cepat (Cheat Sheet)

```bash
# Cek server jalan?
curl -s http://localhost:4178/api/health

# Lihat log server
tail -f /tmp/hivekeep-server.log

# Cek proses
ps aux | grep "src/server/index.ts" | grep -v grep

# Restart server
fuser -k 4178/tcp && sleep 2
# ... lalu jalankan ulang perintah start di atas
```

---

## Troubleshooting

| Masalah | Solusi |
|---|---|
| Port 4178 sudah dipakai | `fuser -k 4178/tcp` lalu jalankan ulang |
| Frontend 404 | Pastikan `NODE_ENV=production` dan `dist/client/index.html` ada (jalankan `bun run build` dulu) |
| Tidak bisa login | Seed database mungkin corrupt — regenerate dengan `FRESH=1 bun scripts/seed-test-db.ts` |
| Typecheck / build OOM | Tambahkan `NODE_OPTIONS=--max-old-space-size=8192` |
| Gagal build | Pastikan `bun install` sudah dijalankan |

---

## Arsitektur Singkat

```
Browser (localhost:4178)
        │
        ▼
   Hono Server (Bun)
   ├── API Routes (/api/*)
   ├── Static Files (dist/client/)
   ├── SQLite DB (hivekeep.db)
   ├── SSE Manager (real-time)
   ├── Queue Worker (Agent message processing)
   └── Cron Scheduler
        │
        ▼
   External LLM Providers (OpenAI, Anthropic, dll.)
```
