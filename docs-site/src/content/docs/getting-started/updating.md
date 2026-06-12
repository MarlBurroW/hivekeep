---
title: Updating Hivekeep
description: How Hivekeep updates itself — channels, the in-app updater, Docker, and automatic rollback.
---

Hivekeep checks GitHub for new versions periodically and shows a pulsing badge next to the version number in the sidebar when one is available. Clicking it opens a dialog with the **cumulative changelog** (everything between your version and the latest) and the update path that matches how you installed.

Everything on this page also lives in **Settings → Updates**: current version, update channel, manual check, and the outcome of the last update.

## Update channels

| Channel | Follows | For |
|---|---|---|
| **stable** (default) | GitHub releases (`vX.Y.Z` tags) | Everyone |
| **edge** | The latest commit on `main` | Testing unreleased changes |

Admins switch channels in **Settings → Updates**. On the stable channel the changelog shows the release notes of every release you're behind; on edge it lists the new commits on `main`.

## Updating from the UI (install.sh installs)

Installs managed by `install.sh` (systemd, launchd, or the fallback start script) can update themselves with one click. The updater is designed so that **a failed update can never leave you with a dead platform**:

1. **Pre-flight checks** — clean working tree, enough disk space.
2. **Database snapshot** — an atomic SQLite snapshot (`VACUUM INTO`) is taken before anything changes.
3. **Backup** — the current frontend build and git sha are saved.
4. **Download** — the prebuilt frontend attached to the GitHub release is downloaded and sha256-verified (no heavy local build; falls back to building locally if unavailable).
5. **Apply** — the release tag is checked out (stable) or `main` is fast-forwarded (edge), then dependencies are installed.
6. **Restart** — the server restarts into the new version.

Progress is streamed live in the dialog. If the new version fails to start, a boot guard **automatically rolls back**: previous code, previous frontend build, previous dependencies, and the pre-update database snapshot are restored, and the old version restarts. The dialog reports the outcome either way (`success`, `failed` — nothing changed, or `rolled-back`).

You can also update from the command line:

```bash
bash install.sh --update              # respects your current channel
bash install.sh --update --channel stable   # force a channel
```

## Updating Docker installs

A Docker container can't replace its own image, so the UI shows the update (with the changelog) and the command to run instead:

```bash
docker compose pull && docker compose up -d
```

If your compose file pins a specific version tag (e.g. `ghcr.io/marlburrow/hivekeep:1.2.0`), change it to the new version first — or use `:latest` (stable releases) / `:edge` (every push to `main`).

Your data lives in the mounted volume (`/app/data`), so replacing the image is safe.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `VERSION_CHECK_ENABLED` | `true` | Periodic new-version checks |
| `VERSION_CHECK_INTERVAL_HOURS` | `1` | Check interval |
| `VERSION_CHECK_GITHUB_TOKEN` | — | Optional token to lift GitHub's anonymous rate limit |

The update channel is an in-app admin setting, not an environment variable. Self-update state (journal, snapshots, backups, `update.log`) is kept under `data/update/`.

## Recovering manually

The automatic rollback should make this unnecessary, but if you ever need to dig in:

- `data/update/update.log` — a plain-text log of every update and rollback step.
- `data/update/db-snapshots/` — pre-update database snapshots (latest 3).
- `bash install.sh --status` — checks the install health and whether an update is available.
- `bash install.sh --reset` — re-clones and rebuilds the app while keeping your data.
