/**
 * Remark plugin: surface workspace file paths written in chat messages as
 * `<workspace-path>` elements (clickable chips once the WorkspacePathContext
 * confirms the file exists — unverified candidates degrade to plain text, so
 * regex false positives are harmless). files.md § 5.2.
 *
 * Two scans:
 *
 * 1. TEXT nodes via `mdast-util-find-and-replace` with a CONSERVATIVE
 *    candidate regex (token with an inner `/` or a file extension). The regex
 *    must be global (find-and-replace bails after one match otherwise) and
 *    `link` nodes are ignored — remark-gfm autolinks bare URLs and
 *    `https://x.com/a/b.md` must not get its label rewritten.
 * 2. INLINE-CODE nodes via a manual visit: find-and-replace only ever visits
 *    `text` literals, and both agents (per the system-prompt convention) and
 *    the `@` palette write paths in backticks. This scan is deliberately
 *    PERMISSIVE (spaces/Unicode allowed when there's a `/` or an extension) —
 *    existence is verified server-side anyway.
 */
import { findAndReplace } from 'mdast-util-find-and-replace'
import type { Root } from 'mdast'

/**
 * Conservative text-node candidate: `dir/sub/file ext` requires word-ish chars
 * (no spaces — a sentence in French would match wildly otherwise), either with
 * a `/` or a bare filename with an extension. Boundaries are token-anchored
 * (lookbehind/lookahead on non-word).
 */
export const WORKSPACE_PATH_TEXT_REGEX =
  /(?:^|(?<=[\s({[«"']))((?:[\w.-]+\/)+[\w][\w.-]*|[\w][\w-]*\.[A-Za-z0-9]{1,8})(?=$|[\s)}\],.;:!?»"'])/g

/** Permissive inline-code candidate: anything with a `/` or an extension. */
const INLINE_CODE_PATH_REGEX = /^(?:[^\n/]+\/)*[^\n/]+\.[A-Za-z0-9]{1,8}$|^[^\n]+\/[^\n]+$/

/** Obvious non-paths the conservative regex would otherwise catch. */
const TEXT_FALSE_POSITIVES = /^(?:\d+(?:\.\d+)+|[a-z]+:\/\/.*|www\..*)$/i

interface PathNodeData {
  hName: 'workspace-path'
  hProperties: { 'data-path': string; 'data-was-code'?: '' }
}

function pathNode(path: string, wasCode: boolean) {
  return {
    type: 'text' as const,
    value: '',
    data: {
      hName: 'workspace-path',
      hProperties: wasCode ? { 'data-path': path, 'data-was-code': '' } : { 'data-path': path },
    } satisfies PathNodeData,
  }
}

/** Remark plugin factory. */
export function remarkWorkspacePaths() {
  return (tree: Root) => {
    // 1. Plain-text candidates.
    findAndReplace(
      tree,
      [
        [
          new RegExp(WORKSPACE_PATH_TEXT_REGEX.source, WORKSPACE_PATH_TEXT_REGEX.flags),
          (raw: string) => {
            if (TEXT_FALSE_POSITIVES.test(raw)) return false
            return pathNode(raw, false)
          },
        ],
        // biome-ignore lint/suspicious/noExplicitAny: mdast-util-find-and-replace's typing is loose
      ] as any,
      { ignore: ['link', 'linkReference'] },
    )

    // 2. Backticked candidates (whole inlineCode value only). Tiny manual walk
    //    instead of unist-util-visit (not a dependency of this repo).
    const walk = (node: { type?: string; children?: Array<{ type?: string; value?: string }> }) => {
      if (!Array.isArray(node.children)) return
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]!
        if (child.type === 'inlineCode' && typeof child.value === 'string') {
          const value = child.value.trim()
          if (value && !value.includes('\n') && INLINE_CODE_PATH_REGEX.test(value) && !TEXT_FALSE_POSITIVES.test(value)) {
            node.children.splice(i, 1, pathNode(value, true) as never)
          }
          continue
        }
        walk(child as { type?: string; children?: Array<{ type?: string; value?: string }> })
      }
    }
    walk(tree as unknown as { type?: string; children?: Array<{ type?: string; value?: string }> })
  }
}
