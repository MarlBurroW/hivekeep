import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCopyToClipboard } from '@/client/hooks/useCopyToClipboard'
import { Badge } from '@/client/components/ui/badge'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/client/components/ui/collapsible'
import { MarkdownContent } from '@/client/components/chat/MarkdownContent'
import { InlineToolCall } from '@/client/components/chat/InlineToolCall'
import { TaskResultCard } from '@/client/components/chat/TaskResultCard'
import { WebhookMessageCard } from '@/client/components/chat/WebhookMessageCard'
import { ImageLightbox } from '@/client/components/chat/ImageLightbox'
import { TokenUsageIndicator } from '@/client/components/chat/TokenUsageIndicator'
import { ChatAvatar } from '@/client/components/chat/ChatAvatar'
import { cn } from '@/client/lib/utils'
import { PlatformIcon } from '@/client/components/common/PlatformIcon'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/client/components/ui/context-menu'
import { FileIcon, Download, Brain, ChevronDown, Copy, Check, RefreshCw, Quote, Pencil, Volume2, VolumeX, BookOpen, SmilePlus, EyeOff } from 'lucide-react'
import type { ToolCallViewItem } from '@/client/hooks/useToolCalls'
import { RelativeTimestamp } from '@/client/components/chat/RelativeTimestamp'
import type { MessageFile, MessageTokenUsage } from '@/shared/types'
import type { MessageReaction, ChannelTransferSystemEvent } from '@/client/hooks/useChat'
import { PRESET_EMOJIS } from '@/client/hooks/useReactions'
import { ArrowLeftFromLine, ArrowRightFromLine } from 'lucide-react'

interface InjectedMemory {
  id: string
  category: string
  content: string
  subject: string | null
}

interface MessageBubbleProps {
  role: 'user' | 'assistant' | 'system'
  content: string
  sourceType: string
  avatarUrl?: string | null
  senderName?: string
  /** Pre-computed initials for user messages (via getUserInitials). */
  userInitials?: string
  timestamp?: string
  toolCalls?: ToolCallViewItem[]
  injectedMemories?: InjectedMemory[] | null
  stepLimitReached?: boolean
  files?: MessageFile[]
  reactions?: MessageReaction[]
  currentUserId?: string
  /** When true, the message content has been redacted. */
  isRedacted?: boolean
  /** When true, the message is part of a consecutive group from the same sender — avatar and name are hidden, spacing is tighter. */
  isGrouped?: boolean
  /** When true, the message was just added to the list (animate entrance). */
  isNew?: boolean
  messageId?: string
  resolvedTaskId?: string | null
  onOpenTaskDetail?: (taskId: string) => void
  onRegenerate?: () => void
  onQuoteReply?: (text: string) => void
  onEditResend?: (text: string) => void
  onToggleReaction?: (messageId: string, emoji: string) => void
  /** Token usage data for this message (assistant messages only). */
  tokenUsage?: MessageTokenUsage | null
  /** LLM provider type ("anthropic", "openai", ...) used to pick the right
   *  cache multipliers when computing the billable token equivalent. */
  providerType?: string | null
  /** Reasoning/thinking segments with offsets into content */
  reasoning?: Array<{ offset: number; text: string }> | string
  /** Adapter-provided, already-localized line of context describing how the
   *  message was transported (e.g. "Sent on TeamSpeak via TTS, voice Kartal"). */
  channelContextLine?: string | null
  /** Brand color of the channel platform (used for the bubble accent border). */
  channelBrandColor?: string | null
  /** Channel platform identifier (e.g. "teamspeak", "telegram"). When provided,
   *  takes precedence over the legacy regex extraction from message content. */
  channelPlatformOverride?: string | null
  /** Structured channel-transfer event for sourceType='system' rows. When
   *  set, the bubble renders a dedicated handoff card instead of the
   *  generic gray banner used for other system messages. */
  systemEvent?: ChannelTransferSystemEvent | null
  /** Current Kin's avatar URL (for the "self" side of the transfer card). */
  currentKinAvatarUrl?: string | null
  /** Current Kin's display name (for the "self" side of the transfer card). */
  currentKinName?: string | null
}

/** A content part is either a text segment, a group of tool calls, or a reasoning block at the same offset. */
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'tools'; tools: ToolCallViewItem[] }
  | { type: 'reasoning'; text: string }

/** A positioned element (tool call group or reasoning block) to be interleaved with text. */
type PositionedElement =
  | { kind: 'tools'; offset: number; tools: ToolCallViewItem[] }
  | { kind: 'reasoning'; offset: number; text: string }

/**
 * Split message content into interleaved text, tool call, and reasoning parts using offsets.
 * Tool calls at the same offset are grouped together.
 * Falls back to [all text, then all tools] when offsets are missing.
 */
function buildContentParts(
  content: string,
  toolCalls: ToolCallViewItem[],
  reasoningSegments?: Array<{ offset: number; text: string }>,
): ContentPart[] {
  const hasOffsets = toolCalls.some((tc) => tc.offset !== undefined) || (reasoningSegments && reasoningSegments.length > 0)
  if (!hasOffsets) {
    // Fallback: text first, then all tool calls at the end
    const parts: ContentPart[] = []
    if (content) parts.push({ type: 'text', text: content })
    if (toolCalls.length > 0) parts.push({ type: 'tools', tools: toolCalls })
    return parts
  }

  // Sort tool calls by offset and group consecutive ones at the same offset
  const sorted = [...toolCalls].sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0))
  const toolGroups: Array<{ offset: number; tools: ToolCallViewItem[] }> = []
  for (const tc of sorted) {
    const offset = tc.offset ?? 0
    const last = toolGroups[toolGroups.length - 1]
    if (last && last.offset === offset) {
      last.tools.push(tc)
    } else {
      toolGroups.push({ offset, tools: [tc] })
    }
  }

  // Merge tool groups and reasoning segments into a single sorted list
  const elements: PositionedElement[] = []
  for (const g of toolGroups) elements.push({ kind: 'tools', offset: g.offset, tools: g.tools })
  if (reasoningSegments) {
    for (const r of reasoningSegments) elements.push({ kind: 'reasoning', offset: r.offset, text: r.text })
  }
  elements.sort((a, b) => a.offset - b.offset)

  // Build interleaved parts
  const parts: ContentPart[] = []
  let cursor = 0

  for (const el of elements) {
    // Text segment before this element
    if (el.offset > cursor) {
      const text = content.slice(cursor, el.offset)
      if (text.trim()) parts.push({ type: 'text', text })
    }
    if (el.kind === 'tools') {
      parts.push({ type: 'tools', tools: el.tools })
    } else {
      parts.push({ type: 'reasoning', text: el.text })
    }
    cursor = el.offset
  }

  // Remaining text after the last element
  if (cursor < content.length) {
    const text = content.slice(cursor)
    if (text.trim()) {
      // Deduplicate: if trailing text is very similar to a prior text part, skip it.
      // This handles LLMs that repeat their response after tool calls (e.g. Memorize).
      const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
      const trailing = normalize(text)
      const isDuplicate = trailing.length > 20 && parts.some(
        (p) => p.type === 'text' && (() => {
          const prev = normalize(p.text)
          // Check if one contains the other (allowing minor wording differences)
          return prev.length > 20 && (
            trailing.startsWith(prev.slice(0, Math.floor(prev.length * 0.6))) ||
            prev.startsWith(trailing.slice(0, Math.floor(trailing.length * 0.6)))
          )
        })(),
      )
      if (!isDuplicate) parts.push({ type: 'text', text })
    }
  }

  return parts
}

// ─── File attachments rendering ───────────────────────────────────────────────

function MessageFiles({ files, isUser }: { files: MessageFile[]; isUser: boolean }) {
  const [lightboxFile, setLightboxFile] = useState<MessageFile | null>(null)

  const images = files.filter((f) => f.mimeType.startsWith('image/'))
  const others = files.filter((f) => !f.mimeType.startsWith('image/'))

  if (files.length === 0) return null

  return (
    <>
      {/* Image thumbnails */}
      {images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {images.map((img) => (
            <button
              key={img.id}
              type="button"
              onClick={() => setLightboxFile(img)}
              className="overflow-hidden rounded-lg border border-border/50 hover:opacity-90 transition-opacity focus-visible:ring-2 focus-visible:ring-ring"
            >
              <img
                src={img.url}
                alt={img.name}
                className="max-h-48 max-w-48 object-cover"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      )}

      {/* Non-image file chips */}
      {others.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {others.map((file) => (
            <a
              key={file.id}
              href={file.url}
              download={file.name}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors',
                isUser
                  ? 'bg-primary-foreground/20 text-primary-foreground hover:bg-primary-foreground/30'
                  : 'bg-muted-foreground/10 text-muted-foreground hover:bg-muted-foreground/20',
              )}
            >
              <FileIcon className="size-3.5 shrink-0" />
              <span className="max-w-32 truncate">{file.name}</span>
              <Download className="size-3 shrink-0" />
            </a>
          ))}
        </div>
      )}

      {/* Lightbox */}
      {lightboxFile && (
        <ImageLightbox
          file={lightboxFile}
          onClose={() => setLightboxFile(null)}
        />
      )}
    </>
  )
}

// ─── Injected memories indicator ──────────────────────────────────────────────

function estimateMemoryTokens(mem: InjectedMemory): number {
  const text = `${mem.content}${mem.subject ?? ''}${mem.category}`
  return Math.ceil(text.length / 3.5)
}

function formatMemoryTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function InjectedMemoriesIndicator({ memories }: { memories: InjectedMemory[] }) {
  const { t } = useTranslation()
  const count = memories.length
  const totalTokens = memories.reduce((sum, m) => sum + estimateMemoryTokens(m), 0)

  return (
    <Collapsible>
      <CollapsibleTrigger className="group mt-1.5 flex items-center gap-1.5 text-xs text-chart-2 hover:text-chart-2/80 transition-colors">
        <Brain className="size-3.5" />
        <span>
          {count === 1 ? t('chat.memoriesUsedSingular') : t('chat.memoriesUsed', { count })}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/70">~{formatMemoryTokens(totalTokens)}t</span>
        <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1.5 space-y-1 rounded-lg border border-chart-2/20 bg-chart-2/5 px-3 py-2">
          {memories.map((mem) => {
            const memTokens = estimateMemoryTokens(mem)
            return (
              <div key={mem.id} className="flex items-start gap-2 text-xs">
                <Badge variant="secondary" size="xs" className="mt-0.5 shrink-0">
                  {t(`settings.memories.category.${mem.category}`)}
                </Badge>
                <span className="text-muted-foreground whitespace-pre-wrap min-w-0 flex-1">
                  {mem.content}
                  {mem.subject && (
                    <span className="ml-1 text-muted-foreground/60">({mem.subject})</span>
                  )}
                </span>
                <span className="shrink-0 self-start mt-0.5 font-mono text-[10px] text-muted-foreground/60 tabular-nums">
                  {formatMemoryTokens(memTokens)}t
                </span>
              </div>
            )
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

// ─── Reasoning/thinking block ────────────────────────────────────────────────

function ReasoningBlock({ reasoning }: { reasoning: string }) {
  const { t } = useTranslation()

  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger className="group mt-1.5 flex items-center gap-1.5 text-xs text-chart-4 hover:text-chart-4/80 transition-colors">
        <Brain className="size-3.5" />
        <span>{t('chat.thinking')}</span>
        <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1.5 rounded-lg border border-chart-4/20 bg-chart-4/5 px-3 py-2 text-xs text-muted-foreground italic">
          <MarkdownContent content={reasoning} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

// ─── Copy message button ──────────────────────────────────────────────────────

function CopyMessageButton({ content, isUser }: { content: string; isUser: boolean }) {
  const { t } = useTranslation()
  const { copy, copied } = useCopyToClipboard()

  const handleCopy = useCallback(() => {
    copy(content, { successKey: 'chat.copied', errorKey: 'chat.copyFailed' })
  }, [content, copy])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'absolute opacity-0 group-hover/msg:opacity-100 transition-opacity',
        'rounded-md p-1 hover:bg-muted/80 active:scale-95',
        'text-muted-foreground hover:text-foreground',
        isUser ? '-left-8 top-1' : '-right-8 top-1',
      )}
      title={t('chat.copyMessage')}
      aria-label={t('chat.copyMessage')}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}

// ─── Read aloud button (Web Speech API) ───────────────────────────────────────

function ReadAloudButton({ content }: { content: string }) {
  const { t } = useTranslation()
  const [isSpeaking, setIsSpeaking] = useState(false)
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null)

  // Clean markdown/code artifacts for more natural speech
  const plainText = useMemo(() => {
    return content
      .replace(/```[\s\S]*?```/g, '') // remove code blocks
      .replace(/`([^`]+)`/g, '$1') // inline code → text
      .replace(/!\[.*?\]\(.*?\)/g, '') // remove images
      .replace(/\[([^\]]+)\]\(.*?\)/g, '$1') // links → text
      .replace(/[#*_~>]/g, '') // strip markdown symbols
      .replace(/\n{2,}/g, '. ') // paragraph breaks → pauses
      .replace(/\n/g, ' ')
      .trim()
  }, [content])

  // Sync state if speech ends externally
  useEffect(() => {
    const handleEnd = () => setIsSpeaking(false)
    const utt = utteranceRef.current
    if (utt) {
      utt.addEventListener('end', handleEnd)
      utt.addEventListener('error', handleEnd)
    }
    return () => {
      if (utt) {
        utt.removeEventListener('end', handleEnd)
        utt.removeEventListener('error', handleEnd)
      }
    }
  })

  const handleToggle = useCallback(() => {
    if (!('speechSynthesis' in window)) return

    if (isSpeaking) {
      window.speechSynthesis.cancel()
      setIsSpeaking(false)
      return
    }

    // Stop any other ongoing speech
    window.speechSynthesis.cancel()

    const utt = new SpeechSynthesisUtterance(plainText)
    utt.onend = () => setIsSpeaking(false)
    utt.onerror = () => setIsSpeaking(false)
    utteranceRef.current = utt
    window.speechSynthesis.speak(utt)
    setIsSpeaking(true)
  }, [isSpeaking, plainText])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (isSpeaking) window.speechSynthesis.cancel()
    }
  }, [isSpeaking])

  // Don't render if Web Speech API is unavailable or content is empty/only code
  if (!('speechSynthesis' in globalThis) || !plainText) return null

  return (
    <button
      type="button"
      onClick={handleToggle}
      className={cn(
        'opacity-0 group-hover/msg:opacity-100 transition-opacity',
        'rounded-md p-1 hover:bg-muted/80 active:scale-95',
        'text-muted-foreground hover:text-foreground',
        isSpeaking && 'opacity-100 text-primary',
      )}
      title={isSpeaking ? t('chat.readAloud.stop') : t('chat.readAloud.start')}
      aria-label={isSpeaking ? t('chat.readAloud.stop') : t('chat.readAloud.start')}
    >
      {isSpeaking ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
    </button>
  )
}

// ─── Edit & resend button ─────────────────────────────────────────────────────

function EditResendButton({ content, onEditResend }: { content: string; onEditResend: (text: string) => void }) {
  const { t } = useTranslation()

  const handleClick = useCallback(() => {
    onEditResend(content)
  }, [content, onEditResend])

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'absolute opacity-0 group-hover/msg:opacity-100 transition-opacity',
        'rounded-md p-1 hover:bg-muted/80 active:scale-95',
        'text-muted-foreground hover:text-foreground',
        '-left-8 top-7',
      )}
      title={t('chat.editResend')}
      aria-label={t('chat.editResend')}
    >
      <Pencil className="size-3.5" />
    </button>
  )
}

// ─── Regenerate button ────────────────────────────────────────────────────────

function RegenerateButton({ onRegenerate }: { onRegenerate: () => void }) {
  const { t } = useTranslation()

  return (
    <button
      type="button"
      onClick={onRegenerate}
      className={cn(
        'opacity-0 group-hover/msg:opacity-100 transition-opacity',
        'rounded-md p-1 hover:bg-muted/80 active:scale-95',
        'text-muted-foreground hover:text-foreground',
      )}
      title={t('chat.regenerate')}
      aria-label={t('chat.regenerate')}
    >
      <RefreshCw className="size-3.5" />
    </button>
  )
}

// ─── Reading time estimate ────────────────────────────────────────────────

/** Average reading speed in words per minute. */
const WORDS_PER_MINUTE = 200
/** Minimum word count before showing reading time. */
const READING_TIME_THRESHOLD = 100

function ReadingTime({ content }: { content: string }) {
  const { t } = useTranslation()

  const minutes = useMemo(() => {
    // Strip code blocks and markdown noise for a more accurate word count
    const cleaned = content
      .replace(/```[\s\S]*?```/g, '') // remove code blocks
      .replace(/`[^`]+`/g, '') // remove inline code
      .replace(/!\[.*?\]\(.*?\)/g, '') // remove images
      .replace(/\[([^\]]+)\]\(.*?\)/g, '$1') // links → text
      .replace(/[#*_~>|]/g, '') // strip markdown symbols
    const words = cleaned.trim().split(/\s+/).filter(Boolean).length
    if (words < READING_TIME_THRESHOLD) return 0
    return Math.max(1, Math.round(words / WORDS_PER_MINUTE))
  }, [content])

  if (minutes === 0) return null

  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/50">
      <BookOpen className="size-2.5" />
      {t('chat.readingTime', { minutes })}
    </span>
  )
}


// ─── Reaction display & picker ────────────────────────────────────────────────

function ReactionPicker({ onSelect, isUser }: { onSelect: (emoji: string) => void; isUser: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div className="relative inline-block" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'opacity-0 group-hover/msg:opacity-100 transition-opacity',
          'rounded-md p-1 hover:bg-muted/80 active:scale-95',
          'text-muted-foreground hover:text-foreground',
        )}
        title={t('chat.react')}
        aria-label={t('chat.react')}
      >
        <SmilePlus className="size-3.5" />
      </button>
      {open && (
        <div
          className={cn(
            'absolute z-50 flex gap-0.5 rounded-full bg-popover border border-border shadow-lg px-2 py-1',
            isUser ? 'right-0' : 'left-0',
            'bottom-full mb-1',
          )}
        >
          {PRESET_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => { onSelect(emoji); setOpen(false) }}
              className="hover:scale-125 transition-transform text-base px-0.5"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ReactionDisplay({
  reactions,
  currentUserId,
  onToggle,
}: {
  reactions: MessageReaction[]
  currentUserId?: string
  onToggle?: (emoji: string) => void
}) {
  if (!reactions || reactions.length === 0) return null

  // Group by emoji
  const grouped = new Map<string, { count: number; hasOwn: boolean }>()
  for (const r of reactions) {
    const entry = grouped.get(r.emoji) ?? { count: 0, hasOwn: false }
    entry.count++
    if (r.userId === currentUserId) entry.hasOwn = true
    grouped.set(r.emoji, entry)
  }

  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {Array.from(grouped.entries()).map(([emoji, { count, hasOwn }]) => (
        <button
          key={emoji}
          type="button"
          onClick={() => onToggle?.(emoji)}
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-colors border',
            hasOwn
              ? 'bg-primary/15 border-primary/30 text-foreground'
              : 'bg-muted/50 border-border/50 text-muted-foreground hover:bg-muted',
          )}
        >
          <span>{emoji}</span>
          {count > 1 && <span className="text-[10px]">{count}</span>}
        </button>
      ))}
    </div>
  )
}

// ─── Message context menu ─────────────────────────────────────────────────────

function MessageContextMenu({
  children,
  content,
  isUser,
  onRegenerate,
  onQuoteReply,
  onEditResend,
}: {
  children: React.ReactNode
  content: string
  isUser: boolean
  onRegenerate?: () => void
  onQuoteReply?: (text: string) => void
  onEditResend?: (text: string) => void
}) {
  const { t } = useTranslation()
  const { copy } = useCopyToClipboard()

  const handleCopy = useCallback(() => {
    copy(content, { successKey: 'chat.copied', errorKey: 'chat.copyFailed' })
  }, [content, copy])

  const handleQuote = useCallback(() => {
    if (onQuoteReply) {
      // Build a blockquote from first 3 lines of content
      const lines = content.split('\n').filter((l) => l.trim())
      const preview = lines.slice(0, 3).map((l) => `> ${l}`).join('\n')
      const suffix = lines.length > 3 ? '\n> ...' : ''
      onQuoteReply(`${preview}${suffix}\n\n`)
    }
  }, [content, onQuoteReply])

  const handleEditResend = useCallback(() => {
    if (onEditResend) {
      onEditResend(content)
    }
  }, [content, onEditResend])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={handleCopy}>
          <Copy className="size-4" />
          {t('chat.contextMenu.copy')}
        </ContextMenuItem>
        {onQuoteReply && (
          <ContextMenuItem onClick={handleQuote}>
            <Quote className="size-4" />
            {t('chat.contextMenu.quote')}
          </ContextMenuItem>
        )}
        {isUser && onEditResend && (
          <ContextMenuItem onClick={handleEditResend}>
            <Pencil className="size-4" />
            {t('chat.contextMenu.editResend')}
          </ContextMenuItem>
        )}
        {!isUser && 'speechSynthesis' in globalThis && (
          <ContextMenuItem onClick={() => {
            window.speechSynthesis.cancel()
            const plainText = content
              .replace(/```[\s\S]*?```/g, '')
              .replace(/`([^`]+)`/g, '$1')
              .replace(/!\[.*?\]\(.*?\)/g, '')
              .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')
              .replace(/[#*_~>]/g, '')
              .replace(/\n{2,}/g, '. ')
              .replace(/\n/g, ' ')
              .trim()
            if (plainText) {
              const utt = new SpeechSynthesisUtterance(plainText)
              window.speechSynthesis.speak(utt)
            }
          }}>
            <Volume2 className="size-4" />
            {t('chat.contextMenu.readAloud')}
          </ContextMenuItem>
        )}
        {!isUser && onRegenerate && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onRegenerate}>
              <RefreshCw className="size-4" />
              {t('chat.regenerate')}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

// ─── Message bubble ───────────────────────────────────────────────────────────

/** A small avatar tile rendered inside the transfer card. Small when the
 *  Kin is the "other" side of the handoff, big when it's the current Kin
 *  (the one whose history the user is viewing). */
function TransferAvatar({ name, avatarUrl, size }: { name: string; avatarUrl: string | null; size: 'big' | 'small' }) {
  const dim = size === 'big' ? 'size-10' : 'size-7'
  const txt = size === 'big' ? 'text-sm' : 'text-[10px]'
  const initials = name?.slice(0, 2).toUpperCase() || 'K'
  return (
    <div className={cn(dim, 'shrink-0 overflow-hidden rounded-lg bg-muted flex items-center justify-center font-semibold text-muted-foreground/80', txt)}>
      {avatarUrl ? (
        <img src={avatarUrl} alt={name} className="size-full object-cover" />
      ) : (
        <span>{initials}</span>
      )}
    </div>
  )
}

/** Dedicated card for channel_transferred_in / channel_transferred_out
 *  system events. The two variants share the same structure (paired
 *  avatars, platform icon + channel name, optional reason, timestamp)
 *  but differ in accent color, directional arrow, verb, and the relative
 *  sizes of the two avatars so the user perceives the state in one
 *  glance (out: this Kin LOST the channel, in: this Kin GAINED it). */
function ChannelTransferCard({
  event,
  currentName,
  currentAvatarUrl,
  timestamp,
}: {
  event: ChannelTransferSystemEvent
  currentName: string | null
  currentAvatarUrl: string | null
  timestamp?: string
}) {
  const { t } = useTranslation()
  const isOut = event.type === 'channel_transferred_out'
  // Tone tokens: warm/destructive on out, primary/success-ish on in. The
  // exact tokens used here exist on every palette (semantic colors) so
  // the cards stay readable on all 8 design-system themes without
  // per-palette tuning.
  const accent = isOut
    ? {
        border: 'border-warning/50',
        bg: 'bg-warning/5',
        chipBg: 'bg-warning/15',
        chipText: 'text-warning',
        iconColor: 'text-warning',
        indicator: 'OUT',
      }
    : {
        border: 'border-success/50',
        bg: 'bg-success/5',
        chipBg: 'bg-success/15',
        chipText: 'text-success',
        iconColor: 'text-success',
        indicator: 'IN',
      }
  const DirectionalIcon = isOut ? ArrowRightFromLine : ArrowLeftFromLine
  // Avatar sizing reflects who "owns" the action in this row:
  //   out: current Kin (left, big) handed off to other Kin (right, small)
  //   in:  current Kin (right, big) received from other Kin (left, small)
  const leftIsCurrent = isOut
  const titleKey = isOut ? 'chat.transfer.outTitle' : 'chat.transfer.inTitle'
  const titleDefault = isOut
    ? 'Channel transferred to {{kinName}}'
    : 'Channel received from {{kinName}}'
  const subKey = isOut ? 'chat.transfer.outSubtext' : 'chat.transfer.inSubtext'
  const subDefault = isOut
    ? 'This Kin no longer has this channel.'
    : 'This Kin now has this channel.'

  return (
    <div className={cn('flex justify-center px-4 py-2', 'animate-fade-in')}>
      <div
        className={cn(
          'w-full max-w-md rounded-xl border bg-card/40 shadow-sm overflow-hidden',
          accent.border,
          accent.bg,
        )}
        role="article"
        aria-label={t(titleKey, titleDefault, { kinName: event.otherKin.name })}
      >
        {/* Top accent chip */}
        <div className={cn('flex items-center justify-between px-3 py-1 text-[10px] font-semibold uppercase tracking-wider', accent.chipBg, accent.chipText)}>
          <span className="flex items-center gap-1.5">
            <DirectionalIcon className="size-3" />
            {accent.indicator}
          </span>
          {event.at && (
            <span className="text-[10px] font-normal opacity-80 normal-case tracking-normal">
              {new Date(event.at).toLocaleString()}
            </span>
          )}
        </div>

        <div className="p-3 space-y-2">
          {/* Avatars row with directional arrow */}
          <div className="flex items-center gap-2">
            <TransferAvatar
              name={leftIsCurrent ? (currentName ?? 'Kin') : event.otherKin.name}
              avatarUrl={leftIsCurrent ? currentAvatarUrl ?? null : event.otherKin.avatarUrl}
              size={leftIsCurrent ? 'big' : 'small'}
            />
            <DirectionalIcon className={cn('size-4 shrink-0', accent.iconColor)} />
            <TransferAvatar
              name={leftIsCurrent ? event.otherKin.name : (currentName ?? 'Kin')}
              avatarUrl={leftIsCurrent ? event.otherKin.avatarUrl : currentAvatarUrl ?? null}
              size={leftIsCurrent ? 'small' : 'big'}
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate">
                {t(titleKey, titleDefault, { kinName: event.otherKin.name })}
              </p>
              <p className="text-[11px] text-muted-foreground truncate">
                {t(subKey, subDefault)}
              </p>
            </div>
          </div>

          {/* Channel pill */}
          {event.channelName && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {event.channelPlatform && (
                <PlatformIcon platform={event.channelPlatform} variant="color" className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{event.channelName}</span>
            </div>
          )}

          {/* Reason block */}
          {event.reason && (
            <blockquote className={cn('border-l-2 pl-2 text-xs italic text-muted-foreground', isOut ? 'border-warning/60' : 'border-success/60')}>
              {event.reason}
            </blockquote>
          )}

          {!event.at && timestamp && (
            <RelativeTimestamp timestamp={timestamp} className="text-[10px] text-muted-foreground/70" />
          )}
        </div>
      </div>
    </div>
  )
}

/** Small, discreet line under a channel-routed message that surfaces the
 *  adapter-supplied transport context (TTS vs text, voice, target channel…). */
function ChannelContextLine({ platform, text }: { platform: string | null; text: string }) {
  return (
    <p className="mt-1.5 flex items-center gap-1 text-[10px] italic text-muted-foreground/80">
      {platform && <PlatformIcon platform={platform} variant="mono" className="size-2.5 shrink-0" />}
      <span>{text}</span>
    </p>
  )
}

export const MessageBubble = memo(function MessageBubble({
  role,
  content,
  sourceType,
  avatarUrl,
  senderName,
  userInitials,
  timestamp,
  toolCalls,
  injectedMemories,
  stepLimitReached = false,
  files,
  reactions,
  currentUserId,
  messageId,
  resolvedTaskId,
  isRedacted = false,
  isGrouped = false,
  isNew = false,
  onOpenTaskDetail,
  onRegenerate,
  onQuoteReply,
  onEditResend,
  onToggleReaction,
  tokenUsage,
  providerType,
  reasoning,
  channelContextLine,
  channelBrandColor,
  channelPlatformOverride,
  systemEvent,
  currentKinAvatarUrl,
  currentKinName,
}: MessageBubbleProps) {
  const handleToggleReaction = useCallback((emoji: string) => {
    if (onToggleReaction && messageId) onToggleReaction(messageId, emoji)
  }, [onToggleReaction, messageId])

  const handleOpenTaskDetail = useCallback(() => {
    if (onOpenTaskDetail && resolvedTaskId) onOpenTaskDetail(resolvedTaskId)
  }, [onOpenTaskDetail, resolvedTaskId])

  const isUser = role === 'user' && sourceType === 'user'
  const isFromOtherKin = sourceType === 'kin' && role === 'user'
  const isFromChannel = sourceType === 'channel'
  const { t } = useTranslation()
  // Server-provided platform takes precedence; fall back to legacy regex
  // extraction so old persisted messages keep their icon.
  const channelPlatform = channelPlatformOverride
    ?? (isFromChannel ? content.match(/^\[(\w+):/)?.[1] ?? 'channel' : null)
  // Also surface the platform brand on outbound kin messages that were sent
  // through a channel (channelBrandColor is populated server-side via
  // channel_message_links).
  const hasChannelBrand = Boolean(channelBrandColor)
  const isTaskResult = sourceType === 'task'
  const isWebhook = sourceType === 'webhook'
  const isSystem = sourceType === 'system' || sourceType === 'cron'
  // Deduplicate tool calls by ID (safety net for race conditions between
  // streaming and fetched state that can produce the same call twice)
  const dedupedToolCalls = useMemo(() => {
    if (!toolCalls || toolCalls.length === 0) return toolCalls
    const seen = new Set<string>()
    return toolCalls.filter((tc) => {
      if (seen.has(tc.id)) return false
      seen.add(tc.id)
      return true
    })
  }, [toolCalls])
  const hasToolCalls = dedupedToolCalls && dedupedToolCalls.length > 0
  const hasFiles = files && files.length > 0
  const hasMemories = injectedMemories && injectedMemories.length > 0

  // Normalize reasoning prop: string (streaming) → single segment at offset 0, array → as-is
  const reasoningSegments = useMemo(() => {
    if (!reasoning) return undefined
    if (typeof reasoning === 'string') return [{ offset: 0, text: reasoning }]
    return reasoning
  }, [reasoning])
  const hasReasoning = reasoningSegments && reasoningSegments.length > 0

  const contentParts = useMemo(
    () => (hasToolCalls || hasReasoning ? buildContentParts(content, dedupedToolCalls ?? [], reasoningSegments) : null),
    [content, dedupedToolCalls, hasToolCalls, reasoningSegments, hasReasoning],
  )

  // Task result cards (from persisted messages)
  if (isTaskResult) {
    return <TaskResultCard mode="message" content={content} timestamp={timestamp} avatarUrl={avatarUrl} senderName={senderName} onOpenDetail={handleOpenTaskDetail} />
  }

  // Webhook message cards
  if (isWebhook) {
    return <WebhookMessageCard content={content} timestamp={timestamp} />
  }

  // System messages centered. Channel-transfer audit events (out/in) get
  // a dedicated colored card to make the handoff direction perceivable at
  // a glance; everything else falls through to the generic gray banner.
  if (isSystem) {
    if (systemEvent && (systemEvent.type === 'channel_transferred_out' || systemEvent.type === 'channel_transferred_in')) {
      return (
        <ChannelTransferCard
          event={systemEvent}
          currentName={currentKinName ?? null}
          currentAvatarUrl={currentKinAvatarUrl ?? null}
          timestamp={timestamp}
        />
      )
    }
    return (
      <div className={cn('flex justify-center px-4 py-2', isNew && 'animate-fade-in')}>
        <div className="rounded-lg bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
          {content}
        </div>
      </div>
    )
  }

  // Redacted content placeholder
  const redactedContent = isRedacted ? (
    <div className="flex items-center gap-1.5 text-muted-foreground italic">
      <EyeOff className="size-3.5 shrink-0" />
      <span className="text-sm">{t('chat.messageRedacted', 'This message was redacted')}</span>
    </div>
  ) : null

  const initials = (isUser && userInitials) ? userInitials : (senderName?.slice(0, 2).toUpperCase() ?? 'K')

  const bubbleClass = isFromOtherKin
    ? 'bg-accent text-accent-foreground border border-border'
    : 'bg-muted text-foreground'

  // Assistant messages with tool calls: interleaved layout
  if (!isUser && contentParts) {
    return (
      <MessageContextMenu content={content} isUser={false} onRegenerate={onRegenerate} onQuoteReply={onQuoteReply} onEditResend={onEditResend}>
      <div className={cn('flex gap-3 px-4', isNew && 'animate-fade-in-up', isGrouped ? 'py-0.5' : 'py-2')}>
        {isGrouped ? (
          <div className="size-10 shrink-0" />
        ) : (
          <ChatAvatar avatarUrl={avatarUrl} name={senderName} />
        )}

        <div className="group/msg relative max-w-[80%] space-y-1.5">
          {!isGrouped && senderName && (
            <p className="text-xs font-medium text-muted-foreground">{senderName}</p>
          )}

          <CopyMessageButton content={content} isUser={false} />

          {/* Interleaved content parts */}
          {contentParts.map((part, i) =>
            part.type === 'text' ? (
              <div
                key={`text-${i}`}
                className={cn('rounded-2xl px-4 py-2.5', bubbleClass, i === 0 && 'rounded-tl-md')}
                style={hasChannelBrand && i === 0 ? { borderLeft: `3px solid ${channelBrandColor}` } : undefined}
              >
                {isRedacted ? redactedContent : <MarkdownContent content={part.text} isUser={false} />}
              </div>
            ) : part.type === 'reasoning' ? (
              <ReasoningBlock key={`reasoning-${i}`} reasoning={part.text} />
            ) : (
              <div key={`tools-${i}`} className="space-y-1">
                {part.tools.map((tc) => (
                  <InlineToolCall key={tc.id} toolCall={tc} />
                ))}
              </div>
            ),
          )}

          {/* Files after content parts */}
          {hasFiles && (
            <div className={cn('rounded-2xl px-4 py-2', bubbleClass)}>
              <MessageFiles files={files} isUser={false} />
            </div>
          )}

          {/* Channel transport context (platform-supplied, already localized) */}
          {channelContextLine && (
            <ChannelContextLine platform={channelPlatform} text={channelContextLine} />
          )}

          {/* Injected memories indicator */}
          {hasMemories && <InjectedMemoriesIndicator memories={injectedMemories} />}

          {/* Step limit indicator */}
          {stepLimitReached && (
            <div className="flex items-center gap-1.5 mt-1 text-[11px] text-warning">
              <span>⚠️</span>
              <span className="text-muted-foreground">{t('chat.stepLimitReached')}</span>
            </div>
          )}

          <ReactionDisplay reactions={reactions ?? []} currentUserId={currentUserId} onToggle={handleToggleReaction} />

          <div className="flex items-center gap-1.5">
            {timestamp && (
              <RelativeTimestamp timestamp={timestamp} className="text-[10px] text-muted-foreground/70" />
            )}
            <ReadingTime content={content} />
            {tokenUsage && <TokenUsageIndicator tokenUsage={tokenUsage} providerType={providerType} />}
            {onRegenerate && <RegenerateButton onRegenerate={onRegenerate} />}
            <ReadAloudButton content={content} />
            {onToggleReaction && <ReactionPicker onSelect={handleToggleReaction} isUser={false} />}
          </div>
        </div>
      </div>
      </MessageContextMenu>
    )
  }

  // Standard message (user or assistant without tool calls)
  return (
    <MessageContextMenu content={content} isUser={isUser} onRegenerate={isUser ? undefined : onRegenerate} onQuoteReply={onQuoteReply} onEditResend={isUser ? onEditResend : undefined}>
    <div
      className={cn(
        'flex gap-3 px-4',
        isNew && 'animate-fade-in-up',
        isUser ? 'flex-row-reverse' : 'flex-row',
        isGrouped ? 'py-0.5' : 'py-2',
      )}
    >
      {isGrouped ? (
        /* Invisible spacer preserving alignment with the avatar column */
        <div className="size-10 shrink-0" />
      ) : (
        <ChatAvatar avatarUrl={avatarUrl} name={senderName} />
      )}

      <div
        className={cn(
          'group/msg relative max-w-[80%] rounded-2xl px-4 py-2.5',
          isUser
            ? cn('bg-primary text-primary-foreground', !isGrouped && 'rounded-tr-md')
            : isFromOtherKin
              ? cn('bg-accent text-accent-foreground border border-border', !isGrouped && 'rounded-tl-md')
              : isFromChannel
                ? cn('bg-accent text-accent-foreground border border-chart-4/30', !isGrouped && 'rounded-tl-md')
                : cn('bg-muted text-foreground', !isGrouped && 'rounded-tl-md'),
        )}
        style={hasChannelBrand ? { borderLeft: `3px solid ${channelBrandColor}` } : undefined}
      >
        <CopyMessageButton content={content} isUser={isUser} />
        {isUser && onEditResend && <EditResendButton content={content} onEditResend={onEditResend} />}
        {!isGrouped && senderName && (
          <p className={cn(
            'mb-1 text-xs font-medium flex items-center gap-1.5',
            isUser ? 'text-primary-foreground/70' : 'text-muted-foreground',
          )}>
            {isFromChannel && channelPlatform && <PlatformIcon platform={channelPlatform} variant="color" className="size-3" />}
            {senderName}
          </p>
        )}

        {isRedacted ? redactedContent : <MarkdownContent content={content} isUser={isUser} />}

        {!isRedacted && hasFiles && <MessageFiles files={files} isUser={isUser} />}

        {/* Channel transport context (platform-supplied, already localized) */}
        {!isRedacted && channelContextLine && (
          <ChannelContextLine platform={channelPlatform} text={channelContextLine} />
        )}

        {/* Injected memories indicator */}
        {!isRedacted && hasMemories && <InjectedMemoriesIndicator memories={injectedMemories} />}

        {/* Step limit indicator */}
        {!isRedacted && stepLimitReached && (
          <div className="flex items-center gap-1.5 mt-1 text-[11px]">
            <span>⚠️</span>
            <span className="text-muted-foreground">{t('chat.stepLimitReached')}</span>
          </div>
        )}

        <ReactionDisplay reactions={reactions ?? []} currentUserId={currentUserId} onToggle={handleToggleReaction} />

        <div className="flex items-center gap-1.5 mt-1">
          {timestamp && (
            <RelativeTimestamp
              timestamp={timestamp}
              className={cn(
                'text-[10px]',
                isUser ? 'text-primary-foreground/50' : 'text-muted-foreground/70',
              )}
            />
          )}
          {!isUser && <ReadingTime content={content} />}
          {!isUser && tokenUsage && <TokenUsageIndicator tokenUsage={tokenUsage} providerType={providerType} />}
          {!isUser && onRegenerate && <RegenerateButton onRegenerate={onRegenerate} />}
          {!isUser && <ReadAloudButton content={content} />}
          {onToggleReaction && <ReactionPicker onSelect={handleToggleReaction} isUser={isUser} />}
        </div>
      </div>
    </div>
    </MessageContextMenu>
  )
})
