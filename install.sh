#!/usr/bin/env bash
# Hivekeep installer
# Usage: curl -fsSL https://raw.githubusercontent.com/MarlBurroW/hivekeep/main/install.sh | bash
# Or:    HIVEKEEP_PORT=8080 bash install.sh
# Non-interactive: HIVEKEEP_NO_PROMPT=true bash install.sh
set -euo pipefail

# ─── Root detection ──────────────────────────────────────────────────────────
IS_ROOT=false
[ "$(id -u)" -eq 0 ] && IS_ROOT=true

# ─── Configurable via env vars ───────────────────────────────────────────────
if [ "$IS_ROOT" = true ]; then
  HIVEKEEP_DIR="${HIVEKEEP_DIR:-/opt/hivekeep}"
  HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-/var/lib/hivekeep}"
  HIVEKEEP_USER="${HIVEKEEP_USER:-hivekeep}"
else
  HIVEKEEP_DIR="${HIVEKEEP_DIR:-$HOME/hivekeep}"
  HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-$HOME/.local/share/hivekeep}"
fi

HIVEKEEP_PORT="${HIVEKEEP_PORT:-3000}"
HIVEKEEP_PUBLIC_URL="${HIVEKEEP_PUBLIC_URL:-}"
HIVEKEEP_REPO="MarlBurroW/hivekeep"
# Explicitly requesting a branch implies the edge channel (tracking a branch
# head instead of release tags).
HIVEKEEP_BRANCH_EXPLICIT=false
[ -n "${HIVEKEEP_BRANCH:-}" ] && HIVEKEEP_BRANCH_EXPLICIT=true
HIVEKEEP_BRANCH="${HIVEKEEP_BRANCH:-main}"
# Update channel: stable (release tags, default) | edge (HEAD of main).
# Empty = auto-detect (existing checkout state, HIVEKEEP_BRANCH, else stable).
HIVEKEEP_CHANNEL="${HIVEKEEP_CHANNEL:-}"
HIVEKEEP_DRY_RUN=false
HIVEKEEP_QUIET="${HIVEKEEP_QUIET:-false}"
HIVEKEEP_START_TIME=""
HIVEKEEP_YES="${HIVEKEEP_YES:-false}"
HIVEKEEP_SYSTEM_BUN_INSTALL="/usr/local/lib/hivekeep/bun"
HIVEKEEP_SYSTEM_CONFIG_DIR="/etc/hivekeep"
HIVEKEEP_SYSTEMD_UNIT="/etc/systemd/system/hivekeep.service"
HIVEKEEP_LEGACY_BUN_LINK="/usr/local/bin/bun"
HIVEKEEP_LEGACY_BUN_ROOT="/root/.bun"

# ─── Colors (auto-detect terminal support) ───────────────────────────────────
setup_colors() {
  if [ "${NO_COLOR:-}" = "1" ] || [ "${HIVEKEEP_NO_COLOR:-}" = "true" ]; then
    RED='' GREEN='' YELLOW='' CYAN='' DIM='' BOLD='' NC=''
  elif [ -t 1 ] && [ -t 2 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    CYAN='\033[0;36m'
    DIM='\033[2m'
    BOLD='\033[1m'
    NC='\033[0m'
  else
    # Not a terminal (piped or redirected) — no colors
    RED='' GREEN='' YELLOW='' CYAN='' DIM='' BOLD='' NC=''
  fi
}
setup_colors

info()    { [ "$HIVEKEEP_QUIET" = true ] && return; echo -e "${CYAN}▸${NC} $*"; }
success() { [ "$HIVEKEEP_QUIET" = true ] && return; echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC} $*" >&2; }
error()   { echo -e "${RED}✗ ERROR:${NC} $*" >&2; exit 1; }
header()  { [ "$HIVEKEEP_QUIET" = true ] && return; echo -e "\n${BOLD}$*${NC}"; }

# ─── Elapsed time tracking ──────────────────────────────────────────────────
start_timer() { HIVEKEEP_START_TIME="$(date +%s)"; }

# Returns human-readable elapsed time since start_timer() was called
format_elapsed() {
  [ -z "$HIVEKEEP_START_TIME" ] && return
  local now elapsed
  now="$(date +%s)"
  elapsed=$((now - HIVEKEEP_START_TIME))
  if [ "$elapsed" -lt 5 ] 2>/dev/null; then
    echo "< 5s"
  elif [ "$elapsed" -lt 60 ] 2>/dev/null; then
    echo "${elapsed}s"
  elif [ "$elapsed" -lt 3600 ] 2>/dev/null; then
    local m=$((elapsed / 60)) s=$((elapsed % 60))
    if [ "$s" -gt 0 ]; then
      echo "${m}m ${s}s"
    else
      echo "${m}m"
    fi
  else
    local h=$((elapsed / 3600)) m=$(( (elapsed % 3600) / 60 ))
    echo "${h}h ${m}m"
  fi
}

# ─── Step progress (for main install flow) ───────────────────────────────────
STEP_CURRENT=0
STEP_TOTAL=0

step() {
  STEP_CURRENT=$((STEP_CURRENT + 1))
  [ "$HIVEKEEP_QUIET" = true ] && return
  local progress=""
  if [ "$STEP_TOTAL" -gt 0 ] 2>/dev/null; then
    progress="${DIM}[${STEP_CURRENT}/${STEP_TOTAL}]${NC} "
  fi
  echo -e "\n${progress}${BOLD}$*${NC}"
}

# ─── Installer self-update check ─────────────────────────────────────────────
# When running from a local file (not piped via curl | bash), check if the
# installer itself is outdated compared to the remote version on GitHub.
# This prevents users from running stale install logic against a newer codebase.
check_installer_update() {
  # Skip if piped (no local file to update), quiet mode, CI, or no-prompt
  [ ! -t 0 ] && return 0
  [ "$HIVEKEEP_QUIET" = true ] && return 0
  [ "${HIVEKEEP_NO_PROMPT:-}" = "true" ] && return 0
  [ "${CI:-}" = "true" ] && return 0
  [ "${HIVEKEEP_SKIP_SELF_UPDATE:-}" = "true" ] && return 0

  # Only check if we can identify the running script file
  local self_path="${BASH_SOURCE[0]:-}"
  [ -z "$self_path" ] && return 0
  [ ! -f "$self_path" ] && return 0

  # Compute local checksum
  local local_hash=""
  if command -v sha256sum &>/dev/null; then
    local_hash="$(sha256sum "$self_path" 2>/dev/null | awk '{print $1}')"
  elif command -v shasum &>/dev/null; then
    local_hash="$(shasum -a 256 "$self_path" 2>/dev/null | awk '{print $1}')"
  else
    return 0  # can't compare without a hash tool
  fi
  [ -z "$local_hash" ] && return 0

  # Fetch remote installer (lightweight: just the hash via a temp file)
  local remote_url="https://raw.githubusercontent.com/$HIVEKEEP_REPO/$HIVEKEEP_BRANCH/install.sh"
  local tmp_remote
  tmp_remote="$(mktemp)"

  if ! curl -fsSL --max-time 8 "$remote_url" -o "$tmp_remote" 2>/dev/null; then
    rm -f "$tmp_remote"
    return 0  # network issue, skip silently
  fi

  local remote_hash=""
  if command -v sha256sum &>/dev/null; then
    remote_hash="$(sha256sum "$tmp_remote" 2>/dev/null | awk '{print $1}')"
  elif command -v shasum &>/dev/null; then
    remote_hash="$(shasum -a 256 "$tmp_remote" 2>/dev/null | awk '{print $1}')"
  fi

  if [ -z "$remote_hash" ] || [ "$local_hash" = "$remote_hash" ]; then
    rm -f "$tmp_remote"
    return 0  # up to date or can't compare
  fi

  # Installer is outdated
  echo -e "${YELLOW}⚠${NC} A newer version of the installer is available."
  echo -en "  ${CYAN}?${NC} ${BOLD}Update installer and restart?${NC} ${DIM}[Y/n]${NC}: " >/dev/tty
  local answer
  read -r answer </dev/tty || answer="y"
  [ -z "$answer" ] && answer="y"

  if [[ "$answer" =~ ^[Yy]$ ]]; then
    cp "$tmp_remote" "$self_path"
    chmod +x "$self_path"
    rm -f "$tmp_remote"
    success "Installer updated"
    # Re-exec with same arguments, skip self-update to avoid loop
    HIVEKEEP_SKIP_SELF_UPDATE=true exec bash "$self_path" "$@"
  fi

  rm -f "$tmp_remote"
}

# ─── Cleanup & signal handling ───────────────────────────────────────────────
SPINNER_PID=""
SPINNER_LOG=""
INTERRUPTED=false

cleanup_on_signal() {
  INTERRUPTED=true
  echo "" >&2

  # Kill any running spinner background command
  if [ -n "$SPINNER_PID" ] && kill -0 "$SPINNER_PID" 2>/dev/null; then
    kill "$SPINNER_PID" 2>/dev/null
    wait "$SPINNER_PID" 2>/dev/null || true
  fi
  SPINNER_PID=""

  # Clean spinner line
  printf "\r\033[K" >&2

  # Remove temp log file
  [ -n "$SPINNER_LOG" ] && rm -f "$SPINNER_LOG"
  SPINNER_LOG=""

  warn "Interrupted by user"

  release_lock

  # EXIT trap will fire next and handle rollback
  exit 130
}

trap cleanup_on_signal INT TERM

# ─── Spinner for long-running commands ───────────────────────────────────────
# Usage: run_with_spinner "Installing dependencies..." command arg1 arg2
run_with_spinner() {
  local label="$1"
  shift

  # If not a terminal or quiet mode, just run silently
  if [ "$HIVEKEEP_QUIET" = true ]; then
    "$@" >/dev/null 2>&1
    return
  fi
  if [ ! -t 1 ] && [ ! -t 2 ]; then
    info "$label"
    "$@"
    return
  fi

  local frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
  local frame_count=${#frames[@]}
  local i=0
  local spin_start
  spin_start="$(date +%s)"
  SPINNER_LOG="$(mktemp)"

  # Start the command in background, capturing output
  "$@" > "$SPINNER_LOG" 2>&1 &
  local cmd_pid=$!
  SPINNER_PID=$cmd_pid

  # Animate spinner while command runs (show elapsed time after 3s)
  while kill -0 "$cmd_pid" 2>/dev/null; do
    local elapsed_str=""
    local now_s
    now_s="$(date +%s)"
    local elapsed_s=$((now_s - spin_start))
    if [ "$elapsed_s" -ge 3 ]; then
      if [ "$elapsed_s" -lt 60 ]; then
        elapsed_str=" ${DIM}(${elapsed_s}s)${NC}"
      else
        local em=$((elapsed_s / 60)) es=$((elapsed_s % 60))
        elapsed_str=" ${DIM}(${em}m ${es}s)${NC}"
      fi
    fi
    printf "\r  ${CYAN}%s${NC} %s%b" "${frames[$((i % frame_count))]}" "$label" "$elapsed_str" >&2
    i=$((i + 1))
    sleep 0.1
  done

  # Get exit code
  wait "$cmd_pid"
  local exit_code=$?
  SPINNER_PID=""

  # Compute final elapsed time
  local final_elapsed=""
  local end_s
  end_s="$(date +%s)"
  local total_s=$((end_s - spin_start))
  if [ "$total_s" -ge 3 ]; then
    if [ "$total_s" -lt 60 ]; then
      final_elapsed=" ${DIM}(${total_s}s)${NC}"
    else
      local fm=$((total_s / 60)) fs=$((total_s % 60))
      if [ "$fs" -gt 0 ]; then
        final_elapsed=" ${DIM}(${fm}m ${fs}s)${NC}"
      else
        final_elapsed=" ${DIM}(${fm}m)${NC}"
      fi
    fi
  fi

  # Clear spinner line
  printf "\r\033[K" >&2

  if [ $exit_code -eq 0 ]; then
    if [ -n "$final_elapsed" ]; then
      [ "$HIVEKEEP_QUIET" = true ] && return
      echo -e "${GREEN}✓${NC} ${label}${final_elapsed}" >&2
    else
      success "$label"
    fi
  else
    echo -e "${RED}✗${NC} ${label}${final_elapsed}" >&2
    echo "" >&2
    echo -e "${DIM}Command output:${NC}" >&2
    tail -20 "$SPINNER_LOG" >&2
    rm -f "$SPINNER_LOG"
    SPINNER_LOG=""
    return $exit_code
  fi

  rm -f "$SPINNER_LOG"
  SPINNER_LOG=""
  return 0
}

# ─── Retry wrapper for flaky network operations ─────────────────────────────
# Usage: retry <max_attempts> <label> command arg1 arg2 ...
# Retries with exponential backoff (2s, 4s, 8s, ...) on failure.
retry() {
  local max_attempts="$1"
  local label="$2"
  shift 2

  local attempt=1
  local delay=2

  while true; do
    if "$@" 2>&1; then
      return 0
    fi

    if [ $attempt -ge "$max_attempts" ]; then
      return 1
    fi

    warn "$label failed (attempt $attempt/$max_attempts) — retrying in ${delay}s..."
    sleep $delay
    delay=$((delay * 2))
    attempt=$((attempt + 1))
  done
}

# ─── Lockfile (prevent concurrent installer runs) ────────────────────────────
# Running two installers at the same time (e.g. two cron-triggered updates,
# or a user running install while an update is in progress) can corrupt the
# build, git state, or database. We use a lockfile to serialize access.
HIVEKEEP_LOCKFILE=""

acquire_lock() {
  local lock_dir="${TMPDIR:-/tmp}"
  HIVEKEEP_LOCKFILE="$lock_dir/hivekeep-installer.lock"

  # Try to create the lockfile atomically
  if ( set -o noclobber; echo "$$" > "$HIVEKEEP_LOCKFILE" ) 2>/dev/null; then
    # We got the lock — register cleanup
    return 0
  fi

  # Lockfile exists — check if the holder is still alive
  local holder_pid
  holder_pid="$(cat "$HIVEKEEP_LOCKFILE" 2>/dev/null || echo "")"

  if [ -n "$holder_pid" ] && kill -0 "$holder_pid" 2>/dev/null; then
    error "Another installer is already running (PID $holder_pid). Wait for it to finish or remove $HIVEKEEP_LOCKFILE"
  fi

  # Stale lockfile — previous run crashed without cleanup
  warn "Removing stale lockfile (previous PID $holder_pid is gone)"
  rm -f "$HIVEKEEP_LOCKFILE"

  if ( set -o noclobber; echo "$$" > "$HIVEKEEP_LOCKFILE" ) 2>/dev/null; then
    return 0
  fi

  # Race condition: another process grabbed it between our rm and write
  error "Another installer is already running. Wait for it to finish or remove $HIVEKEEP_LOCKFILE"
}

release_lock() {
  if [ -n "${HIVEKEEP_LOCKFILE:-}" ] && [ -f "${HIVEKEEP_LOCKFILE:-}" ]; then
    # Only remove if we own it
    local holder_pid
    holder_pid="$(cat "$HIVEKEEP_LOCKFILE" 2>/dev/null || echo "")"
    if [ "$holder_pid" = "$$" ]; then
      rm -f "$HIVEKEEP_LOCKFILE"
    fi
  fi
  HIVEKEEP_LOCKFILE=""
}

# ─── OS detection ────────────────────────────────────────────────────────────
detect_os() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  # Detect WSL
  IS_WSL=false
  if [ -f /proc/version ] && grep -qi 'microsoft\|wsl' /proc/version 2>/dev/null; then
    IS_WSL=true
  fi

  case "$OS" in
    Linux)
      if [ -f /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        DISTRO="${ID:-unknown}"
        DISTRO_LIKE="${ID_LIKE:-}"  # exported for potential use by plugins
      export DISTRO_LIKE
      else
        DISTRO="unknown"
        DISTRO_LIKE=""
      fi
      # Check if systemd is actually available (WSL1 and some containers don't have it)
      if command -v systemctl &>/dev/null && systemctl --version &>/dev/null 2>&1; then
        INIT_SYSTEM="systemd"
      else
        INIT_SYSTEM="script"
      fi
      ;;
    Darwin)
      DISTRO="macos"
      DISTRO_LIKE=""
      INIT_SYSTEM="launchd"
      ;;
    *)
      error "Unsupported OS: $OS. Hivekeep supports Linux and macOS."
      ;;
  esac

  local os_label="$OS ($DISTRO, $ARCH)"
  if [ "$IS_WSL" = true ]; then
    os_label="$OS ($DISTRO, $ARCH, WSL)"
  fi

  if [ "$IS_ROOT" = true ]; then
    success "Detected OS: $os_label — running as root (system install)"
  else
    success "Detected OS: $os_label — running as $USER (user install)"
  fi

  if [ "$INIT_SYSTEM" = "script" ]; then
    warn "systemd not available — will use a start/stop script instead"
    if [ "$IS_WSL" = true ]; then
      info "WSL detected. Service won't auto-start on boot; use the hivekeep script to start manually."
    fi
  fi
}

# ─── Install a system package (sudo only for this) ───────────────────────────
APT_UPDATED=false

install_pkg() {
  local pkg="$1"

  # Verify sudo is available when needed (not root, not brew)
  if [ "$IS_ROOT" != true ] && ! command -v brew &>/dev/null; then
    if ! command -v sudo &>/dev/null; then
      echo "" >&2
      error "$pkg is required but 'sudo' is not available to install it.\n\n  ${BOLD}Fix:${NC} Install $pkg manually as root, then re-run the installer.\n  ${DIM}Example: su -c 'apt-get update && apt-get install -y $pkg'${NC}"
    fi
    # Check that the user can actually sudo (cached credentials or NOPASSWD)
    if ! sudo -n true 2>/dev/null; then
      info "sudo password may be required to install $pkg"
    fi
  fi

  info "Installing $pkg..."
  if command -v apt-get &>/dev/null; then
    # Refresh package cache once per installer run (stale caches cause failures on fresh systems)
    if [ "$APT_UPDATED" != true ]; then
      info "Refreshing package cache..."
      if [ "$IS_ROOT" = true ]; then
        apt-get update -qq 2>/dev/null || warn "apt-get update failed (continuing anyway)"
      else
        sudo apt-get update -qq 2>/dev/null || warn "apt-get update failed (continuing anyway)"
      fi
      APT_UPDATED=true
    fi
    if [ "$IS_ROOT" = true ]; then
      apt-get install -y "$pkg" -q
    else
      sudo apt-get install -y "$pkg" -q
    fi
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y "$pkg" -q
  elif command -v yum &>/dev/null; then
    sudo yum install -y "$pkg" -q
  elif command -v pacman &>/dev/null; then
    sudo pacman -S --noconfirm "$pkg"
  elif command -v apk &>/dev/null; then
    sudo apk add --no-cache "$pkg"
  elif command -v zypper &>/dev/null; then
    sudo zypper install -y "$pkg"
  elif command -v brew &>/dev/null; then
    brew install "$pkg"
  else
    error "$pkg is required but could not be installed automatically. Please install it manually."
  fi
  success "$pkg installed"
}

# ─── Check prerequisites ─────────────────────────────────────────────────────
check_prerequisites() {
  step "Checking prerequisites"

  if ! command -v git &>/dev/null; then
    install_pkg git
  fi
  success "git $(git --version | awk '{print $3}')"

  if ! command -v curl &>/dev/null; then
    install_pkg curl
  fi
  success "curl found"

  # unzip is required by the Bun installer
  if ! command -v unzip &>/dev/null; then
    install_pkg unzip
  fi
  success "unzip found"
}

# ─── Pre-flight checks ───────────────────────────────────────────────────────
preflight_checks() {
  step "Running pre-flight checks"

  # Check available disk space (need ~500MB for clone + deps + build)
  local install_parent
  install_parent="$(dirname "$HIVEKEEP_DIR")"
  mkdir -p "$install_parent" 2>/dev/null || true

  local avail_kb
  if avail_kb="$(df -k "$install_parent" 2>/dev/null | awk 'NR==2 {print $4}')"; then
    if [ -n "$avail_kb" ] && [ "$avail_kb" -lt 512000 ] 2>/dev/null; then
      local avail_mb=$((avail_kb / 1024))
      error "Not enough disk space: ${avail_mb}MB available in $install_parent (need at least 500MB)"
    elif [ -n "$avail_kb" ] && [ "$avail_kb" -lt 1024000 ] 2>/dev/null; then
      local avail_mb=$((avail_kb / 1024))
      warn "Low disk space: ${avail_mb}MB available in $install_parent (recommended: 1GB+)"
    else
      success "Disk space OK"
    fi
  fi

  # Check if target port is already in use (skip on update — our own service may be running)
  if [ -d "$HIVEKEEP_DIR/.git" ]; then
    : # skip port check on update
  elif [ -n "${HIVEKEEP_PORT:-}" ]; then
    local port_in_use=false
    if command -v ss &>/dev/null; then
      ss -tlnp 2>/dev/null | grep -q ":${HIVEKEEP_PORT} " && port_in_use=true
    elif command -v lsof &>/dev/null; then
      lsof -i ":${HIVEKEEP_PORT}" -sTCP:LISTEN &>/dev/null && port_in_use=true
    elif command -v netstat &>/dev/null; then
      netstat -tlnp 2>/dev/null | grep -q ":${HIVEKEEP_PORT} " && port_in_use=true
    fi

    if [ "$port_in_use" = true ]; then
      warn "Port $HIVEKEEP_PORT is already in use. You may need to choose a different port."
      warn "Set HIVEKEEP_PORT=<number> or change it during the configuration step."
    else
      success "Port $HIVEKEEP_PORT is available"
    fi
  fi

  # Proactively warn about privileged ports (<1024) for non-root installs.
  # Binding these requires root; a normal user install will otherwise fail at
  # startup with an opaque permission error. Hoisted out of the install-only
  # branch above so it also fires on updates and under -y/CI (where the
  # configure wizard is skipped). Runs exactly once per preflight.
  if [ -n "${HIVEKEEP_PORT:-}" ] && [ "$IS_ROOT" != true ] && [ "$HIVEKEEP_PORT" -lt 1024 ] 2>/dev/null; then
    warn "Port $HIVEKEEP_PORT is a privileged port (<1024) and you are not root."
    warn "A non-root service cannot bind it and will fail to start."
    info "Pick a port >= 1024 (e.g. 3000), or expose port 80/443 with a reverse proxy"
    info "(Caddy, nginx, Traefik) in front of Hivekeep. To run on the privileged port"
    info "directly, re-run the installer as root."
  fi

  # Check available memory (Bun builds can OOM on small machines)
  if [ "$OS" = "Linux" ] && [ -f /proc/meminfo ]; then
    local mem_total_kb mem_avail_kb swap_total_kb
    mem_total_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo "")"
    mem_avail_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || echo "")"
    swap_total_kb="$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo "")"

    if [ -n "$mem_total_kb" ]; then
      local mem_total_mb=$((mem_total_kb / 1024))
      local mem_avail_mb=0
      [ -n "$mem_avail_kb" ] && mem_avail_mb=$((mem_avail_kb / 1024))
      local swap_total_mb=0
      [ -n "$swap_total_kb" ] && swap_total_mb=$((swap_total_kb / 1024))
      local effective_mb=$((mem_avail_mb + swap_total_mb))

      if [ "$mem_total_mb" -lt 512 ] 2>/dev/null; then
        warn "Low total RAM: ${mem_total_mb}MB (minimum 512MB recommended for builds)"
        if [ "$swap_total_mb" -lt 256 ] 2>/dev/null; then
          warn "No swap or very little swap (${swap_total_mb}MB). The build may fail with out-of-memory."
          info "Consider adding swap: sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile"
        else
          info "Swap available (${swap_total_mb}MB) — should help during build"
        fi
      elif [ "$effective_mb" -lt 384 ] 2>/dev/null; then
        warn "Low available memory: ${mem_avail_mb}MB RAM + ${swap_total_mb}MB swap"
        info "Close other processes or add swap if the build fails"
      else
        success "Memory OK (${mem_avail_mb}MB available, ${mem_total_mb}MB total)"
      fi
    fi
  elif [ "$OS" = "Darwin" ]; then
    local mem_bytes
    mem_bytes="$(sysctl -n hw.memsize 2>/dev/null || echo "")"
    if [ -n "$mem_bytes" ]; then
      local mem_total_mb=$((mem_bytes / 1024 / 1024))
      success "Memory OK (${mem_total_mb}MB total)"
    fi
  fi

  # Show proxy config if set (useful for debugging corporate/firewall setups)
  if [ -n "${HTTP_PROXY:-}${HTTPS_PROXY:-}${http_proxy:-}${https_proxy:-}" ]; then
    local proxy_url="${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}"
    info "Using proxy: $proxy_url"
  fi

  # Check internet connectivity (needed for git clone and bun install)
  if curl -fsSL --max-time 5 https://github.com >/dev/null 2>&1; then
    success "Internet connectivity OK"
  else
    # Provide more helpful diagnostics
    if ! host github.com &>/dev/null 2>&1 && ! nslookup github.com &>/dev/null 2>&1; then
      error "DNS resolution failed for github.com. Check your network/DNS settings."
    elif [ -n "${HTTP_PROXY:-}${HTTPS_PROXY:-}${http_proxy:-}${https_proxy:-}" ]; then
      error "Cannot reach github.com through proxy. Verify your proxy settings."
    else
      error "Cannot reach github.com. Check your internet connection and firewall settings."
    fi
  fi

  # Detect container environments (Docker, Podman, LXC, etc.)
  local in_container=false
  local container_type=""

  if [ -f /.dockerenv ]; then
    in_container=true
    container_type="Docker"
  elif [ -f /run/.containerenv ]; then
    in_container=true
    container_type="Podman"
  elif grep -qa 'docker\|containerd' /proc/1/cgroup 2>/dev/null; then
    in_container=true
    container_type="Docker"
  elif grep -qa 'lxc' /proc/1/cgroup 2>/dev/null; then
    in_container=true
    container_type="LXC"
  elif [ -f /proc/1/sched ] 2>/dev/null; then
    local pid1_name
    pid1_name="$(head -1 /proc/1/sched 2>/dev/null | awk '{print $1}')"
    if [ -n "$pid1_name" ] && [ "$pid1_name" != "systemd" ] && [ "$pid1_name" != "init" ]; then
      # PID 1 is not init/systemd, likely a container
      in_container=true
      container_type="container"
    fi
  fi

  if [ "$in_container" = true ]; then
    warn "Running inside a $container_type environment"

    # If this is a fresh install (not --docker mode), suggest Docker mode instead
    if [ ! -d "$HIVEKEEP_DIR/.git" ]; then
      info "Consider using ${BOLD}bash install.sh --docker${NC} instead, which generates"
      info "a docker-compose.yml and avoids building inside the container."
    fi

    if [ "$INIT_SYSTEM" = "script" ]; then
      info "systemd is not available; a start/stop script will be used."
      info "The service won't auto-restart. Use a container restart policy or supervisor."
    fi
  fi
}

# ─── Interactive prompt (works with curl | bash via /dev/tty) ─────────────────
# Usage: prompt_value VAR_NAME "Question" "default value"
prompt_value() {
  local var_name="$1"
  local question="$2"
  local default="$3"
  local answer

  # Auto-accept defaults in non-interactive / --yes mode
  if [ "$HIVEKEEP_YES" = true ] || [ "${HIVEKEEP_NO_PROMPT:-}" = "true" ] || [ "${CI:-}" = "true" ]; then
    printf -v "$var_name" '%s' "$default"
    return
  fi

  echo -en "  ${CYAN}?${NC} ${BOLD}${question}${NC} ${DIM}[${default}]${NC}: " >/dev/tty
  read -r answer </dev/tty || answer=""

  if [ -z "$answer" ]; then
    answer="$default"
  fi

  printf -v "$var_name" '%s' "$answer"
}

# ─── Detect local IP ─────────────────────────────────────────────────────────
detect_local_ip() {
  if [ "$OS" = "Linux" ]; then
    hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost"
  else
    ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "localhost"
  fi
}

# ─── Configuration wizard ────────────────────────────────────────────────────
configure() {
  local env_file="$HIVEKEEP_DATA_DIR/hivekeep.env"

  # Skip on update if config already exists — don't overwrite user's settings
  if [ "${IS_UPDATE:-false}" = true ] && [ -f "$env_file" ]; then
    info "Existing config found at $env_file — keeping it"
    # Still read the port from it for the summary
    # shellcheck disable=SC1090
    . "$env_file" 2>/dev/null || true
    HIVEKEEP_PORT="${PORT:-$HIVEKEEP_PORT}"
    HIVEKEEP_PUBLIC_URL="${PUBLIC_URL:-$HIVEKEEP_PUBLIC_URL}"
    # Fallback: build URL from local IP if still empty
    if [ -z "$HIVEKEEP_PUBLIC_URL" ]; then
      local local_ip
      local_ip="$(detect_local_ip)"
      HIVEKEEP_PUBLIC_URL="http://${local_ip}:${HIVEKEEP_PORT}"
    fi
    return
  fi

  # Skip wizard if env vars already set or non-interactive
  local skip_wizard=false
  [ "${HIVEKEEP_NO_PROMPT:-}" = "true" ] && skip_wizard=true
  [ "${CI:-}" = "true" ] && skip_wizard=true
  # If all key vars were explicitly set via env, no need to ask
  [ -n "${HIVEKEEP_PORT_EXPLICIT:-}" ] && [ -n "${HIVEKEEP_PUBLIC_URL}" ] && skip_wizard=true

  if [ "$skip_wizard" = true ]; then
    : # use defaults / env vars as-is
  else
    local local_ip
    local_ip="$(detect_local_ip)"

    echo ""
    echo -e "${BOLD}Configuration${NC}"
    echo -e "${DIM}Press Enter to accept the default value shown in brackets.${NC}"
    echo ""

    prompt_value HIVEKEEP_PORT "Port" "$HIVEKEEP_PORT"

    # Warn if a non-root user picked a privileged port (<1024): it won't bind.
    if [ "$IS_ROOT" != true ] && [ "$HIVEKEEP_PORT" -lt 1024 ] 2>/dev/null; then
      warn "Port $HIVEKEEP_PORT is privileged (<1024) and you are not root, so the service won't be able to bind it."
      warn "Choose a port >= 1024 (e.g. 3000), or put a reverse proxy in front of Hivekeep for ports 80/443."
    fi

    local default_url="http://${local_ip}:${HIVEKEEP_PORT}"
    [ -n "$HIVEKEEP_PUBLIC_URL" ] && default_url="$HIVEKEEP_PUBLIC_URL"
    prompt_value HIVEKEEP_PUBLIC_URL "Public URL (for webhooks & invite links)" "$default_url"
  fi

  # Fallback if public URL still empty
  if [ -z "$HIVEKEEP_PUBLIC_URL" ]; then
    local local_ip
    local_ip="$(detect_local_ip)"
    HIVEKEEP_PUBLIC_URL="http://${local_ip}:${HIVEKEEP_PORT}"
  fi

  # Write config file
  mkdir -p "$HIVEKEEP_DATA_DIR"
  cat > "$env_file" << ENV
# Hivekeep configuration — generated by installer
# Edit this file to change settings, then restart: systemctl --user restart hivekeep
NODE_ENV=production
PORT=${HIVEKEEP_PORT}
HOST=0.0.0.0
HIVEKEEP_DATA_DIR=${HIVEKEEP_DATA_DIR}
PUBLIC_URL=${HIVEKEEP_PUBLIC_URL}
ENV
  chmod 600 "$env_file"
  success "Config written to $env_file"
}

# ─── Install Bun ─────────────────────────────────────────────────────────────
# Minimum Bun version required (lockfileVersion 1 needs Bun 1.2+)
BUN_MIN_VERSION="1.2.0"

configure_bun_environment() {
  if [ -z "${BUN_INSTALL:-}" ]; then
    if [ "${IS_ROOT:-false}" = true ] && [ "${OS:-$(uname -s)}" = "Linux" ]; then
      BUN_INSTALL="$HIVEKEEP_SYSTEM_BUN_INSTALL"
    else
      BUN_INSTALL="$HOME/.bun"
    fi
  fi

  export BUN_INSTALL
  case ":${PATH:-}:" in
    *":$BUN_INSTALL/bin:"*) ;;
    *) export PATH="$BUN_INSTALL/bin:${PATH:-}" ;;
  esac
}

prepare_managed_bun_directory() {
  local managed_parent
  managed_parent="$(dirname "$HIVEKEEP_SYSTEM_BUN_INSTALL")"

  case "$HIVEKEEP_SYSTEM_BUN_INSTALL" in
    /*) ;;
    *) error "Managed Bun path must be absolute: $HIVEKEEP_SYSTEM_BUN_INSTALL" ;;
  esac
  case "$HIVEKEEP_SYSTEM_BUN_INSTALL" in
    *[!A-Za-z0-9_./-]*) error "Managed Bun path contains unsupported characters: $HIVEKEEP_SYSTEM_BUN_INSTALL" ;;
  esac

  install -d -o root -g root -m 0755 \
    "$managed_parent" \
    "$HIVEKEEP_SYSTEM_BUN_INSTALL" \
    "$HIVEKEEP_SYSTEM_BUN_INSTALL/bin"

  if [ -f "$HIVEKEEP_SYSTEM_BUN_INSTALL/bin/bun" ]; then
    chown root:root "$HIVEKEEP_SYSTEM_BUN_INSTALL/bin/bun"
    chmod 0755 "$HIVEKEEP_SYSTEM_BUN_INSTALL/bin/bun"
  fi
}

canonical_executable_path() {
  local executable="$1"
  if command -v readlink &>/dev/null; then
    readlink -f -- "$executable" 2>/dev/null && return 0
  fi
  if command -v realpath &>/dev/null; then
    realpath "$executable" 2>/dev/null && return 0
  fi
  return 1
}

run_as_service_user() {
  local executable="$1"
  shift

  local env_bin service_path
  env_bin="$(command -v env 2>/dev/null || true)"
  [ -n "$env_bin" ] || return 127
  service_path="${executable%/*}:/usr/local/bin:/usr/bin:/bin"
  local -a clean_command=(
    "$env_bin" -i
    "HOME=$HIVEKEEP_DIR"
    "USER=$HIVEKEEP_USER"
    "LOGNAME=$HIVEKEEP_USER"
    "PATH=$service_path"
    "$executable" "$@"
  )

  if command -v runuser &>/dev/null; then
    runuser -u "$HIVEKEEP_USER" -- "${clean_command[@]}"
    return
  fi

  if command -v su &>/dev/null && command -v sh &>/dev/null; then
    local command="" arg quoted
    for arg in "${clean_command[@]}"; do
      printf -v quoted '%q' "$arg"
      command+="${quoted} "
    done
    su -s "$(command -v sh)" -c "exec $command" "$HIVEKEEP_USER"
    return
  fi

  return 127
}

bun_runs_as_service_user() {
  run_as_service_user "$1" --version &>/dev/null
}

run_configured_bun() {
  local executable="$1"
  shift

  if [ "${IS_ROOT:-false}" = true ] && [ "${OS:-}" = "Linux" ] && [ "${INIT_SYSTEM:-}" = "systemd" ]; then
    id "$HIVEKEEP_USER" &>/dev/null || return 127
    run_as_service_user "$executable" "$@"
    return
  fi

  "$executable" "$@"
}

escape_systemd_environment_value() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '%s' "$value"
}

escape_systemd_exec_token() {
  escape_systemd_environment_value "$1"
}

persist_bun_path() {
  local path_dir="$HIVEKEEP_DATA_DIR"
  if [ "${IS_ROOT:-false}" = true ]; then
    path_dir="$HIVEKEEP_SYSTEM_CONFIG_DIR"
    case "$path_dir" in
      /*) ;;
      *) error "System config path must be absolute: $path_dir" ;;
    esac
    case "$path_dir" in
      *[!A-Za-z0-9_./-]*) error "System config path contains unsupported characters: $path_dir" ;;
    esac
    install -d -o root -g root -m 0755 "$path_dir"
  else
    mkdir -p "$path_dir"
  fi

  local path_file="$path_dir/bun.path"
  local staged_path="${path_file}.tmp.$$"

  case "$BUN_BIN" in
    *$'\n'*|*$'\r'*) error "Bun path contains an unsupported newline" ;;
  esac

  rm -f "$staged_path"
  printf '%s\n' "$BUN_BIN" > "$staged_path"
  chmod 0644 "$staged_path"
  if [ "${IS_ROOT:-false}" = true ]; then
    chown root:root "$staged_path"
  fi
  mv -f "$staged_path" "$path_file"
}

configured_bun_path() {
  local path_dir="$HIVEKEEP_DATA_DIR"
  [ "${IS_ROOT:-false}" = true ] && path_dir="$HIVEKEEP_SYSTEM_CONFIG_DIR"
  local path_file="$path_dir/bun.path"
  local configured=""
  if [ -f "$path_file" ]; then
    if [ "${IS_ROOT:-false}" = true ]; then
      local dir_owner dir_mode file_owner file_mode
      dir_owner="$(stat -c '%U' "$path_dir" 2>/dev/null || stat -f '%Su' "$path_dir" 2>/dev/null || true)"
      dir_mode="$(stat -c '%a' "$path_dir" 2>/dev/null || stat -f '%Lp' "$path_dir" 2>/dev/null || true)"
      file_owner="$(stat -c '%U' "$path_file" 2>/dev/null || stat -f '%Su' "$path_file" 2>/dev/null || true)"
      file_mode="$(stat -c '%a' "$path_file" 2>/dev/null || stat -f '%Lp' "$path_file" 2>/dev/null || true)"
      [ "$dir_owner" = root ] || return 1
      [ -n "$dir_mode" ] || return 1
      (( (8#$dir_mode & 8#022) == 0 )) || return 1
      [ "$file_owner" = root ] || return 1
      [ -n "$file_mode" ] || return 1
      (( (8#$file_mode & 8#022) == 0 )) || return 1
    fi
    IFS= read -r configured < "$path_file" || true
    if [ -n "$configured" ] && [ -f "$configured" ]; then
      printf '%s' "$configured"
      return 0
    fi
    return 1
  fi

  local selected_bun
  selected_bun="$(command -v bun 2>/dev/null || true)"
  [ -n "$selected_bun" ] || return 1
  canonical_executable_path "$selected_bun" || printf '%s' "$selected_bun"
}

# Compare two semver strings: returns 0 if $1 >= $2, 1 otherwise
version_gte() {
  local IFS='.'
  local -a v1 v2
  IFS='.' read -ra v1 <<< "$1"
  IFS='.' read -ra v2 <<< "$2"
  local i
  for i in 0 1 2; do
    local a="${v1[$i]:-0}" b="${v2[$i]:-0}"
    if [ "$a" -gt "$b" ] 2>/dev/null; then return 0; fi
    if [ "$a" -lt "$b" ] 2>/dev/null; then return 1; fi
  done
  return 0
}

ensure_bun() {
  step "Checking Bun runtime"

  # Validate architecture — Bun only supports x86_64 and aarch64 (ARM64)
  case "$ARCH" in
    x86_64|amd64)
      : # supported
      ;;
    aarch64|arm64)
      : # supported
      ;;
    armv7l|armv6l|armhf)
      echo ""
      error "Bun does not support 32-bit ARM ($ARCH).\n\n" \
            " Hivekeep requires Bun, which only runs on x86_64 or ARM64 (aarch64).\n" \
            " If you're on a Raspberry Pi, you need a 64-bit OS:\n" \
            "   ${DIM}• Raspberry Pi OS (64-bit): https://www.raspberrypi.com/software/${NC}\n" \
            "   ${DIM}• Ubuntu Server 64-bit for Pi: https://ubuntu.com/download/raspberry-pi${NC}\n\n" \
            " Alternatively, use Docker (which handles architecture natively):\n" \
            "   ${DIM}bash install.sh --docker${NC}"
      ;;
    i386|i686)
      error "Bun does not support 32-bit x86 ($ARCH).\n\n" \
            " Hivekeep requires a 64-bit system (x86_64 or ARM64).\n" \
            " Alternatively, use Docker: ${DIM}bash install.sh --docker${NC}"
      ;;
    *)
      warn "Unknown architecture: $ARCH. Bun may not be available for this platform."
      warn "If Bun installation fails, try Docker instead: bash install.sh --docker"
      ;;
  esac

  configure_bun_environment
  if [ "$IS_ROOT" = true ] && [ "$OS" = "Linux" ] && [ "$BUN_INSTALL" = "$HIVEKEEP_SYSTEM_BUN_INSTALL" ]; then
    prepare_managed_bun_directory
  fi

  if command -v bun &>/dev/null; then
    local current_version
    current_version="$(bun --version 2>/dev/null || echo "0.0.0")"

    if version_gte "$current_version" "$BUN_MIN_VERSION"; then
      success "Bun v${current_version}"
      return 0
    fi

    warn "Bun v${current_version} is too old (need v${BUN_MIN_VERSION}+)"
    info "Upgrading Bun..."
    run_with_spinner "Upgrading Bun..." retry 3 "Bun upgrade" bash -c 'curl -fsSL https://bun.sh/install | bash'
    export PATH="$BUN_INSTALL/bin:$PATH"
    hash -r 2>/dev/null || true

    local new_version
    new_version="$(bun --version 2>/dev/null || echo "0.0.0")"
    if version_gte "$new_version" "$BUN_MIN_VERSION"; then
      success "Bun upgraded: v${current_version} → v${new_version}"
    else
      error "Bun upgrade failed (got v${new_version}, need v${BUN_MIN_VERSION}+). Upgrade manually: https://bun.sh"
    fi
    return 0
  fi

  info "Installing Bun..."
  run_with_spinner "Downloading and installing Bun..." retry 3 "Bun install" bash -c 'curl -fsSL https://bun.sh/install | bash'
  export PATH="$BUN_INSTALL/bin:$PATH"

  command -v bun &>/dev/null || error "Bun installation failed. Install manually: https://bun.sh"

  local installed_version
  installed_version="$(bun --version 2>/dev/null || echo "0.0.0")"
  if ! version_gte "$installed_version" "$BUN_MIN_VERSION"; then
    error "Installed Bun v${installed_version} is below minimum v${BUN_MIN_VERSION}. Please update manually: https://bun.sh"
  fi
  success "Bun v${installed_version} installed"
}

# ─── Backup database before update ───────────────────────────────────────────
BACKUP_DB_PATH=""

backup_database() {
  local db_file="$HIVEKEEP_DATA_DIR/hivekeep.db"
  [ ! -f "$db_file" ] && return

  local backup_dir="$HIVEKEEP_DATA_DIR/backups"
  mkdir -p "$backup_dir"

  local timestamp
  timestamp="$(date +%Y%m%d-%H%M%S)"
  local version_tag
  version_tag="$(git -C "$HIVEKEEP_DIR" describe --tags 2>/dev/null || git -C "$HIVEKEEP_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
  # Sanitize version for filename
  version_tag="$(echo "$version_tag" | tr '/' '-')"

  BACKUP_DB_PATH="$backup_dir/hivekeep-${version_tag}-${timestamp}.db"

  # Use sqlite3 .backup if available (safe even if DB is in use), else cp
  if command -v sqlite3 &>/dev/null; then
    if sqlite3 "$db_file" ".backup '$BACKUP_DB_PATH'" 2>/dev/null; then
      success "Database backed up (sqlite3): $(basename "$BACKUP_DB_PATH")"
    else
      cp "$db_file" "$BACKUP_DB_PATH"
      success "Database backed up (copy): $(basename "$BACKUP_DB_PATH")"
    fi
  else
    cp "$db_file" "$BACKUP_DB_PATH"
    success "Database backed up (copy): $(basename "$BACKUP_DB_PATH")"
  fi

  # Also backup WAL/SHM if they exist (for cp-based backups)
  if [ -f "${db_file}-wal" ]; then cp "${db_file}-wal" "${BACKUP_DB_PATH}-wal" 2>/dev/null || true; fi
  if [ -f "${db_file}-shm" ]; then cp "${db_file}-shm" "${BACKUP_DB_PATH}-shm" 2>/dev/null || true; fi

  # Prune old backups: keep last 5
  local count
  count="$(find "$backup_dir" -maxdepth 1 -name 'hivekeep-*.db' -type f 2>/dev/null | wc -l)"
  if [ "$count" -gt 5 ] 2>/dev/null; then
    find "$backup_dir" -maxdepth 1 -name 'hivekeep-*.db' -type f -printf '%T@ %p\n' 2>/dev/null \
      | sort -n \
      | head -n "$((count - 5))" \
      | awk '{print $2}' \
      | while IFS= read -r old; do
          rm -f "$old" "${old}-wal" "${old}-shm"
        done
    info "Pruned old backups (keeping last 5)"
  fi
}

# ─── Update channels ─────────────────────────────────────────────────────────
# stable: follows release tags (vX.Y.Z), uses prebuilt client assets from the
#         GitHub release when available.
# edge:   follows the HEAD of $HIVEKEEP_BRANCH (main), builds locally.
HIVEKEEP_TARGET_TAG=""

resolve_channel() {
  # 1. Explicit --channel flag / HIVEKEEP_CHANNEL env wins
  if [ -n "$HIVEKEEP_CHANNEL" ]; then
    echo "$HIVEKEEP_CHANNEL"
    return
  fi
  # 2. Explicitly requested branch = edge semantics
  if [ "$HIVEKEEP_BRANCH_EXPLICIT" = true ]; then
    echo "edge"
    return
  fi
  # 3. Existing install: a branch checkout tracks that branch (edge), a
  #    detached HEAD (left by a tag checkout) tracks releases (stable).
  if [ -d "$HIVEKEEP_DIR/.git" ]; then
    local cur_branch
    cur_branch="$(git -C "$HIVEKEEP_DIR" branch --show-current 2>/dev/null || echo "")"
    if [ -n "$cur_branch" ]; then
      echo "edge"
    else
      echo "stable"
    fi
    return
  fi
  # 4. Fresh install: stable
  echo "stable"
}

# Newest non-prerelease vX.Y.Z tag. Prefers the local repo (after a fetch);
# falls back to the remote so it also works before cloning. Memoized: a single
# update flow resolves the tag several times (check, install, build) and each
# remote resolution is a network round-trip.
_LATEST_STABLE_TAG_CACHE=""
get_latest_stable_tag() {
  if [ -n "$_LATEST_STABLE_TAG_CACHE" ]; then
    echo "$_LATEST_STABLE_TAG_CACHE"
    return
  fi
  local tags=""
  if [ -d "${HIVEKEEP_DIR:-/nonexistent}/.git" ]; then
    tags="$(git -C "$HIVEKEEP_DIR" tag -l 'v*' 2>/dev/null)"
  fi
  if [ -z "$tags" ]; then
    tags="$(git ls-remote --tags --refs "https://github.com/$HIVEKEEP_REPO.git" 'v*' 2>/dev/null | awk -F/ '{print $NF}')"
  fi
  _LATEST_STABLE_TAG_CACHE="$(echo "$tags" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"
  echo "$_LATEST_STABLE_TAG_CACHE"
}

# Download the prebuilt client assets attached to a release by CI
# (hivekeep-client-vX.Y.Z.tar.gz + .sha256) and extract them into
# $HIVEKEEP_DIR/dist/client. Returns non-zero when unavailable or invalid so
# the caller can fall back to a local build.
download_prebuilt_client() {
  local tag="$1"
  [ -z "$tag" ] && return 1

  local asset="hivekeep-client-${tag}.tar.gz"
  local base="https://github.com/$HIVEKEEP_REPO/releases/download/${tag}"
  local tmp
  tmp="$(mktemp -d)" || return 1

  if ! curl -fsSL --connect-timeout 10 --max-time 300 -o "$tmp/$asset" "$base/$asset" 2>/dev/null; then
    rm -rf "$tmp"
    return 1
  fi
  if ! curl -fsSL --connect-timeout 10 --max-time 60 -o "$tmp/$asset.sha256" "$base/$asset.sha256" 2>/dev/null; then
    rm -rf "$tmp"
    return 1
  fi

  # Verify the checksum (sha256sum on Linux, shasum on macOS)
  local expected actual
  expected="$(awk '{print $1}' "$tmp/$asset.sha256")"
  if command -v sha256sum &>/dev/null; then
    actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
  elif command -v shasum &>/dev/null; then
    actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
  else
    warn "No sha256 tool available — skipping prebuilt assets"
    rm -rf "$tmp"
    return 1
  fi
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    warn "Prebuilt client checksum mismatch — falling back to local build"
    rm -rf "$tmp"
    return 1
  fi

  # Extract to a staging dir, sanity-check, then swap into place
  if ! tar -xzf "$tmp/$asset" -C "$tmp" 2>/dev/null || [ ! -f "$tmp/dist/client/index.html" ]; then
    warn "Prebuilt client archive is malformed — falling back to local build"
    rm -rf "$tmp"
    return 1
  fi

  rm -rf "${HIVEKEEP_DIR:?}/dist/client"
  mkdir -p "$HIVEKEEP_DIR/dist"
  mv "$tmp/dist/client" "$HIVEKEEP_DIR/dist/client"
  rm -rf "$tmp"
  return 0
}

# ─── Clone or update ─────────────────────────────────────────────────────────
ROLLBACK_COMMIT=""
HIVEKEEP_NO_CHANGES=false

install_or_update() {
  step "Installing Hivekeep"

  local channel
  channel="$(resolve_channel)"

  if [ -d "$HIVEKEEP_DIR/.git" ]; then
    info "Existing installation found at $HIVEKEEP_DIR — updating (${BOLD}${channel}${NC} channel)..."

    # Backup database before update
    backup_database

    # Save current commit for rollback on failure
    ROLLBACK_COMMIT="$(git -C "$HIVEKEEP_DIR" rev-parse HEAD 2>/dev/null || echo "")"
    local old_version
    old_version="$(get_installed_version)"
    if [ -n "$ROLLBACK_COMMIT" ]; then
      info "Current version: $old_version (rollback point: ${ROLLBACK_COMMIT:0:8})"
    fi

    retry 3 "git fetch" git -C "$HIVEKEEP_DIR" fetch --tags origin

    # Detect a dirty working tree before switching versions. A plain checkout/
    # pull aborts with a cryptic "local changes would be overwritten" error if
    # any tracked file was edited, so handle it explicitly.
    local working_tree_dirty=false
    if [ -n "$(git -C "$HIVEKEEP_DIR" status --porcelain 2>/dev/null | grep -v '^??' || true)" ]; then
      working_tree_dirty=true
    fi

    if [ "$channel" = "stable" ]; then
      # Stable: check out the newest release tag (detached HEAD — the repo
      # state IS the release, which is also how install state is detected).
      HIVEKEEP_TARGET_TAG="$(get_latest_stable_tag)"
      if [ -z "$HIVEKEEP_TARGET_TAG" ]; then
        error "Could not resolve the latest release tag. Check your internet connection, or use --channel edge to track main."
      fi

      if [ "$working_tree_dirty" = true ]; then
        warn "Local changes detected in $HIVEKEEP_DIR. Stashing them before updating."
        git -C "$HIVEKEEP_DIR" stash push -m "pre-update $(date +%Y%m%d-%H%M%S)" &>/dev/null || true
        info "Recover them later with: git -C \"$HIVEKEEP_DIR\" stash list"
      fi

      git -C "$HIVEKEEP_DIR" checkout --detach "$HIVEKEEP_TARGET_TAG" &>/dev/null || \
        error "Could not check out $HIVEKEEP_TARGET_TAG.
  ${BOLD}Fix:${NC} reset to a clean copy (your data and config are preserved):
    ${DIM}bash install.sh --reset${NC}"
    else
      # Edge: fast-forward the tracked branch.
      git -C "$HIVEKEEP_DIR" checkout "$HIVEKEEP_BRANCH" &>/dev/null || \
        git -C "$HIVEKEEP_DIR" checkout -B "$HIVEKEEP_BRANCH" "origin/$HIVEKEEP_BRANCH"

      if [ "$working_tree_dirty" = true ]; then
        warn "Local changes detected in $HIVEKEEP_DIR. Stashing them before updating."
        # Run as a SINGLE attempt: a merge conflict is not transient, so retrying
        # would only re-fail with "a rebase is in progress" after each backoff and
        # could leave a half-finished rebase tree littered with conflict markers.
        if git -C "$HIVEKEEP_DIR" -c rebase.autoStash=true pull --rebase origin "$HIVEKEEP_BRANCH"; then
          info "Your local changes were stashed and re-applied on top of the update."
          info "If anything looks off, run: git -C \"$HIVEKEEP_DIR\" stash list"
        else
          # Abort any in-progress rebase so the tree is left clean (guarded: this is
          # a no-op if no rebase is actually in progress).
          git -C "$HIVEKEEP_DIR" rebase --abort &>/dev/null || true
          error "Update could not merge your local changes automatically.
  Your installation has uncommitted edits that conflict with the new version.
  ${BOLD}Fix:${NC} reset to a clean copy (your data and config are preserved):
    ${DIM}bash install.sh --reset${NC}"
        fi
      else
        retry 3 "git pull" git -C "$HIVEKEEP_DIR" pull origin "$HIVEKEEP_BRANCH"
      fi
    fi

    local new_version
    new_version="$(get_installed_version)"
    local new_head
    new_head="$(git -C "$HIVEKEEP_DIR" rev-parse HEAD 2>/dev/null || echo "")"
    if [ "$old_version" = "$new_version" ] && [ "$ROLLBACK_COMMIT" = "$new_head" ]; then
      HIVEKEEP_NO_CHANGES=true
      success "Already up to date ($new_version)"
    else
      success "Updated: $old_version → $new_version"
      # Show what changed (categorized by type)
      if [ -n "$ROLLBACK_COMMIT" ]; then
        echo ""
        show_categorized_commits "${ROLLBACK_COMMIT}..HEAD" 5 || true
      fi
    fi
    IS_UPDATE=true
  else
    mkdir -p "$(dirname "$HIVEKEEP_DIR")"
    if [ "$channel" = "stable" ]; then
      HIVEKEEP_TARGET_TAG="$(get_latest_stable_tag)"
      if [ -n "$HIVEKEEP_TARGET_TAG" ]; then
        info "Installing latest release: ${BOLD}${HIVEKEEP_TARGET_TAG}${NC}"
        run_with_spinner "Cloning Hivekeep to $HIVEKEEP_DIR..." retry 3 "git clone" git clone "https://github.com/$HIVEKEEP_REPO.git" "$HIVEKEEP_DIR" --branch "$HIVEKEEP_TARGET_TAG" --depth 1
      else
        warn "Could not resolve the latest release tag — falling back to the $HIVEKEEP_BRANCH branch"
        run_with_spinner "Cloning Hivekeep to $HIVEKEEP_DIR..." retry 3 "git clone" git clone "https://github.com/$HIVEKEEP_REPO.git" "$HIVEKEEP_DIR" --branch "$HIVEKEEP_BRANCH" --depth 1
      fi
    else
      info "Installing the ${BOLD}edge${NC} channel (branch: $HIVEKEEP_BRANCH)"
      run_with_spinner "Cloning Hivekeep to $HIVEKEEP_DIR..." retry 3 "git clone" git clone "https://github.com/$HIVEKEEP_REPO.git" "$HIVEKEEP_DIR" --branch "$HIVEKEEP_BRANCH" --depth 1
    fi
    IS_UPDATE=false
  fi
}

# ─── Rollback on failure ────────────────────────────────────────────────────
rollback() {
  local exit_code=$?
  if [ $exit_code -eq 0 ]; then
    return
  fi

  echo ""
  if [ "$INTERRUPTED" = true ]; then
    echo -e "${RED}${BOLD}Installation interrupted!${NC}"
  else
    echo -e "${RED}${BOLD}Installation failed!${NC}"
  fi

  # Rollback git to previous commit on update
  if [ -n "${ROLLBACK_COMMIT:-}" ] && [ -d "$HIVEKEEP_DIR/.git" ]; then
    echo ""
    warn "Rolling back to previous version (${ROLLBACK_COMMIT:0:8})..."
    if git -C "$HIVEKEEP_DIR" reset --hard "$ROLLBACK_COMMIT" &>/dev/null; then
      success "Code rolled back to ${ROLLBACK_COMMIT:0:8}"

      # Try to rebuild the old version so the service can restart
      info "Rebuilding previous version..."
      configure_bun_environment
      if command -v bun &>/dev/null; then
        cd "$HIVEKEEP_DIR"
        if bun install --frozen-lockfile &>/dev/null && bun run build &>/dev/null; then
          success "Previous version rebuilt"
        else
          warn "Could not rebuild previous version — manual intervention needed"
        fi
      fi

      # Restart the service if it was running
      if [ "${IS_UPDATE:-false}" = true ]; then
        info "Restarting service with previous version..."
        if [ "${INIT_SYSTEM:-}" = "launchd" ]; then
          local plist="$HOME/Library/LaunchAgents/io.hivekeep.server.plist"
          [ -f "$plist" ] && launchctl load "$plist" 2>/dev/null
        elif [ "${INIT_SYSTEM:-}" = "script" ]; then
          local script_path="$HIVEKEEP_DIR/hivekeep"
          if [ -x "$script_path" ]; then "$script_path" start 2>/dev/null || true; fi
        elif [ "${IS_ROOT:-false}" = true ]; then
          systemctl start hivekeep 2>/dev/null || true
        else
          systemctl --user start hivekeep 2>/dev/null || true
        fi
        success "Service restarted with previous version"
      fi
    else
      warn "Rollback failed — manual intervention needed"
      warn "Try: cd $HIVEKEEP_DIR && git reset --hard $ROLLBACK_COMMIT"
    fi
  elif [ "${IS_UPDATE:-false}" != true ] && [ -d "$HIVEKEEP_DIR" ]; then
    # Fresh install failed — clean up the partial clone
    warn "Cleaning up partial installation..."
    rm -rf "$HIVEKEEP_DIR"
    success "Removed $HIVEKEEP_DIR"
  fi

  # Mention database backup if one was made
  if [ -n "${BACKUP_DB_PATH:-}" ] && [ -f "${BACKUP_DB_PATH:-}" ]; then
    echo ""
    info "Database backup is available at: $BACKUP_DB_PATH"
    info "To restore: cp '$BACKUP_DB_PATH' '$HIVEKEEP_DATA_DIR/hivekeep.db'"
  fi

  echo ""
  echo -e "${RED}Please check the error above and try again.${NC}"
  echo -e "${DIM}If the problem persists, open an issue: https://github.com/$HIVEKEEP_REPO/issues${NC}"
  echo ""

  release_lock
}

# ─── Build ───────────────────────────────────────────────────────────────────
build_hivekeep() {
  step "Installing dependencies and building"

  cd "$HIVEKEEP_DIR"

  # Skip build entirely if nothing changed and build output already exists.
  # This makes `bash install.sh` fast when run as a health check on an
  # up-to-date installation (avoids expensive bun install + build).
  if [ "$HIVEKEEP_NO_CHANGES" = true ]; then
    local has_build=false
    for dir in .output dist; do
      if [ -d "${HIVEKEEP_DIR}/$dir" ] && [ -n "$(find "${HIVEKEEP_DIR}/$dir" -type f -print -quit 2>/dev/null)" ]; then
        has_build=true
        break
      fi
    done
    if [ "$has_build" = true ] && [ -d "$HIVEKEEP_DIR/node_modules" ]; then
      success "No changes detected, skipping build"
      return 0
    fi
    info "No code changes but build artifacts missing, rebuilding..."
  fi

  # On updates, clean stale build output before rebuilding.
  # Prevents serving outdated/broken builds if the build step layout changed.
  if [ "${IS_UPDATE:-false}" = true ]; then
    for dir in .output dist .nuxt; do
      [ -d "${HIVEKEEP_DIR:?}/$dir" ] && rm -rf "${HIVEKEEP_DIR:?}/$dir"
    done
  fi

  # Install dependencies with retry. If it fails (e.g., corrupted node_modules
  # from a previously interrupted install), remove node_modules and retry clean.
  if ! run_with_spinner "Installing dependencies..." retry 3 "bun install" bun install --frozen-lockfile; then
    warn "Dependency install failed — cleaning node_modules and retrying from scratch..."
    rm -rf "$HIVEKEEP_DIR/node_modules" "$HIVEKEEP_DIR/bun.lockb.tmp" 2>/dev/null || true
    run_with_spinner "Installing dependencies (clean retry)..." retry 3 "bun install" bun install --frozen-lockfile
  fi

  # Stable channel: prefer the prebuilt client attached to the GitHub release
  # by CI (sha256-verified) — skips the expensive local Vite build entirely.
  local built=false
  if [ -n "$HIVEKEEP_TARGET_TAG" ]; then
    if run_with_spinner "Downloading prebuilt client assets ($HIVEKEEP_TARGET_TAG)..." download_prebuilt_client "$HIVEKEEP_TARGET_TAG"; then
      success "Prebuilt client assets installed (no local build needed)"
      built=true
    else
      info "Prebuilt assets unavailable for $HIVEKEEP_TARGET_TAG — building locally"
    fi
  fi

  # Build with retry. If the build fails (OOM, stale cache), clean build
  # artifacts and retry once. This handles cases where a previous interrupted
  # build left partial output that confuses the bundler.
  if [ "$built" != true ]; then
    if ! run_with_spinner "Building Hivekeep..." bun run build; then
      warn "Build failed — cleaning build artifacts and retrying..."
      rm -rf "$HIVEKEEP_DIR/.output" "$HIVEKEEP_DIR/dist" "$HIVEKEEP_DIR/.nuxt" 2>/dev/null || true
      run_with_spinner "Building Hivekeep (clean retry)..." bun run build
    fi
  fi

  # Install the headless browser the browse_url / screenshot_url / browser_*
  # session tools need at runtime (driven via playwright-extra → playwright).
  install_chromium
}

# ─── Headless browser (Playwright Chromium) ──────────────────────────────────
# The browse_url / screenshot_url tools and the browser_* session tools launch a
# headless Chromium via playwright-extra. Without the browser binary they fail at
# runtime ("Executable doesn't exist … run `playwright install`").
#
# This step is best-effort: a failure here (e.g. no sudo for system libs) must
# NOT abort the install — the rest of Hivekeep works fine, browsing tools just
# stay unavailable until Chromium is present. Idempotent: re-running is a cheap
# no-op once the matching browser build is already installed.
install_chromium() {
  cd "$HIVEKEEP_DIR" || return 0

  # Install the browser INSIDE the install dir (not the caller's ~/.cache) so it
  # lives somewhere the runtime service user can read. In the root/system-install
  # flow the service runs as a separate '$HIVEKEEP_USER' account, and setup_system_user
  # chowns the whole install dir to it — a browser under root's $HOME would be
  # invisible to the service. We persist PLAYWRIGHT_BROWSERS_PATH into hivekeep.env
  # so the running server looks in the same place.
  local browsers_path="${HIVEKEEP_DIR}/.cache/ms-playwright"
  mkdir -p "$browsers_path"
  persist_browsers_path "$browsers_path"

  # Run the project-local playwright CLI (matches the installed library version;
  # a pinned version could pull a mismatched browser build).
  if [ "$OS" = "Darwin" ]; then
    # macOS: Homebrew/the system already provides the shared libs Chromium needs,
    # and `--with-deps` isn't supported on macOS — plain install only.
    if ! run_with_spinner "Installing headless browser (Chromium)..." \
        env PLAYWRIGHT_BROWSERS_PATH="$browsers_path" bun x playwright install chromium; then
      warn "Could not install Chromium for the browser tools (browse_url / screenshot_url / browser sessions)."
      warn "Hivekeep is installed and will run; install it later with:"
      warn "  cd ${HIVEKEEP_DIR} && PLAYWRIGHT_BROWSERS_PATH='${browsers_path}' bun x playwright install chromium"
    fi
  else
    # Linux: prefer `--with-deps` so apt pulls Chromium's system libraries. That
    # needs root/sudo; if neither is available, fall back to a plain browser
    # install and tell the user how to add the OS libs themselves.
    if [ "$IS_ROOT" = true ]; then
      if ! run_with_spinner "Installing headless browser (Chromium + system libs)..." \
          env PLAYWRIGHT_BROWSERS_PATH="$browsers_path" bun x playwright install --with-deps chromium; then
        warn "Could not install Chromium for the browser tools (browse_url / screenshot_url / browser sessions)."
        warn "Hivekeep is installed and will run; install it later with:"
        warn "  cd ${HIVEKEEP_DIR} && PLAYWRIGHT_BROWSERS_PATH='${browsers_path}' bun x playwright install --with-deps chromium"
      fi
    elif command -v sudo &>/dev/null && sudo -n true 2>/dev/null; then
      # `--with-deps` shells out to apt internally, so it must run under sudo;
      # pass the browsers path through so the binary also lands in the shared dir.
      if ! run_with_spinner "Installing headless browser (Chromium + system libs)..." \
          sudo env PLAYWRIGHT_BROWSERS_PATH="$browsers_path" bun x playwright install --with-deps chromium; then
        warn "Could not install Chromium for the browser tools (browse_url / screenshot_url / browser sessions)."
        warn "Hivekeep is installed and will run; install it later with:"
        warn "  cd ${HIVEKEEP_DIR} && sudo env PLAYWRIGHT_BROWSERS_PATH='${browsers_path}' bun x playwright install --with-deps chromium"
      fi
    else
      # No sudo for the OS libs — install just the browser binary and tell the
      # user how to add the system dependencies in a separate one-time step.
      if ! run_with_spinner "Installing headless browser (Chromium)..." \
          env PLAYWRIGHT_BROWSERS_PATH="$browsers_path" bun x playwright install chromium; then
        warn "Could not install Chromium for the browser tools (browse_url / screenshot_url / browser sessions)."
      else
        warn "Chromium installed without system libraries (no sudo available)."
        warn "If browsing tools fail to launch, install the OS deps once with:"
        warn "  cd ${HIVEKEEP_DIR} && sudo bun x playwright install-deps chromium"
      fi
    fi
  fi
}

# Persist PLAYWRIGHT_BROWSERS_PATH into hivekeep.env so the systemd/launchd
# service (which may run as a different user than the installer) finds the
# browser installed above. Idempotent: replaces any existing line.
persist_browsers_path() {
  local browsers_path="$1"
  local env_file="$HIVEKEEP_DATA_DIR/hivekeep.env"
  [ -f "$env_file" ] || return 0
  # Drop a stale line then append the current value.
  if command -v sed &>/dev/null; then
    sed -i.bak '/^PLAYWRIGHT_BROWSERS_PATH=/d' "$env_file" 2>/dev/null || true
    rm -f "${env_file}.bak" 2>/dev/null || true
  fi
  printf 'PLAYWRIGHT_BROWSERS_PATH=%s\n' "$browsers_path" >> "$env_file"
}

# ─── Database ────────────────────────────────────────────────────────────────
setup_database() {
  step "Setting up database"

  mkdir -p "$HIVEKEEP_DATA_DIR"

  # Skip migrations if nothing changed and database already exists
  if [ "$HIVEKEEP_NO_CHANGES" = true ] && [ -f "$HIVEKEEP_DATA_DIR/hivekeep.db" ]; then
    success "No changes detected, skipping migrations"
    return 0
  fi

  cd "$HIVEKEEP_DIR"
  run_with_spinner "Running database migrations..." env HIVEKEEP_DATA_DIR="$HIVEKEEP_DATA_DIR" DB_PATH="$HIVEKEEP_DATA_DIR/hivekeep.db" bun run db:migrate
}

# ─── System user + ownership (root only) ─────────────────────────────────────
setup_system_user() {
  [ "$IS_ROOT" != true ] && return

  if ! id "$HIVEKEEP_USER" &>/dev/null; then
    info "Creating system user '$HIVEKEEP_USER'..."
    useradd \
      --system \
      --home-dir "$HIVEKEEP_DIR" \
      --shell /usr/sbin/nologin \
      --comment "Hivekeep service account" \
      "$HIVEKEEP_USER"
    success "User '$HIVEKEEP_USER' created"
  else
    success "User '$HIVEKEEP_USER' already exists"
  fi

  local ownership_paths=()
  [ -e "$HIVEKEEP_DIR" ] && ownership_paths+=("$HIVEKEEP_DIR")
  [ -e "$HIVEKEEP_DATA_DIR" ] && ownership_paths+=("$HIVEKEEP_DATA_DIR")
  if [ ${#ownership_paths[@]} -gt 0 ]; then
    chown -R "$HIVEKEEP_USER:$HIVEKEEP_USER" "${ownership_paths[@]}"
  fi
  success "Permissions set"
}

# ─── Resolve Bun path ────────────────────────────────────────────────────────
resolve_bun_path() {
  configure_bun_environment

  local selected_bun
  selected_bun="$(command -v bun 2>/dev/null || true)"
  [ -n "$selected_bun" ] || error "Bun is not available on PATH after installation"

  if [ "$IS_ROOT" != true ] || [ "$OS" != "Linux" ] || [ "${INIT_SYSTEM:-}" != "systemd" ]; then
    BUN_BIN="$(canonical_executable_path "$selected_bun" || printf '%s' "$selected_bun")"
    return 0
  fi

  BUN_BIN="$(canonical_executable_path "$selected_bun" || true)"
  [ -n "$BUN_BIN" ] || error "Could not resolve the Bun executable: $selected_bun"

  id "$HIVEKEEP_USER" &>/dev/null || error "Service user '$HIVEKEEP_USER' does not exist"
  if ! command -v runuser &>/dev/null && ! command -v su &>/dev/null; then
    error "Cannot validate Bun as '$HIVEKEEP_USER': install runuser or su and retry"
  fi

  local path_requires_managed_copy=false
  case "$BUN_BIN" in
    *[!A-Za-z0-9_./-]*) path_requires_managed_copy=true ;;
  esac

  if [ "$path_requires_managed_copy" = false ] && bun_runs_as_service_user "$BUN_BIN"; then
    success "Bun is executable by '$HIVEKEEP_USER' ($BUN_BIN)"
    return 0
  fi

  prepare_managed_bun_directory

  local managed_bun="$HIVEKEEP_SYSTEM_BUN_INSTALL/bin/bun"
  local managed_canonical=""
  managed_canonical="$(canonical_executable_path "$managed_bun" || true)"

  if [ -n "$managed_canonical" ] && [ "$BUN_BIN" = "$managed_canonical" ]; then
    BUN_BIN="$managed_bun"
    bun_runs_as_service_user "$BUN_BIN" || \
      error "Managed Bun is not executable by '$HIVEKEEP_USER': $BUN_BIN"
    success "Bun permissions repaired for '$HIVEKEEP_USER' ($BUN_BIN)"
    return 0
  fi

  local staged_bun="${managed_bun}.tmp.$$"
  rm -f "$staged_bun"
  install -o root -g root -m 0755 "$BUN_BIN" "$staged_bun"

  if ! bun_runs_as_service_user "$staged_bun"; then
    rm -f "$staged_bun"
    error "Bun cannot execute as '$HIVEKEEP_USER' after staging it at $staged_bun"
  fi

  mv -f "$staged_bun" "$managed_bun"
  chown root:root "$managed_bun"
  chmod 0755 "$managed_bun"
  BUN_BIN="$managed_bun"

  bun_runs_as_service_user "$BUN_BIN" || \
    error "Managed Bun is not executable by '$HIVEKEEP_USER': $BUN_BIN"
  success "Bun prepared for '$HIVEKEEP_USER' ($BUN_BIN)"
}

# ─── Service: systemd system (root) ──────────────────────────────────────────
create_systemd_system_service() {
  local env_file="$HIVEKEEP_DATA_DIR/hivekeep.env"
  local bun_dir
  local escaped_bun_bin
  local service_path
  bun_dir="$(dirname "$BUN_BIN")"
  escaped_bun_bin="$(escape_systemd_exec_token "$BUN_BIN")"
  service_path="$(escape_systemd_environment_value "${bun_dir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")"
  UNIT_FILE="$HIVEKEEP_SYSTEMD_UNIT"

  if [ "$IS_UPDATE" = true ] && systemctl is-active --quiet hivekeep 2>/dev/null; then
    info "Stopping existing service..."
    systemctl stop hivekeep
  fi

  cat > "$UNIT_FILE" << UNIT
[Unit]
Description=Hivekeep — AI Agent Platform
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
User=$HIVEKEEP_USER
Group=$HIVEKEEP_USER
WorkingDirectory=$HIVEKEEP_DIR
EnvironmentFile=-${env_file}
Environment="PATH=${service_path}"
ExecStart="$escaped_bun_bin" src/server/index.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hivekeep

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable hivekeep
  systemctl reset-failed hivekeep 2>/dev/null || true
  systemctl start hivekeep
  success "systemd system service started"
}

legacy_system_bun_service_needs_repair() {
  [ "$(id -u)" -eq 0 ] || return 1
  [ "$(uname -s)" = "Linux" ] || return 1
  [ -f "$HIVEKEEP_SYSTEMD_UNIT" ] || return 1
  [ -L "$HIVEKEEP_LEGACY_BUN_LINK" ] || return 1
  grep -Fq "ExecStart=$HIVEKEEP_LEGACY_BUN_LINK " "$HIVEKEEP_SYSTEMD_UNIT" || return 1

  local legacy_target
  legacy_target="$(canonical_executable_path "$HIVEKEEP_LEGACY_BUN_LINK" || true)"
  case "$legacy_target" in
    "${HIVEKEEP_LEGACY_BUN_ROOT%/}"/*) ;;
    *) return 1 ;;
  esac

  id "$HIVEKEEP_USER" &>/dev/null || return 1
  ! bun_runs_as_service_user "$HIVEKEEP_LEGACY_BUN_LINK"
}

repair_legacy_system_bun_service() {
  info "Repairing the legacy root-only Bun service path..."
  detect_os
  configure_bun_environment
  setup_system_user
  resolve_bun_path

  local previous_is_update="${IS_UPDATE:-false}"
  IS_UPDATE=true
  create_systemd_system_service
  IS_UPDATE="$previous_is_update"
  persist_bun_path

  local env_file="$HIVEKEEP_DATA_DIR/hivekeep.env"
  if [ -f "$env_file" ]; then
    local configured_port
    configured_port="$(grep '^PORT=' "$env_file" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
    [ -n "$configured_port" ] && HIVEKEEP_PORT="$configured_port"
  fi

  HIVEKEEP_HEALTHY=false
  verify_running
  [ "$HIVEKEEP_HEALTHY" = true ] || error "Legacy Bun path was migrated, but Hivekeep did not become healthy"

  systemctl is-active --quiet hivekeep || error "Legacy Bun path was migrated, but the systemd service is not active"
  local main_pid exec_status
  main_pid="$(systemctl show hivekeep -p MainPID --value 2>/dev/null || echo 0)"
  exec_status="$(systemctl show hivekeep -p ExecMainStatus --value 2>/dev/null || echo 1)"
  [ "$main_pid" -gt 0 ] 2>/dev/null || error "Legacy Bun path was migrated, but systemd has no Hivekeep process"
  [ "$exec_status" = "0" ] || error "Legacy Bun path was migrated, but systemd reports exit status $exec_status"
  success "Legacy Bun service path migrated to $BUN_BIN"
}

# ─── Service: systemd user (non-root) ────────────────────────────────────────
create_systemd_user_service() {
  local env_file="$HIVEKEEP_DATA_DIR/hivekeep.env"
  local bun_dir
  local escaped_bun_bin
  local service_path
  bun_dir="$(dirname "$BUN_BIN")"
  escaped_bun_bin="$(escape_systemd_exec_token "$BUN_BIN")"
  service_path="$(escape_systemd_environment_value "${bun_dir}:${PATH:-/usr/local/bin:/usr/bin:/bin}")"
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT_FILE="$UNIT_DIR/hivekeep.service"

  mkdir -p "$UNIT_DIR"

  if [ "$IS_UPDATE" = true ] && systemctl --user is-active --quiet hivekeep 2>/dev/null; then
    info "Stopping existing service..."
    systemctl --user stop hivekeep
  fi

  cat > "$UNIT_FILE" << UNIT
[Unit]
Description=Hivekeep — AI Agent Platform
After=network.target

[Service]
Type=simple
WorkingDirectory=$HIVEKEEP_DIR
EnvironmentFile=-${env_file}
Environment="PATH=${service_path}"
ExecStart="$escaped_bun_bin" src/server/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT

  systemctl --user daemon-reload
  systemctl --user enable hivekeep
  systemctl --user start hivekeep

  loginctl enable-linger "$USER" 2>/dev/null || \
    warn "Could not enable lingering (service won't auto-start on boot without login). Run: sudo loginctl enable-linger $USER"

  success "systemd user service started"
}

# ─── Service: launchd (macOS) ────────────────────────────────────────────────
create_launchd_service() {
  local env_file="$HIVEKEEP_DATA_DIR/hivekeep.env"
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST_PATH="$PLIST_DIR/io.hivekeep.server.plist"
  LOG_DIR="$HOME/Library/Logs/hivekeep"

  mkdir -p "$PLIST_DIR" "$LOG_DIR"

  if [ -f "$PLIST_PATH" ]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
  fi

  # Build env dict from hivekeep.env for launchd (it doesn't support EnvironmentFile)
  local env_dict=""
  if [ -f "$env_file" ]; then
    while IFS='=' read -r key value; do
      # Skip comments and empty lines
      [[ "$key" =~ ^#.*$ ]] && continue
      [[ -z "$key" ]] && continue
      env_dict+="    <key>${key}</key><string>${value}</string>\n"
    done < "$env_file"
  fi

  cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.hivekeep.server</string>

  <key>ProgramArguments</key>
  <array>
    <string>$BUN_BIN</string>
    <string>src/server/index.ts</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$HIVEKEEP_DIR</string>

  <key>EnvironmentVariables</key>
  <dict>
$(printf '%b' "$env_dict")    <key>PATH</key><string>$(dirname "$BUN_BIN"):/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/hivekeep.log</string>

  <key>StandardErrorPath</key>
  <string>$LOG_DIR/hivekeep-error.log</string>
</dict>
</plist>
PLIST

  launchctl load "$PLIST_PATH"
  success "launchd service loaded"
}

# ─── Service: start/stop script (WSL / no-systemd fallback) ──────────────────
create_script_service() {
  local env_file="$HIVEKEEP_DATA_DIR/hivekeep.env"
  local script_path="$HIVEKEEP_DIR/hivekeep"
  local pid_file="$HIVEKEEP_DATA_DIR/hivekeep.pid"
  local log_file="$HIVEKEEP_DATA_DIR/hivekeep.log"

  cat > "$script_path" << 'SCRIPT_HEADER'
#!/usr/bin/env bash
# Hivekeep service manager (for systems without systemd)
set -euo pipefail
SCRIPT_HEADER

  cat >> "$script_path" << SCRIPT_VARS
HIVEKEEP_DIR="$HIVEKEEP_DIR"
DATA_DIR="$HIVEKEEP_DATA_DIR"
ENV_FILE="$env_file"
PID_FILE="$pid_file"
LOG_FILE="$log_file"
BUN_BIN="$BUN_BIN"
SCRIPT_VARS

  cat >> "$script_path" << 'SCRIPT_BODY'

# Verify PID file points to an actual Hivekeep process (not a recycled PID)
is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null)" || return 1
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  # Guard against recycled PIDs: verify the process is actually bun/hivekeep
  if [ -d "/proc/$pid" ]; then
    local cmdline
    cmdline="$(cat "/proc/$pid/cmdline" 2>/dev/null | tr '\0' ' ')" || true
    if echo "$cmdline" | grep -qiE 'bun|hivekeep'; then
      return 0
    fi
    # PID exists but isn't Hivekeep — stale PID file
    return 1
  fi
  # No /proc (macOS/BSD) — fall back to ps
  if ps -p "$pid" -o args= 2>/dev/null | grep -qiE 'bun|hivekeep'; then
    return 0
  fi
  return 1
}

get_pid() {
  cat "$PID_FILE" 2>/dev/null || echo ""
}

# Rotate log file if it exceeds the threshold
# Keeps up to 3 archived logs: hivekeep.log.1 (newest) .. hivekeep.log.3 (oldest)
rotate_logs() {
  local max_bytes="${1:-52428800}"  # default 50MB
  local max_archives=3

  [ -f "$LOG_FILE" ] || return 0

  local size_bytes
  size_bytes="$(stat -c %s "$LOG_FILE" 2>/dev/null || stat -f %z "$LOG_FILE" 2>/dev/null || echo 0)"
  [ "$size_bytes" -ge "$max_bytes" ] 2>/dev/null || return 0

  # Shift existing archives: .3 -> deleted, .2 -> .3, .1 -> .2
  local i=$max_archives
  while [ "$i" -gt 1 ]; do
    local prev=$((i - 1))
    [ -f "${LOG_FILE}.${prev}" ] && mv -f "${LOG_FILE}.${prev}" "${LOG_FILE}.${i}"
    i=$((i - 1))
  done

  # Current log becomes .1, start fresh
  mv -f "$LOG_FILE" "${LOG_FILE}.1"
  : > "$LOG_FILE"

  local size_mb=$((size_bytes / 1048576))
  echo "Log rotated (was ${size_mb}MB). Archived to ${LOG_FILE}.1"
}

case "${1:-}" in
  start)
    if is_running; then
      echo "Hivekeep is already running (PID $(get_pid))"
      exit 0
    fi
    # Clean up stale PID file if present
    rm -f "$PID_FILE"
    # Auto-rotate logs before starting if they're large
    rotate_logs
    echo "Starting Hivekeep..."
    cd "$HIVEKEEP_DIR"
    set -a
    # shellcheck disable=SC1090
    [ -f "$ENV_FILE" ] && . "$ENV_FILE"
    set +a
    nohup "$BUN_BIN" src/server/index.ts >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "Hivekeep started (PID $!)"
    echo "Logs: tail -f $LOG_FILE"
    ;;
  stop)
    if ! is_running; then
      echo "Hivekeep is not running"
      rm -f "$PID_FILE"
      exit 0
    fi
    _pid="$(get_pid)"
    echo "Stopping Hivekeep (PID $_pid)..."
    kill "$_pid" 2>/dev/null || true

    # Wait up to 10 seconds for graceful shutdown
    _attempts=0
    while [ $_attempts -lt 20 ] && kill -0 "$_pid" 2>/dev/null; do
      sleep 0.5
      _attempts=$((_attempts + 1))
    done

    # Force kill if still running
    if kill -0 "$_pid" 2>/dev/null; then
      echo "Process didn't stop gracefully, sending SIGKILL..."
      kill -9 "$_pid" 2>/dev/null || true
      sleep 1
    fi

    rm -f "$PID_FILE"
    echo "Hivekeep stopped"
    ;;
  restart)
    "$0" stop
    sleep 1
    "$0" start
    ;;
  status)
    # ── Version ──
    _ver=""
    if [ -d "$HIVEKEEP_DIR/.git" ]; then
      _ver="$(git -C "$HIVEKEEP_DIR" describe --tags 2>/dev/null || git -C "$HIVEKEEP_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
    fi

    if is_running; then
      _pid="$(get_pid)"
      echo "● Hivekeep is running (PID $_pid)"
      [ -n "$_ver" ] && echo "  Version: $_ver"

      # Show uptime
      if [ -d "/proc/$_pid" ]; then
        _start_time="$(stat -c %Y "/proc/$_pid" 2>/dev/null)" || _start_time=""
        if [ -n "$_start_time" ]; then
          _now_time="$(date +%s)"
          _uptime_s=$((_now_time - _start_time))
          _days=$((_uptime_s / 86400))
          _hours=$(( (_uptime_s % 86400) / 3600 ))
          _mins=$(( (_uptime_s % 3600) / 60 ))
          if [ "$_days" -gt 0 ]; then
            echo "  Uptime:  ${_days}d ${_hours}h ${_mins}m"
          elif [ "$_hours" -gt 0 ]; then
            echo "  Uptime:  ${_hours}h ${_mins}m"
          else
            echo "  Uptime:  ${_mins}m"
          fi
        fi
      fi

      # Show memory usage
      _mem_kb=""
      if [ -f "/proc/$_pid/status" ]; then
        _mem_kb="$(awk '/^VmRSS:/ {print $2}' "/proc/$_pid/status" 2>/dev/null)" || _mem_kb=""
      fi
      if [ -z "$_mem_kb" ]; then
        _mem_kb="$(ps -p "$_pid" -o rss= 2>/dev/null | tr -d ' ')" || _mem_kb=""
      fi
      if [ -n "$_mem_kb" ] && [ "$_mem_kb" -gt 0 ] 2>/dev/null; then
        _mem_mb=$((_mem_kb / 1024))
        if [ "$_mem_mb" -gt 512 ] 2>/dev/null; then
          echo "  Memory:  ${_mem_mb}MB RSS ⚠ (high)"
        else
          echo "  Memory:  ${_mem_mb}MB RSS"
        fi
      fi

      # Show port from config and HTTP health
      _port=""
      if [ -f "$ENV_FILE" ]; then
        _port="$(grep '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2)" || _port=""
      fi
      if [ -n "$_port" ]; then
        _http_code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${_port}/" --max-time 3 2>/dev/null || echo "000")"
        if [ "$_http_code" != "000" ]; then
          echo "  Port:    $_port (HTTP $_http_code ✓)"
        else
          echo "  Port:    $_port (not responding ⚠)"
        fi
      fi

      # Show database info
      _db_file="$DATA_DIR/hivekeep.db"
      if [ -f "$_db_file" ]; then
        _db_size="$(du -h "$_db_file" 2>/dev/null | awk '{print $1}')" || _db_size=""
        [ -n "$_db_size" ] && echo "  DB:      $_db_size"
      fi

      # Show disk space
      _avail_kb="$(df -k "$DATA_DIR" 2>/dev/null | awk 'NR==2 {print $4}')" || _avail_kb=""
      if [ -n "$_avail_kb" ] && [ "$_avail_kb" -gt 0 ] 2>/dev/null; then
        _avail_mb=$((_avail_kb / 1024))
        _avail_gb=$((_avail_mb / 1024))
        if [ "$_avail_mb" -lt 500 ] 2>/dev/null; then
          echo "  Disk:    ${_avail_mb}MB free ⚠ (low)"
        elif [ "$_avail_gb" -gt 0 ] 2>/dev/null; then
          echo "  Disk:    ${_avail_gb}GB free"
        else
          echo "  Disk:    ${_avail_mb}MB free"
        fi
      fi

      # Show log file size
      if [ -f "$LOG_FILE" ]; then
        _log_size="$(du -h "$LOG_FILE" 2>/dev/null | awk '{print $1}')" || _log_size=""
        [ -n "$_log_size" ] && echo "  Logs:    $LOG_FILE ($_log_size)"
        _log_kb="$(du -k "$LOG_FILE" 2>/dev/null | awk '{print $1}')" || _log_kb="0"
        if [ "$_log_kb" -gt 102400 ] 2>/dev/null; then
          echo "  ⚠ Log file is large. Run: $0 log-rotate"
        fi
      fi

      # Check for available updates (quick, non-blocking)
      if [ -d "$HIVEKEEP_DIR/.git" ]; then
        _branch="$(git -C "$HIVEKEEP_DIR" branch --show-current 2>/dev/null || echo "main")"
        if git -C "$HIVEKEEP_DIR" fetch --dry-run origin "$_branch" 2>&1 | grep -q "$_branch" 2>/dev/null; then
          _behind="$(git -C "$HIVEKEEP_DIR" rev-list HEAD.."origin/$_branch" --count 2>/dev/null || echo "0")"
          if [ "$_behind" -gt 0 ] 2>/dev/null; then
            _remote_ver="$(git -C "$HIVEKEEP_DIR" describe --tags "origin/$_branch" 2>/dev/null || git -C "$HIVEKEEP_DIR" rev-parse --short "origin/$_branch" 2>/dev/null || echo "?")"
            echo ""
            echo "  ⬆ Update available: $_ver → $_remote_ver ($_behind commits behind)"
            echo "    Run: $0 update"
          fi
        fi
      fi
    else
      echo "○ Hivekeep is not running"
      [ -n "$_ver" ] && echo "  Version: $_ver"
      rm -f "$PID_FILE"
      # Show last few log lines as a hint
      if [ -f "$LOG_FILE" ]; then
        echo ""
        echo "Last log lines:"
        tail -5 "$LOG_FILE" 2>/dev/null | sed 's/^/  /'
      fi
      exit 1
    fi
    ;;
  logs)
    if [ "${2:-}" = "--recent" ] || [ "${2:-}" = "-n" ]; then
      _n="${3:-50}"
      tail -n "$_n" "$LOG_FILE"
    else
      tail -f "$LOG_FILE"
    fi
    ;;
  version)
    if [ -d "$HIVEKEEP_DIR/.git" ]; then
      _ver="$(git -C "$HIVEKEEP_DIR" describe --tags 2>/dev/null || git -C "$HIVEKEEP_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
      echo "Hivekeep $_ver"
    else
      echo "Hivekeep (version unknown)"
    fi
    ;;
  log-rotate)
    if [ -f "$LOG_FILE" ]; then
      _size="$(du -h "$LOG_FILE" 2>/dev/null | awk '{print $1}')" || _size="?"
      echo "Current log: $LOG_FILE ($_size)"
      rotate_logs 0  # force rotation regardless of size
      echo "Done."
    else
      echo "No log file found at $LOG_FILE"
    fi
    ;;
  update)
    # Convenience wrapper: re-run the installer in update mode
    _install_sh="$HIVEKEEP_DIR/install.sh"
    if [ ! -f "$_install_sh" ]; then
      echo "install.sh not found at $_install_sh"
      echo "Download and run manually:"
      echo "  curl -fsSL https://raw.githubusercontent.com/MarlBurroW/hivekeep/main/install.sh | bash"
      exit 1
    fi
    exec bash "$_install_sh" --update "$@"
    ;;
  backup)
    _install_sh="$HIVEKEEP_DIR/install.sh"
    if [ ! -f "$_install_sh" ]; then
      echo "install.sh not found at $_install_sh"
      exit 1
    fi
    exec bash "$_install_sh" --backup "${2:-}"
    ;;
  doctor)
    _install_sh="$HIVEKEEP_DIR/install.sh"
    if [ ! -f "$_install_sh" ]; then
      echo "install.sh not found at $_install_sh"
      exit 1
    fi
    exec bash "$_install_sh" --doctor
    ;;
  test)
    _install_sh="$HIVEKEEP_DIR/install.sh"
    if [ ! -f "$_install_sh" ]; then
      echo "install.sh not found at $_install_sh"
      exit 1
    fi
    exec bash "$_install_sh" --test
    ;;
  config)
    _install_sh="$HIVEKEEP_DIR/install.sh"
    if [ ! -f "$_install_sh" ]; then
      echo "install.sh not found at $_install_sh"
      exit 1
    fi
    exec bash "$_install_sh" --config
    ;;
  env)
    _install_sh="$HIVEKEEP_DIR/install.sh"
    if [ ! -f "$_install_sh" ]; then
      echo "install.sh not found at $_install_sh"
      exit 1
    fi
    # Pass remaining args (KEY=VAL, KEY-, or nothing for list)
    exec bash "$_install_sh" --env "${2:-}"
    ;;
  restore)
    _install_sh="$HIVEKEEP_DIR/install.sh"
    if [ ! -f "$_install_sh" ]; then
      echo "install.sh not found at $_install_sh"
      exit 1
    fi
    exec bash "$_install_sh" --restore "${2:-}"
    ;;
  reset)
    _install_sh="$HIVEKEEP_DIR/install.sh"
    if [ ! -f "$_install_sh" ]; then
      echo "install.sh not found at $_install_sh"
      exit 1
    fi
    exec bash "$_install_sh" --reset
    ;;
  cron)
    _install_sh="$HIVEKEEP_DIR/install.sh"
    if [ ! -f "$_install_sh" ]; then
      echo "install.sh not found at $_install_sh"
      exit 1
    fi
    exec bash "$_install_sh" --cron "${2:-status}"
    ;;
  health)
    # Lightweight health check for monitoring tools (Uptime Kuma, cron, Prometheus, etc.)
    # Exit 0 = healthy, 1 = unhealthy. Minimal output, suitable for scripting.
    _port=""
    if [ -f "$ENV_FILE" ]; then
      _port="$(grep '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2)" || _port=""
    fi
    _port="${_port:-3000}"
    _json=false
    [ "${2:-}" = "--json" ] && _json=true

    _healthy=true
    _reason=""

    # Check process
    if ! is_running; then
      _healthy=false
      _reason="process not running"
    fi

    # Check HTTP
    _http_code="000"
    if [ "$_healthy" = true ] && command -v curl &>/dev/null; then
      _http_code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${_port}/" --max-time 5 2>/dev/null || echo "000")"
      if [ "$_http_code" = "000" ]; then
        _healthy=false
        _reason="http not responding"
      fi
    fi

    # Check disk space (warn under 200MB)
    _disk_low=false
    _avail_mb=""
    _avail_kb="$(df -k "$DATA_DIR" 2>/dev/null | awk 'NR==2 {print $4}')" || _avail_kb=""
    if [ -n "$_avail_kb" ] && [ "$_avail_kb" -gt 0 ] 2>/dev/null; then
      _avail_mb=$((_avail_kb / 1024))
      if [ "$_avail_mb" -lt 200 ] 2>/dev/null; then
        _disk_low=true
      fi
    fi

    if [ "$_json" = true ]; then
      _pid_val="$(get_pid)"
      [ -z "$_pid_val" ] && _pid_val="null" || _pid_val="$_pid_val"
      [ -z "$_avail_mb" ] && _avail_mb="null"
      echo "{\"healthy\":$_healthy,\"pid\":$_pid_val,\"port\":$_port,\"http\":$_http_code,\"disk_mb\":$_avail_mb,\"disk_low\":$_disk_low}"
    else
      if [ "$_healthy" = true ]; then
        if [ "$_disk_low" = true ]; then
          echo "healthy (disk low: ${_avail_mb}MB)"
        else
          echo "healthy"
        fi
      else
        echo "unhealthy: $_reason"
      fi
    fi

    [ "$_healthy" = true ] && exit 0 || exit 1
    ;;
  *)
    echo "Hivekeep service manager"
    echo ""
    echo "Usage: $0 <command> [args]"
    echo ""
    echo "Service:"
    echo "  start         Start Hivekeep in the background"
    echo "  stop          Stop Hivekeep (graceful, then force after 10s)"
    echo "  restart       Stop and start Hivekeep"
    echo "  status        Show Hivekeep status, uptime, and resource usage"
    echo "  health        Quick health check for monitoring (exit 0/1, use --json)"
    echo "  logs          Tail the log file (use 'logs -n 50' for recent lines)"
    echo "  log-rotate    Rotate the log file now (archives to .1/.2/.3)"
    echo ""
    echo "Configuration:"
    echo "  config        Re-run the configuration wizard (change port, URL)"
    echo "  env [K|K=V|K-] Show, get, set, or remove config variables"
    echo ""
    echo "Maintenance:"
    echo "  update        Check for updates and apply"
    echo "  backup [path] Back up the database"
    echo "  restore [path] Restore database from a backup"
    echo "  reset         Fix broken install: re-clone & rebuild, keep data"
    echo "  cron [cmd]    Manage auto-updates (enable/disable/status)"
    echo "  doctor        Generate a diagnostic report (for bug reports)"
    echo "  test          Run self-tests to validate the installation"
    echo "  version       Show installed version"
    exit 1
    ;;
esac
SCRIPT_BODY

  chmod +x "$script_path"

  # Start Hivekeep
  "$script_path" start
  success "Hivekeep started via $script_path"
}

# ─── Create service (dispatch) ───────────────────────────────────────────────
create_service() {
  step "Creating service"

  if [ "$INIT_SYSTEM" = "launchd" ]; then
    create_launchd_service
  elif [ "$INIT_SYSTEM" = "script" ]; then
    create_script_service
  elif [ "$IS_ROOT" = true ]; then
    create_systemd_system_service
  else
    create_systemd_user_service
  fi

  persist_bun_path
}

# ─── Post-start health check ─────────────────────────────────────────────────
HIVEKEEP_HEALTHY=false

# Analyze recent logs and provide actionable hints for common failures
diagnose_startup_failure() {
  local log_lines=""

  # Grab last 50 lines of logs depending on init system
  if [ "$INIT_SYSTEM" = "launchd" ]; then
    local log_file="$HOME/Library/Logs/hivekeep/hivekeep.log"
    [ -f "$log_file" ] && log_lines="$(tail -50 "$log_file" 2>/dev/null)"
  elif [ "$INIT_SYSTEM" = "script" ]; then
    local log_file="$HIVEKEEP_DATA_DIR/hivekeep.log"
    [ -f "$log_file" ] && log_lines="$(tail -50 "$log_file" 2>/dev/null)"
  elif [ "$IS_ROOT" = true ]; then
    log_lines="$(journalctl -u hivekeep --no-pager -n 50 2>/dev/null)"
  else
    log_lines="$(journalctl --user -u hivekeep --no-pager -n 50 2>/dev/null)"
  fi

  if [ -z "$log_lines" ]; then
    warn "No logs found. The service may not have started at all."
    echo ""
    echo -e "  ${BOLD}Check that the service is registered:${NC}"
    if [ "$INIT_SYSTEM" = "launchd" ]; then
      echo -e "  ${DIM}  launchctl list | grep hivekeep${NC}"
    elif [ "$INIT_SYSTEM" = "script" ]; then
      echo -e "  ${DIM}  $HIVEKEEP_DIR/hivekeep status${NC}"
    elif [ "$IS_ROOT" = true ]; then
      echo -e "  ${DIM}  sudo systemctl status hivekeep${NC}"
    else
      echo -e "  ${DIM}  systemctl --user status hivekeep${NC}"
    fi
    return
  fi

  local hints_shown=0

  # Pattern: port already in use
  if echo "$log_lines" | grep -qi 'EADDRINUSE\|address already in use\|port.*already.*in.*use'; then
    echo ""
    echo -e "  ${RED}Diagnosis:${NC} Port $HIVEKEEP_PORT is already in use by another process."
    echo -e "  ${BOLD}Fix:${NC}"
    echo -e "  ${DIM}  # Find what's using the port:${NC}"
    if command -v ss &>/dev/null; then
      echo -e "  ${DIM}  ss -tlnp | grep :${HIVEKEEP_PORT}${NC}"
    elif command -v lsof &>/dev/null; then
      echo -e "  ${DIM}  lsof -i :${HIVEKEEP_PORT}${NC}"
    fi
    echo -e "  ${DIM}  # Then either stop that process, or change Hivekeep's port:${NC}"
    echo -e "  ${DIM}  bash install.sh --config${NC}"
    hints_shown=$((hints_shown + 1))
  fi

  # Pattern: out of memory
  if echo "$log_lines" | grep -qi 'out of memory\|OOM\|Cannot allocate memory\|JavaScript heap\|ENOMEM'; then
    echo ""
    echo -e "  ${RED}Diagnosis:${NC} Hivekeep ran out of memory."
    echo -e "  ${BOLD}Fix:${NC}"
    echo -e "  ${DIM}  # Check available memory:${NC}"
    echo -e "  ${DIM}  free -h${NC}"
    echo -e "  ${DIM}  # Add swap if needed:${NC}"
    echo -e "  ${DIM}  sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile${NC}"
    hints_shown=$((hints_shown + 1))
  fi

  # Pattern: permission denied
  if echo "$log_lines" | grep -qi 'EACCES\|permission denied\|EPERM'; then
    echo ""
    echo -e "  ${RED}Diagnosis:${NC} Permission error accessing files or ports."
    echo -e "  ${BOLD}Fix:${NC}"
    if [ "$IS_ROOT" = true ]; then
      echo -e "  ${DIM}  # Re-apply ownership:${NC}"
      echo -e "  ${DIM}  sudo chown -R ${HIVEKEEP_USER}:${HIVEKEEP_USER} ${HIVEKEEP_DIR} ${HIVEKEEP_DATA_DIR}${NC}"
    else
      echo -e "  ${DIM}  # Check file ownership:${NC}"
      echo -e "  ${DIM}  ls -la ${HIVEKEEP_DIR}/ ${HIVEKEEP_DATA_DIR}/${NC}"
    fi
    if [ "$HIVEKEEP_PORT" -lt 1024 ] 2>/dev/null; then
      echo -e "  ${DIM}  # Port $HIVEKEEP_PORT requires root. Use a port >= 1024 or run as root.${NC}"
    fi
    hints_shown=$((hints_shown + 1))
  fi

  # Pattern: database locked / corrupt
  if echo "$log_lines" | grep -qi 'database.*locked\|SQLITE_BUSY\|database.*corrupt\|database disk image is malformed'; then
    echo ""
    echo -e "  ${RED}Diagnosis:${NC} Database issue (locked or corrupted)."
    echo -e "  ${BOLD}Fix:${NC}"
    echo -e "  ${DIM}  # If locked, make sure no other Hivekeep process is running:${NC}"
    echo -e "  ${DIM}  pgrep -f 'hivekeep.*server' && echo 'Found stale process!'${NC}"
    echo -e "  ${DIM}  # If corrupted, restore from a backup:${NC}"
    echo -e "  ${DIM}  bash install.sh --restore${NC}"
    hints_shown=$((hints_shown + 1))
  fi

  # Pattern: missing module / build issue
  if echo "$log_lines" | grep -qi 'Cannot find module\|MODULE_NOT_FOUND\|Cannot find package\|SyntaxError'; then
    echo ""
    echo -e "  ${RED}Diagnosis:${NC} Missing dependency or broken build."
    echo -e "  ${BOLD}Fix:${NC}"
    echo -e "  ${DIM}  bash install.sh --reset${NC}"
    hints_shown=$((hints_shown + 1))
  fi

  # Pattern: env var / config issue
  if echo "$log_lines" | grep -qi 'missing.*env\|missing.*config\|required.*variable\|ENCRYPTION_KEY'; then
    echo ""
    echo -e "  ${RED}Diagnosis:${NC} Missing or invalid configuration."
    echo -e "  ${BOLD}Fix:${NC}"
    echo -e "  ${DIM}  bash install.sh --config${NC}"
    hints_shown=$((hints_shown + 1))
  fi

  # If no specific pattern matched, show the last few log lines as a hint
  if [ "$hints_shown" -eq 0 ]; then
    echo ""
    echo -e "  ${BOLD}Recent log output:${NC}"
    echo "$log_lines" | tail -10 | while IFS= read -r line; do
      echo -e "  ${DIM}  $line${NC}"
    done
    echo ""
    echo -e "  ${DIM}If the issue isn't clear, run: bash install.sh --test${NC}"
    echo -e "  ${DIM}Or open an issue: https://github.com/$HIVEKEEP_REPO/issues${NC}"
  fi
}

verify_running() {
  step "Verifying Hivekeep is running"

  local url="http://localhost:${HIVEKEEP_PORT}"
  local attempts=0
  local max_attempts=15

  # In quiet mode, reduce wait time
  [ "$HIVEKEEP_QUIET" = true ] && max_attempts=10

  while [ $attempts -lt $max_attempts ]; do
    local http_code
    http_code="$(curl -s -o /dev/null -w '%{http_code}' "${url}/" --max-time 2 2>/dev/null || echo "000")"
    if [ "$http_code" != "000" ]; then
      HIVEKEEP_HEALTHY=true
      success "Hivekeep is up and responding (HTTP $http_code)"
      return
    fi
    sleep 2
    attempts=$((attempts + 1))
  done

  warn "Hivekeep hasn't responded after 30 seconds"

  # Try to diagnose the actual problem instead of just saying "check the logs"
  diagnose_startup_failure

  # Always show the log command as a fallback
  echo ""
  echo -e "  ${BOLD}Full logs:${NC}"
  if [ "$INIT_SYSTEM" = "launchd" ]; then
    echo -e "  ${DIM}  tail -f ~/Library/Logs/hivekeep/hivekeep.log${NC}"
  elif [ "$INIT_SYSTEM" = "script" ]; then
    echo -e "  ${DIM}  $HIVEKEEP_DIR/hivekeep logs${NC}"
  elif [ "$IS_ROOT" = true ]; then
    echo -e "  ${DIM}  sudo journalctl -u hivekeep -f${NC}"
  else
    echo -e "  ${DIM}  journalctl --user -u hivekeep -f${NC}"
  fi
}

# ─── Summary ─────────────────────────────────────────────────────────────────
print_summary() {
  ACTION="installed"
  [ "${IS_UPDATE:-false}" = true ] && ACTION="updated"

  local version
  version="$(get_installed_version)"

  local elapsed=""
  elapsed="$(format_elapsed)"

  # In quiet mode, just print the essential one-liner
  if [ "$HIVEKEEP_QUIET" = true ]; then
    local status_icon="●"
    [ "$HIVEKEEP_HEALTHY" = true ] && status_icon="${GREEN}●${NC}" || status_icon="${YELLOW}●${NC}"
    local quiet_extra=""
    [ -n "$elapsed" ] && quiet_extra=" in ${elapsed}"
    echo -e "${status_icon} Hivekeep ${version} ${ACTION}${quiet_extra} — ${HIVEKEEP_PUBLIC_URL}"
    return
  fi

  echo ""
  local msg="Hivekeep ${version} ${ACTION} successfully!"
  local pad_len=$(( 40 - ${#msg} ))
  local padding=""
  for (( i=0; i<pad_len; i++ )); do padding+=" "; done
  echo -e "${BOLD}╔════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}║  ${msg}${padding}║${NC}"
  echo -e "${BOLD}╚════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${CYAN}Access URL:${NC}   $HIVEKEEP_PUBLIC_URL"
  echo -e "  ${CYAN}Install dir:${NC}  $HIVEKEEP_DIR"
  echo -e "  ${CYAN}Data dir:${NC}     $HIVEKEEP_DATA_DIR"
  echo -e "  ${CYAN}Config file:${NC}  $HIVEKEEP_DATA_DIR/hivekeep.env"
  if [ -n "${BACKUP_DB_PATH:-}" ] && [ -f "${BACKUP_DB_PATH:-}" ]; then
    echo -e "  ${CYAN}DB backup:${NC}    $(basename "$BACKUP_DB_PATH")"
  fi
  if [ "$HIVEKEEP_HEALTHY" = true ]; then
    echo -e "  ${GREEN}●${NC} ${BOLD}Status:${NC}       Running"
  else
    echo -e "  ${YELLOW}●${NC} ${BOLD}Status:${NC}       Starting (check logs if it doesn't come up)"
  fi
  if [ -n "$elapsed" ]; then
    echo -e "  ${CYAN}Completed in:${NC} $elapsed"
  fi
  echo ""

  if [ "${IS_UPDATE:-false}" != true ]; then
    echo -e "  ${BOLD}Getting started:${NC}"
    echo -e "  1. Open ${CYAN}$HIVEKEEP_PUBLIC_URL${NC} in your browser"
    echo -e "  2. Create your admin account"
    echo -e "  3. Add an AI provider (Anthropic, OpenAI, or Google Gemini)"
    echo -e "  4. Create your first agent and start chatting!"
    echo ""
    echo -e "  ${DIM}You'll need at least one AI provider API key.${NC}"
  else
    echo -e "  Visit ${CYAN}$HIVEKEEP_PUBLIC_URL${NC} to continue using Hivekeep."
  fi
  echo ""

  # Security hints for non-localhost HTTP URLs
  local show_security_hints=false
  local url_is_http=false
  local url_is_remote=false

  if [[ "$HIVEKEEP_PUBLIC_URL" =~ ^http:// ]]; then
    url_is_http=true
  fi
  # Check if URL points to a non-localhost address
  local url_host
  url_host="$(echo "$HIVEKEEP_PUBLIC_URL" | sed -E 's|^https?://||; s|[:/].*||')"
  case "$url_host" in
    localhost|127.0.0.1|::1) ;;
    *) url_is_remote=true ;;
  esac

  if [ "$url_is_http" = true ] && [ "$url_is_remote" = true ]; then
    show_security_hints=true
  fi

  # Check if ENCRYPTION_KEY is missing from config
  local has_encryption_key=false
  local env_file_path="$HIVEKEEP_DATA_DIR/hivekeep.env"
  if [ -f "$env_file_path" ] && grep -q '^ENCRYPTION_KEY=.\+' "$env_file_path" 2>/dev/null; then
    has_encryption_key=true
  fi

  if [ "$show_security_hints" = true ] || [ "$has_encryption_key" = false ]; then
    echo -e "  ${YELLOW}${BOLD}⚡ Secure your installation:${NC}"
    echo ""

    if [ "$show_security_hints" = true ]; then
      echo -e "  ${YELLOW}▸${NC} Your public URL uses ${BOLD}HTTP${NC} on a non-localhost address."
      echo -e "    API keys and credentials will be sent in plain text!"
      echo -e "    Set up HTTPS with a reverse proxy:"
      echo ""
      echo -e "    ${BOLD}Caddy${NC} ${DIM}(easiest, auto-HTTPS with Let's Encrypt):${NC}"
      echo -e "    ${DIM}    # Install: https://caddyserver.com/docs/install${NC}"
      echo -e "    ${DIM}    # Caddyfile:${NC}"
      echo -e "    ${DIM}    your-domain.com {${NC}"
      echo -e "    ${DIM}        reverse_proxy localhost:${HIVEKEEP_PORT}${NC}"
      echo -e "    ${DIM}    }${NC}"
      echo ""
      echo -e "    ${BOLD}Nginx${NC}${DIM} + certbot, ${BOLD}Traefik${NC}${DIM}, or any reverse proxy also work.${NC}"
      echo -e "    ${DIM}Then update your URL: bash install.sh --env PUBLIC_URL=https://your-domain.com${NC}"
      echo ""
    fi

    if [ "$has_encryption_key" = false ]; then
      echo -e "  ${YELLOW}▸${NC} Your secrets ${BOLD}are encrypted at rest${NC}. Hivekeep auto-generates an"
      echo -e "    encryption key on first run and saves it to:"
      echo -e "    ${CYAN}$HIVEKEEP_DATA_DIR/.encryption-key${NC}"
      echo -e "    ${BOLD}Back up this file together with your database.${NC} Without it, stored"
      echo -e "    API keys and vault secrets cannot be decrypted after a restore."
      echo -e "    ${DIM}Optional: pin the key in the environment for easy portability:${NC}"
      echo -e "    ${DIM}bash install.sh --env ENCRYPTION_KEY=\$(cat $HIVEKEEP_DATA_DIR/.encryption-key)${NC}"
      echo ""
    fi
  fi

  if [ "$INIT_SYSTEM" = "script" ]; then
    echo -e "  ${BOLD}Service commands:${NC}"
    echo -e "    $HIVEKEEP_DIR/hivekeep status"
    echo -e "    $HIVEKEEP_DIR/hivekeep restart"
    echo -e "    $HIVEKEEP_DIR/hivekeep logs"
    if [ "$IS_WSL" = true ]; then
      echo ""
      echo -e "  ${YELLOW}Note:${NC} On WSL, Hivekeep won't auto-start on boot."
      echo -e "  Add to your ~/.bashrc or ~/.profile:"
      echo -e "    ${DIM}$HIVEKEEP_DIR/hivekeep start${NC}"
    fi
  elif [ "$INIT_SYSTEM" = "systemd" ]; then
    if [ "$IS_ROOT" = true ]; then
      echo -e "  ${BOLD}Service commands:${NC}"
      echo -e "    sudo systemctl status hivekeep"
      echo -e "    sudo systemctl restart hivekeep"
      echo -e "    sudo journalctl -u hivekeep -f"
    else
      echo -e "  ${BOLD}Service commands:${NC}"
      echo -e "    systemctl --user status hivekeep"
      echo -e "    systemctl --user restart hivekeep"
      echo -e "    journalctl --user -u hivekeep -f"
    fi
  else
    echo -e "  ${BOLD}Service commands:${NC}"
    echo -e "    launchctl list | grep hivekeep"
    echo -e "    tail -f ~/Library/Logs/hivekeep/hivekeep.log"
    echo -e "    launchctl unload ~/Library/LaunchAgents/io.hivekeep.server.plist"
  fi

  echo ""
  echo -e "  ${DIM}To change settings: edit $HIVEKEEP_DATA_DIR/hivekeep.env"
  if [ "$INIT_SYSTEM" = "systemd" ]; then
    local restart_cmd="systemctl --user restart hivekeep"
    [ "$IS_ROOT" = true ] && restart_cmd="sudo systemctl restart hivekeep"
    echo -e "  then run: $restart_cmd${NC}"
  elif [ "$INIT_SYSTEM" = "script" ]; then
    echo -e "  then run: $HIVEKEEP_DIR/hivekeep restart${NC}"
  fi
  echo ""
}

# ─── Uninstall ───────────────────────────────────────────────────────────────
uninstall() {
  echo ""
  echo -e "${BOLD}Hivekeep Uninstaller${NC}"
  echo ""

  detect_os
  configure_bun_environment
  local retained_bun_path
  retained_bun_path="$(configured_bun_path || true)"

  # Stop and disable service
  header "Stopping service..."
  if [ "$INIT_SYSTEM" = "launchd" ]; then
    local plist="$HOME/Library/LaunchAgents/io.hivekeep.server.plist"
    if [ -f "$plist" ]; then
      launchctl unload "$plist" 2>/dev/null || true
      rm -f "$plist"
      success "launchd service removed"
    else
      info "No launchd service found"
    fi
  elif [ "$INIT_SYSTEM" = "script" ]; then
    local script_path="$HIVEKEEP_DIR/hivekeep"
    if [ -x "$script_path" ]; then
      "$script_path" stop 2>/dev/null || true
      success "Hivekeep stopped"
    else
      # Try killing by PID file
      local pid_file="$HIVEKEEP_DATA_DIR/hivekeep.pid"
      if [ -f "$pid_file" ]; then
        kill "$(cat "$pid_file")" 2>/dev/null || true
        rm -f "$pid_file"
      fi
      info "No service script found"
    fi
  elif [ "$IS_ROOT" = true ]; then
    if systemctl is-active --quiet hivekeep 2>/dev/null; then
      systemctl stop hivekeep
    fi
    systemctl disable hivekeep 2>/dev/null || true
    rm -f /etc/systemd/system/hivekeep.service
    systemctl daemon-reload
    success "systemd system service removed"
  else
    if systemctl --user is-active --quiet hivekeep 2>/dev/null; then
      systemctl --user stop hivekeep
    fi
    systemctl --user disable hivekeep 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/hivekeep.service"
    systemctl --user daemon-reload
    success "systemd user service removed"
  fi

  if [ "$IS_ROOT" = true ]; then
    rm -f "$HIVEKEEP_SYSTEM_CONFIG_DIR/bun.path"
    rmdir "$HIVEKEEP_SYSTEM_CONFIG_DIR" 2>/dev/null || true
  else
    rm -f "$HIVEKEEP_DATA_DIR/bun.path"
  fi

  # Remove app directory
  header "Removing application files..."
  if [ -d "$HIVEKEEP_DIR" ]; then
    rm -rf "$HIVEKEEP_DIR"
    success "Removed $HIVEKEEP_DIR"
  else
    info "$HIVEKEEP_DIR not found — skipping"
  fi

  # Remove system user (root only)
  if [ "$IS_ROOT" = true ] && id "${HIVEKEEP_USER:-hivekeep}" &>/dev/null; then
    userdel "${HIVEKEEP_USER:-hivekeep}" 2>/dev/null || true
    success "System user '${HIVEKEEP_USER:-hivekeep}' removed"
  fi

  # Ask about data directory
  echo ""
  local remove_data="n"
  if [ "${HIVEKEEP_NO_PROMPT:-}" = "true" ] || [ "${CI:-}" = "true" ]; then
    remove_data="n"
  elif [ -d "$HIVEKEEP_DATA_DIR" ]; then
    # Show what's in the data directory before asking
    local data_size
    data_size="$(du -sh "$HIVEKEEP_DATA_DIR" 2>/dev/null | awk '{print $1}' || echo "unknown")"
    local has_db=false
    [ -f "$HIVEKEEP_DATA_DIR/hivekeep.db" ] && has_db=true

    echo -e "  ${DIM}Data directory: $HIVEKEEP_DATA_DIR ($data_size)${NC}"
    if [ "$has_db" = true ]; then
      local db_size
      db_size="$(du -h "$HIVEKEEP_DATA_DIR/hivekeep.db" 2>/dev/null | awk '{print $1}' || echo "?")"
      echo -e "  ${DIM}  Database: $db_size${NC}"
    fi
    [ -f "$HIVEKEEP_DATA_DIR/hivekeep.env" ] && echo -e "  ${DIM}  Config: hivekeep.env${NC}"
    local backup_count=0
    if [ -d "$HIVEKEEP_DATA_DIR/backups" ]; then
      backup_count="$(find "$HIVEKEEP_DATA_DIR/backups" -maxdepth 1 -name 'hivekeep-*.db' -type f 2>/dev/null | wc -l)"
      [ "$backup_count" -gt 0 ] && echo -e "  ${DIM}  Backups: $backup_count${NC}"
    fi
    echo ""

    echo -en "  ${YELLOW}?${NC} ${BOLD}Remove data directory?${NC} ${DIM}This deletes your database and config [y/N]${NC}: " >/dev/tty
    read -r remove_data </dev/tty || remove_data="n"

    # If user wants to delete data and a database exists, offer a backup first
    if [[ "$remove_data" =~ ^[Yy]$ ]] && [ "$has_db" = true ]; then
      echo ""
      local do_backup="y"
      echo -en "  ${CYAN}?${NC} ${BOLD}Create a backup before deleting?${NC} ${DIM}[Y/n]${NC}: " >/dev/tty
      read -r do_backup </dev/tty || do_backup="y"
      [ -z "$do_backup" ] && do_backup="y"

      if [[ "$do_backup" =~ ^[Yy]$ ]]; then
        local backup_dest
        backup_dest="$HOME/hivekeep-backup-$(date +%Y%m%d-%H%M%S).db"
        if cp "$HIVEKEEP_DATA_DIR/hivekeep.db" "$backup_dest" 2>/dev/null; then
          # Also copy the config alongside the DB
          if [ -f "$HIVEKEEP_DATA_DIR/hivekeep.env" ]; then
            cp "$HIVEKEEP_DATA_DIR/hivekeep.env" "${backup_dest%.db}.env" 2>/dev/null || true
          fi
          success "Backup saved to $backup_dest"
        else
          warn "Could not create backup. Aborting data removal for safety."
          remove_data="n"
        fi
      fi
    fi
  else
    info "$HIVEKEEP_DATA_DIR not found — nothing to remove"
  fi

  if [[ "$remove_data" =~ ^[Yy]$ ]]; then
    if [ -d "$HIVEKEEP_DATA_DIR" ]; then
      rm -rf "$HIVEKEEP_DATA_DIR"
      success "Removed $HIVEKEEP_DATA_DIR"
    fi
  elif [ -d "$HIVEKEEP_DATA_DIR" ]; then
    info "Data kept at $HIVEKEEP_DATA_DIR"
  fi

  # Remove auto-update cron job if present
  header "Cleaning up scheduled tasks..."
  HIVEKEEP_CRON_TAG="# hivekeep-auto-update"
  local existing_crontab
  existing_crontab="$(crontab -l 2>/dev/null || echo "")"
  if echo "$existing_crontab" | grep -q "$HIVEKEEP_CRON_TAG"; then
    local new_crontab
    new_crontab="$(echo "$existing_crontab" | grep -v "$HIVEKEEP_CRON_TAG")"
    if [ -n "$new_crontab" ]; then
      echo "$new_crontab" | crontab -
    else
      crontab -r 2>/dev/null || echo "" | crontab -
    fi
    success "Auto-update cron job removed"
  else
    info "No auto-update cron job found"
  fi

  # Remove launchd auto-update plist (macOS)
  if [ "$INIT_SYSTEM" = "launchd" ]; then
    local update_plist="$HOME/Library/LaunchAgents/io.hivekeep.auto-update.plist"
    if [ -f "$update_plist" ]; then
      launchctl unload "$update_plist" 2>/dev/null || true
      rm -f "$update_plist"
      success "Auto-update launchd job removed"
    fi
  fi

  # Remove lockfile
  local lock_file="${TMPDIR:-/tmp}/hivekeep-installer.lock"
  if [ -f "$lock_file" ]; then
    rm -f "$lock_file"
    success "Lockfile removed"
  fi

  echo ""
  echo -e "${GREEN}${BOLD}Hivekeep uninstalled.${NC}"

  # Post-uninstall hints
  local hints=()
  if [ -n "$retained_bun_path" ] && [ -f "$retained_bun_path" ]; then
    hints+=("Bun runtime is still installed at $retained_bun_path")
  fi
  if [ -d "$HIVEKEEP_DATA_DIR" ] && [[ ! "$remove_data" =~ ^[Yy]$ ]]; then
    hints+=("Data preserved at $HIVEKEEP_DATA_DIR (re-install will reuse it)")
  fi

  if [ ${#hints[@]} -gt 0 ]; then
    echo ""
    echo -e "  ${DIM}Notes:${NC}"
    for hint in "${hints[@]}"; do
      echo -e "  ${DIM}  • $hint${NC}"
    done
  fi
  echo ""
}

# ─── Version info ─────────────────────────────────────────────────────────────
# ─── Categorized commit display ──────────────────────────────────────────────
# Displays commits grouped by conventional commit type (feat, fix, etc.)
# Usage: show_categorized_commits "commit_range" [max_per_category]
# Example: show_categorized_commits "HEAD..origin/main" 10
show_categorized_commits() {
  local range="$1"
  local max_per_cat="${2:-0}"  # 0 = no limit

  local commits
  commits="$(git -C "$HIVEKEEP_DIR" log --oneline "$range" 2>/dev/null)"
  [ -z "$commits" ] && return 1

  # Extract categories
  local feats fixes installer docs refactor other
  feats="$(echo "$commits" | grep -iE '^\w+ feat' || true)"
  fixes="$(echo "$commits" | grep -iE '^\w+ fix' || true)"
  installer="$(echo "$commits" | grep -iE '^\w+ installer' || true)"
  docs="$(echo "$commits" | grep -iE '^\w+ (docs?|readme)' || true)"
  refactor="$(echo "$commits" | grep -iE '^\w+ (refactor|chore|ci|build|perf|test)' || true)"
  other="$(echo "$commits" | grep -viE '^\w+ (feat|fix|installer|docs?|readme|refactor|chore|ci|build|perf|test)' || true)"

  _show_cat_section() {
    local title="$1" icon="$2" lines="$3"
    [ -z "$lines" ] && return
    local count shown=0
    count="$(echo "$lines" | wc -l)"
    echo -e "  ${icon} ${BOLD}${title}${NC} ${DIM}(${count})${NC}"
    while IFS= read -r line; do
      if [ "$max_per_cat" -gt 0 ] 2>/dev/null && [ "$shown" -ge "$max_per_cat" ] 2>/dev/null; then
        local remaining=$((count - max_per_cat))
        echo -e "    ${DIM}  ... and $remaining more${NC}"
        break
      fi
      local hash="${line%% *}"
      local msg="${line#"$hash" }"
      echo -e "    ${DIM}•${NC} $msg"
      shown=$((shown + 1))
    done <<< "$lines"
    echo ""
  }

  _show_cat_section "Features" "✨" "$feats"
  _show_cat_section "Bug Fixes" "🐛" "$fixes"
  _show_cat_section "Installer" "📦" "$installer"
  _show_cat_section "Documentation" "📝" "$docs"
  _show_cat_section "Maintenance" "🔧" "$refactor"
  _show_cat_section "Other" "📋" "$other"

  return 0
}

get_installed_version() {
  if [ -d "$HIVEKEEP_DIR/.git" ]; then
    git -C "$HIVEKEEP_DIR" describe --tags 2>/dev/null || \
      git -C "$HIVEKEEP_DIR" rev-parse --short HEAD 2>/dev/null || \
      echo "unknown"
  else
    echo "not installed"
  fi
}

get_installed_branch() {
  if [ -d "$HIVEKEEP_DIR/.git" ]; then
    git -C "$HIVEKEEP_DIR" branch --show-current 2>/dev/null || echo "unknown"
  else
    echo "n/a"
  fi
}

get_installed_date() {
  if [ -d "$HIVEKEEP_DIR/.git" ]; then
    git -C "$HIVEKEEP_DIR" log -1 --format='%ci' 2>/dev/null | cut -d' ' -f1 || echo "unknown"
  else
    echo "n/a"
  fi
}

show_version() {
  # Detect OS first for correct default dirs
  OS="$(uname -s)"
  IS_ROOT=false
  [ "$(id -u)" -eq 0 ] && IS_ROOT=true
  if [ "$IS_ROOT" = true ]; then
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-/opt/hivekeep}"
  else
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-$HOME/hivekeep}"
  fi

  local version
  version="$(get_installed_version)"

  if [ "$version" = "not installed" ]; then
    echo "Hivekeep is not installed at $HIVEKEEP_DIR"
    exit 1
  fi

  local branch date_str commit_count channel
  branch="$(get_installed_branch)"
  date_str="$(get_installed_date)"
  commit_count="$(git -C "$HIVEKEEP_DIR" rev-list HEAD --count 2>/dev/null || echo "?")"
  channel="$(resolve_channel)"

  echo -e "${BOLD}Hivekeep${NC} $version"
  echo -e "  Channel: $channel"
  if [ -n "$branch" ] && [ "$branch" != "unknown" ]; then
    echo -e "  Branch: $branch"
  fi
  echo -e "  Last update: $date_str"
  echo -e "  Commits: $commit_count"
  echo -e "  Install: $HIVEKEEP_DIR"

  # Check if updates are available
  local remote_version="" behind="0"
  if [ "$channel" = "stable" ]; then
    if git -C "$HIVEKEEP_DIR" fetch --tags origin --quiet 2>/dev/null; then
      remote_version="$(get_latest_stable_tag)"
      if [ -n "$remote_version" ]; then
        local remote_head local_head
        remote_head="$(git -C "$HIVEKEEP_DIR" rev-parse "${remote_version}^{commit}" 2>/dev/null || echo "")"
        local_head="$(git -C "$HIVEKEEP_DIR" rev-parse HEAD 2>/dev/null || echo "")"
        if [ -n "$remote_head" ] && [ "$remote_head" != "$local_head" ]; then
          behind="$(git -C "$HIVEKEEP_DIR" rev-list "HEAD..$remote_head" --count 2>/dev/null || echo "1")"
          [ "$behind" = "0" ] && behind="1"
        fi
      fi
    fi
  else
    [ -z "$branch" ] || [ "$branch" = "unknown" ] && branch="main"
    if git -C "$HIVEKEEP_DIR" fetch origin "$branch" --quiet 2>/dev/null; then
      remote_version="$(git -C "$HIVEKEEP_DIR" describe --tags "origin/$branch" 2>/dev/null || \
        git -C "$HIVEKEEP_DIR" rev-parse --short "origin/$branch" 2>/dev/null || echo "unknown")"
      behind="$(git -C "$HIVEKEEP_DIR" rev-list HEAD.."origin/$branch" --count 2>/dev/null || echo "0")"
    fi
  fi

  if [ "$behind" -gt 0 ] 2>/dev/null; then
    echo ""
    echo -e "  ${YELLOW}⚠ $behind commit(s) behind${NC} → $remote_version"
    echo -e "  ${DIM}Run: bash install.sh --update${NC}"
  elif [ -n "$remote_version" ]; then
    echo ""
    echo -e "  ${GREEN}✓ Up to date${NC}"
  fi
}

# ─── Changelog ────────────────────────────────────────────────────────────────
show_changelog() {
  # Detect OS first for correct default dirs
  OS="$(uname -s)"
  IS_ROOT=false
  [ "$(id -u)" -eq 0 ] && IS_ROOT=true
  if [ "$IS_ROOT" = true ]; then
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-/opt/hivekeep}"
  else
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-$HOME/hivekeep}"
  fi

  if [ ! -d "$HIVEKEEP_DIR/.git" ]; then
    echo "Hivekeep is not installed at $HIVEKEEP_DIR"
    exit 1
  fi

  local channel target_ref target_label
  channel="$(resolve_channel)"

  # Fetch latest from remote
  info "Fetching latest changes (${channel} channel)..."
  if [ "$channel" = "stable" ]; then
    if ! git -C "$HIVEKEEP_DIR" fetch --tags origin --quiet 2>/dev/null; then
      error "Could not fetch from remote. Check your internet connection."
    fi
    target_ref="$(get_latest_stable_tag)"
    [ -z "$target_ref" ] && error "Could not resolve the latest release tag."
    target_label="$target_ref"
  else
    local branch
    branch="$(git -C "$HIVEKEEP_DIR" branch --show-current 2>/dev/null || echo "main")"
    if ! git -C "$HIVEKEEP_DIR" fetch origin "$branch" --quiet 2>/dev/null; then
      error "Could not fetch from remote. Check your internet connection."
    fi
    target_ref="origin/$branch"
    target_label="$(git -C "$HIVEKEEP_DIR" describe --tags "$target_ref" 2>/dev/null || git -C "$HIVEKEEP_DIR" rev-parse --short "$target_ref")"
  fi

  local local_ref remote_ref
  local_ref="$(git -C "$HIVEKEEP_DIR" rev-parse HEAD 2>/dev/null)"
  remote_ref="$(git -C "$HIVEKEEP_DIR" rev-parse "${target_ref}^{commit}" 2>/dev/null)"

  if [ "$local_ref" = "$remote_ref" ]; then
    local version
    version="$(get_installed_version)"
    echo ""
    echo -e "  ${GREEN}✓ Up to date${NC} ($version, $channel channel)"
    echo ""
    exit 0
  fi

  local behind
  behind="$(git -C "$HIVEKEEP_DIR" rev-list "HEAD..$remote_ref" --count 2>/dev/null || echo "0")"
  local current_version
  current_version="$(get_installed_version)"

  echo ""
  echo -e "${BOLD}Hivekeep Changelog${NC}"
  echo ""
  echo -e "  ${CYAN}Channel:${NC}    $channel"
  echo -e "  ${CYAN}Installed:${NC}  $current_version"
  echo -e "  ${CYAN}Latest:${NC}     $target_label"
  echo -e "  ${CYAN}Changes:${NC}    $behind commit(s)"
  echo ""

  # Show categorized changelog
  if ! show_categorized_commits "HEAD..$remote_ref"; then
    echo -e "  ${DIM}No commits to show.${NC}"
    echo ""
    exit 0
  fi

  # Show tags in the range (version milestones)
  local tags_in_range
  tags_in_range="$(git -C "$HIVEKEEP_DIR" log --simplify-by-decoration --decorate=short --pretty=format:'%D' "HEAD..$remote_ref" 2>/dev/null | grep -oE 'tag: [^,)]+' | sed 's/tag: //' || true)"
  if [ -n "$tags_in_range" ]; then
    echo -e "  ${CYAN}${BOLD}Version tags in this range:${NC}"
    echo "$tags_in_range" | while IFS= read -r tag; do
      [ -z "$tag" ] && continue
      local tag_date
      tag_date="$(git -C "$HIVEKEEP_DIR" log -1 --format='%ci' "$tag" 2>/dev/null | cut -d' ' -f1 || echo "")"
      echo -e "    ${BOLD}$tag${NC} ${DIM}($tag_date)${NC}"
    done
    echo ""
  fi

  echo -e "  ${DIM}To apply these changes: bash install.sh --update${NC}"
  echo ""
}

# ─── Help ────────────────────────────────────────────────────────────────────
show_help() {
  echo ""
  echo -e "${BOLD}Hivekeep Installer${NC} — Self-hosted AI agent platform"
  echo ""
  echo -e "${BOLD}USAGE${NC}"
  echo "  curl -fsSL https://raw.githubusercontent.com/MarlBurroW/hivekeep/main/install.sh | bash   # Fresh install"
  echo "  bash install.sh [COMMAND] [OPTIONS]           # Local install or manage"
  echo ""

  echo -e "${BOLD}INSTALL & UPDATE${NC}"
  echo "  ${DIM}(no command)${NC}      Install Hivekeep (or update if already installed)"
  echo "  --update        Check for updates and apply if available"
  echo "  --channel CHAN  Update channel: stable (release tags, default) or edge (main branch)"
  echo "  --docker        Docker Compose setup (no Bun/build needed)"
  echo "  --dry-run       Preview what would happen without making changes"
  echo "  --reset         Fix broken install: re-clone & rebuild, keep data"
  echo "  --uninstall     Remove Hivekeep (keeps data unless confirmed)"
  echo ""

  echo -e "${BOLD}SERVICE${NC}"
  echo "  --start         Start the Hivekeep service"
  echo "  --stop          Stop the Hivekeep service"
  echo "  --restart       Restart the Hivekeep service"
  echo "  --logs [N]      Show logs (follow live, or last N lines)"
  echo "                  --grep PATTERN: filter lines; --since TIME: journalctl time"
  echo ""

  echo -e "${BOLD}CONFIGURATION${NC}"
  echo "  --config        Re-run the configuration wizard (change port, URL)"
  echo "  --env [KEY=VAL] Show, get, set, or remove env variables in the config file"
  echo "                  No args: show all; KEY: get one; KEY=VAL: set; KEY-: remove"
  echo ""

  echo -e "${BOLD}DATA${NC}"
  echo "  --backup [path] Back up database (and config) to a file"
  echo "  --restore [path] Restore from a backup (interactive picker if no path)"
  echo ""

  echo -e "${BOLD}DIAGNOSTICS${NC}"
  echo "  --status        Check current installation health"
  echo "  --health        Quick health check for monitoring (exit 0=ok, 1=fail)"
  echo "                  --json: machine-readable JSON output"
  echo "  --test          Run self-tests (validates DB, build, HTTP, etc.)"
  echo "  --doctor        Generate a diagnostic report (for bug reports / support)"
  echo "  --version       Show installed version and check for updates"
  echo "  --changelog     Show what changed between installed and latest version"
  echo ""

  echo -e "${BOLD}AUTOMATION${NC}"
  echo "  --cron [enable|disable|status]  Manage automatic update scheduling"
  echo "                  enable: set up weekly auto-updates (cron/launchd)"
  echo "                  disable: remove the auto-update job"
  echo "                  status: show current auto-update config"
  echo ""

  echo -e "${BOLD}SHELL${NC}"
  echo "  --completions [bash|zsh|fish]  Generate shell tab-completions"
  echo ""

  echo -e "${BOLD}FLAGS${NC}"
  echo "  --yes, -y       Auto-confirm all prompts (accept defaults)"
  echo "  --quiet, -q     Suppress non-essential output (only errors + summary)"
  echo "  --no-color      Disable colored output (also: NO_COLOR=1)"
  echo "  --help          Show this help message"
  echo ""

  echo -e "${BOLD}ENVIRONMENT VARIABLES${NC}"
  echo "  HIVEKEEP_PORT         Port to run on (default: 3000)"
  echo "  HIVEKEEP_DIR          Installation directory"
  echo "  HIVEKEEP_DATA_DIR     Data directory (database, config)"
  echo "  HIVEKEEP_PUBLIC_URL   Public URL for webhooks & invite links"
  echo "  HIVEKEEP_CHANNEL      Update channel: stable (default) or edge (same as --channel)"
  echo "  HIVEKEEP_BRANCH       Git branch for the edge channel (default: main; implies edge)"
  echo "  HIVEKEEP_NO_PROMPT    Skip interactive prompts (default: false)"
  echo "  HIVEKEEP_YES          Auto-confirm all prompts (same as --yes)"
  echo "  HIVEKEEP_QUIET        Suppress non-essential output (same as --quiet)"
  echo "  HIVEKEEP_CRON_SCHEDULE    Cron expression for auto-updates (default: 0 3 * * 0)"
  echo "  HIVEKEEP_SKIP_SELF_UPDATE  Skip installer self-update check"
  echo ""

  echo -e "${BOLD}QUICK START${NC}"
  echo -e "  ${DIM}# Install with defaults${NC}"
  echo "  curl -fsSL https://raw.githubusercontent.com/MarlBurroW/hivekeep/main/install.sh | bash"
  echo ""
  echo -e "  ${DIM}# Custom port, non-interactive${NC}"
  echo "  HIVEKEEP_PORT=8080 bash install.sh -y"
  echo ""
  echo -e "  ${DIM}# Docker (no build tools needed)${NC}"
  echo "  bash install.sh --docker"
  echo ""

  echo -e "${BOLD}COMMON TASKS${NC}"
  echo -e "  ${DIM}# Update to latest version${NC}"
  echo "  bash install.sh --update"
  echo ""
  echo -e "  ${DIM}# Set up automatic weekly updates${NC}"
  echo "  bash install.sh --cron enable"
  echo ""
  echo -e "  ${DIM}# Or daily auto-updates${NC}"
  echo "  HIVEKEEP_CRON_SCHEDULE='0 3 * * *' bash install.sh --cron enable"
  echo ""
  echo -e "  ${DIM}# Change config${NC}"
  echo "  bash install.sh --config"
  echo "  bash install.sh --env PORT               ${DIM}# get a single value${NC}"
  echo "  bash install.sh --env LOG_LEVEL=debug"
  echo "  bash install.sh --env ENCRYPTION_KEY=\$(openssl rand -hex 32)"
  echo ""
  echo -e "  ${DIM}# Back up and restore${NC}"
  echo "  bash install.sh --backup ~/hivekeep-backup.db"
  echo "  bash install.sh --restore ~/hivekeep-backup.db"
  echo ""
  echo -e "  ${DIM}# Monitoring / health checks${NC}"
  echo "  bash install.sh --health              ${DIM}# exit 0=ok, 1=fail${NC}"
  echo "  bash install.sh --health --json       ${DIM}# JSON for dashboards${NC}"
  echo ""
  echo -e "  ${DIM}# Troubleshoot${NC}"
  echo "  bash install.sh --status"
  echo "  bash install.sh --logs 200 --grep error"
  echo "  bash install.sh --doctor > report.md"
  echo ""
  echo -e "  ${DIM}# Fix a broken install (keeps your data)${NC}"
  echo "  bash install.sh --reset"
  echo ""
  echo -e "  ${DIM}# Enable tab completion${NC}"
  echo "  eval \"\$(bash install.sh --completions bash)\"   ${DIM}# bash${NC}"
  echo "  eval \"\$(bash install.sh --completions zsh)\"    ${DIM}# zsh${NC}"
  echo "  bash install.sh --completions fish > ~/.config/fish/completions/hivekeep.fish"
  echo ""
}

# ─── Status check ────────────────────────────────────────────────────────────
check_status() {
  echo ""
  echo -e "${BOLD}Hivekeep Status Check${NC}"
  echo ""

  detect_os

  local has_issues=false

  # Check installation directory
  header "Installation"
  if [ -d "$HIVEKEEP_DIR/.git" ]; then
    local version
    version="$(git -C "$HIVEKEEP_DIR" describe --tags 2>/dev/null || git -C "$HIVEKEEP_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
    local branch
    branch="$(git -C "$HIVEKEEP_DIR" branch --show-current 2>/dev/null || echo "unknown")"
    success "Installed at $HIVEKEEP_DIR (${branch} @ ${version})"
  else
    error_noexit "Hivekeep not found at $HIVEKEEP_DIR"
    has_issues=true
  fi

  # Check data directory
  if [ -d "$HIVEKEEP_DATA_DIR" ]; then
    success "Data directory: $HIVEKEEP_DATA_DIR"
    if [ -f "$HIVEKEEP_DATA_DIR/hivekeep.env" ]; then
      success "Config file exists"
      # shellcheck disable=SC1090,SC1091
      . "$HIVEKEEP_DATA_DIR/hivekeep.env" 2>/dev/null || true
      HIVEKEEP_PORT="${PORT:-$HIVEKEEP_PORT}"
    else
      warn "No config file found at $HIVEKEEP_DATA_DIR/hivekeep.env"
      has_issues=true
    fi
    if [ -f "$HIVEKEEP_DATA_DIR/hivekeep.db" ]; then
      local db_size
      db_size="$(du -h "$HIVEKEEP_DATA_DIR/hivekeep.db" 2>/dev/null | awk '{print $1}')"
      success "Database: $db_size"
    else
      warn "No database found"
      has_issues=true
    fi
    # Show backup info
    local backup_dir="$HIVEKEEP_DATA_DIR/backups"
    if [ -d "$backup_dir" ]; then
      local backup_count
      backup_count="$(find "$backup_dir" -maxdepth 1 -name 'hivekeep-*.db' -type f 2>/dev/null | wc -l)"
      if [ "$backup_count" -gt 0 ] 2>/dev/null; then
        local latest_backup
        latest_backup="$(find "$backup_dir" -maxdepth 1 -name 'hivekeep-*.db' -type f -printf '%T@ %f\n' 2>/dev/null | sort -rn | head -1 | awk '{print $2}')"
        success "Backups: $backup_count (latest: $latest_backup)"
      fi
    fi
  else
    error_noexit "Data directory not found at $HIVEKEEP_DATA_DIR"
    has_issues=true
  fi

  # Check Bun
  header "Runtime"
  configure_bun_environment
  local doctor_bun
  doctor_bun="$(configured_bun_path || true)"
  if [ -n "$doctor_bun" ]; then
    local bun_ver
    bun_ver="$(run_configured_bun "$doctor_bun" --version 2>/dev/null || echo "0.0.0")"
    if version_gte "$bun_ver" "$BUN_MIN_VERSION"; then
      success "Bun v${bun_ver}"
    else
      warn "Bun v${bun_ver} is outdated (need v${BUN_MIN_VERSION}+). Run the installer to upgrade."
      has_issues=true
    fi

    if [ "$IS_ROOT" = true ] && [ "$OS" = "Linux" ] && [ "${INIT_SYSTEM:-}" = "systemd" ] && id "$HIVEKEEP_USER" &>/dev/null; then
      if bun_runs_as_service_user "$doctor_bun"; then
        success "Bun is executable by '$HIVEKEEP_USER'"
      else
        warn "Bun cannot execute as '$HIVEKEEP_USER' ($doctor_bun)"
        has_issues=true
      fi
    fi
  else
    warn "Configured Bun runtime not found"
    has_issues=true
  fi

  # Check service
  header "Service"
  if [ "$INIT_SYSTEM" = "launchd" ]; then
    if launchctl list 2>/dev/null | grep -q io.hivekeep.server; then
      success "launchd service is loaded"
    else
      warn "launchd service not loaded"
      has_issues=true
    fi
  elif [ "$INIT_SYSTEM" = "script" ]; then
    local script_path="$HIVEKEEP_DIR/hivekeep"
    local pid_file="$HIVEKEEP_DATA_DIR/hivekeep.pid"
    if [ -x "$script_path" ]; then
      if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
        success "Hivekeep is running (PID $(cat "$pid_file"), managed by script)"
      else
        warn "Hivekeep is not running (start with: $script_path start)"
        has_issues=true
      fi
    else
      warn "Service script not found at $script_path"
      has_issues=true
    fi
  elif [ "$IS_ROOT" = true ]; then
    if systemctl is-active --quiet hivekeep 2>/dev/null; then
      success "systemd service is running"
    elif systemctl is-enabled --quiet hivekeep 2>/dev/null; then
      warn "systemd service is enabled but not running"
      has_issues=true
    else
      warn "systemd system service not found"
      has_issues=true
    fi
  else
    if systemctl --user is-active --quiet hivekeep 2>/dev/null; then
      success "systemd user service is running"
    elif systemctl --user is-enabled --quiet hivekeep 2>/dev/null; then
      warn "systemd user service is enabled but not running"
      has_issues=true
    else
      warn "systemd user service not found"
      has_issues=true
    fi
  fi

  # Check port
  header "Network"
  if command -v ss &>/dev/null; then
    if ss -tlnp 2>/dev/null | grep -q ":${HIVEKEEP_PORT} "; then
      success "Port $HIVEKEEP_PORT is listening"
    else
      warn "Port $HIVEKEEP_PORT is not listening"
      has_issues=true
    fi
  elif command -v lsof &>/dev/null; then
    if lsof -i ":${HIVEKEEP_PORT}" -sTCP:LISTEN &>/dev/null; then
      success "Port $HIVEKEEP_PORT is listening"
    else
      warn "Port $HIVEKEEP_PORT is not listening"
      has_issues=true
    fi
  else
    info "Cannot check port (no ss or lsof)"
  fi

  # HTTP health check
  if command -v curl &>/dev/null; then
    local http_code
    http_code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${HIVEKEEP_PORT}/" --max-time 3 2>/dev/null || echo "000")"
    if [ "$http_code" != "000" ]; then
      success "HTTP responding (status $http_code)"
    else
      warn "HTTP not responding on localhost:${HIVEKEEP_PORT}"
      has_issues=true
    fi

    # Check PUBLIC_URL reachability (important for webhooks)
    local public_url="${PUBLIC_URL:-$HIVEKEEP_PUBLIC_URL}"
    if [ -n "$public_url" ] && [ "$public_url" != "http://localhost:${HIVEKEEP_PORT}" ]; then
      # Extract host from URL to check if it's a local/private IP (skip those)
      local url_host
      url_host="$(echo "$public_url" | sed -E 's|^https?://||; s|[:/].*||')"

      local is_local=false
      case "$url_host" in
        localhost|127.*|10.*|192.168.*) is_local=true ;;
        172.*)
          # Check 172.16.0.0/12 range
          local second_octet
          second_octet="$(echo "$url_host" | cut -d. -f2)"
          [ -n "$second_octet" ] && [ "$second_octet" -ge 16 ] 2>/dev/null && [ "$second_octet" -le 31 ] 2>/dev/null && is_local=true
          ;;
      esac

      if [ "$is_local" = false ]; then
        # Public URL with a real hostname, test reachability
        local public_code
        public_code="$(curl -s -o /dev/null -w '%{http_code}' "$public_url" --max-time 8 2>/dev/null || echo "000")"
        if [ "$public_code" != "000" ]; then
          success "Public URL reachable: $public_url (status $public_code)"

          # Check TLS if HTTPS
          if [[ "$public_url" =~ ^https:// ]]; then
            # Verify certificate validity and expiry
            local cert_expiry cert_days_left
            cert_expiry="$(echo | openssl s_client -servername "$url_host" -connect "$url_host:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | sed 's/notAfter=//')"
            if [ -n "$cert_expiry" ]; then
              local expiry_epoch now_epoch
              expiry_epoch="$(date -d "$cert_expiry" +%s 2>/dev/null || date -jf '%b %d %T %Y %Z' "$cert_expiry" +%s 2>/dev/null || echo "")"
              now_epoch="$(date +%s)"
              if [ -n "$expiry_epoch" ]; then
                cert_days_left=$(( (expiry_epoch - now_epoch) / 86400 ))
                if [ "$cert_days_left" -lt 0 ] 2>/dev/null; then
                  warn "TLS certificate EXPIRED ($cert_expiry)"
                  has_issues=true
                elif [ "$cert_days_left" -lt 7 ] 2>/dev/null; then
                  warn "TLS certificate expires in ${cert_days_left} day(s) ($cert_expiry)"
                  has_issues=true
                elif [ "$cert_days_left" -lt 30 ] 2>/dev/null; then
                  warn "TLS certificate expires in ${cert_days_left} days"
                else
                  success "TLS certificate valid (${cert_days_left} days remaining)"
                fi
              fi
            fi
          fi
        else
          warn "Public URL not reachable: $public_url"
          info "Check your reverse proxy, DNS, and firewall settings"
          info "Webhooks from AI providers may not work until this is fixed"
          has_issues=true
        fi
      else
        info "Public URL is local ($public_url), skipping external reachability check"
      fi
    fi
  fi

  # Check process resources (uptime, memory, disk, logs)
  header "Resources"

  # Process uptime & memory (find the Hivekeep PID)
  local hivekeep_pid=""
  if [ "$INIT_SYSTEM" = "script" ]; then
    local pid_file="$HIVEKEEP_DATA_DIR/hivekeep.pid"
    [ -f "$pid_file" ] && hivekeep_pid="$(cat "$pid_file" 2>/dev/null)"
  elif [ "$INIT_SYSTEM" = "launchd" ]; then
    hivekeep_pid="$(pgrep -f 'bun.*server/index' 2>/dev/null | head -1 || echo "")"
  elif [ "$IS_ROOT" = true ]; then
    hivekeep_pid="$(systemctl show hivekeep -p MainPID --value 2>/dev/null || echo "")"
    [ "$hivekeep_pid" = "0" ] && hivekeep_pid=""
  else
    hivekeep_pid="$(systemctl --user show hivekeep -p MainPID --value 2>/dev/null || echo "")"
    [ "$hivekeep_pid" = "0" ] && hivekeep_pid=""
  fi

  if [ -n "$hivekeep_pid" ] && kill -0 "$hivekeep_pid" 2>/dev/null; then
    # Uptime
    local proc_uptime=""
    if [ -d "/proc/$hivekeep_pid" ]; then
      local start_time_epoch
      start_time_epoch="$(stat -c %Y "/proc/$hivekeep_pid" 2>/dev/null)" || start_time_epoch=""
      if [ -n "$start_time_epoch" ]; then
        local now_epoch uptime_s
        now_epoch="$(date +%s)"
        uptime_s=$((now_epoch - start_time_epoch))
        local d=$((uptime_s / 86400)) h=$(( (uptime_s % 86400) / 3600 )) m=$(( (uptime_s % 3600) / 60 ))
        if [ "$d" -gt 0 ]; then
          proc_uptime="${d}d ${h}h ${m}m"
        elif [ "$h" -gt 0 ]; then
          proc_uptime="${h}h ${m}m"
        else
          proc_uptime="${m}m"
        fi
      fi
    elif [ "$OS" = "Darwin" ]; then
      local elapsed
      elapsed="$(ps -p "$hivekeep_pid" -o etime= 2>/dev/null | tr -d ' ')" || elapsed=""
      [ -n "$elapsed" ] && proc_uptime="$elapsed"
    fi
    [ -n "$proc_uptime" ] && success "Process uptime: $proc_uptime (PID $hivekeep_pid)"

    # Memory RSS
    local mem_kb=""
    if [ -f "/proc/$hivekeep_pid/status" ]; then
      mem_kb="$(awk '/^VmRSS:/ {print $2}' "/proc/$hivekeep_pid/status" 2>/dev/null)" || mem_kb=""
    fi
    if [ -z "$mem_kb" ]; then
      mem_kb="$(ps -p "$hivekeep_pid" -o rss= 2>/dev/null | tr -d ' ')" || mem_kb=""
    fi
    if [ -n "$mem_kb" ] && [ "$mem_kb" -gt 0 ] 2>/dev/null; then
      local mem_mb=$((mem_kb / 1024))
      if [ "$mem_mb" -gt 512 ] 2>/dev/null; then
        warn "Memory: ${mem_mb}MB RSS (high)"
        has_issues=true
      else
        success "Memory: ${mem_mb}MB RSS"
      fi
    fi
  fi

  # Disk space
  local install_parent
  install_parent="$(dirname "$HIVEKEEP_DIR")"
  local avail_kb=""
  avail_kb="$(df -k "$install_parent" 2>/dev/null | awk 'NR==2 {print $4}')" || avail_kb=""
  if [ -n "$avail_kb" ] && [ "$avail_kb" -gt 0 ] 2>/dev/null; then
    local avail_mb=$((avail_kb / 1024))
    local avail_gb=$((avail_mb / 1024))
    if [ "$avail_mb" -lt 500 ] 2>/dev/null; then
      warn "Disk: ${avail_mb}MB free (critically low, need 500MB+)"
      has_issues=true
    elif [ "$avail_mb" -lt 1024 ] 2>/dev/null; then
      warn "Disk: ${avail_mb}MB free (low, recommend 1GB+)"
    elif [ "$avail_gb" -gt 0 ] 2>/dev/null; then
      success "Disk: ${avail_gb}GB free"
    else
      success "Disk: ${avail_mb}MB free"
    fi
  fi

  # Data directory size
  if [ -d "$HIVEKEEP_DATA_DIR" ]; then
    local data_size
    data_size="$(du -sh "$HIVEKEEP_DATA_DIR" 2>/dev/null | awk '{print $1}')"
    [ -n "$data_size" ] && info "Data directory size: $data_size"
  fi

  # Log file size (for script-managed installs)
  if [ "$INIT_SYSTEM" = "script" ]; then
    local log_file="$HIVEKEEP_DATA_DIR/hivekeep.log"
    if [ -f "$log_file" ]; then
      local log_kb
      log_kb="$(du -k "$log_file" 2>/dev/null | awk '{print $1}')" || log_kb="0"
      if [ "$log_kb" -gt 102400 ] 2>/dev/null; then
        local log_mb=$((log_kb / 1024))
        warn "Log file: ${log_mb}MB (large, run: bash install.sh --start && $HIVEKEEP_DIR/hivekeep log-rotate)"
        has_issues=true
      elif [ "$log_kb" -gt 10240 ] 2>/dev/null; then
        local log_mb=$((log_kb / 1024))
        info "Log file: ${log_mb}MB"
      fi
    fi
  fi

  # Check for available updates
  header "Updates"
  if [ -d "$HIVEKEEP_DIR/.git" ]; then
    local local_ref remote_ref channel
    local_ref="$(git -C "$HIVEKEEP_DIR" rev-parse HEAD 2>/dev/null || echo "")"
    channel="$(resolve_channel)"

    if [ "$channel" = "stable" ]; then
      if [ -n "$local_ref" ] && git -C "$HIVEKEEP_DIR" fetch --tags origin --quiet 2>/dev/null; then
        local latest_tag
        latest_tag="$(get_latest_stable_tag)"
        remote_ref="$(git -C "$HIVEKEEP_DIR" rev-parse "${latest_tag}^{commit}" 2>/dev/null || echo "")"
        if [ -n "$remote_ref" ] && [ "$local_ref" != "$remote_ref" ]; then
          local local_tag
          local_tag="$(git -C "$HIVEKEEP_DIR" describe --tags --exact-match HEAD 2>/dev/null || echo "$(echo "$local_ref" | cut -c1-8)")"
          echo -e "  ${CYAN}⬆${NC}  ${BOLD}Update available:${NC} ${local_tag} → ${BOLD}${latest_tag}${NC} (stable channel)"
          echo -e "  ${DIM}   Run: bash install.sh --update${NC}"
        else
          success "Up to date (stable channel)"
        fi
      else
        info "Could not check for updates (network unavailable)"
      fi
    else
      local branch
      branch="$(git -C "$HIVEKEEP_DIR" branch --show-current 2>/dev/null || echo "main")"
      if [ -n "$local_ref" ] && git -C "$HIVEKEEP_DIR" fetch origin "$branch" --quiet 2>/dev/null; then
        remote_ref="$(git -C "$HIVEKEEP_DIR" rev-parse "origin/$branch" 2>/dev/null || echo "")"

        if [ -n "$remote_ref" ] && [ "$local_ref" != "$remote_ref" ]; then
          local behind_count
          behind_count="$(git -C "$HIVEKEEP_DIR" rev-list HEAD.."origin/$branch" --count 2>/dev/null || echo "0")"
          if [ "$behind_count" -gt 0 ] 2>/dev/null; then
            echo -e "  ${CYAN}⬆${NC}  ${BOLD}Update available:${NC} ${behind_count} new commit(s) on ${branch} (edge channel)"
            echo -e "  ${DIM}   Run: bash install.sh --update${NC}"
          fi
        else
          success "Up to date (edge channel)"
        fi
      else
        info "Could not check for updates (network unavailable)"
      fi
    fi
  else
    info "Cannot check updates (not a git install)"
  fi

  # Summary
  echo ""
  if [ "$has_issues" = true ]; then
    echo -e "${YELLOW}${BOLD}Some issues detected.${NC} Check the warnings above."
  else
    echo -e "${GREEN}${BOLD}Everything looks good!${NC}"
  fi
  echo ""
}

# Non-fatal error (for status checks)
error_noexit() { echo -e "${RED}✗${NC} $*" >&2; }

# ─── Service lifecycle (start/stop/restart) ──────────────────────────────────
# Helpers to manage the Hivekeep service from the installer itself,
# so users don't need to remember systemctl vs launchctl vs script commands.

_service_env_setup() {
  OS="$(uname -s)"
  IS_ROOT=false
  [ "$(id -u)" -eq 0 ] && IS_ROOT=true
  if [ "$IS_ROOT" = true ]; then
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-/opt/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-/var/lib/hivekeep}"
  else
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-$HOME/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-$HOME/.local/share/hivekeep}"
  fi
  detect_os
}

_service_start() {
  if [ "$INIT_SYSTEM" = "launchd" ]; then
    local plist="$HOME/Library/LaunchAgents/io.hivekeep.server.plist"
    if [ ! -f "$plist" ]; then
      error "launchd service not installed. Run the installer first: bash install.sh"
    fi
    if launchctl list 2>/dev/null | grep -q io.hivekeep.server; then
      warn "Hivekeep is already running"
      return 0
    fi
    launchctl load "$plist"
    success "Hivekeep started (launchd)"
  elif [ "$INIT_SYSTEM" = "script" ]; then
    local script_path="$HIVEKEEP_DIR/hivekeep"
    if [ ! -x "$script_path" ]; then
      error "Service script not found. Run the installer first: bash install.sh"
    fi
    "$script_path" start
  elif [ "$IS_ROOT" = true ]; then
    if ! systemctl is-enabled --quiet hivekeep 2>/dev/null; then
      error "systemd service not installed. Run the installer first: sudo bash install.sh"
    fi
    if systemctl is-active --quiet hivekeep 2>/dev/null; then
      warn "Hivekeep is already running"
      return 0
    fi
    systemctl start hivekeep
    success "Hivekeep started (systemd)"
  else
    if ! systemctl --user is-enabled --quiet hivekeep 2>/dev/null; then
      error "systemd user service not installed. Run the installer first: bash install.sh"
    fi
    if systemctl --user is-active --quiet hivekeep 2>/dev/null; then
      warn "Hivekeep is already running"
      return 0
    fi
    systemctl --user start hivekeep
    success "Hivekeep started (systemd user service)"
  fi
}

_service_stop() {
  if [ "$INIT_SYSTEM" = "launchd" ]; then
    local plist="$HOME/Library/LaunchAgents/io.hivekeep.server.plist"
    if ! launchctl list 2>/dev/null | grep -q io.hivekeep.server; then
      warn "Hivekeep is not running"
      return 0
    fi
    launchctl unload "$plist" 2>/dev/null || true
    success "Hivekeep stopped (launchd)"
  elif [ "$INIT_SYSTEM" = "script" ]; then
    local script_path="$HIVEKEEP_DIR/hivekeep"
    if [ ! -x "$script_path" ]; then
      error "Service script not found at $script_path"
    fi
    "$script_path" stop
  elif [ "$IS_ROOT" = true ]; then
    if ! systemctl is-active --quiet hivekeep 2>/dev/null; then
      warn "Hivekeep is not running"
      return 0
    fi
    systemctl stop hivekeep
    success "Hivekeep stopped (systemd)"
  else
    if ! systemctl --user is-active --quiet hivekeep 2>/dev/null; then
      warn "Hivekeep is not running"
      return 0
    fi
    systemctl --user stop hivekeep
    success "Hivekeep stopped (systemd user service)"
  fi
}

do_start() {
  echo ""
  _service_env_setup
  if [ ! -d "$HIVEKEEP_DIR/.git" ]; then
    error "Hivekeep is not installed at $HIVEKEEP_DIR. Run the installer first: bash install.sh"
  fi
  _service_start
  echo ""
}

do_stop() {
  echo ""
  _service_env_setup
  if [ ! -d "$HIVEKEEP_DIR/.git" ]; then
    error "Hivekeep is not installed at $HIVEKEEP_DIR. Run the installer first: bash install.sh"
  fi
  _service_stop
  echo ""
}

do_restart() {
  echo ""
  _service_env_setup
  if [ ! -d "$HIVEKEEP_DIR/.git" ]; then
    error "Hivekeep is not installed at $HIVEKEEP_DIR. Run the installer first: bash install.sh"
  fi
  info "Restarting Hivekeep..."

  if [ "$INIT_SYSTEM" = "launchd" ]; then
    local plist="$HOME/Library/LaunchAgents/io.hivekeep.server.plist"
    launchctl unload "$plist" 2>/dev/null || true
    sleep 1
    launchctl load "$plist"
    success "Hivekeep restarted (launchd)"
  elif [ "$INIT_SYSTEM" = "script" ]; then
    local script_path="$HIVEKEEP_DIR/hivekeep"
    if [ ! -x "$script_path" ]; then
      error "Service script not found at $script_path"
    fi
    "$script_path" restart
  elif [ "$IS_ROOT" = true ]; then
    systemctl restart hivekeep
    success "Hivekeep restarted (systemd)"
  else
    systemctl --user restart hivekeep
    success "Hivekeep restarted (systemd user service)"
  fi
  echo ""
}

# ─── Doctor (diagnostic report for bug reports) ─────────────────────────────
do_doctor() {
  # Minimal env setup
  OS="$(uname -s)"
  ARCH="$(uname -m)"
  IS_ROOT=false
  [ "$(id -u)" -eq 0 ] && IS_ROOT=true
  if [ "$IS_ROOT" = true ]; then
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-/opt/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-/var/lib/hivekeep}"
  else
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-$HOME/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-$HOME/.local/share/hivekeep}"
  fi

  detect_os 2>/dev/null || true

  # Everything goes to stdout as plain text, suitable for pasting into a GitHub issue
  echo "# Hivekeep Diagnostic Report"
  echo "Generated: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  echo ""

  # ── System ──
  echo "## System"
  echo "- OS: $OS ($ARCH)"
  echo "- Distro: ${DISTRO:-unknown}"
  [ "$IS_WSL" = true ] && echo "- WSL: yes"
  if [ -f /proc/version ]; then
    echo "- Kernel: $(uname -r)"
  elif [ "$OS" = "Darwin" ]; then
    echo "- macOS: $(sw_vers -productVersion 2>/dev/null || echo unknown)"
  fi
  echo "- Init: ${INIT_SYSTEM:-unknown}"
  echo "- User: $(id -un) (uid=$(id -u))"
  echo "- Shell: ${SHELL:-unknown}"

  # Container detection
  local container="none"
  if [ -f /.dockerenv ]; then
    container="docker"
  elif grep -qa 'container=' /proc/1/environ 2>/dev/null; then
    container="$(grep -oP 'container=\K[^ ]+' /proc/1/environ 2>/dev/null || echo "yes")"
  elif [ -f /run/host/container-manager ] 2>/dev/null; then
    container="$(cat /run/host/container-manager 2>/dev/null)"
  fi
  [ "$container" != "none" ] && echo "- Container: $container"

  # Memory
  if [ "$OS" = "Linux" ] && [ -f /proc/meminfo ]; then
    local mem_total mem_avail swap_total
    mem_total="$(awk '/^MemTotal:/ {printf "%.0f", $2/1024}' /proc/meminfo 2>/dev/null)"
    mem_avail="$(awk '/^MemAvailable:/ {printf "%.0f", $2/1024}' /proc/meminfo 2>/dev/null)"
    swap_total="$(awk '/^SwapTotal:/ {printf "%.0f", $2/1024}' /proc/meminfo 2>/dev/null)"
    echo "- Memory: ${mem_avail:-?}MB available / ${mem_total:-?}MB total, swap ${swap_total:-0}MB"
  elif [ "$OS" = "Darwin" ]; then
    local mem_bytes
    mem_bytes="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
    echo "- Memory: $((mem_bytes / 1024 / 1024))MB total"
  fi

  # Disk
  local install_parent
  install_parent="$(dirname "$HIVEKEEP_DIR")"
  local disk_info
  disk_info="$(df -h "$install_parent" 2>/dev/null | awk 'NR==2 {printf "%s available / %s total (%s used)", $4, $2, $5}')"
  [ -n "$disk_info" ] && echo "- Disk ($install_parent): $disk_info"

  echo ""

  # ── Hivekeep installation ──
  echo "## Hivekeep"
  if [ -d "$HIVEKEEP_DIR/.git" ]; then
    local version branch commit commit_date
    version="$(git -C "$HIVEKEEP_DIR" describe --tags 2>/dev/null || echo "no tags")"
    branch="$(git -C "$HIVEKEEP_DIR" branch --show-current 2>/dev/null || echo "unknown")"
    commit="$(git -C "$HIVEKEEP_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
    commit_date="$(git -C "$HIVEKEEP_DIR" log -1 --format='%ci' 2>/dev/null | cut -d' ' -f1 || echo "unknown")"
    echo "- Version: $version"
    echo "- Branch: $branch"
    echo "- Commit: $commit ($commit_date)"
    echo "- Install dir: $HIVEKEEP_DIR"

    # Check if behind upstream
    local behind=""
    if git -C "$HIVEKEEP_DIR" fetch --dry-run origin "$branch" 2>&1 | grep -q "$branch"; then
      local local_head remote_head
      local_head="$(git -C "$HIVEKEEP_DIR" rev-parse HEAD 2>/dev/null)"
      remote_head="$(git -C "$HIVEKEEP_DIR" rev-parse "origin/$branch" 2>/dev/null)"
      if [ "$local_head" != "$remote_head" ]; then
        local count_behind
        count_behind="$(git -C "$HIVEKEEP_DIR" rev-list HEAD..origin/"$branch" --count 2>/dev/null || echo "?")"
        echo "- Behind upstream: $count_behind commit(s)"
      else
        echo "- Up to date with origin/$branch"
      fi
    fi

    # Dirty state
    if ! git -C "$HIVEKEEP_DIR" diff --quiet HEAD 2>/dev/null; then
      echo "- Working tree: DIRTY (uncommitted changes)"
    fi
  else
    echo "- Not installed at $HIVEKEEP_DIR"
  fi

  echo "- Data dir: $HIVEKEEP_DATA_DIR"
  if [ -d "$HIVEKEEP_DATA_DIR" ]; then
    local data_size
    data_size="$(du -sh "$HIVEKEEP_DATA_DIR" 2>/dev/null | awk '{print $1}')"
    echo "- Data size: $data_size"
  fi

  echo ""

  # ── Runtime ──
  echo "## Runtime"
  configure_bun_environment
  local diagnose_bun
  diagnose_bun="$(configured_bun_path || true)"
  if [ -n "$diagnose_bun" ]; then
    echo "- Bun: $(run_configured_bun "$diagnose_bun" --version 2>/dev/null || echo error) ($diagnose_bun)"
    if [ "$IS_ROOT" = true ] && [ "$OS" = "Linux" ] && [ "${INIT_SYSTEM:-}" = "systemd" ] && id "$HIVEKEEP_USER" &>/dev/null; then
      if bun_runs_as_service_user "$diagnose_bun"; then
        echo "- Service user Bun execution: ok ($HIVEKEEP_USER)"
      else
        echo "- Service user Bun execution: FAILED ($HIVEKEEP_USER)"
      fi
    fi
  else
    echo "- Bun: NOT FOUND"
  fi
  command -v git &>/dev/null && echo "- Git: $(git --version 2>/dev/null | awk '{print $3}')"
  command -v curl &>/dev/null && echo "- Curl: $(curl --version 2>/dev/null | head -1 | awk '{print $2}')"
  command -v sqlite3 &>/dev/null && echo "- SQLite3: $(sqlite3 --version 2>/dev/null | awk '{print $1}')"

  echo ""

  # ── Config (sanitized) ──
  echo "## Config"
  local env_file="$HIVEKEEP_DATA_DIR/hivekeep.env"
  if [ -f "$env_file" ]; then
    local perms
    perms="$(stat -c '%a' "$env_file" 2>/dev/null || stat -f '%Lp' "$env_file" 2>/dev/null || echo "?")"
    echo "- File: $env_file (permissions: $perms)"
    echo '```'
    # Show keys and redact sensitive values
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      [[ "$line" =~ ^# ]] && { echo "$line"; continue; }
      local key="${line%%=*}"
      local val="${line#*=}"
      case "$key" in
        *KEY*|*SECRET*|*TOKEN*|*PASSWORD*|*ENCRYPTION*)
          if [ -n "$val" ]; then
            echo "${key}=[REDACTED (${#val} chars)]"
          else
            echo "${key}="
          fi
          ;;
        *)
          echo "$line"
          ;;
      esac
    done < "$env_file"
    echo '```'
  else
    echo "- Config file not found at $env_file"
  fi

  echo ""

  # ── Database ──
  echo "## Database"
  local db_file="$HIVEKEEP_DATA_DIR/hivekeep.db"
  if [ -f "$db_file" ]; then
    local db_size
    db_size="$(du -h "$db_file" 2>/dev/null | awk '{print $1}')"
    echo "- File: $db_file ($db_size)"
    if command -v sqlite3 &>/dev/null; then
      local integrity journal_mode table_count
      integrity="$(sqlite3 "$db_file" "PRAGMA integrity_check;" 2>/dev/null || echo "error")"
      journal_mode="$(sqlite3 "$db_file" "PRAGMA journal_mode;" 2>/dev/null || echo "unknown")"
      table_count="$(sqlite3 "$db_file" "SELECT count(*) FROM sqlite_master WHERE type='table';" 2>/dev/null || echo "?")"
      echo "- Integrity: $integrity"
      echo "- Journal mode: $journal_mode"
      echo "- Tables: $table_count"
    else
      echo "- sqlite3 not available for inspection"
    fi
  else
    echo "- Not found at $db_file"
  fi

  # Backups
  local backup_dir="$HIVEKEEP_DATA_DIR/backups"
  if [ -d "$backup_dir" ]; then
    local backup_count
    backup_count="$(find "$backup_dir" -maxdepth 1 -name 'hivekeep-*.db' -type f 2>/dev/null | wc -l)"
    echo "- Backups: $backup_count"
  fi

  echo ""

  # ── Service ──
  echo "## Service"
  if [ "$INIT_SYSTEM" = "launchd" ]; then
    if launchctl list 2>/dev/null | grep -q io.hivekeep.server; then
      echo "- Status: loaded (launchd)"
    else
      echo "- Status: not loaded (launchd)"
    fi
  elif [ "$INIT_SYSTEM" = "script" ]; then
    local pid_file="$HIVEKEEP_DATA_DIR/hivekeep.pid"
    if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
      echo "- Status: running (PID $(cat "$pid_file"), script-managed)"
    else
      echo "- Status: not running (script-managed)"
    fi
  elif [ "$IS_ROOT" = true ]; then
    local svc_status
    svc_status="$(systemctl is-active hivekeep 2>/dev/null || echo "unknown")"
    echo "- Status: $svc_status (systemd system)"
    if [ "$svc_status" = "failed" ]; then
      echo "- Exit code: $(systemctl show hivekeep -p ExecMainStatus --value 2>/dev/null || echo "?")"
    fi
  else
    local svc_status
    svc_status="$(systemctl --user is-active hivekeep 2>/dev/null || echo "unknown")"
    echo "- Status: $svc_status (systemd user)"
    if [ "$svc_status" = "failed" ]; then
      echo "- Exit code: $(systemctl --user show hivekeep -p ExecMainStatus --value 2>/dev/null || echo "?")"
    fi
  fi

  # Port check
  local port="${HIVEKEEP_PORT:-3000}"
  if [ -f "$HIVEKEEP_DATA_DIR/hivekeep.env" ]; then
    # shellcheck disable=SC1090
    . "$HIVEKEEP_DATA_DIR/hivekeep.env" 2>/dev/null || true
    port="${PORT:-$port}"
  fi

  local port_listening="no"
  if command -v ss &>/dev/null; then
    ss -tlnp 2>/dev/null | grep -q ":${port} " && port_listening="yes"
  elif command -v lsof &>/dev/null; then
    lsof -i ":${port}" -sTCP:LISTEN &>/dev/null && port_listening="yes"
  fi
  echo "- Port $port listening: $port_listening"

  # HTTP check
  if command -v curl &>/dev/null && [ "$port_listening" = "yes" ]; then
    local http_code
    http_code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${port}/" --max-time 3 2>/dev/null || echo "000")"
    echo "- HTTP status: $http_code"
    local api_code
    api_code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${port}/api/health" --max-time 3 2>/dev/null || echo "000")"
    echo "- API health: $api_code"
  fi

  # Public URL reachability & TLS
  local public_url=""
  if [ -f "$env_file" ]; then
    # shellcheck disable=SC1090
    public_url="$( ( . "$env_file" 2>/dev/null; echo "${PUBLIC_URL:-}" ) )"
  fi
  if [ -n "$public_url" ]; then
    echo "- Public URL: $public_url"
    local url_host
    url_host="$(echo "$public_url" | sed -E 's|^https?://||; s|[:/].*||')"

    local is_local=false
    case "$url_host" in
      localhost|127.*|10.*|192.168.*) is_local=true ;;
      172.*)
        local so
        so="$(echo "$url_host" | cut -d. -f2)"
        [ -n "$so" ] && [ "$so" -ge 16 ] 2>/dev/null && [ "$so" -le 31 ] 2>/dev/null && is_local=true
        ;;
    esac

    if [ "$is_local" = false ] && command -v curl &>/dev/null; then
      local public_code
      public_code="$(curl -s -o /dev/null -w '%{http_code}' "$public_url" --max-time 8 2>/dev/null || echo "000")"
      echo "- Public URL reachable: $([ "$public_code" != "000" ] && echo "yes (status $public_code)" || echo "NO")"

      if [[ "$public_url" =~ ^https:// ]] && command -v openssl &>/dev/null; then
        local cert_expiry
        cert_expiry="$(echo | openssl s_client -servername "$url_host" -connect "$url_host:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | sed 's/notAfter=//')"
        if [ -n "$cert_expiry" ]; then
          local expiry_epoch now_epoch
          expiry_epoch="$(date -d "$cert_expiry" +%s 2>/dev/null || date -jf '%b %d %T %Y %Z' "$cert_expiry" +%s 2>/dev/null || echo "")"
          now_epoch="$(date +%s)"
          if [ -n "$expiry_epoch" ]; then
            local days_left=$(( (expiry_epoch - now_epoch) / 86400 ))
            echo "- TLS certificate: expires in ${days_left} days ($cert_expiry)"
          else
            echo "- TLS certificate: $cert_expiry (could not parse date)"
          fi
        else
          echo "- TLS certificate: could not retrieve"
        fi
      fi
    elif [ "$is_local" = true ]; then
      echo "- Public URL: local address (external reachability not tested)"
    fi
  fi

  echo ""

  # ── Recent logs ──
  echo "## Recent Logs (last 25 lines)"
  echo '```'
  if [ "$INIT_SYSTEM" = "launchd" ]; then
    local log_file="$HOME/Library/Logs/hivekeep/hivekeep.log"
    if [ -f "$log_file" ]; then
      tail -25 "$log_file" 2>/dev/null
    else
      echo "(no log file found)"
    fi
  elif [ "$INIT_SYSTEM" = "script" ]; then
    local log_file="$HIVEKEEP_DATA_DIR/hivekeep.log"
    if [ -f "$log_file" ]; then
      tail -25 "$log_file" 2>/dev/null
    else
      echo "(no log file found)"
    fi
  elif [ "$IS_ROOT" = true ]; then
    journalctl -u hivekeep --no-pager -n 25 2>/dev/null || echo "(no journal entries)"
  else
    journalctl --user -u hivekeep --no-pager -n 25 2>/dev/null || echo "(no journal entries)"
  fi
  echo '```'

  echo ""
  echo "---"
  echo "Paste this into a GitHub issue: https://github.com/$HIVEKEEP_REPO/issues/new"
}

# ─── Dry run ─────────────────────────────────────────────────────────────────
dry_run() {
  echo ""
  echo -e "${BOLD}Hivekeep Installer — Dry Run${NC}"
  echo -e "${DIM}No changes will be made. This shows what would happen.${NC}"
  echo ""

  detect_os

  # Check existing installation
  header "Installation plan"
  if [ -d "$HIVEKEEP_DIR/.git" ]; then
    local current_version
    current_version="$(git -C "$HIVEKEEP_DIR" describe --tags 2>/dev/null || git -C "$HIVEKEEP_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
    info "Mode: ${BOLD}UPDATE${NC} (existing install at $HIVEKEEP_DIR, currently $current_version)"
  else
    info "Mode: ${BOLD}FRESH INSTALL${NC}"
    info "Will clone to: $HIVEKEEP_DIR"
  fi
  info "Data directory: $HIVEKEEP_DATA_DIR"
  info "Channel: $(resolve_channel)"
  info "Branch: $HIVEKEEP_BRANCH"

  # Prerequisites
  header "Prerequisites"
  for cmd in git curl unzip; do
    if command -v "$cmd" &>/dev/null; then
      success "$cmd — already installed"
    else
      info "$cmd — ${YELLOW}will be installed${NC}"
    fi
  done

  # Bun
  configure_bun_environment
  if command -v bun &>/dev/null; then
    local bun_ver
    bun_ver="$(bun --version 2>/dev/null || echo "0.0.0")"
    if version_gte "$bun_ver" "$BUN_MIN_VERSION"; then
      success "Bun v${bun_ver} — already installed (meets v${BUN_MIN_VERSION}+ requirement)"
    else
      info "Bun v${bun_ver} — ${YELLOW}will be upgraded${NC} (need v${BUN_MIN_VERSION}+)"
    fi
  else
    info "Bun — ${YELLOW}will be installed${NC} from https://bun.sh"
  fi

  # Disk space & memory
  header "Resources"
  local install_parent
  install_parent="$(dirname "$HIVEKEEP_DIR")"
  local avail_kb
  if avail_kb="$(df -k "$install_parent" 2>/dev/null | awk 'NR==2 {print $4}')"; then
    local avail_mb=$((avail_kb / 1024))
    if [ "$avail_mb" -lt 500 ] 2>/dev/null; then
      warn "Disk: only ${avail_mb}MB available (need 500MB+)"
    else
      success "Disk: ${avail_mb}MB available"
    fi
  fi

  if [ "$OS" = "Linux" ] && [ -f /proc/meminfo ]; then
    local mem_total_kb mem_avail_kb swap_total_kb
    mem_total_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo "")"
    mem_avail_kb="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || echo "")"
    swap_total_kb="$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo "")"
    if [ -n "$mem_total_kb" ]; then
      local mem_total_mb=$((mem_total_kb / 1024))
      local mem_avail_mb=0
      [ -n "$mem_avail_kb" ] && mem_avail_mb=$((mem_avail_kb / 1024))
      local swap_total_mb=0
      [ -n "$swap_total_kb" ] && swap_total_mb=$((swap_total_kb / 1024))
      if [ "$mem_total_mb" -lt 512 ] 2>/dev/null && [ "$swap_total_mb" -lt 256 ] 2>/dev/null; then
        warn "RAM: ${mem_total_mb}MB total, ${swap_total_mb}MB swap — build may OOM"
      else
        success "RAM: ${mem_avail_mb}MB available / ${mem_total_mb}MB total"
      fi
    fi
  elif [ "$OS" = "Darwin" ]; then
    local mem_bytes
    mem_bytes="$(sysctl -n hw.memsize 2>/dev/null || echo "")"
    if [ -n "$mem_bytes" ]; then
      local mem_total_mb=$((mem_bytes / 1024 / 1024))
      success "RAM: ${mem_total_mb}MB total"
    fi
  fi

  # Port
  header "Network"
  info "Will listen on port $HIVEKEEP_PORT"
  local port_in_use=false
  if command -v ss &>/dev/null; then
    ss -tlnp 2>/dev/null | grep -q ":${HIVEKEEP_PORT} " && port_in_use=true
  elif command -v lsof &>/dev/null; then
    lsof -i ":${HIVEKEEP_PORT}" -sTCP:LISTEN &>/dev/null && port_in_use=true
  fi
  if [ "$port_in_use" = true ]; then
    warn "Port $HIVEKEEP_PORT is currently in use"
  else
    success "Port $HIVEKEEP_PORT is available"
  fi

  # Config
  header "Configuration"
  local env_file="$HIVEKEEP_DATA_DIR/hivekeep.env"
  if [ -d "$HIVEKEEP_DIR/.git" ] && [ -f "$env_file" ]; then
    info "Existing config at $env_file — will be kept"
  else
    info "Will create config at $env_file"
    info "Interactive prompts for: port, public URL"
  fi

  # Service
  header "Service"
  if [ "$IS_ROOT" = true ]; then
    info "Will create system user: ${HIVEKEEP_USER:-hivekeep}"
  fi
  if [ "$INIT_SYSTEM" = "launchd" ]; then
    info "Will create launchd service: ~/Library/LaunchAgents/io.hivekeep.server.plist"
  elif [ "$INIT_SYSTEM" = "script" ]; then
    info "Will create start/stop script: $HIVEKEEP_DIR/hivekeep"
    if [ "$IS_WSL" = true ]; then
      warn "WSL detected — service won't auto-start on boot"
    fi
  elif [ "$IS_ROOT" = true ]; then
    info "Will create systemd system service: /etc/systemd/system/hivekeep.service"
  else
    info "Will create systemd user service: ~/.config/systemd/user/hivekeep.service"
  fi

  # Build
  header "Build steps"
  info "bun install --frozen-lockfile"
  info "bun run build"
  info "bun run db:migrate"

  # Summary
  echo ""
  echo -e "${GREEN}${BOLD}Dry run complete.${NC} Run without --dry-run to proceed with installation."
  echo ""
}

# ─── Docker Compose install ──────────────────────────────────────────────────
docker_install() {
  echo ""
  echo -e "${BOLD}Hivekeep Docker Setup${NC}"
  echo -e "Generates a docker-compose.yml for running Hivekeep in Docker"
  echo ""

  OS="$(uname -s)"

  # Check Docker is available
  if ! command -v docker &>/dev/null; then
    error "Docker is not installed. Install it from https://docs.docker.com/get-docker/"
  fi
  success "Docker $(docker --version | awk '{print $3}' | tr -d ',')"

  # Docker is installed, but the daemon may not be running (very common on
  # desktop Linux/macOS). `docker info` talks to the daemon and fails fast if so.
  if ! docker info &>/dev/null; then
    local daemon_fix
    if [ "$OS" = "Darwin" ]; then
      daemon_fix="Start Docker Desktop and wait for the whale icon to settle, then re-run this command."
    else
      daemon_fix="Start the daemon: sudo systemctl start docker
  (or launch Docker Desktop if you use it), then re-run this command."
    fi
    error "Docker is installed but the daemon isn't responding.
  Hivekeep can't create the container until Docker is running.
  ${BOLD}Fix:${NC} $daemon_fix"
  fi
  success "Docker daemon is running"

  # Check Docker Compose (v2 plugin or standalone)
  local compose_cmd=""
  if docker compose version &>/dev/null 2>&1; then
    compose_cmd="docker compose"
    success "Docker Compose $(docker compose version --short 2>/dev/null)"
  elif command -v docker-compose &>/dev/null; then
    compose_cmd="docker-compose"
    success "docker-compose $(docker-compose --version | awk '{print $NF}')"
  else
    error "Docker Compose is not installed. Install it from https://docs.docker.com/compose/install/"
  fi

  # Choose output directory
  local output_dir="${HIVEKEEP_DOCKER_DIR:-./hivekeep}"

  if [ "${HIVEKEEP_NO_PROMPT:-}" != "true" ] && [ "${CI:-}" != "true" ]; then
    echo ""
    echo -e "${BOLD}Configuration${NC}"
    echo -e "${DIM}Press Enter to accept the default value shown in brackets.${NC}"
    echo ""
    prompt_value output_dir "Output directory" "$output_dir"
    prompt_value HIVEKEEP_PORT "Port" "$HIVEKEEP_PORT"

    local local_ip
    local_ip="$(detect_local_ip)"
    local default_url="http://${local_ip}:${HIVEKEEP_PORT}"
    [ -n "$HIVEKEEP_PUBLIC_URL" ] && default_url="$HIVEKEEP_PUBLIC_URL"
    prompt_value HIVEKEEP_PUBLIC_URL "Public URL (for webhooks & invite links)" "$default_url"
  fi

  if [ -z "$HIVEKEEP_PUBLIC_URL" ]; then
    local local_ip
    local_ip="$(detect_local_ip)"
    HIVEKEEP_PUBLIC_URL="http://${local_ip}:${HIVEKEEP_PORT}"
  fi

  mkdir -p "$output_dir"

  # Generate encryption key
  local enc_key
  enc_key="$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"

  # Write .env
  cat > "$output_dir/.env" << ENV
# Hivekeep Docker configuration
# Edit these values, then run: docker compose up -d
#
# For all options, see: https://github.com/MarlBurroW/hivekeep

# ── Core ─────────────────────────────────────────────────────────
PORT=${HIVEKEEP_PORT}
PUBLIC_URL=${HIVEKEEP_PUBLIC_URL}
ENCRYPTION_KEY=${enc_key}
LOG_LEVEL=info

# ── Resource limits ──────────────────────────────────────────────
# Adjust based on your machine. Defaults are safe for 2GB+ RAM.
# Small machines (1GB RAM): MEMORY_LIMIT=512m CPU_LIMIT=1.0
# Larger machines:          MEMORY_LIMIT=2g   CPU_LIMIT=4.0
MEMORY_LIMIT=1g
CPU_LIMIT=2.0
ENV
  chmod 600 "$output_dir/.env"

  # Write docker-compose.yml
  cat > "$output_dir/docker-compose.yml" << 'COMPOSE'
# Hivekeep — Self-hosted AI agent platform
# Docs: https://github.com/MarlBurroW/hivekeep
#
# Quick start:  docker compose up -d
# Update:       docker compose pull && docker compose up -d
# Logs:         docker compose logs -f hivekeep

services:
  hivekeep:
    image: ghcr.io/marlburrow/hivekeep:latest
    container_name: hivekeep
    ports:
      - "${PORT:-3000}:3000"
    volumes:
      - hivekeep-data:/app/data
    environment:
      - NODE_ENV=production
      - PORT=3000
      - HOST=0.0.0.0
      - HIVEKEEP_DATA_DIR=/app/data
      - PUBLIC_URL=${PUBLIC_URL:-http://localhost:3000}
      - ENCRYPTION_KEY=${ENCRYPTION_KEY:-}
      - LOG_LEVEL=${LOG_LEVEL:-info}
    restart: unless-stopped

    # ── Resource limits ──────────────────────────────────────────────
    # Prevents runaway memory/CPU from affecting the host.
    # Adjust to your machine: 512m is fine for small usage,
    # increase to 1g or 2g for heavier workloads.
    deploy:
      resources:
        limits:
          memory: ${MEMORY_LIMIT:-1g}
          cpus: "${CPU_LIMIT:-2.0}"
        reservations:
          memory: 256m

    # ── Logging ──────────────────────────────────────────────────────
    # Prevents Docker logs from filling up the disk on long-running
    # installations. Keeps up to 3 x 10MB rotated log files.
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

    # ── Security hardening ───────────────────────────────────────────
    # read_only: prevents writes outside of mounted volumes
    # no-new-privileges: blocks privilege escalation inside container
    # tmpfs: provides writable /tmp without persisting to disk
    read_only: true
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp:size=64m

    # ── Health check ─────────────────────────────────────────────────
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://localhost:3000/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 30s
      retries: 3

volumes:
  hivekeep-data:
COMPOSE

  success "Created $output_dir/docker-compose.yml"
  success "Created $output_dir/.env"

  # Ask if user wants to start now
  local start_now="y"
  if [ "${HIVEKEEP_NO_PROMPT:-}" != "true" ] && [ "${CI:-}" != "true" ]; then
    echo ""
    echo -en "  ${CYAN}?${NC} ${BOLD}Start Hivekeep now?${NC} ${DIM}[Y/n]${NC}: " >/dev/tty
    read -r start_now </dev/tty || start_now="y"
    [ -z "$start_now" ] && start_now="y"
  fi

  if [[ "$start_now" =~ ^[Yy]$ ]]; then
    header "Starting Hivekeep..."
    cd "$output_dir"
    # shellcheck disable=SC2086
    run_with_spinner "Building and starting container..." $compose_cmd up -d --build
    success "Hivekeep is starting!"

    # Wait a moment for health check
    info "Waiting for Hivekeep to be ready..."
    local attempts=0
    while [ $attempts -lt 30 ]; do
      if curl -sf "http://localhost:${HIVEKEEP_PORT}/api/health" --max-time 2 &>/dev/null; then
        success "Hivekeep is ready!"
        break
      fi
      sleep 2
      attempts=$((attempts + 1))
    done

    if [ $attempts -ge 30 ]; then
      warn "Hivekeep hasn't responded yet. It may still be building."
      info "Check status with: cd $output_dir && $compose_cmd logs -f"
    fi
  fi

  # Summary
  echo ""
  echo -e "${BOLD}╔════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}║  Hivekeep Docker setup complete!             ║${NC}"
  echo -e "${BOLD}╚════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${CYAN}Access URL:${NC}   $HIVEKEEP_PUBLIC_URL"
  echo -e "  ${CYAN}Directory:${NC}    $(cd "$output_dir" && pwd)"
  echo -e "  ${CYAN}Config:${NC}       $output_dir/.env"
  echo ""
  echo -e "  Visit the URL above to complete the setup wizard."
  echo -e "  You will need at least one AI provider API key"
  echo -e "  (Anthropic, OpenAI, or Google Gemini)."
  echo ""
  echo -e "  ${BOLD}Docker commands:${NC}"
  echo -e "    cd $(cd "$output_dir" && pwd)"
  echo -e "    $compose_cmd logs -f          ${DIM}# View logs${NC}"
  echo -e "    $compose_cmd restart           ${DIM}# Restart${NC}"
  echo -e "    $compose_cmd pull && $compose_cmd up -d  ${DIM}# Update${NC}"
  echo -e "    $compose_cmd down              ${DIM}# Stop${NC}"
  echo -e "    $compose_cmd down -v           ${DIM}# Stop & remove data${NC}"
  echo ""
  echo -e "  ${BOLD}Resource tuning:${NC} ${DIM}(edit .env, then: $compose_cmd up -d)${NC}"
  echo -e "    ${DIM}Small machine (1GB):  MEMORY_LIMIT=512m CPU_LIMIT=1.0${NC}"
  echo -e "    ${DIM}Default (2GB+):       MEMORY_LIMIT=1g   CPU_LIMIT=2.0${NC}"
  echo -e "    ${DIM}Larger (4GB+):        MEMORY_LIMIT=2g   CPU_LIMIT=4.0${NC}"
  echo ""
}

# ─── Logs ────────────────────────────────────────────────────────────────────
show_logs() {
  local log_lines="${LOGS_LINES:-0}"
  local log_grep="${LOGS_GREP:-}"
  local log_since="${LOGS_SINCE:-}"

  # Detect environment (minimal, no banner)
  OS="$(uname -s)"
  IS_ROOT=false
  [ "$(id -u)" -eq 0 ] && IS_ROOT=true
  if [ "$IS_ROOT" = true ]; then
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-/opt/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-/var/lib/hivekeep}"
  else
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-$HOME/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-$HOME/.local/share/hivekeep}"
  fi

  # Detect init system
  if [ "$OS" = "Darwin" ]; then
    INIT_SYSTEM="launchd"
  elif command -v systemctl &>/dev/null && systemctl --version &>/dev/null 2>&1; then
    INIT_SYSTEM="systemd"
  else
    INIT_SYSTEM="script"
  fi

  # Determine if we follow (default) or show last N lines
  local follow=true
  if [ "$log_lines" -gt 0 ] 2>/dev/null || [ -n "$log_grep" ] || [ -n "$log_since" ]; then
    follow=false
  fi

  # Helper: apply grep filter if requested
  _log_filter() {
    if [ -n "$log_grep" ]; then
      grep -i --color=auto -- "$log_grep" || true
    else
      cat
    fi
  }

  # For file-based logs (launchd, script)
  _show_file_logs() {
    local log_file="$1"
    if [ ! -f "$log_file" ]; then
      echo "No log file found at $log_file" >&2
      exit 1
    fi

    if [ "$follow" = true ]; then
      if [ -n "$log_grep" ]; then
        tail -f "$log_file" | grep -i --color=auto --line-buffered -- "$log_grep"
      else
        exec tail -f "$log_file"
      fi
    else
      local n="${log_lines:-100}"
      [ "$n" -eq 0 ] 2>/dev/null && n=100

      if [ -n "$log_since" ]; then
        # For file-based logs, --since is best-effort: show last N lines
        # and note that --since works best with journalctl
        echo -e "${DIM}Note: --since filtering works best with systemd/journalctl.${NC}" >&2
        echo -e "${DIM}Showing last $n lines instead.${NC}" >&2
        echo "" >&2
      fi

      tail -n "$n" "$log_file" | _log_filter
    fi
  }

  # For journalctl-based logs (systemd)
  _show_journal_logs() {
    local base_cmd=("journalctl")
    if [ "$IS_ROOT" = true ]; then
      base_cmd+=("-u" "hivekeep")
    else
      base_cmd+=("--user" "-u" "hivekeep")
    fi

    if [ -n "$log_since" ]; then
      base_cmd+=("--since" "$log_since")
    fi

    if [ "$follow" = true ]; then
      if [ -n "$log_grep" ]; then
        "${base_cmd[@]}" -f --no-pager | grep -i --color=auto --line-buffered -- "$log_grep"
      else
        exec "${base_cmd[@]}" -f
      fi
    else
      local n="${log_lines:-100}"
      [ "$n" -eq 0 ] 2>/dev/null && n=100
      "${base_cmd[@]}" --no-pager -n "$n" | _log_filter
    fi
  }

  if [ "$INIT_SYSTEM" = "launchd" ]; then
    _show_file_logs "$HOME/Library/Logs/hivekeep/hivekeep.log"
  elif [ "$INIT_SYSTEM" = "script" ]; then
    _show_file_logs "$HIVEKEEP_DATA_DIR/hivekeep.log"
  else
    _show_journal_logs
  fi
}

# ─── Backup (standalone) ─────────────────────────────────────────────────────
do_backup() {
  echo ""
  echo -e "${BOLD}Hivekeep Backup${NC}"
  echo ""

  # Minimal env setup
  OS="$(uname -s)"
  IS_ROOT=false
  [ "$(id -u)" -eq 0 ] && IS_ROOT=true
  if [ "$IS_ROOT" = true ]; then
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-/opt/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-/var/lib/hivekeep}"
  else
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-$HOME/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-$HOME/.local/share/hivekeep}"
  fi

  local db_file="$HIVEKEEP_DATA_DIR/hivekeep.db"
  local env_file="$HIVEKEEP_DATA_DIR/hivekeep.env"

  if [ ! -f "$db_file" ]; then
    error "No database found at $db_file — nothing to back up"
  fi

  # Determine output path
  local timestamp
  timestamp="$(date +%Y%m%d-%H%M%S)"
  local version_tag="manual"
  if [ -d "$HIVEKEEP_DIR/.git" ]; then
    version_tag="$(git -C "$HIVEKEEP_DIR" describe --tags 2>/dev/null || git -C "$HIVEKEEP_DIR" rev-parse --short HEAD 2>/dev/null || echo "manual")"
    version_tag="$(echo "$version_tag" | tr '/' '-')"
  fi

  local output="${1:-}"
  if [ -z "$output" ]; then
    local backup_dir="$HIVEKEEP_DATA_DIR/backups"
    mkdir -p "$backup_dir"
    output="$backup_dir/hivekeep-${version_tag}-${timestamp}.db"
  fi

  # Create parent directory if needed
  mkdir -p "$(dirname "$output")"

  # Backup using sqlite3 .backup if available (safe even while running)
  if command -v sqlite3 &>/dev/null; then
    if sqlite3 "$db_file" ".backup '$output'" 2>/dev/null; then
      success "Database backed up (sqlite3 safe copy)"
    else
      cp "$db_file" "$output"
      [ -f "${db_file}-wal" ] && cp "${db_file}-wal" "${output}-wal"
      [ -f "${db_file}-shm" ] && cp "${db_file}-shm" "${output}-shm"
      success "Database backed up (file copy)"
    fi
  else
    cp "$db_file" "$output"
    [ -f "${db_file}-wal" ] && cp "${db_file}-wal" "${output}-wal"
    [ -f "${db_file}-shm" ] && cp "${db_file}-shm" "${output}-shm"
    success "Database backed up (file copy)"
  fi

  # Also back up env file alongside
  if [ -f "$env_file" ]; then
    cp "$env_file" "${output%.db}.env"
    success "Config backed up: $(basename "${output%.db}.env")"
  fi

  local db_size
  db_size="$(du -h "$output" 2>/dev/null | awk '{print $1}')"

  echo ""
  echo -e "  ${CYAN}Backup:${NC}  $output ($db_size)"
  if [ -f "${output%.db}.env" ]; then
    echo -e "  ${CYAN}Config:${NC}  ${output%.db}.env"
  fi
  echo ""

  # Verify backup integrity if sqlite3 is available
  if command -v sqlite3 &>/dev/null; then
    local result
    result="$(sqlite3 "$output" "PRAGMA integrity_check;" 2>/dev/null || echo "error")"
    if [ "$result" = "ok" ]; then
      success "Backup integrity verified"
    else
      warn "Backup integrity check returned: $result"
    fi
  fi

  # List existing backups
  local backup_dir="$HIVEKEEP_DATA_DIR/backups"
  if [ -d "$backup_dir" ]; then
    local count
    count="$(find "$backup_dir" -maxdepth 1 -name 'hivekeep-*.db' -type f 2>/dev/null | wc -l)"
    if [ "$count" -gt 0 ] 2>/dev/null; then
      echo ""
      info "$count backup(s) in $backup_dir"
    fi
  fi
  echo ""
}

# ─── Restore ─────────────────────────────────────────────────────────────────
do_restore() {
  echo ""
  echo -e "${BOLD}Hivekeep Restore${NC}"
  echo ""

  # Minimal env setup
  OS="$(uname -s)"
  IS_ROOT=false
  [ "$(id -u)" -eq 0 ] && IS_ROOT=true
  if [ "$IS_ROOT" = true ]; then
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-/opt/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-/var/lib/hivekeep}"
  else
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-$HOME/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-$HOME/.local/share/hivekeep}"
  fi

  # Detect init system for service control
  if [ "$OS" = "Darwin" ]; then
    INIT_SYSTEM="launchd"
  elif command -v systemctl &>/dev/null && systemctl --version &>/dev/null 2>&1; then
    INIT_SYSTEM="systemd"
  else
    INIT_SYSTEM="script"
  fi

  local backup_file="${1:-}"

  # If no file given, list available backups and let user pick
  if [ -z "$backup_file" ]; then
    local backup_dir="$HIVEKEEP_DATA_DIR/backups"
    if [ ! -d "$backup_dir" ] || [ -z "$(find "$backup_dir" -maxdepth 1 -name 'hivekeep-*.db' -type f 2>/dev/null)" ]; then
      error "No backup file specified and no backups found in $backup_dir"
    fi

    echo -e "  ${BOLD}Available backups:${NC}"
    echo ""
    local i=1
    local -a backup_list=()
    while IFS= read -r f; do
      backup_list+=("$f")
      local fname size
      fname="$(basename "$f")"
      size="$(du -h "$f" 2>/dev/null | awk '{print $1}')"
      local mtime
      mtime="$(date -r "$f" '+%Y-%m-%d %H:%M' 2>/dev/null || stat -c '%y' "$f" 2>/dev/null | cut -d. -f1 || echo "unknown")"
      echo -e "  ${CYAN}$i)${NC} $fname ($size, $mtime)"
      i=$((i + 1))
    done < <(find "$backup_dir" -maxdepth 1 -name 'hivekeep-*.db' -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk '{print $2}')

    if [ ${#backup_list[@]} -eq 0 ]; then
      error "No backups found in $backup_dir"
    fi

    echo ""
    local choice
    echo -en "  ${CYAN}?${NC} ${BOLD}Which backup to restore?${NC} ${DIM}[1-${#backup_list[@]}]${NC}: " >/dev/tty
    read -r choice </dev/tty || choice=""

    if [[ ! "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt ${#backup_list[@]} ] 2>/dev/null; then
      error "Invalid selection"
    fi
    backup_file="${backup_list[$((choice - 1))]}"
  fi

  if [ ! -f "$backup_file" ]; then
    error "Backup file not found: $backup_file"
  fi

  # Verify backup integrity before restoring
  if command -v sqlite3 &>/dev/null; then
    local result
    result="$(sqlite3 "$backup_file" "PRAGMA integrity_check;" 2>/dev/null || echo "error")"
    if [ "$result" = "ok" ]; then
      success "Backup integrity OK"
    else
      warn "Backup integrity check returned: $result"
      echo -en "  ${YELLOW}?${NC} ${BOLD}Continue anyway?${NC} ${DIM}[y/N]${NC}: " >/dev/tty
      local cont
      read -r cont </dev/tty || cont="n"
      [[ ! "$cont" =~ ^[Yy]$ ]] && exit 1
    fi
  fi

  local db_file="$HIVEKEEP_DATA_DIR/hivekeep.db"
  local backup_size
  backup_size="$(du -h "$backup_file" 2>/dev/null | awk '{print $1}')"

  echo ""
  echo -e "  ${YELLOW}⚠ This will replace your current database with:${NC}"
  echo -e "  ${CYAN}$(basename "$backup_file")${NC} ($backup_size)"
  echo ""

  if [ "$HIVEKEEP_YES" != true ] && [ "${HIVEKEEP_NO_PROMPT:-}" != "true" ] && [ "${CI:-}" != "true" ]; then
    echo -en "  ${YELLOW}?${NC} ${BOLD}Continue?${NC} ${DIM}[y/N]${NC}: " >/dev/tty
    local confirm
    read -r confirm </dev/tty || confirm="n"
    [[ ! "$confirm" =~ ^[Yy]$ ]] && { info "Cancelled"; exit 0; }
  fi

  # Back up current database first
  if [ -f "$db_file" ]; then
    local safety_backup
    safety_backup="$HIVEKEEP_DATA_DIR/backups/hivekeep-pre-restore-$(date +%Y%m%d-%H%M%S).db"
    mkdir -p "$(dirname "$safety_backup")"
    cp "$db_file" "$safety_backup"
    [ -f "${db_file}-wal" ] && cp "${db_file}-wal" "${safety_backup}-wal"
    [ -f "${db_file}-shm" ] && cp "${db_file}-shm" "${safety_backup}-shm"
    success "Current database saved to $(basename "$safety_backup")"
  fi

  # Stop service before replacing database
  header "Stopping Hivekeep..."
  local was_running=false
  if [ "$INIT_SYSTEM" = "launchd" ]; then
    local plist="$HOME/Library/LaunchAgents/io.hivekeep.server.plist"
    if [ -f "$plist" ] && launchctl list 2>/dev/null | grep -q io.hivekeep.server; then
      was_running=true
      launchctl unload "$plist" 2>/dev/null || true
      success "Service stopped"
    fi
  elif [ "$INIT_SYSTEM" = "script" ]; then
    local script_path="$HIVEKEEP_DIR/hivekeep"
    local pid_file="$HIVEKEEP_DATA_DIR/hivekeep.pid"
    if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
      was_running=true
      "$script_path" stop 2>/dev/null || kill "$(cat "$pid_file")" 2>/dev/null || true
      success "Service stopped"
    fi
  elif [ "$IS_ROOT" = true ]; then
    if systemctl is-active --quiet hivekeep 2>/dev/null; then
      was_running=true
      systemctl stop hivekeep
      success "Service stopped"
    fi
  else
    if systemctl --user is-active --quiet hivekeep 2>/dev/null; then
      was_running=true
      systemctl --user stop hivekeep
      success "Service stopped"
    fi
  fi

  # Replace database
  header "Restoring database..."
  cp "$backup_file" "$db_file"
  # Remove WAL/SHM from current (will be recreated) and copy from backup if they exist
  rm -f "${db_file}-wal" "${db_file}-shm"
  [ -f "${backup_file}-wal" ] && cp "${backup_file}-wal" "${db_file}-wal"
  [ -f "${backup_file}-shm" ] && cp "${backup_file}-shm" "${db_file}-shm"

  # Fix ownership if running as root
  if [ "$IS_ROOT" = true ] && id "${HIVEKEEP_USER:-hivekeep}" &>/dev/null; then
    chown "${HIVEKEEP_USER}:${HIVEKEEP_USER}" "$db_file" "${db_file}-wal" "${db_file}-shm" 2>/dev/null || true
  fi

  success "Database restored from $(basename "$backup_file")"

  # Also restore env file if it exists alongside the backup
  local env_backup="${backup_file%.db}.env"
  if [ -f "$env_backup" ]; then
    echo ""
    echo -en "  ${CYAN}?${NC} ${BOLD}Also restore config file?${NC} ${DIM}[y/N]${NC}: " >/dev/tty
    local restore_env
    read -r restore_env </dev/tty || restore_env="n"
    if [[ "$restore_env" =~ ^[Yy]$ ]]; then
      cp "$env_backup" "$HIVEKEEP_DATA_DIR/hivekeep.env"
      chmod 600 "$HIVEKEEP_DATA_DIR/hivekeep.env"
      success "Config restored"
    fi
  fi

  # Restart service if it was running
  if [ "$was_running" = true ]; then
    header "Restarting Hivekeep..."
    if [ "$INIT_SYSTEM" = "launchd" ]; then
      launchctl load "$HOME/Library/LaunchAgents/io.hivekeep.server.plist" 2>/dev/null
    elif [ "$INIT_SYSTEM" = "script" ]; then
      "$HIVEKEEP_DIR/hivekeep" start 2>/dev/null || true
    elif [ "$IS_ROOT" = true ]; then
      systemctl start hivekeep
    else
      systemctl --user start hivekeep
    fi
    success "Service restarted"
  fi

  echo ""
  echo -e "${GREEN}${BOLD}Restore complete!${NC}"
  if [ "$was_running" != true ]; then
    echo -e "  ${DIM}Start Hivekeep to use the restored database.${NC}"
  fi
  echo ""
}

# ─── Manage env variables (get / set / remove) ───────────────────────────────
do_env() {
  local assignment="${1:-}"

  # Minimal env setup
  OS="$(uname -s)"
  IS_ROOT=false
  [ "$(id -u)" -eq 0 ] && IS_ROOT=true
  if [ "$IS_ROOT" = true ]; then
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-/var/lib/hivekeep}"
  else
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-$HOME/.local/share/hivekeep}"
  fi

  local env_file="$HIVEKEEP_DATA_DIR/hivekeep.env"

  # ── No argument: list all variables ──
  if [ -z "$assignment" ]; then
    if [ ! -f "$env_file" ]; then
      error "No config file found at $env_file. Run the installer first: bash install.sh"
    fi

    echo ""
    echo -e "${BOLD}Hivekeep Configuration${NC}"
    echo -e "${DIM}$env_file${NC}"
    echo ""

    local secret_patterns="KEY TOKEN SECRET PASSWORD PASS"
    while IFS= read -r line; do
      # Skip empty lines and comments
      [[ -z "$line" ]] && continue
      if [[ "$line" =~ ^#.*$ ]]; then
        echo -e "  ${DIM}$line${NC}"
        continue
      fi

      local k="${line%%=*}"
      local v="${line#*=}"

      # Mask secret values
      local masked=false
      for sp in $secret_patterns; do
        if echo "$k" | grep -qi "$sp"; then
          if [ ${#v} -gt 8 ]; then
            v="${v:0:4}...${v: -4}"
          elif [ -n "$v" ]; then
            v="****"
          fi
          masked=true
          break
        fi
      done

      if [ "$masked" = true ]; then
        echo -e "  ${CYAN}${k}${NC}=${DIM}${v}${NC}"
      else
        echo -e "  ${CYAN}${k}${NC}=${v}"
      fi
    done < "$env_file"

    echo ""
    return
  fi

  # ── KEY- syntax: remove a variable ──
  if [[ "$assignment" =~ ^[A-Za-z_][A-Za-z0-9_]*-$ ]]; then
    local key="${assignment%-}"

    if [ ! -f "$env_file" ]; then
      error "No config file found at $env_file. Run the installer first: bash install.sh"
    fi

    if ! grep -q "^${key}=" "$env_file" 2>/dev/null; then
      warn "$key is not set in $env_file"
      return
    fi

    local tmp_env
    tmp_env="$(mktemp)"
    while IFS= read -r line; do
      case "$line" in
        "${key}="*) ;; # skip this line
        *)          echo "$line" ;;
      esac
    done < "$env_file" > "$tmp_env"
    mv "$tmp_env" "$env_file"
    chmod 600 "$env_file"
    success "$key removed from $env_file"
    return
  fi

  # ── KEY syntax (bare name): get a single variable ──
  if [[ "$assignment" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    local key="$assignment"

    if [ ! -f "$env_file" ]; then
      error "No config file found at $env_file. Run the installer first: bash install.sh"
    fi

    local found_value=""
    local found=false
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      [[ "$line" =~ ^#.*$ ]] && continue
      local k="${line%%=*}"
      if [ "$k" = "$key" ]; then
        found_value="${line#*=}"
        found=true
        break
      fi
    done < "$env_file"

    if [ "$found" = true ]; then
      # Raw output (no colors, no prefix) so it's script-friendly:
      #   PORT=$(bash install.sh --env PORT)
      echo "$found_value"
    else
      warn "$key is not set in $env_file"
      return 1
    fi
    return
  fi

  # ── KEY=VALUE syntax: set a variable ──
  if [[ ! "$assignment" =~ ^[A-Za-z_][A-Za-z0-9_]*=.* ]]; then
    error "Invalid format. Usage: bash install.sh --env [KEY | KEY=VALUE | KEY-]"
  fi

  local key="${assignment%%=*}"
  local value="${assignment#*=}"

  if [ ! -f "$env_file" ]; then
    # Create the file if it doesn't exist yet (pre-install config)
    mkdir -p "$HIVEKEEP_DATA_DIR"
    cat > "$env_file" << ENV
# Hivekeep configuration
NODE_ENV=production
ENV
    chmod 600 "$env_file"
  fi

  # Check if key already exists in the file
  if grep -q "^${key}=" "$env_file" 2>/dev/null; then
    # Update existing key
    local tmp_env
    tmp_env="$(mktemp)"
    while IFS= read -r line; do
      case "$line" in
        "${key}="*) echo "${key}=${value}" ;;
        *)          echo "$line" ;;
      esac
    done < "$env_file" > "$tmp_env"
    mv "$tmp_env" "$env_file"
    chmod 600 "$env_file"
    success "$key updated in $env_file"
  else
    # Append new key
    echo "${key}=${value}" >> "$env_file"
    success "$key added to $env_file"
  fi

  # Show the current value (mask secrets)
  local display_value="$value"
  local secret_keys="KEY TOKEN SECRET PASSWORD PASS"
  for sk in $secret_keys; do
    if echo "$key" | grep -qi "$sk"; then
      if [ ${#value} -gt 8 ]; then
        display_value="${value:0:4}...${value: -4}"
      else
        display_value="****"
      fi
      break
    fi
  done
  info "$key=$display_value"
}

# ─── Reconfigure ─────────────────────────────────────────────────────────────
do_config() {
  echo ""
  echo -e "${BOLD}Hivekeep Configuration${NC}"
  echo ""

  # Minimal env setup
  OS="$(uname -s)"
  IS_ROOT=false
  [ "$(id -u)" -eq 0 ] && IS_ROOT=true
  if [ "$IS_ROOT" = true ]; then
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-/opt/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-/var/lib/hivekeep}"
  else
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-$HOME/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-$HOME/.local/share/hivekeep}"
  fi

  local env_file="$HIVEKEEP_DATA_DIR/hivekeep.env"

  if [ ! -f "$env_file" ]; then
    error "No config file found at $env_file. Run the installer first: bash install.sh"
  fi

  # Read current values
  local current_port current_url current_log_level current_encryption_key
  # shellcheck disable=SC1090
  . "$env_file" 2>/dev/null || true
  current_port="${PORT:-3000}"
  current_url="${PUBLIC_URL:-}"
  current_log_level="${LOG_LEVEL:-info}"
  current_encryption_key="${ENCRYPTION_KEY:-}"

  echo -e "  ${DIM}Current config: $env_file${NC}"
  echo -e "  ${DIM}Edit values below. Press Enter to keep current value.${NC}"
  echo ""

  # Core settings
  echo -e "  ${BOLD}Core${NC}"
  local new_port new_url
  prompt_value new_port "Port" "$current_port"
  prompt_value new_url "Public URL" "$current_url"

  # Logging
  echo ""
  echo -e "  ${BOLD}Logging${NC}"
  local new_log_level
  prompt_value new_log_level "Log level (debug/info/warn/error)" "$current_log_level"
  # Validate log level
  case "$new_log_level" in
    debug|info|warn|error) ;;
    *)
      warn "Invalid log level '$new_log_level', falling back to '$current_log_level'"
      new_log_level="$current_log_level"
      ;;
  esac

  # Security
  echo ""
  echo -e "  ${BOLD}Security${NC}"
  local new_encryption_key
  if [ -n "$current_encryption_key" ]; then
    local masked_key="${current_encryption_key:0:8}...${current_encryption_key: -4}"
    echo -e "  ${DIM}Encryption key is set ($masked_key). Leave blank to keep it.${NC}"
    prompt_value new_encryption_key "Encryption key" "$current_encryption_key"
  else
    echo -e "  ${DIM}No key is pinned here. Hivekeep auto-generates one at${NC}"
    echo -e "  ${DIM}$HIVEKEEP_DATA_DIR/.encryption-key on first run (secrets are encrypted at rest).${NC}"
    echo -e "  ${DIM}Pin it here only if you want it portable across machines.${NC}"
    local gen_key="y"
    if [ "$HIVEKEEP_YES" != true ] && [ "${HIVEKEEP_NO_PROMPT:-}" != "true" ] && [ "${CI:-}" != "true" ]; then
      echo -en "  ${CYAN}?${NC} ${BOLD}Generate an encryption key?${NC} ${DIM}[Y/n]${NC}: " >/dev/tty
      read -r gen_key </dev/tty || gen_key="y"
      [ -z "$gen_key" ] && gen_key="y"
    fi
    if [[ "$gen_key" =~ ^[Yy]$ ]]; then
      new_encryption_key="$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"
      success "Encryption key generated"
    else
      new_encryption_key=""
    fi
  fi

  # Check if anything changed
  local has_changes=false
  [ "$new_port" != "$current_port" ] && has_changes=true
  [ "$new_url" != "$current_url" ] && has_changes=true
  [ "$new_log_level" != "$current_log_level" ] && has_changes=true
  [ "$new_encryption_key" != "$current_encryption_key" ] && has_changes=true

  if [ "$has_changes" = false ]; then
    echo ""
    info "No changes made."
    echo ""
    exit 0
  fi

  # If port changed, check availability (unless it's our own service)
  if [ "$new_port" != "$current_port" ]; then
    local port_in_use=false
    if command -v ss &>/dev/null; then
      ss -tlnp 2>/dev/null | grep -q ":${new_port} " && port_in_use=true
    elif command -v lsof &>/dev/null; then
      lsof -i ":${new_port}" -sTCP:LISTEN &>/dev/null && port_in_use=true
    fi
    if [ "$port_in_use" = true ]; then
      warn "Port $new_port is already in use. The service may fail to start."
      echo -en "  ${YELLOW}?${NC} ${BOLD}Continue anyway?${NC} ${DIM}[y/N]${NC}: " >/dev/tty
      local cont
      read -r cont </dev/tty || cont="n"
      [[ ! "$cont" =~ ^[Yy]$ ]] && { info "Cancelled"; exit 0; }
    fi
  fi

  # Rewrite the env file preserving any extra user-added vars
  local tmp_env
  tmp_env="$(mktemp)"

  # Track which keys we've written (to append missing ones at the end)
  local wrote_log_level=false wrote_encryption_key=false

  # Update known keys, pass through everything else
  while IFS= read -r line; do
    case "$line" in
      PORT=*)             echo "PORT=${new_port}" ;;
      PUBLIC_URL=*)       echo "PUBLIC_URL=${new_url}" ;;
      LOG_LEVEL=*)        echo "LOG_LEVEL=${new_log_level}"; wrote_log_level=true ;;
      ENCRYPTION_KEY=*)   echo "ENCRYPTION_KEY=${new_encryption_key}"; wrote_encryption_key=true ;;
      *)                  echo "$line" ;;
    esac
  done < "$env_file" > "$tmp_env"

  # Append keys that weren't already in the file
  if [ "$wrote_log_level" = false ] && [ "$new_log_level" != "info" ]; then
    echo "LOG_LEVEL=${new_log_level}" >> "$tmp_env"
  fi
  if [ "$wrote_encryption_key" = false ] && [ -n "$new_encryption_key" ]; then
    echo "ENCRYPTION_KEY=${new_encryption_key}" >> "$tmp_env"
  fi

  mv "$tmp_env" "$env_file"
  chmod 600 "$env_file"

  echo ""
  if [ "$new_port" != "$current_port" ]; then
    success "Port: $current_port → $new_port"
  fi
  if [ "$new_url" != "$current_url" ]; then
    success "Public URL: $current_url → $new_url"
  fi
  if [ "$new_log_level" != "$current_log_level" ]; then
    success "Log level: $current_log_level → $new_log_level"
  fi
  if [ "$new_encryption_key" != "$current_encryption_key" ]; then
    if [ -z "$current_encryption_key" ] && [ -n "$new_encryption_key" ]; then
      success "Encryption key: set (API keys will be encrypted at rest)"
    elif [ -n "$new_encryption_key" ]; then
      success "Encryption key: updated"
    fi
  fi
  success "Config updated: $env_file"

  # Detect init system and offer restart
  if [ "$OS" = "Darwin" ]; then
    INIT_SYSTEM="launchd"
  elif command -v systemctl &>/dev/null && systemctl --version &>/dev/null 2>&1; then
    INIT_SYSTEM="systemd"
  else
    INIT_SYSTEM="script"
  fi

  local is_running=false
  if [ "$INIT_SYSTEM" = "launchd" ]; then
    launchctl list 2>/dev/null | grep -q io.hivekeep.server && is_running=true
  elif [ "$INIT_SYSTEM" = "script" ]; then
    local pid_file="$HIVEKEEP_DATA_DIR/hivekeep.pid"
    [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null && is_running=true
  elif [ "$IS_ROOT" = true ]; then
    systemctl is-active --quiet hivekeep 2>/dev/null && is_running=true
  else
    systemctl --user is-active --quiet hivekeep 2>/dev/null && is_running=true
  fi

  if [ "$is_running" = true ]; then
    echo ""
    local do_restart="y"
    if [ "$HIVEKEEP_YES" != true ]; then
      echo -en "  ${CYAN}?${NC} ${BOLD}Restart Hivekeep now to apply changes?${NC} ${DIM}[Y/n]${NC}: " >/dev/tty
      read -r do_restart </dev/tty || do_restart="y"
      [ -z "$do_restart" ] && do_restart="y"
    fi

    if [[ "$do_restart" =~ ^[Yy]$ ]]; then
      if [ "$INIT_SYSTEM" = "launchd" ]; then
        local plist="$HOME/Library/LaunchAgents/io.hivekeep.server.plist"
        launchctl unload "$plist" 2>/dev/null || true
        launchctl load "$plist" 2>/dev/null
      elif [ "$INIT_SYSTEM" = "script" ]; then
        "$HIVEKEEP_DIR/hivekeep" restart 2>/dev/null || true
      elif [ "$IS_ROOT" = true ]; then
        systemctl restart hivekeep
      else
        systemctl --user restart hivekeep
      fi
      success "Hivekeep restarted"

      # Quick health check
      sleep 3
      local http_code
      http_code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${new_port}/" --max-time 5 2>/dev/null || echo "000")"
      if [ "$http_code" != "000" ]; then
        success "Hivekeep is responding on port $new_port"
      else
        warn "Hivekeep hasn't responded yet on port $new_port. Give it a moment."
      fi
    else
      echo ""
      info "Remember to restart Hivekeep for changes to take effect."
    fi
  else
    echo ""
    info "Hivekeep is not currently running. Changes will apply on next start."
  fi

  echo ""
}

# ─── Update (check + apply) ──────────────────────────────────────────────────
do_update() {
  echo ""
  echo -e "${BOLD}Hivekeep Updater${NC}"
  echo ""

  # Minimal env setup
  OS="$(uname -s)"
  IS_ROOT=false
  [ "$(id -u)" -eq 0 ] && IS_ROOT=true
  if [ "$IS_ROOT" = true ]; then
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-/opt/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-/var/lib/hivekeep}"
    HIVEKEEP_USER="${HIVEKEEP_USER:-hivekeep}"
  else
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-$HOME/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-$HOME/.local/share/hivekeep}"
  fi

  if [ ! -d "$HIVEKEEP_DIR/.git" ]; then
    error "Hivekeep is not installed at $HIVEKEEP_DIR. Run the installer first: bash install.sh"
  fi

  local channel target_ref
  channel="$(resolve_channel)"

  if [ "$channel" = "stable" ]; then
    info "Checking for updates on the ${BOLD}stable${NC} channel (release tags)..."
    git -C "$HIVEKEEP_DIR" fetch --tags origin --quiet 2>/dev/null || \
      error "Could not reach GitHub. Check your internet connection."
    local latest_tag
    latest_tag="$(get_latest_stable_tag)"
    [ -z "$latest_tag" ] && error "Could not resolve the latest release tag."
    target_ref="$latest_tag"
  else
    local branch
    branch="$(git -C "$HIVEKEEP_DIR" branch --show-current 2>/dev/null || echo "main")"
    info "Checking for updates on the ${BOLD}edge${NC} channel (branch ${branch})..."
    git -C "$HIVEKEEP_DIR" fetch origin "$branch" --quiet 2>/dev/null || \
      error "Could not reach GitHub. Check your internet connection."
    target_ref="origin/$branch"
  fi

  local local_head remote_head
  local_head="$(git -C "$HIVEKEEP_DIR" rev-parse HEAD)"
  remote_head="$(git -C "$HIVEKEEP_DIR" rev-parse "${target_ref}^{commit}" 2>/dev/null || echo "")"

  if [ -z "$remote_head" ]; then
    error "Could not resolve update target $target_ref"
  fi

  if [ "$local_head" = "$remote_head" ]; then
    local version
    version="$(git -C "$HIVEKEEP_DIR" describe --tags 2>/dev/null || git -C "$HIVEKEEP_DIR" rev-parse --short HEAD)"
    if legacy_system_bun_service_needs_repair; then
      repair_legacy_system_bun_service
    fi
    echo ""
    echo -e "  ${GREEN}✓ Already up to date${NC} ($version, $channel channel)"
    echo ""
    exit 0
  fi

  # Show what's new
  local behind
  behind="$(git -C "$HIVEKEEP_DIR" rev-list "HEAD..$remote_head" --count 2>/dev/null || echo "?")"
  local current_version new_version
  current_version="$(git -C "$HIVEKEEP_DIR" describe --tags 2>/dev/null || git -C "$HIVEKEEP_DIR" rev-parse --short HEAD)"
  if [ "$channel" = "stable" ]; then
    new_version="$target_ref"
  else
    new_version="$(git -C "$HIVEKEEP_DIR" describe --tags "$target_ref" 2>/dev/null || git -C "$HIVEKEEP_DIR" rev-parse --short "$target_ref")"
  fi

  echo ""
  echo -e "  ${CYAN}Channel:${NC}  $channel"
  echo -e "  ${CYAN}Current:${NC}  $current_version"
  echo -e "  ${CYAN}Latest:${NC}   $new_version"
  echo -e "  ${CYAN}Changes:${NC}  $behind commit(s)"
  echo ""

  # Show categorized changelog
  show_categorized_commits "HEAD..$remote_head" 5 || true

  # Confirm
  if [ "$HIVEKEEP_YES" != true ] && [ "${HIVEKEEP_NO_PROMPT:-}" != "true" ] && [ "${CI:-}" != "true" ]; then
    local confirm="y"
    echo -en "  ${CYAN}?${NC} ${BOLD}Apply update?${NC} ${DIM}[Y/n]${NC}: " >/dev/tty
    read -r confirm </dev/tty || confirm="y"
    [ -z "$confirm" ] && confirm="y"
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
      info "Update cancelled"
      exit 0
    fi
  fi

  echo ""

  start_timer

  # Detect OS fully for the install flow
  STEP_TOTAL=7
  STEP_CURRENT=0

  detect_os
  ensure_bun

  # Enable rollback
  trap rollback EXIT

  install_or_update
  step "Configuring"
  configure
  build_hivekeep
  setup_database
  setup_system_user
  resolve_bun_path
  create_service
  verify_running

  trap - EXIT
  ROLLBACK_COMMIT=""

  print_summary
}

# ─── Reset (fix broken install, keep data) ────────────────────────────────────
do_reset() {
  echo ""
  echo -e "${BOLD}Hivekeep Reset${NC}"
  echo -e "${DIM}Fixes broken installations by re-cloning and rebuilding.${NC}"
  echo -e "${DIM}Your database, config, and backups are preserved.${NC}"
  echo ""

  # Minimal env setup
  OS="$(uname -s)"
  IS_ROOT=false
  [ "$(id -u)" -eq 0 ] && IS_ROOT=true
  if [ "$IS_ROOT" = true ]; then
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-/opt/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-/var/lib/hivekeep}"
    HIVEKEEP_USER="${HIVEKEEP_USER:-hivekeep}"
  else
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-$HOME/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-$HOME/.local/share/hivekeep}"
  fi

  if [ ! -d "$HIVEKEEP_DIR" ] && [ ! -d "$HIVEKEEP_DATA_DIR" ]; then
    error "No Hivekeep installation found. Run the installer first: bash install.sh"
  fi

  detect_os

  # Show what we'll do
  header "Plan"
  if [ -d "$HIVEKEEP_DIR" ]; then
    local current_version="unknown"
    if [ -d "$HIVEKEEP_DIR/.git" ]; then
      current_version="$(git -C "$HIVEKEEP_DIR" describe --tags 2>/dev/null || git -C "$HIVEKEEP_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
    fi
    info "Will remove: $HIVEKEEP_DIR (currently $current_version)"
  fi
  # Resolve the channel BEFORE removing the checkout (detection reads it)
  RESET_CHANNEL="$(resolve_channel)"
  if [ "$RESET_CHANNEL" = "stable" ]; then
    info "Will re-clone from: https://github.com/$HIVEKEEP_REPO (latest release)"
  else
    info "Will re-clone from: https://github.com/$HIVEKEEP_REPO ($HIVEKEEP_BRANCH branch)"
  fi
  info "Will rebuild: dependencies + build + migrations"
  if [ -d "$HIVEKEEP_DATA_DIR" ]; then
    success "Will keep: $HIVEKEEP_DATA_DIR (database, config, backups)"
  fi

  # Diagnose what might be wrong (informational)
  if [ -d "$HIVEKEEP_DIR" ]; then
    header "Diagnosis"
    local issues=0

    # Check git state
    if [ -d "$HIVEKEEP_DIR/.git" ]; then
      if ! git -C "$HIVEKEEP_DIR" status &>/dev/null; then
        warn "Git repository is corrupted"
        issues=$((issues + 1))
      elif [ -n "$(git -C "$HIVEKEEP_DIR" diff --stat HEAD 2>/dev/null)" ]; then
        warn "Working tree has uncommitted changes"
        issues=$((issues + 1))
      fi
    else
      warn "Not a git repository (missing .git/)"
      issues=$((issues + 1))
    fi

    # Check node_modules
    if [ ! -d "$HIVEKEEP_DIR/node_modules" ]; then
      warn "node_modules is missing"
      issues=$((issues + 1))
    elif [ ! -f "$HIVEKEEP_DIR/node_modules/.package-lock.json" ] && [ ! -f "$HIVEKEEP_DIR/bun.lockb" ]; then
      warn "node_modules may be incomplete"
      issues=$((issues + 1))
    fi

    # Check build output
    if [ ! -d "$HIVEKEEP_DIR/.output" ] && [ ! -d "$HIVEKEEP_DIR/dist" ]; then
      warn "No build output found"
      issues=$((issues + 1))
    fi

    if [ "$issues" -eq 0 ]; then
      info "No obvious issues detected (reset will still do a clean rebuild)"
    else
      info "$issues issue(s) found — reset should fix them"
    fi
  fi

  # Confirm
  echo ""
  if [ "$HIVEKEEP_YES" != true ] && [ "${HIVEKEEP_NO_PROMPT:-}" != "true" ] && [ "${CI:-}" != "true" ]; then
    echo -en "  ${YELLOW}?${NC} ${BOLD}Proceed with reset?${NC} ${DIM}[y/N]${NC}: " >/dev/tty
    local confirm
    read -r confirm </dev/tty || confirm="n"
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
      info "Cancelled"
      exit 0
    fi
  fi

  echo ""
  start_timer

  STEP_TOTAL=7
  STEP_CURRENT=0

  # Validate the runtime before stopping the service or removing the checkout.
  ensure_bun
  setup_system_user
  resolve_bun_path

  # 1. Back up the database
  step "Backing up database"
  backup_database

  # 2. Stop the service
  step "Stopping service"
  if [ "$INIT_SYSTEM" = "launchd" ]; then
    local plist="$HOME/Library/LaunchAgents/io.hivekeep.server.plist"
    if [ -f "$plist" ] && launchctl list 2>/dev/null | grep -q io.hivekeep.server; then
      launchctl unload "$plist" 2>/dev/null || true
      success "Service stopped"
    else
      info "Service was not running"
    fi
  elif [ "$INIT_SYSTEM" = "script" ]; then
    local script_path="$HIVEKEEP_DIR/hivekeep"
    local pid_file="$HIVEKEEP_DATA_DIR/hivekeep.pid"
    if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
      if [ -x "$script_path" ]; then
        "$script_path" stop 2>/dev/null || kill "$(cat "$pid_file")" 2>/dev/null || true
      else
        kill "$(cat "$pid_file")" 2>/dev/null || true
      fi
      rm -f "$pid_file"
      success "Service stopped"
    else
      rm -f "$pid_file" 2>/dev/null
      info "Service was not running"
    fi
  elif [ "$IS_ROOT" = true ]; then
    if systemctl is-active --quiet hivekeep 2>/dev/null; then
      systemctl stop hivekeep
      success "Service stopped"
    else
      info "Service was not running"
    fi
  else
    if systemctl --user is-active --quiet hivekeep 2>/dev/null; then
      systemctl --user stop hivekeep
      success "Service stopped"
    else
      info "Service was not running"
    fi
  fi

  # 3. Remove app directory
  step "Removing old installation"
  if [ -d "$HIVEKEEP_DIR" ]; then
    rm -rf "$HIVEKEEP_DIR"
    success "Removed $HIVEKEEP_DIR"
  fi

  # 4. Fresh clone
  step "Cloning Hivekeep"
  mkdir -p "$(dirname "$HIVEKEEP_DIR")"
  if [ "${RESET_CHANNEL:-stable}" = "stable" ]; then
    HIVEKEEP_TARGET_TAG="$(get_latest_stable_tag)"
  fi
  if [ -n "$HIVEKEEP_TARGET_TAG" ]; then
    run_with_spinner "Cloning from GitHub ($HIVEKEEP_TARGET_TAG)..." retry 3 "git clone" git clone "https://github.com/$HIVEKEEP_REPO.git" "$HIVEKEEP_DIR" --branch "$HIVEKEEP_TARGET_TAG" --depth 1
  else
    run_with_spinner "Cloning from GitHub..." retry 3 "git clone" git clone "https://github.com/$HIVEKEEP_REPO.git" "$HIVEKEEP_DIR" --branch "$HIVEKEEP_BRANCH" --depth 1
  fi
  local new_version
  new_version="$(git -C "$HIVEKEEP_DIR" describe --tags 2>/dev/null || git -C "$HIVEKEEP_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
  success "Cloned $new_version"

  # 5. Rebuild
  IS_UPDATE=true
  build_hivekeep
  setup_database

  # 6. Fix permissions + service
  setup_system_user
  resolve_bun_path
  create_service

  # 7. Verify
  verify_running

  # Summary
  local elapsed=""
  elapsed="$(format_elapsed)"

  echo ""
  echo -e "${GREEN}${BOLD}Reset complete!${NC}"
  echo ""
  echo -e "  ${CYAN}Version:${NC}    $new_version"
  echo -e "  ${CYAN}Install:${NC}    $HIVEKEEP_DIR"
  echo -e "  ${CYAN}Data:${NC}       $HIVEKEEP_DATA_DIR (preserved)"
  if [ -n "${BACKUP_DB_PATH:-}" ] && [ -f "${BACKUP_DB_PATH:-}" ]; then
    echo -e "  ${CYAN}DB backup:${NC}  $(basename "$BACKUP_DB_PATH")"
  fi
  if [ "$HIVEKEEP_HEALTHY" = true ]; then
    echo -e "  ${GREEN}●${NC} ${BOLD}Status:${NC}     Running"
  else
    echo -e "  ${YELLOW}●${NC} ${BOLD}Status:${NC}     Starting (check logs)"
  fi
  if [ -n "$elapsed" ]; then
    echo -e "  ${CYAN}Completed in:${NC} $elapsed"
  fi
  echo ""
}

# ─── Self-test ────────────────────────────────────────────────────────────────
# ─── Health check (lightweight, for monitoring) ──────────────────────────────
# Designed for: Uptime Kuma, cron watchdogs, Prometheus node_exporter textfile,
# Healthchecks.io, or any tool that checks exit codes.
#
# Usage:
#   bash install.sh --health            # "healthy" / "unhealthy: reason", exit 0/1
#   bash install.sh --health --json     # JSON output for dashboards
#
# Exit codes: 0 = healthy, 1 = unhealthy
do_health() {
  # Minimal env setup (no banners, no detect_os overhead)
  local is_root=false
  [ "$(id -u)" -eq 0 ] && is_root=true
  local hivekeep_data_dir
  if [ "$is_root" = true ]; then
    hivekeep_data_dir="${HIVEKEEP_DATA_DIR:-/var/lib/hivekeep}"
  else
    hivekeep_data_dir="${HIVEKEEP_DATA_DIR:-$HOME/.local/share/hivekeep}"
  fi

  local env_file="$hivekeep_data_dir/hivekeep.env"
  local pid_file="$hivekeep_data_dir/hivekeep.pid"
  local db_file="$hivekeep_data_dir/hivekeep.db"

  # Parse --json flag
  local json_output=false
  for a in "$@"; do
    [ "$a" = "--json" ] && json_output=true
  done

  # Read port from config
  local port="3000"
  if [ -f "$env_file" ]; then
    local cfg_port
    cfg_port="$(grep '^PORT=' "$env_file" 2>/dev/null | cut -d= -f2)" || cfg_port=""
    [ -n "$cfg_port" ] && port="$cfg_port"
  fi

  local healthy=true
  local reason=""
  local pid=""
  local http_code="000"

  # Check process is running
  # Detect init system quickly
  local os_name init_sys
  os_name="$(uname -s)"
  if [ "$os_name" = "Darwin" ]; then
    init_sys="launchd"
  elif command -v systemctl &>/dev/null && systemctl --version &>/dev/null 2>&1; then
    init_sys="systemd"
  else
    init_sys="script"
  fi

  if [ "$init_sys" = "launchd" ]; then
    if ! launchctl list 2>/dev/null | grep -q io.hivekeep.server; then
      healthy=false
      reason="service not loaded"
    fi
  elif [ "$init_sys" = "script" ]; then
    if [ -f "$pid_file" ]; then
      pid="$(cat "$pid_file" 2>/dev/null || echo "")"
      if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
        healthy=false
        reason="process not running"
        pid=""
      fi
    else
      healthy=false
      reason="no pid file"
    fi
  elif [ "$is_root" = true ]; then
    if ! systemctl is-active --quiet hivekeep 2>/dev/null; then
      healthy=false
      reason="service not active"
    else
      pid="$(systemctl show hivekeep -p MainPID --value 2>/dev/null || echo "")"
      [ "$pid" = "0" ] && pid=""
    fi
  else
    if ! systemctl --user is-active --quiet hivekeep 2>/dev/null; then
      healthy=false
      reason="service not active"
    else
      pid="$(systemctl --user show hivekeep -p MainPID --value 2>/dev/null || echo "")"
      [ "$pid" = "0" ] && pid=""
    fi
  fi

  # Check HTTP response
  if [ "$healthy" = true ] && command -v curl &>/dev/null; then
    http_code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${port}/" --max-time 5 2>/dev/null || echo "000")"
    if [ "$http_code" = "000" ]; then
      healthy=false
      reason="http not responding on port $port"
    fi
  fi

  # Check disk space
  local disk_mb=""
  local disk_low=false
  local avail_kb
  avail_kb="$(df -k "$hivekeep_data_dir" 2>/dev/null | awk 'NR==2 {print $4}')" || avail_kb=""
  if [ -n "$avail_kb" ] && [ "$avail_kb" -gt 0 ] 2>/dev/null; then
    disk_mb=$((avail_kb / 1024))
    [ "$disk_mb" -lt 200 ] 2>/dev/null && disk_low=true
  fi

  # Check database exists
  local db_ok=true
  [ ! -f "$db_file" ] && db_ok=false

  # Output
  if [ "$json_output" = true ]; then
    local pid_json="${pid:-null}"
    [ -n "$pid" ] && pid_json="$pid"
    local disk_json="${disk_mb:-null}"
    local reason_json="null"
    [ -n "$reason" ] && reason_json="\"$reason\""
    echo "{\"healthy\":$healthy,\"pid\":$pid_json,\"port\":$port,\"http\":$http_code,\"disk_mb\":$disk_json,\"disk_low\":$disk_low,\"db_exists\":$db_ok,\"reason\":$reason_json}"
  else
    if [ "$healthy" = true ]; then
      local extra=""
      [ "$disk_low" = true ] && extra=" (disk low: ${disk_mb}MB)"
      [ "$db_ok" = false ] && extra="${extra} (no database)"
      echo "healthy${extra}"
    else
      echo "unhealthy: $reason"
    fi
  fi

  [ "$healthy" = true ] && exit 0 || exit 1
}

# ─── Self-test ────────────────────────────────────────────────────────────────
do_test() {
  echo ""
  echo -e "${BOLD}Hivekeep Self-Test${NC}"
  echo -e "${DIM}Validates that the installation is functional, not just present.${NC}"
  echo ""

  # Minimal env setup
  OS="$(uname -s)"
  IS_ROOT=false
  [ "$(id -u)" -eq 0 ] && IS_ROOT=true
  if [ "$IS_ROOT" = true ]; then
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-/opt/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-/var/lib/hivekeep}"
  else
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-$HOME/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-$HOME/.local/share/hivekeep}"
  fi
  if [ "$OS" = "Darwin" ]; then
    INIT_SYSTEM="launchd"
  elif command -v systemctl &>/dev/null && systemctl --version &>/dev/null 2>&1; then
    INIT_SYSTEM="systemd"
  else
    INIT_SYSTEM="script"
  fi

  local passed=0
  local failed=0
  local warned=0

  test_pass() { passed=$((passed + 1)); success "PASS: $*"; }
  test_fail() { failed=$((failed + 1)); echo -e "${RED}✗ FAIL:${NC} $*" >&2; }
  test_warn() { warned=$((warned + 1)); warn "WARN: $*"; }

  # ── 1. Installation directory ──
  header "Source code"
  if [ -d "$HIVEKEEP_DIR/.git" ]; then
    test_pass "Git repository exists at $HIVEKEEP_DIR"
  else
    test_fail "No git repository at $HIVEKEEP_DIR"
    echo ""
    echo -e "${RED}${BOLD}Cannot continue tests without an installation.${NC}"
    echo -e "${DIM}Run: bash install.sh${NC}"
    echo ""
    exit 1
  fi

  # Check for uncommitted changes / dirty state
  if git -C "$HIVEKEEP_DIR" diff --quiet HEAD 2>/dev/null; then
    test_pass "Working tree is clean"
  else
    test_warn "Working tree has uncommitted changes"
  fi

  # Check package.json exists
  if [ -f "$HIVEKEEP_DIR/package.json" ]; then
    test_pass "package.json exists"
  else
    test_fail "package.json missing"
  fi

  # ── 2. Build artifacts ──
  header "Build artifacts"
  local build_dir="$HIVEKEEP_DIR/.output"
  if [ ! -d "$build_dir" ]; then
    build_dir="$HIVEKEEP_DIR/dist"
  fi

  if [ -d "$build_dir" ]; then
    local file_count
    file_count="$(find "$build_dir" -type f 2>/dev/null | wc -l)"
    if [ "$file_count" -gt 0 ] 2>/dev/null; then
      test_pass "Build output exists ($file_count files in $(basename "$build_dir")/)"
    else
      test_fail "Build directory exists but is empty"
    fi
  else
    # Check for server entry point directly (some setups run from source)
    if [ -f "$HIVEKEEP_DIR/src/server/index.ts" ]; then
      test_pass "Server entry point exists (src/server/index.ts)"
    else
      test_fail "No build output and no server entry point found"
    fi
  fi

  # Check node_modules
  if [ -d "$HIVEKEEP_DIR/node_modules" ]; then
    local mod_count
    mod_count="$(find "$HIVEKEEP_DIR/node_modules" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l)"
    if [ "$mod_count" -gt 10 ] 2>/dev/null; then
      test_pass "Dependencies installed ($mod_count packages)"
    else
      test_warn "node_modules exists but looks sparse ($mod_count packages)"
    fi
  else
    test_fail "node_modules missing (run: cd $HIVEKEEP_DIR && bun install)"
  fi

  # ── 3. Runtime ──
  header "Runtime"
  configure_bun_environment
  local test_bun
  test_bun="$(configured_bun_path || true)"
  if [ -n "$test_bun" ]; then
    local bun_ver
    bun_ver="$(run_configured_bun "$test_bun" --version 2>/dev/null || echo "0.0.0")"
    BUN_MIN_VERSION="${BUN_MIN_VERSION:-1.2.0}"
    if version_gte "$bun_ver" "$BUN_MIN_VERSION"; then
      test_pass "Bun v${bun_ver} (meets v${BUN_MIN_VERSION}+ requirement)"
    else
      test_fail "Bun v${bun_ver} is below minimum v${BUN_MIN_VERSION}"
    fi

    # Verify Bun can actually execute (not just present on PATH)
    if run_configured_bun "$test_bun" -e "console.log('ok')" 2>/dev/null | grep -q "ok"; then
      test_pass "Bun runtime is functional"
    else
      test_fail "Configured Bun runtime cannot execute JavaScript"
    fi

    if [ "$IS_ROOT" = true ] && [ "$OS" = "Linux" ] && [ "${INIT_SYSTEM:-}" = "systemd" ] && id "$HIVEKEEP_USER" &>/dev/null; then
      if bun_runs_as_service_user "$test_bun"; then
        test_pass "Bun executes as service user '$HIVEKEEP_USER'"
      else
        test_fail "Bun cannot execute as service user '$HIVEKEEP_USER' ($test_bun)"
      fi
    fi
  else
    test_fail "Configured Bun runtime not found"
  fi

  # ── 4. Configuration ──
  header "Configuration"
  local env_file="$HIVEKEEP_DATA_DIR/hivekeep.env"
  if [ -f "$env_file" ]; then
    test_pass "Config file exists: $env_file"

    # Check file permissions (should be 600)
    local perms
    perms="$(stat -c '%a' "$env_file" 2>/dev/null || stat -f '%Lp' "$env_file" 2>/dev/null || echo "unknown")"
    if [ "$perms" = "600" ]; then
      test_pass "Config file permissions are secure (600)"
    elif [ "$perms" != "unknown" ]; then
      test_warn "Config file permissions are $perms (expected 600)"
    fi

    # Validate env file syntax (no obvious errors)
    local bad_lines=0
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      [[ "$line" =~ ^#.*$ ]] && continue
      if [[ ! "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
        bad_lines=$((bad_lines + 1))
      fi
    done < "$env_file"
    if [ "$bad_lines" -eq 0 ]; then
      test_pass "Config file syntax is valid"
    else
      test_warn "Config file has $bad_lines suspicious line(s)"
    fi

    # Check required vars are set
    # shellcheck disable=SC1090
    if ( . "$env_file" 2>/dev/null; [ -n "${PORT:-}" ] && echo "PORT_OK" ) | grep -q "PORT_OK"; then
      test_pass "PORT is configured"
    else
      test_warn "PORT not set in config"
    fi
  else
    test_fail "Config file missing: $env_file"
  fi

  # ── 5. Database ──
  header "Database"
  local db_file="$HIVEKEEP_DATA_DIR/hivekeep.db"
  if [ -f "$db_file" ]; then
    local db_size
    db_size="$(du -h "$db_file" 2>/dev/null | awk '{print $1}')"
    test_pass "Database file exists ($db_size)"

    # Integrity check
    if command -v sqlite3 &>/dev/null; then
      local integrity
      integrity="$(sqlite3 "$db_file" "PRAGMA integrity_check;" 2>/dev/null || echo "error")"
      if [ "$integrity" = "ok" ]; then
        test_pass "Database integrity check passed"
      else
        test_fail "Database integrity check failed: $integrity"
      fi

      # Test read capability
      local table_count
      table_count="$(sqlite3 "$db_file" "SELECT count(*) FROM sqlite_master WHERE type='table';" 2>/dev/null || echo "error")"
      if [[ "$table_count" =~ ^[0-9]+$ ]] && [ "$table_count" -gt 0 ] 2>/dev/null; then
        test_pass "Database is readable ($table_count tables)"
      elif [ "$table_count" = "0" ]; then
        test_warn "Database has no tables (migrations may not have run)"
      else
        test_fail "Cannot read database: $table_count"
      fi

      # Test write capability (create and drop a temp table)
      if sqlite3 "$db_file" "CREATE TABLE IF NOT EXISTS _selftest_tmp (id INTEGER); DROP TABLE IF EXISTS _selftest_tmp;" 2>/dev/null; then
        test_pass "Database is writable"
      else
        test_fail "Database is not writable (check permissions)"
      fi
    else
      test_warn "sqlite3 not available, cannot verify database integrity"
    fi

    # Check WAL mode (recommended for concurrent access)
    if command -v sqlite3 &>/dev/null; then
      local journal_mode
      journal_mode="$(sqlite3 "$db_file" "PRAGMA journal_mode;" 2>/dev/null || echo "unknown")"
      if [ "$journal_mode" = "wal" ]; then
        test_pass "Database uses WAL mode (good for concurrent access)"
      elif [ "$journal_mode" != "unknown" ]; then
        info "Database journal mode: $journal_mode"
      fi
    fi
  else
    test_fail "Database file missing: $db_file"
  fi

  # Check backups
  local backup_dir="$HIVEKEEP_DATA_DIR/backups"
  if [ -d "$backup_dir" ]; then
    local backup_count
    backup_count="$(find "$backup_dir" -maxdepth 1 -name 'hivekeep-*.db' -type f 2>/dev/null | wc -l)"
    if [ "$backup_count" -gt 0 ] 2>/dev/null; then
      test_pass "Backups available: $backup_count"
    else
      test_warn "Backup directory exists but no backups found"
    fi
  else
    test_warn "No backup directory (run --backup to create one)"
  fi

  # ── 6. Service & HTTP ──
  header "Service & HTTP"

  # Read port from config
  local port="${HIVEKEEP_PORT:-3000}"
  if [ -f "$env_file" ]; then
    # shellcheck disable=SC1090
    . "$env_file" 2>/dev/null || true
    port="${PORT:-$port}"
  fi

  # Check if port is listening
  local port_listening=false
  if command -v ss &>/dev/null; then
    ss -tlnp 2>/dev/null | grep -q ":${port} " && port_listening=true
  elif command -v lsof &>/dev/null; then
    lsof -i ":${port}" -sTCP:LISTEN &>/dev/null && port_listening=true
  fi

  if [ "$port_listening" = true ]; then
    test_pass "Port $port is listening"
  else
    test_fail "Port $port is not listening (service may not be running)"
  fi

  # HTTP health check
  if command -v curl &>/dev/null; then
    local http_code body
    body="$(curl -s -w '\n%{http_code}' "http://localhost:${port}/" --max-time 5 2>/dev/null || echo -e "\n000")"
    http_code="$(echo "$body" | tail -1)"

    if [ "$http_code" != "000" ]; then
      test_pass "HTTP responding (status $http_code)"
    else
      test_fail "HTTP not responding on localhost:${port}"
    fi

    # Try the API health endpoint
    local api_code
    api_code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${port}/api/health" --max-time 5 2>/dev/null || echo "000")"
    if [ "$api_code" = "200" ]; then
      test_pass "API health endpoint responding (200)"
    elif [ "$api_code" != "000" ]; then
      test_warn "API health endpoint returned $api_code (expected 200)"
    else
      if [ "$port_listening" = true ]; then
        test_warn "API health endpoint not responding (server may still be starting)"
      fi
    fi

    # Check response time
    if [ "$port_listening" = true ]; then
      local time_total
      time_total="$(curl -s -o /dev/null -w '%{time_total}' "http://localhost:${port}/" --max-time 10 2>/dev/null || echo "0")"
      if [ -n "$time_total" ] && [ "$time_total" != "0" ]; then
        # Convert to ms (bash can't do float math, use awk)
        local time_ms
        time_ms="$(awk "BEGIN {printf \"%.0f\", $time_total * 1000}" 2>/dev/null || echo "?")"
        if [ "$time_ms" != "?" ] && [ "$time_ms" -lt 2000 ] 2>/dev/null; then
          test_pass "Response time: ${time_ms}ms"
        elif [ "$time_ms" != "?" ] && [ "$time_ms" -lt 5000 ] 2>/dev/null; then
          test_warn "Slow response time: ${time_ms}ms"
        elif [ "$time_ms" != "?" ]; then
          test_fail "Very slow response: ${time_ms}ms (possible issue)"
        fi
      fi
    fi
  else
    test_warn "curl not available, cannot test HTTP"
  fi

  # ── 7. Public URL & TLS ──
  local public_url=""
  if [ -f "$env_file" ]; then
    # shellcheck disable=SC1090
    public_url="$( ( . "$env_file" 2>/dev/null; echo "${PUBLIC_URL:-}" ) )"
  fi
  if [ -n "$public_url" ] && [ "$public_url" != "http://localhost:${port}" ]; then
    local url_host
    url_host="$(echo "$public_url" | sed -E 's|^https?://||; s|[:/].*||')"

    # Skip local/private IPs
    local is_local=false
    case "$url_host" in
      localhost|127.*|10.*|192.168.*) is_local=true ;;
      172.*)
        local second_octet
        second_octet="$(echo "$url_host" | cut -d. -f2)"
        [ -n "$second_octet" ] && [ "$second_octet" -ge 16 ] 2>/dev/null && [ "$second_octet" -le 31 ] 2>/dev/null && is_local=true
        ;;
    esac

    if [ "$is_local" = false ]; then
      header "Public URL & TLS"
      if command -v curl &>/dev/null; then
        local public_code
        public_code="$(curl -s -o /dev/null -w '%{http_code}' "$public_url" --max-time 8 2>/dev/null || echo "000")"
        if [ "$public_code" != "000" ]; then
          test_pass "Public URL reachable: $public_url (status $public_code)"
        else
          test_fail "Public URL not reachable: $public_url (webhooks will fail)"
        fi

        # TLS certificate check
        if [[ "$public_url" =~ ^https:// ]] && command -v openssl &>/dev/null; then
          local cert_expiry
          cert_expiry="$(echo | openssl s_client -servername "$url_host" -connect "$url_host:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | sed 's/notAfter=//')"
          if [ -n "$cert_expiry" ]; then
            local expiry_epoch now_epoch
            expiry_epoch="$(date -d "$cert_expiry" +%s 2>/dev/null || date -jf '%b %d %T %Y %Z' "$cert_expiry" +%s 2>/dev/null || echo "")"
            now_epoch="$(date +%s)"
            if [ -n "$expiry_epoch" ]; then
              local cert_days_left=$(( (expiry_epoch - now_epoch) / 86400 ))
              if [ "$cert_days_left" -lt 0 ] 2>/dev/null; then
                test_fail "TLS certificate EXPIRED"
              elif [ "$cert_days_left" -lt 7 ] 2>/dev/null; then
                test_warn "TLS certificate expires in ${cert_days_left} day(s)"
              elif [ "$cert_days_left" -lt 30 ] 2>/dev/null; then
                test_warn "TLS certificate expires in ${cert_days_left} days"
              else
                test_pass "TLS certificate valid (${cert_days_left} days remaining)"
              fi
            else
              test_warn "Could not parse TLS certificate expiry date"
            fi
          else
            test_warn "Could not retrieve TLS certificate from $url_host"
          fi
        fi
      fi
    fi
  fi

  # ── Summary ──
  echo ""
  echo -e "${BOLD}────────────────────────────────────────${NC}"
  local total=$((passed + failed + warned))
  echo -e "  ${GREEN}$passed passed${NC}  ${RED}$failed failed${NC}  ${YELLOW}$warned warnings${NC}  ($total tests)"
  echo ""

  if [ "$failed" -eq 0 ] && [ "$warned" -eq 0 ]; then
    echo -e "  ${GREEN}${BOLD}All tests passed! Your Hivekeep installation is healthy.${NC}"
  elif [ "$failed" -eq 0 ]; then
    echo -e "  ${GREEN}${BOLD}All critical tests passed.${NC} Check warnings above for potential improvements."
  else
    echo -e "  ${RED}${BOLD}$failed test(s) failed.${NC} See above for details."
    echo -e "  ${DIM}Run 'bash install.sh' to fix most issues.${NC}"
  fi
  echo ""

  exit "$( [ "$failed" -gt 0 ] && echo 1 || echo 0 )"
}

# ─── Cron (automatic updates) ─────────────────────────────────────────────────
# Usage: bash install.sh --cron [enable|disable|status]
# Sets up a system cron job (or launchd timer on macOS) that runs
# `install.sh --update -y -q` periodically. Defaults to weekly (Sunday 3AM).

HIVEKEEP_CRON_SCHEDULE="${HIVEKEEP_CRON_SCHEDULE:-0 3 * * 0}"  # Default: Sunday 3:00 AM
HIVEKEEP_CRON_TAG="# hivekeep-auto-update"

do_cron() {
  local subcmd="${1:-status}"

  # Minimal env setup
  OS="$(uname -s)"
  IS_ROOT=false
  [ "$(id -u)" -eq 0 ] && IS_ROOT=true
  if [ "$IS_ROOT" = true ]; then
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-/opt/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-/var/lib/hivekeep}"
  else
    HIVEKEEP_DIR="${HIVEKEEP_DIR:-$HOME/hivekeep}"
    HIVEKEEP_DATA_DIR="${HIVEKEEP_DATA_DIR:-$HOME/.local/share/hivekeep}"
  fi

  local install_sh="$HIVEKEEP_DIR/install.sh"

  if [ ! -f "$install_sh" ] && [ "$subcmd" != "status" ]; then
    error "Hivekeep not installed at $HIVEKEEP_DIR. Run the installer first: bash install.sh"
  fi

  # ── macOS: use launchd ──
  if [ "$OS" = "Darwin" ]; then
    local plist_dir="$HOME/Library/LaunchAgents"
    local plist_path="$plist_dir/io.hivekeep.auto-update.plist"
    local log_dir="$HOME/Library/Logs/hivekeep"

    case "$subcmd" in
      enable)
        mkdir -p "$plist_dir" "$log_dir"

        # Parse schedule for launchd (cron → Calendar dict is complex;
        # use StartInterval for simplicity: weekly = 604800 seconds)
        local interval=604800
        if [ "${HIVEKEEP_CRON_SCHEDULE}" != "0 3 * * 0" ]; then
          # If user customized the schedule, try to convert common patterns
          case "$HIVEKEEP_CRON_SCHEDULE" in
            *"* * *") # daily patterns
              interval=86400
              info "Detected daily schedule, using 24h interval"
              ;;
            *)
              info "Using default weekly interval (customize HIVEKEEP_CRON_SCHEDULE for crontab-based systems)"
              ;;
          esac
        fi

        # Unload existing if present
        [ -f "$plist_path" ] && launchctl unload "$plist_path" 2>/dev/null || true

        cat > "$plist_path" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.hivekeep.auto-update</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$install_sh</string>
    <string>--update</string>
    <string>-y</string>
    <string>-q</string>
  </array>

  <key>StartInterval</key>
  <integer>$interval</integer>

  <key>StandardOutPath</key>
  <string>$log_dir/auto-update.log</string>

  <key>StandardErrorPath</key>
  <string>$log_dir/auto-update-error.log</string>

  <key>Nice</key>
  <integer>10</integer>
</dict>
</plist>
PLIST

        launchctl load "$plist_path"
        success "Automatic updates enabled (launchd, every $((interval / 3600))h)"
        info "Log: $log_dir/auto-update.log"
        ;;

      disable)
        if [ -f "$plist_path" ]; then
          launchctl unload "$plist_path" 2>/dev/null || true
          rm -f "$plist_path"
          success "Automatic updates disabled"
        else
          info "Automatic updates are not enabled"
        fi
        ;;

      status)
        echo ""
        echo -e "${BOLD}Auto-Update Status${NC}"
        echo ""
        if [ -f "$plist_path" ]; then
          if launchctl list 2>/dev/null | grep -q io.hivekeep.auto-update; then
            echo -e "  ${GREEN}●${NC} Enabled (launchd timer loaded)"
          else
            echo -e "  ${YELLOW}●${NC} Plist exists but timer not loaded"
          fi
          if [ -f "$log_dir/auto-update.log" ]; then
            local last_run
            last_run="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$log_dir/auto-update.log" 2>/dev/null || echo "unknown")"
            echo -e "  ${CYAN}Last activity:${NC} $last_run"
            echo -e "  ${CYAN}Log:${NC} $log_dir/auto-update.log"
          fi
        else
          echo -e "  ${DIM}○${NC} Not enabled"
          echo ""
          echo -e "  ${DIM}Enable with: bash install.sh --cron enable${NC}"
        fi
        echo ""
        ;;

      *)
        error "Unknown cron subcommand: $subcmd (use enable, disable, or status)"
        ;;
    esac
    return
  fi

  # ── Linux: use crontab ──
  if ! command -v crontab &>/dev/null; then
    error "crontab command not found. Install cron (e.g., apt install cron) or set up the update job manually."
  fi

  local cron_cmd="$HIVEKEEP_CRON_SCHEDULE bash $install_sh --update -y -q >> $HIVEKEEP_DATA_DIR/auto-update.log 2>&1 $HIVEKEEP_CRON_TAG"

  case "$subcmd" in
    enable)
      mkdir -p "$HIVEKEEP_DATA_DIR"

      # Remove existing hivekeep cron entry, then add new one
      local existing_crontab
      existing_crontab="$(crontab -l 2>/dev/null || echo "")"

      # Filter out old hivekeep-auto-update lines
      local new_crontab
      new_crontab="$(echo "$existing_crontab" | grep -v "$HIVEKEEP_CRON_TAG" || true)"

      # Append new entry
      if [ -n "$new_crontab" ]; then
        new_crontab="$new_crontab
$cron_cmd"
      else
        new_crontab="$cron_cmd"
      fi

      echo "$new_crontab" | crontab -
      success "Automatic updates enabled"
      echo ""
      echo -e "  ${CYAN}Schedule:${NC}  $HIVEKEEP_CRON_SCHEDULE (default: weekly, Sunday 3 AM)"
      echo -e "  ${CYAN}Command:${NC}   bash $install_sh --update -y -q"
      echo -e "  ${CYAN}Log:${NC}       $HIVEKEEP_DATA_DIR/auto-update.log"
      echo ""
      echo -e "  ${DIM}Customize schedule: HIVEKEEP_CRON_SCHEDULE='0 3 * * *' bash install.sh --cron enable${NC}"
      echo -e "  ${DIM}Daily at 3 AM:      HIVEKEEP_CRON_SCHEDULE='0 3 * * *'${NC}"
      echo -e "  ${DIM}Every 6 hours:      HIVEKEEP_CRON_SCHEDULE='0 */6 * * *'${NC}"
      echo -e "  ${DIM}Disable:            bash install.sh --cron disable${NC}"
      ;;

    disable)
      local existing_crontab
      existing_crontab="$(crontab -l 2>/dev/null || echo "")"

      if echo "$existing_crontab" | grep -q "$HIVEKEEP_CRON_TAG"; then
        local new_crontab
        new_crontab="$(echo "$existing_crontab" | grep -v "$HIVEKEEP_CRON_TAG")"
        if [ -n "$new_crontab" ]; then
          echo "$new_crontab" | crontab -
        else
          crontab -r 2>/dev/null || echo "" | crontab -
        fi
        success "Automatic updates disabled (cron job removed)"
      else
        info "Automatic updates are not enabled"
      fi
      ;;

    status)
      echo ""
      echo -e "${BOLD}Auto-Update Status${NC}"
      echo ""

      local existing_crontab
      existing_crontab="$(crontab -l 2>/dev/null || echo "")"

      if echo "$existing_crontab" | grep -q "$HIVEKEEP_CRON_TAG"; then
        local cron_line
        cron_line="$(echo "$existing_crontab" | grep "$HIVEKEEP_CRON_TAG")"
        local schedule
        schedule="$(echo "$cron_line" | awk '{print $1, $2, $3, $4, $5}')"

        echo -e "  ${GREEN}●${NC} Enabled"
        echo -e "  ${CYAN}Schedule:${NC} $schedule"

        # Parse cron to human-readable
        case "$schedule" in
          "0 3 * * 0")  echo -e "  ${DIM}(Weekly, Sunday at 3:00 AM)${NC}" ;;
          "0 3 * * *")  echo -e "  ${DIM}(Daily at 3:00 AM)${NC}" ;;
          "0 */6 * * *") echo -e "  ${DIM}(Every 6 hours)${NC}" ;;
          "0 */12 * * *") echo -e "  ${DIM}(Every 12 hours)${NC}" ;;
        esac

        # Show last update log
        local log_file="$HIVEKEEP_DATA_DIR/auto-update.log"
        if [ -f "$log_file" ]; then
          local log_size
          log_size="$(du -h "$log_file" 2>/dev/null | awk '{print $1}')"
          local last_mod
          last_mod="$(date -r "$log_file" '+%Y-%m-%d %H:%M' 2>/dev/null || stat -c '%y' "$log_file" 2>/dev/null | cut -d. -f1 || echo "unknown")"
          echo -e "  ${CYAN}Last run:${NC} $last_mod"
          echo -e "  ${CYAN}Log:${NC} $log_file ($log_size)"

          # Show last few lines of the log
          echo ""
          echo -e "  ${BOLD}Last update output:${NC}"
          tail -5 "$log_file" 2>/dev/null | while IFS= read -r line; do
            echo -e "  ${DIM}  $line${NC}"
          done
        else
          echo -e "  ${CYAN}Log:${NC} $log_file (no runs yet)"
        fi
      else
        echo -e "  ${DIM}○${NC} Not enabled"
        echo ""
        echo -e "  ${DIM}Enable with: bash install.sh --cron enable${NC}"
      fi
      echo ""
      ;;

    *)
      error "Unknown cron subcommand: $subcmd\n\n  Usage: bash install.sh --cron [enable|disable|status]\n\n  ${BOLD}enable${NC}   Set up automatic updates (default: weekly, Sunday 3 AM)\n  ${BOLD}disable${NC}  Remove the automatic update job\n  ${BOLD}status${NC}   Show current auto-update configuration"
      ;;
  esac
}

# ─── Shell completions ────────────────────────────────────────────────────────
generate_completions() {
  local shell="${1:-bash}"

  case "$shell" in
    bash)
      cat << 'BASH_COMP'
# Hivekeep bash completions
# Add to ~/.bashrc:  eval "$(bash install.sh --completions bash)"
# Or:                bash install.sh --completions bash > /etc/bash_completion.d/hivekeep

_hivekeep_completions() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  local prev="${COMP_WORDS[COMP_CWORD-1]}"

  local commands="--help --update --channel --docker --dry-run --reset --uninstall
    --start --stop --restart --logs --status --health --test --doctor
    --config --env --backup --restore --version --changelog
    --cron --completions --yes --quiet --no-color"

  # Sub-options for specific commands
  case "$prev" in
    --logs|logs)
      COMPREPLY=( $(compgen -W "--grep --since" -- "$cur") )
      return
      ;;
    --cron|cron)
      COMPREPLY=( $(compgen -W "enable disable status" -- "$cur") )
      return
      ;;
    --completions|completions)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
      return
      ;;
    --backup|backup|--restore|restore)
      COMPREPLY=( $(compgen -f -- "$cur") )
      return
      ;;
    --grep)
      return  # free-form pattern
      ;;
    --since)
      COMPREPLY=( $(compgen -W "today yesterday '1 hour ago' '30 min ago'" -- "$cur") )
      return
      ;;
  esac

  COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
}

# Support both "hivekeep" (the generated script) and "install.sh"
complete -F _hivekeep_completions hivekeep
complete -F _hivekeep_completions install.sh
BASH_COMP
      ;;

    zsh)
      cat << 'ZSH_COMP'
# Hivekeep zsh completions
# Add to ~/.zshrc:  eval "$(bash install.sh --completions zsh)"
# Or save to a file in your $fpath

_hivekeep() {
  local -a commands=(
    '--help:Show help message'
    '--update:Check for updates and apply'
    '--channel:Update channel (stable or edge)'
    '--docker:Docker Compose setup'
    '--dry-run:Preview without making changes'
    '--reset:Fix broken install, keep data'
    '--uninstall:Remove Hivekeep'
    '--start:Start the service'
    '--stop:Stop the service'
    '--restart:Restart the service'
    '--logs:Show logs (follow or last N lines)'
    '--status:Check installation health'
    '--health:Quick health check for monitoring (exit 0/1)'
    '--test:Run self-tests'
    '--doctor:Generate diagnostic report'
    '--config:Re-run configuration wizard'
    '--env:Show or set env variables'
    '--backup:Back up database and config'
    '--restore:Restore from a backup'
    '--version:Show installed version'
    '--changelog:Show changes since installed version'
    '--cron:Manage automatic update scheduling'
    '--completions:Generate shell completions'
    '--yes:Auto-confirm all prompts'
    '--quiet:Suppress non-essential output'
    '--no-color:Disable colored output'
  )

  _describe 'command' commands
}

compdef _hivekeep hivekeep
compdef _hivekeep install.sh
ZSH_COMP
      ;;

    fish)
      cat << 'FISH_COMP'
# Hivekeep fish completions
# Save to: ~/.config/fish/completions/hivekeep.fish

# Clear existing
complete -c hivekeep -e

complete -c hivekeep -l help -d 'Show help message'
complete -c hivekeep -l update -d 'Check for updates and apply'
complete -c hivekeep -l docker -d 'Docker Compose setup'
complete -c hivekeep -l dry-run -d 'Preview without making changes'
complete -c hivekeep -l reset -d 'Fix broken install, keep data'
complete -c hivekeep -l uninstall -d 'Remove Hivekeep'
complete -c hivekeep -l start -d 'Start the service'
complete -c hivekeep -l stop -d 'Stop the service'
complete -c hivekeep -l restart -d 'Restart the service'
complete -c hivekeep -l logs -d 'Show logs'
complete -c hivekeep -l status -d 'Check installation health'
complete -c hivekeep -l health -d 'Quick health check for monitoring'
complete -c hivekeep -l test -d 'Run self-tests'
complete -c hivekeep -l doctor -d 'Generate diagnostic report'
complete -c hivekeep -l config -d 'Re-run configuration wizard'
complete -c hivekeep -l env -d 'Show or set env variables'
complete -c hivekeep -l backup -d 'Back up database and config'
complete -c hivekeep -l restore -d 'Restore from a backup'
complete -c hivekeep -l version -d 'Show installed version'
complete -c hivekeep -l changelog -d 'Show changes'
complete -c hivekeep -l cron -d 'Manage automatic update scheduling'
complete -c hivekeep -l completions -d 'Generate shell completions'
complete -c hivekeep -l yes -d 'Auto-confirm all prompts'
complete -c hivekeep -l quiet -d 'Suppress non-essential output'
complete -c hivekeep -l no-color -d 'Disable colored output'
FISH_COMP
      ;;

    *)
      echo "Unknown shell: $shell" >&2
      echo "Supported: bash, zsh, fish" >&2
      exit 1
      ;;
  esac
}

# ─── Main ────────────────────────────────────────────────────────────────────
main() {
  # Pre-pass: modifier flags must apply regardless of their position on the
  # command line (commands like --update exit from inside the main loop, so
  # `install.sh --update -y` would otherwise never see -y).
  local _prev_arg=""
  for arg in "$@"; do
    case "$arg" in
      --quiet|-q)
        HIVEKEEP_QUIET=true
        HIVEKEEP_NO_PROMPT=true
        ;;
      --yes|-y)
        HIVEKEEP_YES=true
        HIVEKEEP_NO_PROMPT=true
        ;;
      --no-color)
        NO_COLOR=1
        setup_colors
        ;;
      --channel=*)
        HIVEKEEP_CHANNEL="${arg#--channel=}"
        ;;
      *)
        if [ "$_prev_arg" = "--channel" ]; then
          HIVEKEEP_CHANNEL="$arg"
        fi
        ;;
    esac
    _prev_arg="$arg"
  done
  if [ -n "$HIVEKEEP_CHANNEL" ] && [ "$HIVEKEEP_CHANNEL" != "stable" ] && [ "$HIVEKEEP_CHANNEL" != "edge" ]; then
    error "Invalid --channel '$HIVEKEEP_CHANNEL' (expected: stable or edge)"
  fi

  # Handle flags
  for arg in "$@"; do
    case "$arg" in
      --help|-h|help)
        trap - INT TERM
        show_help
        exit 0
        ;;
      --uninstall|uninstall)
        trap - INT TERM
        acquire_lock
        uninstall
        release_lock
        exit 0
        ;;
      --start|start)
        trap - INT TERM
        do_start
        exit 0
        ;;
      --stop|stop)
        trap - INT TERM
        do_stop
        exit 0
        ;;
      --restart|restart)
        trap - INT TERM
        do_restart
        exit 0
        ;;
      --status|status)
        trap - INT TERM
        check_status
        exit 0
        ;;
      --health|health)
        trap - INT TERM
        do_health "$@"
        exit 0
        ;;
      --test|test)
        trap - INT TERM
        do_test
        exit 0
        ;;
      --doctor|doctor)
        trap - INT TERM
        do_doctor
        exit 0
        ;;
      --logs|logs)
        trap - INT TERM
        # Parse --logs sub-options: [N] [--grep PATTERN] [--since TIME]
        local found_logs=false
        for a in "$@"; do
          if [ "$found_logs" = true ]; then
            case "$a" in
              --grep)  : ;;  # next arg is the pattern
              --since) : ;;  # next arg is the time
              --*)     break ;;
              *)
                # Could be N (number), grep pattern, or since value
                if [[ "$a" =~ ^[0-9]+$ ]]; then
                  LOGS_LINES="$a"
                fi
                ;;
            esac
          fi
          [[ "$a" = "--logs" || "$a" = "logs" ]] && found_logs=true
        done
        # Extract --grep and --since values
        local prev=""
        for a in "$@"; do
          case "$prev" in
            --grep)  LOGS_GREP="$a" ;;
            --since) LOGS_SINCE="$a" ;;
          esac
          prev="$a"
        done
        show_logs
        exit 0
        ;;
      --backup|backup)
        trap - INT TERM
        # Extract the argument after --backup/backup (skip flags like --no-color)
        local backup_path=""
        local found_flag=false
        for a in "$@"; do
          if [ "$found_flag" = true ]; then
            [[ "$a" != --* ]] && backup_path="$a" && break
          fi
          [[ "$a" = "--backup" || "$a" = "backup" ]] && found_flag=true
        done
        do_backup "$backup_path"
        exit 0
        ;;
      --restore|restore)
        trap - INT TERM
        local restore_path=""
        local found_flag=false
        for a in "$@"; do
          if [ "$found_flag" = true ]; then
            [[ "$a" != --* ]] && restore_path="$a" && break
          fi
          [[ "$a" = "--restore" || "$a" = "restore" ]] && found_flag=true
        done
        do_restore "$restore_path"
        exit 0
        ;;
      --env)
        trap - INT TERM
        # Find the KEY=VALUE or KEY- argument after --env (optional)
        local env_val=""
        local found_env=false
        for a in "$@"; do
          if [ "$found_env" = true ]; then
            [[ "$a" != --* ]] && env_val="$a" && break
          fi
          [ "$a" = "--env" ] && found_env=true
        done
        do_env "$env_val"
        exit 0
        ;;
      --config|config)
        trap - INT TERM
        do_config
        exit 0
        ;;
      --reset|reset)
        trap - INT TERM
        acquire_lock
        do_reset
        release_lock
        exit 0
        ;;
      --update|update)
        trap - INT TERM
        acquire_lock
        do_update
        release_lock
        exit 0
        ;;
      --version|-v|version)
        trap - INT TERM
        show_version
        exit 0
        ;;
      --changelog|changelog)
        trap - INT TERM
        show_changelog
        exit 0
        ;;
      --cron|cron)
        trap - INT TERM
        local cron_subcmd="status"
        local found_cron=false
        for a in "$@"; do
          if [ "$found_cron" = true ]; then
            [[ "$a" != --* ]] && cron_subcmd="$a" && break
          fi
          [[ "$a" = "--cron" || "$a" = "cron" ]] && found_cron=true
        done
        do_cron "$cron_subcmd"
        exit 0
        ;;
      --completions|completions)
        trap - INT TERM
        # Find the shell argument after --completions
        local comp_shell="bash"
        local found_comp=false
        for a in "$@"; do
          if [ "$found_comp" = true ]; then
            [[ "$a" != --* ]] && comp_shell="$a" && break
          fi
          [[ "$a" = "--completions" || "$a" = "completions" ]] && found_comp=true
        done
        generate_completions "$comp_shell"
        exit 0
        ;;
      --dry-run|dry-run)
        HIVEKEEP_DRY_RUN=true
        ;;
      --docker|docker)
        trap - INT TERM
        acquire_lock
        docker_install
        release_lock
        exit 0
        ;;
      --quiet|-q)
        HIVEKEEP_QUIET=true
        HIVEKEEP_NO_PROMPT=true
        ;;
      --yes|-y)
        HIVEKEEP_YES=true
        HIVEKEEP_NO_PROMPT=true
        ;;
      --no-color)
        NO_COLOR=1
        setup_colors
        ;;
    esac
  done

  if [ "$HIVEKEEP_DRY_RUN" = true ]; then
    trap - INT TERM
    dry_run
    exit 0
  fi

  # Prevent concurrent installer runs
  acquire_lock

  # Enable rollback trap for actual install/update
  trap rollback EXIT

  if [ "$HIVEKEEP_QUIET" != true ]; then
    echo ""
    echo -e "${BOLD}Hivekeep Installer${NC}"
    echo -e "Self-hosted AI agent platform"
    echo -e "https://github.com/MarlBurroW/hivekeep"
    echo ""
  fi

  # Check if the installer script itself is outdated (local runs only)
  check_installer_update "$@"

  start_timer

  STEP_TOTAL=9
  STEP_CURRENT=0

  detect_os
  check_prerequisites
  preflight_checks
  ensure_bun
  install_or_update
  step "Configuring"
  configure
  build_hivekeep
  setup_database
  setup_system_user
  resolve_bun_path
  create_service
  verify_running

  # Disable rollback trap — we made it!
  trap - EXIT
  ROLLBACK_COMMIT=""

  release_lock
  print_summary
}

if [ -z "${BASH_SOURCE[0]:-}" ] || [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
