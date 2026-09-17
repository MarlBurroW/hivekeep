#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "This test must run as root." >&2
  exit 1
fi

TEST_ROOT="$(mktemp -d /tmp/hivekeep-bun-path-test.XXXXXX)"
TEST_USER="hk-bun-$$-$RANDOM"
PRIVATE_DIR="$(mktemp -d /root/hivekeep-bun-path-test.XXXXXX)"
ORIGINAL_PATH="$PATH"
USERDEL_BIN="$(command -v userdel)"
LOGINCTL_BIN="$(command -v loginctl 2>/dev/null || true)"
USER_CREATED=false
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
  local cleanup_status=$?
  if [ "$USER_CREATED" = true ]; then
    if [ -n "$LOGINCTL_BIN" ]; then
      "$LOGINCTL_BIN" terminate-user "$TEST_USER" 2>/dev/null || true
    fi
    local attempt userdel_error=""
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
      if userdel_error="$("$USERDEL_BIN" "$TEST_USER" 2>&1)"; then
        break
      fi
      /bin/sleep 1
    done
    if id "$TEST_USER" &>/dev/null; then
      echo "Failed to remove test user $TEST_USER: $userdel_error" >&2
      cleanup_status=1
    fi
  fi
  rm -rf "$PRIVATE_DIR" "$TEST_ROOT"
  trap - EXIT
  exit "$cleanup_status"
}
trap cleanup EXIT

chmod 0755 "$TEST_ROOT"
useradd --system --no-create-home --shell /usr/sbin/nologin "$TEST_USER"
USER_CREATED=true

# shellcheck source=../install.sh
source "$SCRIPT_DIR/../install.sh"
PRODUCTION_SYSTEM_BUN_INSTALL="$HIVEKEEP_SYSTEM_BUN_INSTALL"
PRODUCTION_SYSTEM_CONFIG_DIR="$HIVEKEEP_SYSTEM_CONFIG_DIR"
HIVEKEEP_SYSTEM_BUN_INSTALL="$TEST_ROOT/managed-default"
HIVEKEEP_SYSTEM_CONFIG_DIR="$TEST_ROOT/system-config"

pass_count=0

pass() {
  pass_count=$((pass_count + 1))
  echo "PASS: $1"
}

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_equal() {
  local expected="$1" actual="$2" message="$3"
  [ "$expected" = "$actual" ] || fail "$message (expected '$expected', got '$actual')"
}

make_bun() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  printf '%s\n' '#!/bin/sh' 'printf "1.3.14\n"' > "$path"
  chmod 0755 "$path"
}

test_stdin_entrypoint() {
  local help_output
  help_output="$(bash -s -- --help < "$SCRIPT_DIR/../install.sh")"
  grep -q '^USAGE$' <<< "$help_output" || fail "stdin installer entrypoint did not run main"
}
test_stdin_entrypoint
pass "Curl-to-bash stdin entrypoint"

test_environment_defaults() (
  assert_equal "/usr/local/lib/hivekeep/bun" "$PRODUCTION_SYSTEM_BUN_INSTALL" "production managed Bun path"
  assert_equal "/etc/hivekeep" "$PRODUCTION_SYSTEM_CONFIG_DIR" "production system config path"

  IS_ROOT=true
  OS=Linux
  PATH="$ORIGINAL_PATH"
  unset BUN_INSTALL
  configure_bun_environment
  assert_equal "$HIVEKEEP_SYSTEM_BUN_INSTALL" "$BUN_INSTALL" "root Linux default"

  IS_ROOT=false
  HOME="$TEST_ROOT/non-root-home"
  PATH="$ORIGINAL_PATH"
  unset BUN_INSTALL
  configure_bun_environment
  assert_equal "$HOME/.bun" "$BUN_INSTALL" "non-root default"

  IS_ROOT=true
  OS=Linux
  PATH="$ORIGINAL_PATH"
  BUN_INSTALL="$TEST_ROOT/explicit-bun"
  configure_bun_environment
  assert_equal "$TEST_ROOT/explicit-bun" "$BUN_INSTALL" "explicit BUN_INSTALL"
)
test_environment_defaults
pass "Bun environment defaults"

test_systemd_escaping() (
  assert_equal '/tmp/$bun%%path' "$(escape_systemd_environment_value '/tmp/$bun%path')" \
    "systemd Environment value escaping"
  assert_equal '/tmp/$bun%%path' "$(escape_systemd_exec_token '/tmp/$bun%path')" \
    "systemd ExecStart token escaping"
)
test_systemd_escaping
pass "Systemd service values escape ExecStart expansion separately"

test_systemd_user_unit() (
  local unit_home="$TEST_ROOT/systemd-user-home"
  local user_bun="$TEST_ROOT/user "'$cash'"/bin/bun"
  local escaped_bun
  make_bun "$user_bun"
  mkdir -p "$unit_home/app" "$unit_home/data"

  IS_ROOT=false
  IS_UPDATE=false
  HOME="$unit_home"
  HIVEKEEP_DIR="$unit_home/app"
  HIVEKEEP_DATA_DIR="$unit_home/data"
  BUN_BIN="$user_bun"
  systemctl() { return 0; }
  loginctl() { return 0; }
  create_systemd_user_service &>/dev/null

  escaped_bun="$(escape_systemd_exec_token "$BUN_BIN")"
  grep -Fq "ExecStart=\"$escaped_bun\" src/server/index.ts" "$UNIT_FILE" || \
    fail "generated systemd user unit lost the literal Bun path"
  if command -v systemd-analyze &>/dev/null; then
    systemd-analyze verify "$UNIT_FILE" || fail "generated systemd user unit failed verification"
  fi
)
test_systemd_user_unit
pass "Generated systemd user unit preserves and validates the Bun path"

test_systemd_system_unit() (
  local system_bun="$TEST_ROOT/system%runtime/bin/bun"
  local system_unit="$TEST_ROOT/system-hivekeep.service"
  local systemctl_log="$TEST_ROOT/systemctl-calls"
  local escaped_bun
  local escaped_service_path
  local -a systemctl_calls
  make_bun "$system_bun"
  mkdir -p "$TEST_ROOT/system-app" "$TEST_ROOT/system-data"

  IS_ROOT=true
  IS_UPDATE=false
  HIVEKEEP_USER="$TEST_USER"
  HIVEKEEP_DIR="$TEST_ROOT/system-app"
  HIVEKEEP_DATA_DIR="$TEST_ROOT/system-data"
  HIVEKEEP_SYSTEMD_UNIT="$system_unit"
  BUN_BIN="$system_bun"
  systemctl() { printf '%s\n' "$*" >> "$systemctl_log"; }
  create_systemd_system_service &>/dev/null

  grep -Fq "User=$TEST_USER" "$UNIT_FILE" || fail "systemd system unit lost its service user"
  grep -Fq "Group=$TEST_USER" "$UNIT_FILE" || fail "systemd system unit lost its service group"
  escaped_bun="$(escape_systemd_exec_token "$system_bun")"
  grep -Fq "ExecStart=\"$escaped_bun\" src/server/index.ts" "$UNIT_FILE" || \
    fail "systemd system unit lost the verified Bun path"
  escaped_service_path="$(escape_systemd_environment_value "$(dirname "$system_bun"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")"
  grep -Fq "Environment=\"PATH=$escaped_service_path\"" "$UNIT_FILE" || \
    fail "systemd system unit lost the Bun service PATH"
  if command -v systemd-analyze &>/dev/null; then
    systemd-analyze verify "$UNIT_FILE" || fail "generated systemd system unit failed verification"
  fi
  mapfile -t systemctl_calls < "$systemctl_log"
  assert_equal "daemon-reload" "${systemctl_calls[0]}" "systemd reload order"
  assert_equal "enable hivekeep" "${systemctl_calls[1]}" "systemd enable order"
  assert_equal "reset-failed hivekeep" "${systemctl_calls[2]}" "systemd start-limit reset order"
  assert_equal "start hivekeep" "${systemctl_calls[3]}" "systemd start order"
)
test_systemd_system_unit
pass "Generated systemd system unit uses the service user and verified Bun path"

test_persisted_bun_path() (
  local persisted_bun="$TEST_ROOT/persisted runtime/bun"
  local stat_only_path="$TEST_ROOT/stat-only"
  local service_uid
  make_bun "$persisted_bun"
  chown "$TEST_USER:$TEST_USER" "$persisted_bun"
  mkdir -p "$stat_only_path"
  ln -s /usr/bin/stat "$stat_only_path/stat"

  IS_ROOT=true
  OS=Linux
  INIT_SYSTEM=systemd
  HIVEKEEP_USER="$TEST_USER"
  HIVEKEEP_DATA_DIR="$TEST_ROOT/persisted-data"
  HIVEKEEP_SYSTEM_CONFIG_DIR="$TEST_ROOT/persisted-config"
  BUN_BIN="$persisted_bun"
  persist_bun_path

  assert_equal root "$(stat -c '%U' "$HIVEKEEP_SYSTEM_CONFIG_DIR/bun.path")" \
    "persisted service Bun path owner"
  export HIVEKEEP_REVIEW_SECRET=visible-to-root
  if run_configured_bun /usr/bin/env | grep -q HIVEKEEP_REVIEW_SECRET; then
    fail "root environment leaked into service-user diagnostics"
  fi
  service_uid="$(run_configured_bun /usr/bin/id -u)"
  assert_equal "$(/usr/bin/id -u "$TEST_USER")" "$service_uid" "root diagnostic execution user"
  PATH="$stat_only_path"
  assert_equal "$persisted_bun" "$(configured_bun_path)" "persisted service Bun path"

  PATH="$ORIGINAL_PATH"
  rm -f "$persisted_bun"
  PATH="$stat_only_path"
  if configured_bun_path &>/dev/null; then
    fail "root diagnostics replaced a stale configured Bun path with PATH discovery"
  fi

  PATH="$ORIGINAL_PATH"
  make_bun "$persisted_bun"
  chown "$TEST_USER:$TEST_USER" "$persisted_bun"
  chown "$TEST_USER:$TEST_USER" "$HIVEKEEP_SYSTEM_CONFIG_DIR/bun.path"
  PATH="$stat_only_path"
  if configured_bun_path &>/dev/null; then
    fail "root diagnostics trusted service-owned Bun metadata"
  fi
)
test_persisted_bun_path
pass "Root diagnostics trust root-owned metadata and drop service privileges"

test_accessible_system_bun() (
  local selected_dir="$TEST_ROOT/accessible/bin"
  local selected_bun="$selected_dir/bun"
  local before_hash after_hash
  install -d -m 0755 "$selected_dir"
  make_bun "$selected_bun"
  before_hash="$(sha256sum "$selected_bun" | awk '{print $1}')"

  IS_ROOT=true
  OS=Linux
  INIT_SYSTEM=systemd
  HIVEKEEP_USER="$TEST_USER"
  HIVEKEEP_SYSTEM_BUN_INSTALL="$TEST_ROOT/managed-accessible"
  BUN_INSTALL="$TEST_ROOT/accessible"
  PATH="$selected_dir:$ORIGINAL_PATH"
  resolve_bun_path

  after_hash="$(sha256sum "$selected_bun" | awk '{print $1}')"
  assert_equal "$before_hash" "$after_hash" "accessible Bun checksum"
  [ ! -L "$selected_bun" ] || fail "accessible Bun became a symlink"
  assert_equal "$selected_bun" "$BUN_BIN" "accessible Bun path"
)
test_accessible_system_bun
pass "Accessible system Bun remains unchanged"

test_legacy_private_bun() (
  local private_bun="$PRIVATE_DIR/legacy/bin/bun"
  local legacy_dir="$TEST_ROOT/legacy-link"
  local legacy_link="$legacy_dir/bun"
  local original_target

  mkdir -p "$(dirname "$private_bun")" "$legacy_dir"
  chmod 0700 "$PRIVATE_DIR" "$(dirname "$PRIVATE_DIR/legacy")" 2>/dev/null || true
  make_bun "$private_bun"
  chmod 0700 "$PRIVATE_DIR"
  chmod 0755 "$legacy_dir"
  ln -s "$private_bun" "$legacy_link"
  original_target="$(readlink "$legacy_link")"

  IS_ROOT=true
  OS=Linux
  INIT_SYSTEM=systemd
  HIVEKEEP_USER="$TEST_USER"
  HIVEKEEP_SYSTEM_BUN_INSTALL="$TEST_ROOT/managed-legacy"
  BUN_INSTALL=""
  PATH="$legacy_dir:$ORIGINAL_PATH"
  umask 077

  bun_runs_as_service_user "$legacy_link" && fail "legacy private Bun unexpectedly executed"
  resolve_bun_path

  assert_equal "$HIVEKEEP_SYSTEM_BUN_INSTALL/bin/bun" "$BUN_BIN" "managed legacy Bun path"
  assert_equal "$original_target" "$(readlink "$legacy_link")" "legacy symlink preservation"
  bun_runs_as_service_user "$BUN_BIN" || fail "managed Bun did not execute as service user"
  assert_equal "755" "$(stat -c '%a' "$(dirname "$HIVEKEEP_SYSTEM_BUN_INSTALL")")" "managed parent mode"
  assert_equal "755" "$(stat -c '%a' "$HIVEKEEP_SYSTEM_BUN_INSTALL")" "managed directory mode"
  assert_equal "755" "$(stat -c '%a' "$HIVEKEEP_SYSTEM_BUN_INSTALL/bin")" "managed bin mode"
  assert_equal "755" "$(stat -c '%a' "$BUN_BIN")" "managed Bun mode"

  local service_path
  service_path="$(dirname "$BUN_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  run_as_service_user env "PATH=$service_path" bun --version &>/dev/null || \
    fail "bare bun was unavailable with the service PATH"
)
test_legacy_private_bun
pass "Legacy private Bun migrates without changing its symlink"

test_legacy_repair_dispatch() (
  local private_bun="$PRIVATE_DIR/repair/bin/bun"
  local legacy_link="$TEST_ROOT/repair-link/bun"
  local unit_file="$TEST_ROOT/hivekeep.service"
  mkdir -p "$(dirname "$private_bun")" "$(dirname "$legacy_link")" "$TEST_ROOT/repair-data"
  make_bun "$private_bun"
  chmod 0700 "$PRIVATE_DIR"
  ln -s "$private_bun" "$legacy_link"
  printf 'ExecStart=%s src/server/index.ts\n' "$legacy_link" > "$unit_file"

  HIVEKEEP_USER="$TEST_USER"
  HIVEKEEP_SYSTEMD_UNIT="$unit_file"
  HIVEKEEP_LEGACY_BUN_LINK="$legacy_link"
  HIVEKEEP_LEGACY_BUN_ROOT="$PRIVATE_DIR"
  legacy_system_bun_service_needs_repair || fail "legacy detector missed the root-only service path"

  local setup_called=false service_called=false
  HIVEKEEP_DATA_DIR="$TEST_ROOT/repair-data"
  detect_os() { OS=Linux; INIT_SYSTEM=systemd; }
  configure_bun_environment() { :; }
  setup_system_user() { setup_called=true; }
  resolve_bun_path() { BUN_BIN="$TEST_ROOT/repaired-bun"; }
  create_systemd_system_service() { service_called=true; }
  verify_running() { HIVEKEEP_HEALTHY=true; }
  systemctl() {
    case "$1" in
      is-active) return 0 ;;
      show)
        case "$*" in
          *MainPID*) echo 123 ;;
          *ExecMainStatus*) echo 0 ;;
        esac
        ;;
    esac
  }

  repair_legacy_system_bun_service &>/dev/null
  [ "$setup_called" = true ] || fail "legacy repair skipped service-user setup"
  [ "$service_called" = true ] || fail "legacy repair skipped service recreation"
)
test_legacy_repair_dispatch
pass "Legacy detector and repair dispatch"

test_explicit_inaccessible_install() (
  local private_install="$PRIVATE_DIR/explicit"
  local private_bun="$private_install/bin/bun"
  mkdir -p "$(dirname "$private_bun")"
  make_bun "$private_bun"
  chmod 0700 "$PRIVATE_DIR"

  IS_ROOT=true
  OS=Linux
  INIT_SYSTEM=systemd
  HIVEKEEP_USER="$TEST_USER"
  HIVEKEEP_SYSTEM_BUN_INSTALL="$TEST_ROOT/managed-explicit"
  BUN_INSTALL="$private_install"
  PATH="$private_install/bin:$ORIGINAL_PATH"
  resolve_bun_path

  assert_equal "$private_install" "$BUN_INSTALL" "explicit BUN_INSTALL preservation"
  assert_equal "$HIVEKEEP_SYSTEM_BUN_INSTALL/bin/bun" "$BUN_BIN" "explicit fallback path"
  bun_runs_as_service_user "$BUN_BIN" || fail "explicit fallback did not execute"
)
test_explicit_inaccessible_install
pass "Inaccessible explicit BUN_INSTALL uses the managed fallback"

test_su_fallback() (
  local fallback_path="$TEST_ROOT/su-fallback-path"
  local selected_bun="$TEST_ROOT/su-fallback-bun"
  local service_environment
  install -d -m 0755 "$fallback_path"
  ln -s "$(command -v su)" "$fallback_path/su"
  ln -s "$(command -v sh)" "$fallback_path/sh"
  ln -s "$(command -v env)" "$fallback_path/env"
  make_bun "$selected_bun"

  HIVEKEEP_USER="$TEST_USER"
  HIVEKEEP_DIR="$TEST_ROOT/su-fallback-home"
  export HIVEKEEP_REVIEW_SECRET=visible-to-root
  PATH="$fallback_path"
  run_as_service_user "$selected_bun" --version &>/dev/null || fail "su fallback failed"
  service_environment="$(run_as_service_user /usr/bin/env)"
  PATH="$ORIGINAL_PATH"
  if grep -q HIVEKEEP_REVIEW_SECRET <<< "$service_environment"; then
    fail "su fallback leaked the root environment"
  fi
)
test_su_fallback
pass "Service-user validation falls back to su"

test_root_script_service() (
  local private_install="$PRIVATE_DIR/script-service"
  local private_bun="$private_install/bin/bun"
  mkdir -p "$(dirname "$private_bun")"
  make_bun "$private_bun"
  chmod 0700 "$PRIVATE_DIR"

  IS_ROOT=true
  OS=Linux
  INIT_SYSTEM=script
  HIVEKEEP_USER="missing-service-user"
  HIVEKEEP_SYSTEM_BUN_INSTALL="$TEST_ROOT/managed-script-service"
  BUN_INSTALL="$private_install"
  PATH="$private_install/bin:$ORIGINAL_PATH"
  resolve_bun_path

  assert_equal "$private_bun" "$BUN_BIN" "root script service Bun path"
  [ ! -e "$HIVEKEEP_SYSTEM_BUN_INSTALL/bin/bun" ] || fail "script service created an unnecessary managed Bun"
)
test_root_script_service
pass "Root script service does not require an unprivileged service user"

test_setup_user_with_missing_install_dir() (
  local existing_data="$TEST_ROOT/reset-data-only"
  local missing_install="$TEST_ROOT/reset-missing-install"
  local existing_install="$TEST_ROOT/reset-install-only"
  local missing_data="$TEST_ROOT/reset-missing-data"
  mkdir -p "$existing_data"

  IS_ROOT=true
  HIVEKEEP_USER="$TEST_USER"
  HIVEKEEP_DIR="$missing_install"
  HIVEKEEP_DATA_DIR="$existing_data"
  setup_system_user &>/dev/null

  assert_equal "$TEST_USER" "$(stat -c '%U' "$existing_data")" "reset data ownership"
  [ ! -e "$missing_install" ] || fail "service-user setup created the missing install directory"

  mkdir -p "$existing_install"
  HIVEKEEP_DIR="$existing_install"
  HIVEKEEP_DATA_DIR="$missing_data"
  setup_system_user &>/dev/null

  assert_equal "$TEST_USER" "$(stat -c '%U' "$existing_install")" "reset install ownership"
  [ ! -e "$missing_data" ] || fail "service-user setup created the missing data directory"
)
test_setup_user_with_missing_install_dir
pass "Reset preflight tolerates one missing installation path"

test_unusable_bun_fails() (
  local private_install="$PRIVATE_DIR/unusable"
  local private_bun="$private_install/bin/bun"
  local error_log="$TEST_ROOT/unusable-error.log"
  mkdir -p "$(dirname "$private_bun")"
  printf '%s\n' \
    '#!/bin/sh' \
    '[ "$(id -u)" -eq 0 ] || exit 42' \
    'printf "1.3.14\n"' > "$private_bun"
  chmod 0755 "$private_bun"
  chmod 0700 "$PRIVATE_DIR"

  IS_ROOT=true
  OS=Linux
  INIT_SYSTEM=systemd
  HIVEKEEP_USER="$TEST_USER"
  HIVEKEEP_SYSTEM_BUN_INSTALL="$TEST_ROOT/managed-unusable"
  BUN_INSTALL="$private_install"
  PATH="$private_install/bin:$ORIGINAL_PATH"

  if (resolve_bun_path > /dev/null 2> "$error_log"); then
    fail "unusable Bun passed service-user validation"
  fi
  grep -q "cannot execute as '$TEST_USER' after staging" "$error_log" || \
    fail "unusable Bun failed for an unexpected reason"
  if compgen -G "$HIVEKEEP_SYSTEM_BUN_INSTALL/bin/bun.tmp.*" > /dev/null; then
    fail "failed Bun validation left a staged file behind"
  fi
)
test_unusable_bun_fails
pass "Resolution fails before service creation when Bun remains unusable"

echo "All $pass_count installer Bun path tests passed."
