import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { createLogger } from '@/server/logger'
import { recordGuardFire } from '@/server/services/tool-call-tracker'
import type { ToolRegistration } from '@/server/tools/types'
import { resolveToolWorkspace } from '@/server/tools/workspace'
import { config } from '@/server/config'
import { subprocessEnv } from '@/server/services/subprocess-env'

const log = createLogger('shell-tools')

// Sourced from config so operators can raise the ceiling for tasks that run
// genuinely long commands (large test suites, builds). Env: HIVEKEEP_SHELL_TIMEOUT
// (default 30s) and HIVEKEEP_SHELL_MAX_TIMEOUT (default 10min). The Agent picks any
// value up to MAX_TIMEOUT per call via the `timeout` arg.
const DEFAULT_TIMEOUT = config.shell.defaultTimeoutMs
const MAX_TIMEOUT = config.shell.maxTimeoutMs

// Cap the rendered stdout/stderr at 30 KB so a one-off `tree`, `npm install
// --verbose`, or `bun test --verbose` doesn't flood the model's context with
// tens of thousands of irrelevant lines. The model can still re-run a command
// with narrower options if it really needs the full output.
const MAX_OUTPUT_LENGTH = 30_000

// ─── Bash-wrapper detection ──────────────────────────────────────────────────

// Map binaries that have a dedicated Hivekeep tool to the tool they should use
// instead. Sub-Agents have a strong incentive to fall back to `cat`/`head`/etc.
// because they know the shell; the prompt alone hasn't fully prevented this.
// Detect the pattern at execution time and refuse the call — the model retries
// with the dedicated tool.
const WRAPPER_SUGGESTIONS: Record<string, string> = {
  cat: 'read_file (use offset/limit for partial reads)',
  less: 'read_file (use offset/limit for partial reads)',
  more: 'read_file (use offset/limit for partial reads)',
  head: 'read_file with offset and limit',
  tail: 'read_file with offset and limit',
  wc: 'read_file (the response includes totalLines)',
  grep: 'grep',
  rg: 'grep',
  ripgrep: 'grep',
  ls: 'list_directory',
  sed: 'read_file (for inspection) or edit_file / multi_edit (for changes)',
  awk: 'read_file (for inspection) or edit_file / multi_edit (for changes)',
}

// Banned commands. These either have a dedicated Hivekeep tool that performs
// the same job with better integration (http_request, browse_url, …) or are
// network/interactive operations that don't belong in a headless task. The
// list is adapted from Claude Code's BashTool BANNED_COMMANDS.
const BANNED_SUGGESTIONS: Record<string, string> = {
  // HTTP clients — use http_request
  curl: 'http_request',
  curlie: 'http_request',
  wget: 'http_request',
  axel: 'http_request',
  aria2c: 'http_request',
  httpie: 'http_request',
  http: 'http_request',
  xh: 'http_request',
  'http-prompt': 'http_request',
  // Text browsers — use browse_url
  lynx: 'browse_url',
  w3m: 'browse_url',
  links: 'browse_url',
  // GUI browsers — pointless in a headless task
  chrome: 'browse_url or screenshot_url',
  'google-chrome': 'browse_url or screenshot_url',
  chromium: 'browse_url or screenshot_url',
  firefox: 'browse_url or screenshot_url',
  safari: 'browse_url or screenshot_url',
  // Raw socket tools — rarely needed in tasks, ask the user if you truly do
  nc: 'http_request (or ask the user before opening a raw socket)',
  netcat: 'http_request (or ask the user before opening a raw socket)',
  telnet: 'http_request (or ask the user before opening a raw socket)',
}

export interface ShellWrapperViolation {
  binary: string
  suggestion: string
  reason: 'wrapper' | 'banned'
}

export interface HookBypassViolation {
  pattern: string
  detail: string
}

// Markers that indicate the agent is trying to skip the project's pre-commit
// / commit / pre-push hooks. The Agent shouldn't bypass them — fixing the
// underlying issue is the whole point of having hooks. Caught at execution
// time so a prompt rule that the model reasons past still doesn't ship.
//
// Real-world incident that motivated this: prod task `e6c9d6f1` (ticket #25)
// — the agent ran 1× `git commit --no-verify` and 8× `HUSKY=0 bun test` to
// dodge the husky hook chain.
const HOOK_BYPASS_PATTERNS: Array<{ regex: RegExp; pattern: string; detail: string }> = [
  {
    regex: /(?:^|\s)--no-verify(?=\s|$)/,
    pattern: '--no-verify',
    detail: 'skips git pre-commit / commit-msg / pre-push hooks',
  },
  {
    regex: /(?:^|\s)--no-gpg-sign(?=\s|$)/,
    pattern: '--no-gpg-sign',
    detail: 'skips commit signature verification',
  },
  {
    regex: /(?:^|\s)HUSKY=(?:0|false)(?=\s)/,
    pattern: 'HUSKY=0',
    detail: 'disables husky hooks for the spawned process',
  },
  {
    regex: /(?:^|\s)SKIP_HOOKS=(?:1|true)(?=\s)/,
    pattern: 'SKIP_HOOKS=1',
    detail: 'disables Lefthook / pre-commit hooks for the spawned process',
  },
  {
    regex: /(?:^|\s)PRE_COMMIT_ALLOW_NO_CONFIG=(?:1|true)(?=\s)/,
    pattern: 'PRE_COMMIT_ALLOW_NO_CONFIG=1',
    detail: 'lets `pre-commit run` proceed without its config — same effect as skipping',
  },
]

/**
 * Detect an attempt to skip the project's hooks (commit/push/test). Returns
 * the matched marker so the caller can surface a precise refusal message.
 * Exported for unit testing.
 */
export function detectHookBypass(rawCommand: string): HookBypassViolation | null {
  const cmd = rawCommand.trim()
  if (!cmd) return null
  for (const { regex, pattern, detail } of HOOK_BYPASS_PATTERNS) {
    if (regex.test(cmd)) return { pattern, detail }
  }
  return null
}

// `cat <file>` at the start of a pipeline is the prod-observed loophole in
// the pipeline carve-out below (ticket #25 task: `cat src/.../ChatPage.tsx
// | head -90 | tail -50`). We refuse it when the file path looks like a
// project file (does NOT live under /etc, /proc, /sys, /var, /tmp, /root,
// /dev — system paths that read_file blocks outright). The pipeline rest
// is preserved as advisory text in the refusal message.
const SYSTEM_PATH_PREFIXES = ['/etc/', '/proc/', '/sys/', '/var/', '/tmp/', '/root/', '/dev/']

function isProjectFilePath(arg: string): boolean {
  if (!arg) return false
  if (arg.startsWith('-')) return false // flag, not a path
  if (SYSTEM_PATH_PREFIXES.some((p) => arg.startsWith(p))) return false
  return true
}

function isCatWrapperPipelineStart(cmd: string): boolean {
  // Walk to the first `|` (top-level only — ignore `||` and `|&`).
  const head = cmd.split(/\|(?!\|)/, 1)[0]?.trim() ?? ''
  const toks = head.split(/\s+/).filter(Boolean)
  if (toks.length !== 2) return false
  if (toks[0] !== 'cat') return false
  return isProjectFilePath(toks[1]!)
}

/**
 * Detect a bare shell wrapper around a tool that has a dedicated Hivekeep
 * equivalent, OR a banned network/browser command. Returns null when the
 * command looks like a legitimate pipeline / script / multi-step (in which
 * case the binary is being used as a filter rather than as an entrypoint).
 *
 * One known loophole is now caught: `cat <project_file> | head | tail | …`
 * — see ticket #25 prod task. The pipeline still gets to flag itself as a
 * filter chain, but if it *starts* with a bare `cat` of a project file we
 * refuse and point at read_file.
 *
 * Exported for unit testing.
 */
export function detectShellWrapper(rawCommand: string): ShellWrapperViolation | null {
  let cmd = rawCommand.trim()
  if (!cmd) return null

  // Strip a leading `cd <path> && ` or `cd <path> ; ` — the agent often
  // prefixes its file-inspection commands with one (cosmetic, not a real
  // pipeline). This makes the detector see the actual entrypoint.
  const cdMatch = cmd.match(/^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/)
  if (cdMatch) cmd = cmd.slice(cdMatch[0].length).trim()

  // `cat <project_file> | …` — caught BEFORE the pipeline carve-out below.
  if (isCatWrapperPipelineStart(cmd)) {
    return {
      binary: 'cat',
      suggestion: WRAPPER_SUGGESTIONS.cat!,
      reason: 'wrapper',
    }
  }

  // Anything that includes pipelines, redirections, command substitution, or
  // chained commands is treated as legitimate — `cat <(...)`, `... | grep`,
  // `head ... > out`, `cmd1 && cmd2` all have valid reasons to call into
  // these binaries as filters.
  if (/[|<>`]|\$\(|&&|\|\|/.test(cmd)) return null

  const firstWord = cmd.split(/\s+/)[0]?.toLowerCase() ?? ''
  const wrapperSuggestion = WRAPPER_SUGGESTIONS[firstWord]
  if (wrapperSuggestion) {
    return { binary: firstWord, suggestion: wrapperSuggestion, reason: 'wrapper' }
  }
  const bannedSuggestion = BANNED_SUGGESTIONS[firstWord]
  if (bannedSuggestion) {
    return { binary: firstWord, suggestion: bannedSuggestion, reason: 'banned' }
  }
  return null
}

/** Cap a stdout/stderr stream at MAX_OUTPUT_LENGTH characters. The trailing
 *  chunk is preserved (most useful for command tails like build errors). */
function truncateOutput(raw: string): { value: string; truncated: boolean; omitted: number } {
  if (raw.length <= MAX_OUTPUT_LENGTH) return { value: raw, truncated: false, omitted: 0 }
  const tail = raw.slice(raw.length - MAX_OUTPUT_LENGTH)
  const omitted = raw.length - MAX_OUTPUT_LENGTH
  return {
    value: `[…truncated ${omitted} chars from the head — showing the last ${MAX_OUTPUT_LENGTH}…]\n${tail}`,
    truncated: true,
    omitted,
  }
}

export const _SHELL_INTERNALS_FOR_TEST = { truncateOutput, MAX_OUTPUT_LENGTH }

// ─── run_shell tool ──────────────────────────────────────────────────────────

export const runShellTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  expandsSecrets: true,
  secretsViaEnv: true,
  create: (ctx) =>
    tool({
      description:
        'Run a shell command (bash -c). Returns stdout, stderr, exit code. Vault secrets: write `{{secret:KEY}}` in the command (e.g. `GITHUB_TOKEN={{secret:GITHUB_TOKEN}} bun run script.ts`) — it is delivered to the subprocess as an environment variable, never spliced into the command line; use double quotes around it, never single quotes (they block expansion); the `HIVEKEEP_SECRET_*` env prefix is reserved for this mechanism. Use for: git, builds, tests, package managers, language tooling. **Never use for: cat, head, tail, sed, awk, grep, find, ls, wc, echo** — those have dedicated tools (`read_file` with offset/limit, `grep`, `list_directory`, `edit_file`, `multi_edit`). **Never use for: curl, wget, httpie, lynx, w3m, browsers, nc, telnet** — use `http_request` / `browse_url` / `screenshot_url` instead. The runner refuses standalone wrappers around those binaries and asks you to retry with the dedicated tool. Pass `cwd` as a parameter instead of `cd ... &&` prefixes. Output is capped at 30 KB — re-run with narrower options if you need more. Never use `--no-verify`, `git push --force`, or `git reset --hard` without explicit authorization.',
      inputSchema: z.object({
        command: z.string(),
        cwd: z
          .string()
          .optional()
          .describe('Absolute path. Defaults to Agent workspace.'),
        timeout: z
          .number()
          .int()
          .min(1000)
          .max(MAX_TIMEOUT)
          .optional()
          .describe(`Ms. Default: ${DEFAULT_TIMEOUT}, max: ${MAX_TIMEOUT}. Raise it for slow commands (large test suites, builds, migrations) so they aren't killed mid-run.`),
      }),
      execute: async ({ command, cwd, timeout }, options) => {
        const abortSignal = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal
        // Expanded vault secrets delivered by the tool-executor (secretsViaEnv):
        // merged into the subprocess env below — the command string only ever
        // carries `${HIVEKEEP_SECRET_*}` references.
        const secretEnv = (options as { secretEnv?: Record<string, string> } | undefined)?.secretEnv
        const workspace = resolveToolWorkspace(ctx)
        const effectiveCwd = cwd ?? workspace
        const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT
        const start = Date.now()

        const hookBypass = detectHookBypass(command)
        if (hookBypass) {
          log.warn(
            { agentId: ctx.agentId, command, pattern: hookBypass.pattern },
            'Refused hook-bypass command',
          )
          recordGuardFire(ctx.taskId, 'hookBypassRefusal')
          return {
            success: false,
            output: '',
            error:
              `Refusing this command — it contains \`${hookBypass.pattern}\` which ${hookBypass.detail}. ` +
              `The project's hooks (typecheck, tests, build) exist to catch regressions; bypassing them is exactly what causes the kind of incidents you'd want to avoid. ` +
              `Fix the underlying failure first, then re-run the command without the bypass. ` +
              `If the user has explicitly authorised the bypass in this task's mission, you can ask via request_input to confirm before retrying.`,
            exitCode: -1,
            executionTime: 0,
          }
        }

        const violation = detectShellWrapper(command)
        if (violation) {
          log.warn(
            { agentId: ctx.agentId, command, binary: violation.binary, reason: violation.reason },
            'Refused shell command',
          )
          recordGuardFire(
            ctx.taskId,
            violation.reason === 'wrapper' ? 'bashWrapperRefusal' : 'bannedCommandRefusal',
          )
          const intro = violation.reason === 'wrapper'
            ? `Refusing to run \`${violation.binary}\` through run_shell — use the dedicated tool: ${violation.suggestion}.`
            : `\`${violation.binary}\` is banned through run_shell — use the dedicated tool: ${violation.suggestion}.`
          return {
            success: false,
            output: '',
            error:
              `${intro} ` +
              `run_shell is for git/builds/tests/package managers/language tooling. ` +
              `If you genuinely need this binary as part of a pipeline (e.g. piping its output through another command), include the pipe — this check only fires on standalone calls.`,
            exitCode: -1,
            executionTime: 0,
          }
        }

        // The turn was already cancelled before we got here — don't spawn.
        if (abortSignal?.aborted) {
          return { success: false, output: '', error: 'Execution aborted', exitCode: -1, executionTime: 0 }
        }

        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        let onAbort: (() => void) | undefined
        let abortSignalRef: AbortSignal | undefined
        try {
          const proc = Bun.spawn(['bash', '-c', command], {
            cwd: effectiveCwd,
            stdout: 'pipe',
            stderr: 'pipe',
            env: {
              ...subprocessEnv(),
              ...secretEnv,
              HIVEKEEP_KIN_ID: ctx.agentId,
              HIVEKEEP_WORKSPACE: workspace,
            },
          })

          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              proc.kill()
              reject(new Error('Execution timeout'))
            }, effectiveTimeout)
          })

          // Clicking Stop aborts the turn — kill the running process so the turn
          // can unwind immediately instead of waiting out the command's own
          // timeout. Without this a long command (e.g. `timeout 90 ... & wait`)
          // holds the whole turn hostage until it finishes on its own.
          const abortPromise = new Promise<never>((_, reject) => {
            if (!abortSignal) return
            abortSignalRef = abortSignal
            onAbort = () => {
              proc.kill()
              reject(new Error('Execution aborted'))
            }
            abortSignal.addEventListener('abort', onAbort, { once: true })
          })

          const exitCode = await Promise.race([proc.exited, timeoutPromise, abortPromise])
          const stdoutRaw = await new Response(proc.stdout).text()
          const stderrRaw = await new Response(proc.stderr).text()
          const executionTime = Date.now() - start

          const stdoutTrimmed = stdoutRaw.trim()
          const stderrTrimmed = stderrRaw.trim()
          const stdout = truncateOutput(stdoutTrimmed)
          const stderr = truncateOutput(stderrTrimmed)

          log.info(
            {
              agentId: ctx.agentId,
              command,
              executionTime,
              exitCode,
              success: exitCode === 0,
              truncated: stdout.truncated || stderr.truncated,
            },
            'Shell command executed',
          )

          const trimmedStderr = stderr.value || undefined

          return {
            success: exitCode === 0,
            output: stdout.value,
            stderr: trimmedStderr,
            ...(exitCode !== 0 && trimmedStderr ? { error: trimmedStderr } : {}),
            ...(stdout.truncated || stderr.truncated
              ? { truncated: true, omittedBytes: stdout.omitted + stderr.omitted }
              : {}),
            exitCode,
            executionTime,
          }
        } catch (err) {
          const executionTime = Date.now() - start
          const aborted = err instanceof Error && err.message === 'Execution aborted'
          if (!aborted) {
            log.error({ agentId: ctx.agentId, command, err }, 'Shell command execution failed')
          }

          return {
            success: false,
            output: '',
            error: err instanceof Error ? err.message : 'Execution failed',
            exitCode: -1,
            executionTime,
          }
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle)
          if (onAbort && abortSignalRef) abortSignalRef.removeEventListener('abort', onAbort)
        }
      },
    }),
}
