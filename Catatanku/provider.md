# Provider AI di Hivekeep — Panduan & Catatan

Daftar lengkap provider LLM yang didukung Hivekeep, cara menambahkannya, dan catatan dari hasil pengecekan kode.

---

## Daftar Provider Built-in

Semua provider di bawah sudah terdaftar di `src/server/llm/llm/register.ts` dan `src/shared/provider-metadata.ts`. Tinggal tambahkan API key, tidak perlu install plugin.

| Provider | Type ID | API Key URL |
|---|---|---|
| **Anthropic** | `anthropic` | https://console.anthropic.com/settings/keys |
| **Anthropic (Claude Max)** | `anthropic-oauth` | OAuth, tanpa key manual |
| **OpenAI** | `openai` | https://platform.openai.com/api-keys |
| **OpenAI Codex CLI** | `openai-codex` | OAuth, tanpa key manual |
| **Google Gemini** | `gemini` | https://aistudio.google.com/apikey |
| **OpenRouter** | `openrouter` | https://openrouter.ai/keys |
| **xAI (Grok)** | `xai` | https://console.x.ai |
| **DeepSeek** | `deepseek` | https://platform.deepseek.com/api_keys |
| **MiniMax** | `minimax` | https://platform.minimax.io/user-center/basic-information/interface-key |
| **Moonshot / Kimi** | `moonshot` | https://platform.moonshot.ai/console/api-keys |
| **OpenAI-compatible** | `openai-compatible` | Base URL + API key bebas (BYO-endpoint) |

---

## Cara Menambahkan Provider

> **Penting**: Halaman "Manage your provider connections" menampilkan provider yang **sudah dikonfigurasi di database**, bukan daftar built-in yang tersedia. Kalau belum pernah menambahkan provider, halaman ini akan kosong ("No results found") — itu normal. Klik **"Add provider"** untuk menambahkan.

1. Buka **http://localhost:4178** → login (`admin@local.test` / `Password123!`)
2. Masuk ke **Settings → Providers**
3. Klik **"Add provider"** (tombol di pojok kanan atas)
4. Pilih provider dari dropdown (misal: **DeepSeek**)
5. Masukkan API key dari URL penyedia
6. Klik **Save** — model otomatis di-sync dari API provider
7. Provider siap dipakai Agent

---

## Catatan Khusus Per Provider

### DeepSeek ✅

- Built-in penuh — tidak perlu konfigurasi tambahan
- API key gratis dari https://platform.deepseek.com/api_keys
- Model di-sync otomatis dari API (tidak hardcode)
- Model flagship: `deepseek-chat`, `deepseek-reasoner`

### MiniMax ✅

- Provider built-in untuk model AI dari MiniMax (China)
- API key: https://platform.minimax.io/user-center/basic-information/interface-key
- Sering disangka "Mimo" — tapi ini MiniMax, bukan Xiaomi MiMo

### MiMo / Xiaomi ❌

- **Tidak ada sebagai built-in** — MiMo adalah model proprietary Xiaomi (小米大模型) yang belum menyediakan API publik
- MiMo saat ini hanya dipakai internal di ekosistem Xiaomi (asisten XiaoAi, HP, smart home)
- **Kalau nanti Xiaomi rilis API publik format OpenAI**, bisa via provider `openai-compatible`

### OpenAI-compatible (BYO-endpoint)

Provider generik untuk API manapun yang mengikuti format OpenAI:

```
Base URL:    https://api.example.com/v1   (endpoint server)
API Key:     sk-...                       (opsional, kosongkan kalau server lokal)
```

**Didukung**: NewAPI, LiteLLM, llama.cpp (`llama-server`), LM Studio, vLLM, Ollama (OpenAI shim), dan gateway sejenis.

Cara kerjanya: Hivekeep append `/chat/completions` dan `/models` ke Base URL, jadi pastikan endpoint menyediakan kedua endpoint tersebut.

---

## Provider Non-LLM

Selain LLM, Hivekeep juga mendukung provider untuk capability lain:

| Capability | Provider Built-in |
|---|---|
| **Embedding** | OpenAI |
| **Image generation** | OpenAI, Google Gemini |
| **TTS (Text-to-Speech)** | OpenAI |
| **STT (Speech-to-Text)** | OpenAI |
| **Web Search** | Brave, SerpAPI, Tavily, Perplexity Sonar |

---

## Verifikasi Provider Terdaftar

Cek langsung di database atau API:

```bash
# Cek endpoint models (setelah provider dikonfigurasi)
curl -s http://localhost:4178/api/providers | jq .

# Cek provider yang sudah ada di seed database
sqlite3 /tmp/hk-test-39223/hivekeep.db "SELECT type, slug, name, is_valid, last_error FROM providers;"
```

---

## Troubleshooting: "No results found"

### Kenapa muncul "No results found" di halaman Providers?

Halaman **"Manage your provider connections"** hanya menampilkan provider yang **sudah dikonfigurasi** (data dari tabel `providers` di DB), bukan daftar built-in provider types yang tersedia.

Saat ini isi database cuma:

```
type: anthropic-oauth
name: Claude (subscription)
is_valid: 0  ← tidak valid
last_error: undefined is not an object (evaluating 'oauth.expiresAt')
```

Karena `is_valid=0`, UI memfilternya → hasilnya **"No results found"**. Ini normal, bukan bug.

### Solusi

Klik tombol **"Add provider"** (pojok kanan atas) → akan muncul form dengan dropdown semua built-in provider types (DeepSeek, OpenAI, Gemini, dll.).

### Perbedaan dua UI element

| UI Element | Isi | Lokasi Data |
|---|---|---|
| **"Manage your provider connections"** (daftar/tabel) | Provider yang sudah dikonfigurasi | Tabel `providers` di DB |
| **"Add provider"** (dropdown/form) | Semua built-in + plugin provider types | `PROVIDER_META` + plugin registry (in-memory) |

---

## Catatan Teknis

- **Model list** selalu di-fetch dari API provider — tidak ada hardcode model ID
- **Klasifikasi model** (capability, context window, vision) dari metadata API, fallback ke heuristik nama
- **Thinking/Reasoning effort** hanya di-advertise kalau model benar-benar menerima `reasoning_effort` parameter
- **Provider config** disimpan di DB table `providers`, bukan di file `.env`
- **API key** masuk ke vault terenkripsi (AES-256-GCM), tidak pernah terekspos ke Agent atau prompt

---

## Referensi File

| File | Isi |
|---|---|
| `src/shared/provider-metadata.ts` | `PROVIDER_META` — single source of truth semua provider |
| `src/server/llm/llm/register.ts` | `registerBuiltinLLMProviders()` — registrasi provider |
| `src/server/llm/llm/deepseek.ts` | Implementasi provider DeepSeek |
| `src/server/llm/llm/minimax.ts` | Implementasi provider MiniMax |
| `src/server/llm/llm/openai-compatible.ts` | Implementasi provider BYO-endpoint |
