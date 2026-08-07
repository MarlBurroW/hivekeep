/**
 * Allowlisted environment for tool-spawned subprocesses (run_shell, custom
 * tools). The server's own process.env carries ENCRYPTION_KEY, DB_PATH and
 * every provider API key; spreading it into a child means a single `printenv`
 * in a tool call hands all of it to the model and persists it in tool_calls,
 * outside vault redaction (which only tracks vault values). Children get the
 * vars a shell genuinely needs and nothing else.
 */

const SAFE_ENV_VARS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'COLORTERM',
  'BUN_INSTALL',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const

const SAFE_ENV_PREFIXES = ['LC_'] as const

export function subprocessEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of SAFE_ENV_VARS) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && SAFE_ENV_PREFIXES.some((p) => name.startsWith(p))) {
      env[name] = value
    }
  }
  return env
}
