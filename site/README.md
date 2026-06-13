# Hivekeep — marketing site

Astro + Tailwind. Design direction: **"app skin + editorial bones"** (see `../hivekeep-1.0-design-directions.md`, tour 3) — keeps the Hivekeep app's aurora/glass/glow identity but uses an editorial structure (numbered sections, mono metadata, product-like panels, captioned figures) so it never reads as "AI-generated".

## Commands
```bash
cd site
bun install
bun run dev      # local dev (http://localhost:4321/hivekeep)
bun run build    # static output -> dist/
bun run preview  # serve the build
```
Deployed as a GitHub Pages **project site** at `https://marlburrow.github.io/hivekeep/` (hence `base: '/hivekeep'` in `astro.config.mjs`).

## Where to drop your assets

**1. Avatars (JSON + images)** — `src/agents.json` (kept out of a `data/` folder on purpose: the repo's root `.gitignore` ignores `data/`)
Each entry: `{ "name": string, "domain": string, "avatar": string | null, "status"?: "online" | "working" | "idle" }`
- Put avatar images in `public/avatars/` and set `"avatar": "/avatars/atlas.png"`.
- `null` avatar → a themed placeholder robot is shown automatically.
- `status` (optional) only affects the hero "// your agents" panel (first 5 entries).
- `name` + `domain` appear in the hero panel **and** the "household" directory.

**2. Screenshots** — `public/screens/`
Used in captioned figures (e.g. `Fig. 2 — a tool renders as UI`). They render with an automatic **feathered/blended** edge (no hard frame). Replace the placeholder block in `src/pages/index.astro` with an `<img src={...} />`. Suggested first shots: a custom-tool render (weather card), the context/token view, a mini-app.

**3. Provider / channel logos**
Channels use `simple-icons` via `astro-icon` (already wired). AI provider logos in the Hivekeep app use `@lobehub/icons` (color) — if you want those exact marks, drop SVGs into `public/providers/` or we add a small React island later.

## Notes
- Icons: `astro-icon` with `lucide` (UI) + `simple-icons` (brands).
- Fonts: Plus Jakarta Sans (app font) + JetBrains Mono (metadata), via Google Fonts.
- All design tokens live in `src/styles/global.css` and mirror the app's aurora palette.

## Analytics (self-hosted Umami)
Privacy-friendly, **cookieless** analytics (no consent banner needed),
self-hosted so no data leaves your infra. The tracker script is injected in
`src/layouts/Base.astro` and only ships in the **production build**
(`import.meta.env.PROD`), so `bun run dev` never tracks. It renders **only when
configured**, so the build stays clean before Umami exists.

Configuration lives in `src/config/analytics.ts` (`UMAMI_SCRIPT_URL` +
`UMAMI_WEBSITE_ID`). Neither value is secret (both ship in the page HTML); they
can also be set via `PUBLIC_UMAMI_SCRIPT_URL` / `PUBLIC_UMAMI_WEBSITE_ID` env at
build time. Leave either empty to disable analytics entirely.

What you get:
- Pageviews, top pages, countries, devices.
- **Referrers + UTM campaigns** (`?utm_source=...&utm_campaign=...`), auto-parsed
  by Umami - answers "which campaign drove traffic".
- A custom **`Install Copy`** event (`umami.track('Install Copy', { source })`)
  fired whenever a visitor copies an install command (home one-liner, /install
  card, or the configurator - the `source` field says which). Measures install
  *intent* per campaign, not just visits.

### Standing up Umami
Umami must be reachable from visitors' browsers over HTTPS (the `script.js` is
loaded client-side), so put it on a public host behind a TLS reverse proxy. A
minimal Docker stack:

```yaml
services:
  umami:
    image: ghcr.io/umami-software/umami:postgresql-latest
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgresql://umami:umami@db:5432/umami
      DATABASE_TYPE: postgresql
      APP_SECRET: change-me-to-a-long-random-string
    depends_on:
      db: { condition: service_healthy }
    restart: always
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: umami
      POSTGRES_USER: umami
      POSTGRES_PASSWORD: umami
    volumes: ["umami-db:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U umami"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: always
volumes:
  umami-db:
```

Default login is `admin` / `umami` (change it immediately). Add a website
(domain `hivekeep.app`), copy its **Website ID** into `src/config/analytics.ts`,
point `UMAMI_SCRIPT_URL` at `https://<your-umami-host>/script.js`, and redeploy.

Adblockers may block a default `/script.js` path; Umami lets you rename the
script/endpoint (or proxy it under your own domain) if undercounting matters.
