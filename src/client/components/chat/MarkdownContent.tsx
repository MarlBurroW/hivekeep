import { memo, useCallback, useEffect, useMemo, useState, type AnchorHTMLAttributes, type HTMLAttributes, type ImgHTMLAttributes } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from 'react-i18next'
import { Copy, Check, WrapText, Download } from 'lucide-react'
import { useCopyToClipboard } from '@/client/hooks/useCopyToClipboard'
import { cn } from '@/client/lib/utils'
import { HighlightText } from '@/client/components/chat/HighlightText'
import { ImageLightbox } from '@/client/components/chat/ImageLightbox'
import { WorkspacePathMention } from '@/client/components/chat/WorkspacePathMention'
import { remarkWorkspacePaths, WORKSPACE_PATH_TEXT_REGEX } from '@/client/lib/remark-workspace-paths'

interface MarkdownContentProps {
  content: string
  /** Whether the content lives inside a user bubble (primary bg) */
  isUser?: boolean
  /** Drop the chat-scoped remark plugins (workspace paths, …) — used when
   *  MarkdownContent renders outside a conversation (e.g. Files md preview). */
  disableChatPlugins?: boolean
  className?: string
}

const defaultRemarkPlugins = [remarkGfm, remarkWorkspacePaths]

// ─── Lazy-loaded plugins ──────────────────────────────────────────────────────
// rehype-highlight (~170 KB), remark-math + rehype-katex (~260 KB) are loaded
// on demand only when content contains code blocks or math expressions.

// biome-ignore lint: using any for unified plugin compatibility
type UnifiedPlugin = any

interface LazyPlugins {
  remarkPlugins: UnifiedPlugin[]
  rehypePlugins: UnifiedPlugin[]
}

let cachedRehypeHighlight: UnifiedPlugin | null = null
let cachedRemarkMath: UnifiedPlugin | null = null
let cachedRehypeKatex: UnifiedPlugin | null = null

// Simple dedup loaders with listener pattern
function createLoader(load: () => Promise<UnifiedPlugin>) {
  let loading = false
  let cached: UnifiedPlugin | null = null
  const listeners: Array<(p: UnifiedPlugin) => void> = []
  return {
    get: () => cached,
    load: (): Promise<UnifiedPlugin> => {
      if (cached) return Promise.resolve(cached)
      if (loading) return new Promise((r) => listeners.push(r))
      loading = true
      return load().then((p) => {
        cached = p
        listeners.forEach((fn) => fn(p))
        listeners.length = 0
        return p
      })
    },
  }
}

const highlightLoader = createLoader(() => import('rehype-highlight').then((m) => { cachedRehypeHighlight = m.default; return m.default }))
const remarkMathLoader = createLoader(() => import('remark-math').then((m) => { cachedRemarkMath = m.default; return m.default }))
const katexLoader = createLoader(() => import('rehype-katex').then((m) => { cachedRehypeKatex = m.default; return m.default }))

/** Detect if content has fenced code blocks (``` or ~~~) */
function hasCodeBlocks(content: string): boolean {
  return /^(`{3,}|~{3,})/m.test(content)
}

/** Detect if content has math expressions ($...$ or $$...$$) */
function hasMathExpressions(content: string): boolean {
  return /\$\$[\s\S]+?\$\$|\$[^\s$]([^$]*[^\s$])?\$/.test(content)
}

/** Hook to get remark+rehype plugins, loading heavy ones on demand */
function useLazyPlugins(content: string, disableChatPlugins = false): LazyPlugins {
  const needsHighlight = useMemo(() => hasCodeBlocks(content), [content])
  const needsMath = useMemo(() => hasMathExpressions(content), [content])
  const basePlugins = disableChatPlugins ? [remarkGfm] : defaultRemarkPlugins

  const [plugins, setPlugins] = useState<LazyPlugins>(() => {
    const remark: UnifiedPlugin[] = [...basePlugins]
    const rehype: UnifiedPlugin[] = []
    if (needsMath && cachedRemarkMath) remark.push(cachedRemarkMath)
    if (needsHighlight && cachedRehypeHighlight) rehype.push(cachedRehypeHighlight)
    if (needsMath && cachedRehypeKatex) rehype.push(cachedRehypeKatex)
    return { remarkPlugins: remark, rehypePlugins: rehype }
  })

  useEffect(() => {
    let cancelled = false
    const promises: Promise<void>[] = []

    if (needsHighlight && !cachedRehypeHighlight) {
      promises.push(highlightLoader.load().then(() => {}))
    }
    if (needsMath && !cachedRemarkMath) {
      promises.push(remarkMathLoader.load().then(() => {}))
    }
    if (needsMath && !cachedRehypeKatex) {
      promises.push(katexLoader.load().then(() => {}))
    }

    if (promises.length > 0) {
      Promise.all(promises).then(() => {
        if (cancelled) return
        const remark: UnifiedPlugin[] = [...basePlugins]
        const rehype: UnifiedPlugin[] = []
        if (needsMath && cachedRemarkMath) remark.push(cachedRemarkMath)
        if (needsHighlight && cachedRehypeHighlight) rehype.push(cachedRehypeHighlight)
        if (needsMath && cachedRehypeKatex) rehype.push(cachedRehypeKatex)
        setPlugins({ remarkPlugins: remark, rehypePlugins: rehype })
      })
    } else {
      const remark: UnifiedPlugin[] = [...basePlugins]
      const rehype: UnifiedPlugin[] = []
      if (needsMath && cachedRemarkMath) remark.push(cachedRemarkMath)
      if (needsHighlight && cachedRehypeHighlight) rehype.push(cachedRehypeHighlight)
      if (needsMath && cachedRehypeKatex) rehype.push(cachedRehypeKatex)
      setPlugins({ remarkPlugins: remark, rehypePlugins: rehype })
    }

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsHighlight, needsMath, disableChatPlugins])

  return plugins
}

// ─── Code block with copy button ──────────────────────────────────────────────

function CodeBlockCopyButton({ code }: { code: string }) {
  const { t } = useTranslation()
  const { copy, copied } = useCopyToClipboard()

  const handleCopy = useCallback(() => {
    copy(code, { successKey: 'chat.codeBlock.copied', errorKey: 'chat.codeBlock.copyFailed' })
  }, [code, copy])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'rounded-md p-1.5 transition-all',
        'bg-background/60 hover:bg-background/90 backdrop-blur-sm',
        'text-muted-foreground hover:text-foreground',
        'active:scale-95',
      )}
      title={t('chat.codeBlock.copy')}
      aria-label={t('chat.codeBlock.copy')}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}

function extractTextContent(node: React.ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (!node) return ''
  if (Array.isArray(node)) return node.map(extractTextContent).join('')
  if (typeof node === 'object' && 'props' in node) {
    return extractTextContent((node as React.ReactElement<{ children?: React.ReactNode }>).props.children)
  }
  return ''
}

/** Extract the language from the <code> child's className (hljs adds `language-xxx` or `hljs language-xxx`). */
function extractLanguage(children: React.ReactNode): string | null {
  if (!children) return null
  const child = Array.isArray(children) ? children[0] : children
  if (typeof child === 'object' && child !== null && 'props' in child) {
    const className: string = (child as React.ReactElement<{ className?: string }>).props.className ?? ''
    const match = className.match(/language-(\S+)/)
    if (match) {
      const lang = match[1]
      // Skip hljs's "undefined" or empty
      if (lang && lang !== 'undefined') return lang
    }
  }
  return null
}

/** Human-friendly display names for common languages. */
const LANG_DISPLAY: Record<string, string> = {
  js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX',
  ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX',
  py: 'Python', python: 'Python',
  rb: 'Ruby', ruby: 'Ruby',
  rs: 'Rust', rust: 'Rust',
  go: 'Go', golang: 'Go',
  sh: 'Shell', bash: 'Bash', zsh: 'Zsh', fish: 'Fish',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML',
  html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'LESS',
  sql: 'SQL', graphql: 'GraphQL',
  md: 'Markdown', markdown: 'Markdown',
  dockerfile: 'Dockerfile', docker: 'Docker',
  cpp: 'C++', c: 'C', cs: 'C#', csharp: 'C#',
  java: 'Java', kotlin: 'Kotlin', swift: 'Swift',
  php: 'PHP', lua: 'Lua', perl: 'Perl', r: 'R',
  diff: 'Diff', plaintext: 'Text', text: 'Text',
  ini: 'INI', nginx: 'Nginx', makefile: 'Makefile',
}

function langDisplayName(lang: string): string {
  return LANG_DISPLAY[lang.toLowerCase()] ?? lang.toUpperCase()
}

/** Map language identifiers to file extensions for downloading. */
const LANG_EXTENSION: Record<string, string> = {
  js: 'js', javascript: 'js', jsx: 'jsx',
  ts: 'ts', typescript: 'ts', tsx: 'tsx',
  py: 'py', python: 'py',
  rb: 'rb', ruby: 'rb',
  rs: 'rs', rust: 'rs',
  go: 'go', golang: 'go',
  sh: 'sh', bash: 'sh', zsh: 'zsh', fish: 'fish',
  json: 'json', yaml: 'yaml', yml: 'yml', toml: 'toml', xml: 'xml',
  html: 'html', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', graphql: 'graphql',
  md: 'md', markdown: 'md',
  dockerfile: 'Dockerfile', docker: 'Dockerfile',
  cpp: 'cpp', c: 'c', cs: 'cs', csharp: 'cs',
  java: 'java', kotlin: 'kt', swift: 'swift',
  php: 'php', lua: 'lua', perl: 'pl', r: 'r',
  diff: 'diff', plaintext: 'txt', text: 'txt',
  ini: 'ini', nginx: 'conf', makefile: 'Makefile',
}

function langExtension(lang: string | null): string {
  if (!lang) return 'txt'
  return LANG_EXTENSION[lang.toLowerCase()] ?? 'txt'
}

function CodeBlockDownloadButton({ code, language }: { code: string; language: string | null }) {
  const { t } = useTranslation()

  const handleDownload = useCallback(() => {
    const ext = langExtension(language)
    const filename = `code.${ext}`
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [code, language])

  return (
    <button
      type="button"
      onClick={handleDownload}
      className={cn(
        'rounded-md p-1.5 transition-all',
        'bg-background/60 hover:bg-background/90 backdrop-blur-sm',
        'text-muted-foreground hover:text-foreground',
        'active:scale-95',
      )}
      title={t('chat.codeBlock.download')}
      aria-label={t('chat.codeBlock.download')}
    >
      <Download className="size-3.5" />
    </button>
  )
}

/** Minimum number of lines before showing line numbers. */
const LINE_NUMBER_THRESHOLD = 4

/** Minimum longest-line length before showing the wrap toggle. */
const WRAP_TOGGLE_THRESHOLD = 80

function CodeBlockWrapButton({ wrapped, onToggle }: { wrapped: boolean; onToggle: () => void }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'rounded-md p-1.5 transition-all',
        'bg-background/60 hover:bg-background/90 backdrop-blur-sm',
        wrapped ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
        'active:scale-95',
      )}
      title={wrapped ? t('chat.codeBlock.unwrap') : t('chat.codeBlock.wrap')}
      aria-label={wrapped ? t('chat.codeBlock.unwrap') : t('chat.codeBlock.wrap')}
    >
      <WrapText className="size-3.5" />
    </button>
  )
}

function PreBlock({ children, ...props }: HTMLAttributes<HTMLPreElement>) {
  const code = extractTextContent(children).replace(/\n$/, '')
  const language = extractLanguage(children)
  const lines = code.split('\n')
  const showLineNumbers = lines.length >= LINE_NUMBER_THRESHOLD
  const longestLine = Math.max(...lines.map((l) => l.length))
  const showWrapToggle = longestLine >= WRAP_TOGGLE_THRESHOLD
  const [wrapped, setWrapped] = useState(false)

  return (
    <div className="group/codeblock relative">
      {/* Language label */}
      {language && (
        <div className="flex items-center justify-between rounded-t-md border border-b-0 border-border bg-muted/60 px-3 py-1">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
            {langDisplayName(language)}
          </span>
        </div>
      )}
      <div className={cn('relative', language && '[&>pre]:rounded-t-none [&>pre]:mt-0')}>
        {showLineNumbers && !wrapped && (
          <div
            className="absolute left-0 top-0 bottom-0 flex flex-col items-end select-none pointer-events-none py-[0.75em] pr-2 pl-2 text-[0.85em] leading-[1.5] font-mono text-muted-foreground/30 border-r border-border/30"
            aria-hidden="true"
          >
            {lines.map((_, i) => (
              <span key={i}>{i + 1}</span>
            ))}
          </div>
        )}
        <pre
          {...props}
          className={cn(
            props.className,
            showLineNumbers && !wrapped && 'code-with-line-numbers',
            wrapped && 'code-wrapped',
          )}
        >
          {children}
        </pre>
      </div>
      {/* Floating toolbar — appears on hover */}
      {code && (
        <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover/codeblock:opacity-100 transition-opacity">
          {showWrapToggle && <CodeBlockWrapButton wrapped={wrapped} onToggle={() => setWrapped((w) => !w)} />}
          <CodeBlockDownloadButton code={code} language={language} />
          <CodeBlockCopyButton code={code} />
        </div>
      )}
    </div>
  )
}

// Recursively walk React children and wrap string nodes with HighlightText
function highlightChildren(children: React.ReactNode): React.ReactNode {
  if (typeof children === 'string') return <HighlightText text={children} />
  if (typeof children === 'number') return <HighlightText text={String(children)} />
  if (Array.isArray(children)) return children.map((child, i) => {
    if (typeof child === 'string') return <HighlightText key={i} text={child} />
    return child
  })
  return children
}

/** HOC that wraps an HTML element to apply search highlighting to its text children. */
function withHighlight(Tag: string) {
  return function HighlightedElement({ children, ...props }: HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) {
    return <Tag {...props}>{highlightChildren(children)}</Tag>
  }
}

function MarkdownLink({ children, href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { children?: React.ReactNode }) {
  const isExternal = href && (href.startsWith('http://') || href.startsWith('https://'))
  return (
    <a
      href={href}
      {...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      {...props}
    >
      {highlightChildren(children)}
    </a>
  )
}

/**
 * Inline image renderer for markdown ![alt](url) syntax.
 * - Click: opens the existing ImageLightbox dialog
 * - Hover: copy-URL button overlay
 * - Load failure: falls back to a plain link
 */
function MarkdownImage({ src, alt, title }: ImgHTMLAttributes<HTMLImageElement>) {
  const [open, setOpen] = useState(false)
  const [errored, setErrored] = useState(false)
  const { copy, copied } = useCopyToClipboard()

  if (!src || errored) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        className="break-all"
      >
        {alt || src || 'image'}
      </a>
    )
  }

  const fileName = alt || (() => {
    try { return new URL(src).pathname.split('/').filter(Boolean).pop() || 'image' } catch { return 'image' }
  })()

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    copy(src)
  }

  return (
    <>
      <span className="group relative my-2 inline-block max-w-full align-top">
        <img
          src={src}
          alt={alt ?? ''}
          title={title}
          loading="lazy"
          onClick={() => setOpen(true)}
          onError={() => setErrored(true)}
          className="block max-h-80 max-w-full cursor-zoom-in rounded-md border border-border object-contain"
        />
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy image URL"
          className="absolute right-1.5 top-1.5 rounded bg-background/80 p-1 opacity-0 backdrop-blur transition-opacity hover:bg-background group-hover:opacity-100"
        >
          {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
        </button>
      </span>
      {open && (
        <ImageLightbox
          file={{ id: src, name: fileName, url: src, mimeType: 'image/*', size: 0 }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/**
 * Wraps GFM tables in a horizontally-scrollable container so wide tables scroll
 * WITHIN the message bubble instead of forcing the whole page to overflow on
 * narrow viewports. `max-w-full` keeps the wrapper inside the bubble's bounds.
 */
function MarkdownTable({ children, ...props }: HTMLAttributes<HTMLTableElement> & { children?: React.ReactNode }) {
  return (
    <div className="max-w-full overflow-x-auto">
      <table {...props}>{children}</table>
    </div>
  )
}

// biome-ignore lint/suspicious/noExplicitAny: registering a custom tag name in the components map
function WorkspacePathElement(props: HTMLAttributes<HTMLElement> & { 'data-path'?: string; 'data-was-code'?: string }) {
  const path = props['data-path']
  if (!path) return <>{props.children}</>
  return <WorkspacePathMention path={path} wasCode={props['data-was-code'] !== undefined} />
}

const markdownComponents: any = {
  pre: PreBlock,
  table: MarkdownTable,
  p: withHighlight('p'),
  li: withHighlight('li'),
  td: withHighlight('td'),
  th: withHighlight('th'),
  strong: withHighlight('strong'),
  em: withHighlight('em'),
  del: withHighlight('del'),
  a: MarkdownLink,
  img: MarkdownImage,
  h1: withHighlight('h1'),
  h2: withHighlight('h2'),
  h3: withHighlight('h3'),
  h4: withHighlight('h4'),
  h5: withHighlight('h5'),
  h6: withHighlight('h6'),
  blockquote: withHighlight('blockquote'),
  'workspace-path': WorkspacePathElement,
}

// ─── Inner markdown renderer (uses hooks for lazy rehype plugins) ─────────────

function MarkdownRenderer({
  content,
  isUser,
  disableChatPlugins,
  className,
}: MarkdownContentProps) {
  const { remarkPlugins, rehypePlugins } = useLazyPlugins(content, disableChatPlugins)

  return (
    <div
      className={cn(
        'markdown-content text-sm leading-relaxed',
        isUser && 'markdown-content--user',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export const MarkdownContent = memo(function MarkdownContent({
  content,
  isUser = false,
  disableChatPlugins = false,
  className,
}: MarkdownContentProps) {
  // Strip leading whitespace — LLMs sometimes start with \n
  const trimmed = content.trimStart()

  // Skip markdown rendering for very short / plain messages.
  const isPlainText = useMemo(() => {
    if (/[*_`#\[!\-|>~$\\]/.test(trimmed) || /^\d+\.\s/m.test(trimmed)) return false
    // Workspace path candidates (e.g. "voilà rapports/analyse.md") need the
    // remark pipeline even when no markdown marker is present (files.md § 5.2).
    const pathProbe = new RegExp(WORKSPACE_PATH_TEXT_REGEX.source)
    return !pathProbe.test(trimmed)
  }, [trimmed])

  if (isPlainText) {
    return (
      <div className={cn('text-sm whitespace-pre-wrap break-words leading-relaxed', className)}>
        <HighlightText text={trimmed} />
      </div>
    )
  }

  return <MarkdownRenderer content={trimmed} isUser={isUser} disableChatPlugins={disableChatPlugins} className={className} />
})
