# Rencana Rename: Hivekeep → Gezy

Dokumen perencanaan lengkap untuk mengganti seluruh identitas "Hivekeep" menjadi "Gezy" di semua level codebase.

---

## Ringkasan Eksekutif

| Aspek | Nilai Saat Ini | Nilai Baru |
|---|---|---|
| Nama project | `hivekeep` | `gezy` |
| Nama tampilan | Hivekeep | Gezy |
| Prefix env var | `HIVEKEEP_` | `GEZY_` |
| Package SDK | `@hivekeep/sdk` | `@gezy/sdk` |
| Package scaffolder | `create-hivekeep-plugin` | `create-gezy-plugin` |
| Default DB file | `hivekeep.db` | `gezy.db` |
| Default data dir | `./data` (tidak berubah) | `./data` (tidak berubah) |
| Lisensi | MIT (marlburrow) | MIT (marlburrow + Anda) |

> **Penting**: File `LICENSE` dengan copyright asli `marlburrow` **HARUS dipertahankan**. Tambahkan copyright Anda di bawahnya.

---

## Fase Pengerjaan

### Fase 0: Persiapan

1. **Buat branch baru**
   ```bash
   cd ~/dev/gezyhive
   git checkout -b rename/gezy
   ```

2. **Pastikan semua test pass sebelum rename**
   ```bash
   bun run typecheck
   bun run test
   ```

3. **Backup database development**
   ```bash
   cp ~/.local/share/hivekeep-dev/hivekeep.db ~/.local/share/hivekeep-dev/hivekeep.db.bak
   ```

---

### Fase 1: Core Identity — WAJIB

Tanpa ini aplikasi tidak bisa jalan.

#### 1A. Root `package.json`

**File**: `gezyhive/package.json`

```diff
- "name": "hivekeep",
+ "name": "gezy",
- "description": "Self-hosted platform of specialized AI agents...",
+ "description": "Self-hosted AI agent platform — Gezy",
- "homepage": "https://marlburrow.github.io/hivekeep",
+ "homepage": "https://github.com/(repo-anda)",
- "repository": { "url": "https://github.com/MarlBurroW/hivekeep.git" },
+ "repository": { "url": "https://github.com/(repo-anda)" },
- "bugs": { "url": "https://github.com/MarlBurroW/hivekeep/issues" },
+ "bugs": { "url": "https://github.com/(repo-anda)/issues" },
- "hivekeep",
+ "gezy",
- "@hivekeep/sdk": "workspace:*"
+ "@gezy/sdk": "workspace:*"
```

#### 1B. Workspace packages

| File | Field | Lama | Baru |
|---|---|---|---|
| `packages/sdk/package.json` | `name` | `@hivekeep/sdk` | `@gezy/sdk` |
| `packages/sdk/package.json` | `description` | `...for Hivekeep` | `...for Gezy` |
| `packages/sdk/package.json` | `homepage` | `...hivekeep` | (URL Anda) |
| `packages/sdk/package.json` | `keywords` | `hivekeep` | `gezy` |
| `packages/create-hivekeep-plugin/package.json` | `name` | `create-hivekeep-plugin` | `create-gezy-plugin` |
| `packages/create-hivekeep-plugin/package.json` | `bin` | `create-hivekeep-plugin` | `create-gezy-plugin` |
| `packages/create-hivekeep-plugin/package.json` | `description` | `...Hivekeep plugin` | `...Gezy plugin` |

#### 1C. Rename import `@hivekeep/sdk` → `@gezy/sdk` di seluruh server

**Jumlah file**: ~60 file di `src/server/`

Jalankan grep-replace:
```bash
cd ~/dev/gezyhive
grep -rl "@hivekeep/sdk" src/server/ packages/ | xargs sed -i 's/@hivekeep\/sdk/@gezy\/sdk/g'
```

#### 1D. `src/server/config.ts` — Semua env var prefix

**File**: `gezyhive/src/server/config.ts`

Ganti **semua** `HIVEKEEP_` → `GEZY_` (case-sensitive, exact match prefix). Jumlah: ~35 kemunculan.

| Env Var Lama | Env Var Baru |
|---|---|
| `HIVEKEEP_DATA_DIR` | `GEZY_DATA_DIR` |
| `HIVEKEEP_VERSION` | `GEZY_VERSION` |
| `HIVEKEEP_ENV_FILE` | `GEZY_ENV_FILE` |
| `HIVEKEEP_TIMEZONE` | `GEZY_TIMEZONE` |
| `HIVEKEEP_MODEL_REGISTRY` | `GEZY_MODEL_REGISTRY` |
| `HIVEKEEP_FEEDBACK_ENDPOINT` | `GEZY_FEEDBACK_ENDPOINT` |
| `HIVEKEEP_FEEDBACK_MAX_LENGTH` | `GEZY_FEEDBACK_MAX_LENGTH` |
| `HIVEKEEP_FEEDBACK_PROMPT_AFTER_DAYS` | `GEZY_FEEDBACK_PROMPT_AFTER_DAYS` |
| `HIVEKEEP_FEEDBACK_PROMPT_MIN_MESSAGES` | `GEZY_FEEDBACK_PROMPT_MIN_MESSAGES` |
| `HIVEKEEP_FEEDBACK_SNOOZE_DAYS` | `GEZY_FEEDBACK_SNOOZE_DAYS` |
| `HIVEKEEP_ADAPTIVE_THINKING` | `GEZY_ADAPTIVE_THINKING` |
| `HIVEKEEP_MAX_TOOL_USE_CONCURRENCY` | `GEZY_MAX_TOOL_USE_CONCURRENCY` |
| `HIVEKEEP_SHELL_TIMEOUT` | `GEZY_SHELL_TIMEOUT` |
| `HIVEKEEP_SHELL_MAX_TIMEOUT` | `GEZY_SHELL_MAX_TIMEOUT` |
| `HIVEKEEP_REPOS_DIR` | `GEZY_REPOS_DIR` |
| `HIVEKEEP_CLONE_TIMEOUT_SEC` | `GEZY_CLONE_TIMEOUT_SEC` |
| `HIVEKEEP_WORKTREE_KEEP_FAILED_SEC` | `GEZY_WORKTREE_KEEP_FAILED_SEC` |
| `HIVEKEEP_WORKTREE_SWEEP_INTERVAL_MIN` | `GEZY_WORKTREE_SWEEP_INTERVAL_MIN` |
| `HIVEKEEP_TERMINAL_ENABLED` | `GEZY_TERMINAL_ENABLED` |
| `HIVEKEEP_TERMINAL_SHELL` | `GEZY_TERMINAL_SHELL` |
| `HIVEKEEP_TERMINAL_SCROLLBACK_KB` | `GEZY_TERMINAL_SCROLLBACK_KB` |
| `HIVEKEEP_TERMINAL_DETACHED_TTL_SEC` | `GEZY_TERMINAL_DETACHED_TTL_SEC` |
| `HIVEKEEP_TERMINAL_MAX_SESSIONS` | `GEZY_TERMINAL_MAX_SESSIONS` |
| `HIVEKEEP_CUSTOM_TOOLS_DIR` | `GEZY_CUSTOM_TOOLS_DIR` |
| `HIVEKEEP_CUSTOM_TOOL_TIMEOUT` | `GEZY_CUSTOM_TOOL_TIMEOUT` |
| `HIVEKEEP_CUSTOM_TOOL_MAX_TIMEOUT` | `GEZY_CUSTOM_TOOL_MAX_TIMEOUT` |
| `HIVEKEEP_CUSTOM_TOOL_MAX_OUTPUT_BYTES` | `GEZY_CUSTOM_TOOL_MAX_OUTPUT_BYTES` |
| `HIVEKEEP_CUSTOM_TOOL_SETUP_TIMEOUT` | `GEZY_CUSTOM_TOOL_SETUP_TIMEOUT` |
| `HIVEKEEP_PUBLIC_URL` | `GEZY_PUBLIC_URL` |
| `HIVEKEEP_GIT_SHA` | `GEZY_GIT_SHA` |
| `HIVEKEEP_GITHUB_REPO_URL` | `GEZY_GITHUB_REPO_URL` |

Juga di comment & string:
```diff
- /** Read version from HIVEKEEP_VERSION... */
+ /** Read version from GEZY_VERSION... */

- // launchd service name check
- if (process.env.XPC_SERVICE_NAME && process.env.XPC_SERVICE_NAME.includes('hivekeep'))
+ if (process.env.XPC_SERVICE_NAME && process.env.XPC_SERVICE_NAME.includes('gezy'))

- systemd user service
- 'hivekeep.service'
+ 'gezy.service'
```

#### 1E. Database default path

**File**: `gezyhive/src/server/config.ts`

```diff
- path: process.env.DB_PATH ?? `${dataDir}/hivekeep.db`,
+ path: process.env.DB_PATH ?? `${dataDir}/gezy.db`,
```

#### 1F. Default data dir paths

```diff
- const xdgEnv = resolve(os.homedir(), '.local', 'share', 'hivekeep', 'hivekeep.env')
+ const xdgEnv = resolve(os.homedir(), '.local', 'share', 'gezy', 'gezy.env')
```

---

### Fase 2: Docker — WAJIB (jika pakai Docker)

#### 2A. Dockerfile

**File**: `gezyhive/docker/Dockerfile`

```diff
- LABEL org.opencontainers.image.title="Hivekeep"
+ LABEL org.opencontainers.image.title="Gezy"

- LABEL org.opencontainers.image.description="Self-hosted AI agents..."
+ LABEL org.opencontainers.image.description="Gezy — self-hosted AI agents..."

- LABEL org.opencontainers.image.url="https://github.com/MarlBurroW/hivekeep"
+ LABEL org.opencontainers.image.url="https://github.com/(repo-anda)"

- LABEL org.opencontainers.image.source="https://github.com/MarlBurroW/hivekeep"
+ LABEL org.opencontainers.image.source="https://github.com/(repo-anda)"

- RUN groupadd --gid 1001 hivekeep && \
-     useradd --uid 1001 --gid hivekeep --shell /bin/sh --create-home hivekeep
+ RUN groupadd --gid 1001 gezy && \
+     useradd --uid 1001 --gid gezy --shell /bin/sh --create-home gezy

- RUN mkdir -p /app/data && chown -R hivekeep:hivekeep /app/data
+ RUN mkdir -p /app/data && chown -R gezy:gezy /app/data

- ENV HIVEKEEP_DATA_DIR=/app/data
+ ENV GEZY_DATA_DIR=/app/data

- ENV HIVEKEEP_GIT_SHA=$GIT_SHA
+ ENV GEZY_GIT_SHA=$GIT_SHA

- gosu hivekeep
+ gosu gezy

- @hivekeep/sdk
+ @gezy/sdk
```

#### 2B. Docker Compose

**File**: `gezyhive/docker/docker-compose.yml`

```diff
- container_name: hivekeep
+ container_name: gezy

- - hivekeep-data:/app/data
+ - gezy-data:/app/data

- hivekeep-data:
+ gezy-data:
```

#### 2C. Entrypoint script

**File**: `gezyhive/docker/entrypoint.sh`

Ganti semua `hivekeep` → `gezy`, `HIVEKEEP_` → `GEZY_`.

---

### Fase 3: Kode Server — WAJIB

#### 3A. Plugin manager — versi dan kompatibilitas

**File**: `gezyhive/src/server/services/plugins.ts`

```diff
- private hivekeepVersion: string | null = null
+ private gezyVersion: string | null = null

- private async getHivekeepVersion(): Promise<string> {
+ private async getGezyVersion(): Promise<string> {

- if (m.hivekeep !== undefined) {
+ if (m.gezy !== undefined) {

- if (typeof m.hivekeep !== 'string') {
+ if (typeof m.gezy !== 'string') {

- error: `Requires Hivekeep ${manifest.hivekeep} ...`
+ error: `Requires Gezy ${manifest.gezy} ...`

- JSON.stringify({ name: 'hivekeep-plugin-install', private: true })
+ JSON.stringify({ name: 'gezy-plugin-install', private: true })

- JSON.stringify({ name: 'hivekeep-plugin-update', private: true })
+ JSON.stringify({ name: 'gezy-plugin-update', private: true })
```

#### 3B. Feedback endpoint (telemetry)

**File**: `gezyhive/src/server/config.ts`

```diff
- process.env.HIVEKEEP_FEEDBACK_ENDPOINT ??
- 'https://hivekeep-feedback.hivekeep.workers.dev/feedback',
+ process.env.GEZY_FEEDBACK_ENDPOINT ?? '',
```
> Rekomendasi: kosongkan default feedback URL karena instance Anda bukan Hivekeep official.

---

### Fase 4: File Pendukung

#### 4A. `scripts/dev-server.ts` — (cek apakah ada referensi)

```bash
grep -n "hivekeep\|HIVEKEEP" scripts/dev-server.ts
```

#### 4B. `scripts/migrate.ts`, `scripts/seed-test-db.ts`, `scripts/db-snapshot.ts`

`seed-test-db.ts`:
```diff
- const DATA_DIR = process.env.TESTDATA_DIR || join(homedir(), '.local/share/hivekeep-testdata')
+ const DATA_DIR = process.env.TESTDATA_DIR || join(homedir(), '.local/share/gezy-testdata')
```

#### 4C. `src/server/update/` — self-update system

```bash
grep -rn "hivekeep" src/server/update/
```
Ganti referensi ke upstream repo jika ada.

#### 4D. `src/shared/constants.ts` dan `src/shared/types.ts`

```bash
grep -n "hivekeep\|HIVEKEEP" src/shared/
```
Kemungkinan kecil ada, tapi cek untuk aman.

---

### Fase 5: Frontend & UI — REKOMENDASI

#### 5A. Judul halaman / PWA name

**File**: `gezyhive/src/client/index.html`

```diff
- <title>Hivekeep</title>
+ <title>Gezy</title>
```

#### 5B. PWA manifest

```bash
grep -rn "Hivekeep\|hivekeep" src/client/public/
```

#### 5C. i18n Locale files

Lokasi: `src/client/locales/*/`

Dari hasil grep, tidak ada string "Hivekeep" di file locale. Aman — tidak perlu diubah.

#### 5D. Komponen UI yang menyebut nama app

```bash
grep -rn "Hivekeep" src/client/components/
grep -rn "Hivekeep" src/client/pages/
```

Ganti yang ditemukan dengan "Gezy".

---

### Fase 6: Dokumentasi — OPSIONAL

#### 6A. File dokumentasi utama

| File | Tindakan |
|---|---|
| `README.md` | Ganti Hivekeep → Gezy di judul, deskripsi, link |
| `CLAUDE.md` | Ganti di judul dan referensi |
| `CONTRIBUTING.md` | Ganti referensi project |
| `CODE_OF_CONDUCT.md` | (biasanya tidak ada referensi nama) |

#### 6B. File dokumentasi teknis

```bash
grep -rl "Hivekeep\|hivekeep" *.md | grep -v node_modules
```

Ganti yang relevan. Jangan ubah `testing-instance.md` jika masih referensi ke upstream.

#### 6C. Website landing page (`site/`)

| File | Tindakan |
|---|---|
| `site/package.json` | `"name": "gezy-site"` |
| `site/src/` | Ganti string "Hivekeep" di komponen |

---

### Fase 7: Testing & Verifikasi

#### 7A. Build test

```bash
GEZY_DATA_DIR=/tmp/gezy-test bun run build
```

#### 7B. Run test

```bash
GEZY_DATA_DIR=/tmp/gezy-test PORT=4178 bun src/server/index.ts &
curl http://localhost:4178/api/health
# Harus return: {"status":"ok","version":"1.9.0",...}
```

#### 7C. Unit tests

```bash
bun run test
```

#### 7D. Type check

```bash
bun run typecheck
```

---

### Fase 8: Update Config di Mesin Development

Setelah rename selesai, update environment variables di command startup dan file `memulai.md`:

```bash
# Startup command baru
GEZY_DATA_DIR=/path/to/data \
GEZY_MODEL_REGISTRY=false \
GEZY_PUBLIC_URL=http://localhost:4178 \
PORT=4178 \
bun src/server/index.ts
```

---

## Checklist Eksekusi

### Level 1 — Wajib (aplikasi harus jalan)

- [ ] `package.json` root: name, description, deps SDK
- [ ] `packages/sdk/package.json`: name
- [ ] `packages/create-hivekeep-plugin/package.json`: name
- [ ] `src/server/config.ts`: semua `HIVEKEEP_` → `GEZY_` (~35 tempat)
- [ ] `src/server/config.ts`: `hivekeep.db` → `gezy.db`
- [ ] `src/server/config.ts`: path XDG `hivekeep` → `gezy`
- [ ] `src/server/config.ts`: service name `hivekeep` → `gezy`
- [ ] `src/server/services/plugins.ts`: versi, kompatibilitas, string
- [ ] Semua `import ... from '@hivekeep/sdk'` → `'@gezy/sdk'`
- [ ] `docker/Dockerfile`: LABEL, user, env vars, SDK ref
- [ ] `docker/docker-compose.yml`: container name, volume
- [ ] `docker/entrypoint.sh`: env vars, paths
- [ ] `scripts/seed-test-db.ts`: default data dir path

### Level 2 — Rekomendasi

- [ ] `src/client/index.html`: `<title>`
- [ ] `src/client/public/`: PWA manifest
- [ ] Komponen UI yang menyebut "Hivekeep"
- [ ] Feedback URL default di `config.ts`

### Level 3 — Opsional

- [ ] `README.md`, `CLAUDE.md`, doc files
- [ ] `site/` landing page
- [ ] `Catatanku/memulai.md`: update env vars
- [ ] `Catatanku/provider.md`: (tidak ada ref nama app)
- [ ] `Catatanku/bottelegram.md`: (tidak ada ref nama app)

---

## Perintah Grep-Replace (untuk eksekusi cepat)

```bash
cd ~/dev/gezyhive
git checkout -b rename/gezy

# 1. SDK import
grep -rl "@hivekeep/sdk" src/ packages/ --include="*.ts" --include="*.tsx" | xargs sed -i 's/@hivekeep\/sdk/@gezy\/sdk/g'

# 2. Env var prefix (config.ts)
sed -i 's/HIVEKEEP_/GEZY_/g' src/server/config.ts

# 3. Database filename
sed -i 's/hivekeep\.db/gezy.db/g' src/server/config.ts

# 4. File paths di config.ts
sed -i 's/\/hivekeep\//\/gezy\//g' src/server/config.ts
sed -i 's/\/hivekeep"/\/gezy"/g' src/server/config.ts

# 5. Plugin manager strings
sed -i 's/hivekeepVersion/gezyVersion/g' src/server/services/plugins.ts
sed -i 's/getHivekeepVersion/getGezyVersion/g' src/server/services/plugins.ts
sed -i 's/Requires Hivekeep/Requires Gezy/g' src/server/services/plugins.ts
sed -i "s/'hivekeep-plugin-install'/'gezy-plugin-install'/g" src/server/services/plugins.ts
sed -i "s/'hivekeep-plugin-update'/'gezy-plugin-update'/g" src/server/services/plugins.ts

# 6. Script files
sed -i 's/hivekeep-testdata/gezy-testdata/g' scripts/seed-test-db.ts

# 7. Docker files
sed -i 's/Hivekeep/Gezy/g' docker/Dockerfile
sed -i 's/hivekeep/gezy/g' docker/Dockerfile
sed -i 's/HIVEKEEP_/GEZY_/g' docker/Dockerfile
sed -i 's/hivekeep/gezy/g' docker/docker-compose.yml
sed -i 's/hivekeep/gezy/g' docker/entrypoint.sh
sed -i 's/HIVEKEEP_/GEZY_/g' docker/entrypoint.sh

# 8. UI title
sed -i 's/>Hivekeep</>Gezy</g' src/client/index.html
```

---

## Rollback Plan

Jika terjadi masalah setelah rename:

```bash
git checkout main  # atau nama branch asli
git branch -D rename/gezy
```

---

## Estimasi Waktu

| Fase | Waktu |
|---|---|
| Fase 0 (persiapan) | 5 menit |
| Fase 1 (core identity) | 30 menit |
| Fase 2 (Docker) | 10 menit |
| Fase 3 (kode server) | 15 menit |
| Fase 4 (file pendukung) | 10 menit |
| Fase 5 (frontend) | 10 menit |
| Fase 6 (dokumentasi) | 15 menit |
| Fase 7 (testing) | 15 menit |
| **Total** | **~2 jam** |
