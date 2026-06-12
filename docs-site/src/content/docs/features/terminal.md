---
title: Terminal — a shell on your server
description: An admin-only web terminal on the Hivekeep host (or inside the container under Docker), straight from the app.
---

The **Terminal** section gives administrators a real shell on the machine running Hivekeep — the host itself, or the container when you run the Docker image. It is a full PTY rendered with xterm.js: interactive programs, colors, tab completion, `htop`, `vim`, everything works as in a native terminal.

The typical moment: an Agent just wrote files to its workspace, a cron failed, or you want to check disk usage — open Terminal from the activity bar and look for yourself, without SSH-ing into the box.

Terminal is **admin-only**: the entry only appears for admin users, and the server rejects non-admin connections regardless of what the client does.

## Sessions survive navigation

Each browser tab gets its own shell session. If you navigate to another section, briefly lose connectivity, or your phone locks, the shell keeps running server-side: coming back reattaches to the same session and replays its recent output. A detached session is kept alive for 10 minutes by default (`HIVEKEEP_TERMINAL_DETACHED_TTL_SEC`), then the shell is killed.

The **New session** button kills the current shell and starts a fresh one.

## What runs where

- **Bare-metal / systemd installs**: the shell runs as the user the Hivekeep process runs as, starting in its home directory. It sees exactly what the server process sees.
- **Docker**: the shell runs *inside the container*. You get the container's filesystem and tools, which is usually what you want for inspecting `/app/data`, logs, or the workspace volumes. It is not a shell on the Docker host.

## Security notes

A web terminal is equivalent to giving shell access on the server. Hivekeep mitigates this by restricting it to admins, but keep in mind:

- Anyone with an admin account on your instance can run arbitrary commands as the server user.
- If your instance is exposed to the internet, make sure admin accounts have strong passwords.
- You can disable the feature entirely with `HIVEKEEP_TERMINAL_ENABLED=false` — the section then refuses connections and explains why.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `HIVEKEEP_TERMINAL_ENABLED` | `true` | Kill-switch for the whole feature. |
| `HIVEKEEP_TERMINAL_SHELL` | `$SHELL`, then `/bin/bash` | Shell binary spawned for each session. |
| `HIVEKEEP_TERMINAL_SCROLLBACK_KB` | `256` | Output kept server-side per session, replayed on reattach. |
| `HIVEKEEP_TERMINAL_DETACHED_TTL_SEC` | `600` | Lifetime of a session with no client connected. |
| `HIVEKEEP_TERMINAL_MAX_SESSIONS` | `10` | Cap of concurrently running shells across all users. |
