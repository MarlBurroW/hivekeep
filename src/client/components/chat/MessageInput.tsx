import { useRef, useState, useCallback, useEffect, forwardRef, useImperativeHandle, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/client/components/ui/button'
import { Textarea } from '@/client/components/ui/textarea'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/client/components/ui/tooltip'
import { cn } from '@/client/lib/utils'
import { ArrowUp, Square, Paperclip, X, FileIcon, Loader2 } from 'lucide-react'
import { useInputHistory } from '@/client/hooks/useInputHistory'
import { MAX_MESSAGE_LENGTH } from '@/shared/constants'
import { MentionPopover, getMentionItemCount, getMentionItemAt, type MentionItem } from '@/client/components/chat/MentionPopover'
import { CommandPopover, getFilteredCommands, SLASH_COMMANDS, type SlashCommand } from '@/client/components/chat/CommandPopover'
import { TicketMentionPopover, TICKET_MENTION_MAX_VISIBLE } from '@/client/components/chat/TicketMentionPopover'
import { useTicketSearch, type TicketSearchHit } from '@/client/hooks/useTicketSearch'
import { getCaretCoordinates } from '@/client/lib/getCaretCoordinates'
import { PROJECT_SLUG_REGEX } from '@/shared/constants'
import type { MentionableUser, MentionableKin } from '@/client/hooks/useMentionables'
import type { PendingFile } from '@/client/hooks/useFileUpload'
import { ModelPicker, modelPickerValue } from '@/client/components/common/ModelPicker'
import { ThinkingEffortPicker } from '@/client/components/chat/ThinkingEffortPicker'
import type { KinThinkingEffort } from '@/shared/types'

export interface MessageInputHandle {
  focus: () => void
}

interface MessageInputProps {
  onSend: (content: string, fileIds?: string[]) => void
  onStop?: () => void
  isStreaming?: boolean
  /** Kin is processing (dequeued) but may not have started streaming tokens yet */
  isProcessing?: boolean
  disabled?: boolean
  disabledReason?: string
  /** Controlled text value */
  value: string
  /** Controlled text change handler */
  onChange: (value: string) => void
  /** Pending file attachments */
  pendingFiles?: PendingFile[]
  /** Whether any file is currently uploading */
  isUploading?: boolean
  /** Add files to the pending list */
  onAddFiles?: (files: FileList | File[]) => void
  /** Remove a pending file */
  onRemoveFile?: (localId: string) => void
  /** Inject a message into the current streaming response (/btw) */
  onInject?: (content: string) => void
  /** Handle a slash command (name without /, optional arg) */
  onCommand?: (command: string, arg?: string) => void
  /** Kin ID for input history (Up/Down arrow to cycle through sent messages) */
  kinId?: string
  /** Users available for @mention autocomplete */
  mentionableUsers?: MentionableUser[]
  /** Kins available for @mention autocomplete */
  mentionableKins?: MentionableKin[]
  /** Active project UUID for the `#` ticket mention autocomplete. When null,
   *  bare `#N` searches return nothing — the user must use a `slug#` prefix. */
  activeProjectId?: string | null
  /** Active project slug — used to short-circuit ticket mention insertion: a
   *  hit in the active project becomes `#42`, anywhere else becomes `slug#42`. */
  activeProjectSlug?: string | null
  // ── Generation controls (relocated from the conversation header) ──
  /** Models available for the model picker. When omitted the picker is hidden. */
  llmModels?: { id: string; name: string; providerId: string; providerName: string; providerType: string; capability: string }[]
  /** Currently selected model id. */
  model?: string
  /** Provider id backing the selected model (disambiguates same-id models). */
  providerId?: string | null
  /** Change the model for the next message. */
  onModelChange?: (modelId: string, providerId: string) => void
  /** Whether extended thinking is enabled. */
  thinkingEnabled?: boolean
  /** Current thinking effort level. */
  thinkingEffort?: KinThinkingEffort | null
  /** Change thinking enabled/effort. When omitted the effort picker is hidden. */
  onChangeThinking?: (next: { enabled: boolean; effort: KinThinkingEffort | null }) => void
}

export const MessageInput = memo(forwardRef<MessageInputHandle, MessageInputProps>(function MessageInput({
  onSend,
  onStop,
  isStreaming = false,
  isProcessing = false,
  disabled,
  disabledReason,
  value,
  onChange,
  pendingFiles,
  isUploading,
  onAddFiles,
  onRemoveFile,
  onInject,
  onCommand,
  kinId,
  mentionableUsers,
  mentionableKins,
  activeProjectId,
  activeProjectSlug,
  llmModels,
  model,
  providerId,
  onModelChange,
  thinkingEnabled = false,
  thinkingEffort = null,
  onChangeThinking,
}, ref) {
  const { t } = useTranslation()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragCounterRef = useRef(0)

  // Mention autocomplete state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionStartIndex, setMentionStartIndex] = useState(0)
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0)
  const [mentionPosition, setMentionPosition] = useState<{ top: number; left: number }>({ top: 8, left: 0 })
  const isMentionOpen = mentionQuery !== null && (mentionableUsers?.length || mentionableKins?.length)

  // Slash command autocomplete state
  const [commandQuery, setCommandQuery] = useState<string | null>(null)
  const [commandSelectedIndex, setCommandSelectedIndex] = useState(0)
  const [commandPosition, setCommandPosition] = useState<{ top: number; left: number }>({ top: 8, left: 0 })
  const isCommandOpen = commandQuery !== null

  // Ticket mention autocomplete state.
  //   - ticketQuery: the text after the `#` (sans optional `slug#` prefix)
  //   - ticketProjectSlug: the optional slug typed before `#`. When set, the
  //     server scopes the search to that project (cross-project mention).
  //   - ticketStartIndex: position of the first char of the matched token in
  //     the textarea value. Used to compute the replacement range on select.
  const [ticketQuery, setTicketQuery] = useState<string | null>(null)
  const [ticketProjectSlug, setTicketProjectSlug] = useState<string | null>(null)
  const [ticketStartIndex, setTicketStartIndex] = useState(0)
  const [ticketSelectedIndex, setTicketSelectedIndex] = useState(0)
  const [ticketPosition, setTicketPosition] = useState<{ top: number; left: number }>({ top: 8, left: 0 })
  const isTicketOpen = ticketQuery !== null

  const { hits: ticketHits, isLoading: isTicketLoading } = useTicketSearch({
    query: ticketQuery ?? '',
    projectId: activeProjectId ?? null,
    projectSlug: ticketProjectSlug,
    enabled: isTicketOpen,
  })

  // Cap the visible slice; the inner list scrolls if the server returned more.
  const visibleTicketHits = ticketHits.slice(0, TICKET_MENTION_MAX_VISIBLE * 2)

  // Reset the selected row whenever the result set changes so the highlight
  // never points beyond the array bounds.
  useEffect(() => {
    setTicketSelectedIndex(0)
  }, [ticketHits])

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }))

  const history = useInputHistory(kinId ?? '__default__')

  /** Detect @mention trigger from the current cursor position */
  const detectMention = useCallback((text: string, cursorPos: number) => {
    // Walk backwards from cursor to find @ that starts this mention
    let i = cursorPos - 1
    while (i >= 0 && /[a-zA-Z0-9_-]/.test(text[i]!)) i--

    if (i >= 0 && text[i] === '@') {
      // Check that @ is at start of text or preceded by whitespace
      if (i === 0 || /\s/.test(text[i - 1]!)) {
        const query = text.slice(i + 1, cursorPos)
        setMentionQuery(query)
        setMentionStartIndex(i)
        setMentionSelectedIndex(0)
        // Compute popover position from caret
        const textarea = textareaRef.current
        if (textarea) {
          const coords = getCaretCoordinates(textarea, i)
          const textareaRect = textarea.getBoundingClientRect()
          // Position the popover above the caret line (bottom-anchored)
          const distanceFromBottom = textareaRect.height - coords.top - coords.height
          setMentionPosition({ top: Math.max(distanceFromBottom, 8), left: coords.left })
        }
        return
      }
    }

    setMentionQuery(null)
  }, [])

  /** Detect `#ticket` trigger from the current cursor position. Recognises:
   *    - `#abc`           → bare ref, active project scope
   *    - `slug#abc`       → qualified ref, cross-project scope
   *  The match window starts at the `#` (or at the slug for qualified refs)
   *  and ends at the cursor. A non-alphanumeric char terminates the match. */
  const detectTicketMention = useCallback((text: string, cursorPos: number) => {
    // Walk backwards from cursor while the chars are part of the ticket query.
    // Allowed inside the query: letters/digits/`-`/`_` (so `slug#login-fix`
    // is matched as a whole). The `#` separator is handled below.
    let i = cursorPos - 1
    while (i >= 0 && /[a-zA-Z0-9_-]/.test(text[i]!)) i--

    // We expect a `#` at position `i`. If not, no trigger.
    if (i < 0 || text[i] !== '#') {
      setTicketQuery(null)
      setTicketProjectSlug(null)
      return
    }

    // Look for an optional slug just before the `#`. A slug is a contiguous
    // run of [a-z0-9-] starting with a letter. We stop at the first char that
    // breaks the slug regex or hits the start of the input.
    let slugStart = i
    while (slugStart > 0 && /[a-z0-9-]/.test(text[slugStart - 1]!)) slugStart--
    const slugCandidate = text.slice(slugStart, i)
    const hasSlug = slugCandidate.length > 0 && PROJECT_SLUG_REGEX.test(slugCandidate)

    // The token must be preceded by whitespace, start-of-text, or a non-word
    // boundary. This prevents `email#42` (where `email` is not a slug we know)
    // from triggering as well as `abc#42` glued to the previous word.
    const tokenStart = hasSlug ? slugStart : i
    if (tokenStart > 0 && !/[\s({[]/.test(text[tokenStart - 1]!)) {
      setTicketQuery(null)
      setTicketProjectSlug(null)
      return
    }

    const query = text.slice(i + 1, cursorPos)
    setTicketQuery(query)
    setTicketProjectSlug(hasSlug ? slugCandidate : null)
    setTicketStartIndex(tokenStart)

    // Position the popover under the caret line (bottom-anchored like @mention).
    const textarea = textareaRef.current
    if (textarea) {
      const coords = getCaretCoordinates(textarea, tokenStart)
      const textareaRect = textarea.getBoundingClientRect()
      const distanceFromBottom = textareaRect.height - coords.top - coords.height
      setTicketPosition({ top: Math.max(distanceFromBottom, 8), left: coords.left })
    }
  }, [])

  /** Detect /command trigger: only when / is at position 0 and no space yet (typing the command name) */
  const detectCommand = useCallback((text: string, cursorPos: number) => {
    // Command must start at beginning of input with /
    if (text.startsWith('/')) {
      // Extract the part after / up to cursor or first space
      const afterSlash = text.slice(1, cursorPos)
      // Only show popover while typing the command name (no space yet)
      if (!afterSlash.includes(' ')) {
        setCommandQuery(afterSlash)
        setCommandSelectedIndex(0)
        // Position popover above the textarea
        const textarea = textareaRef.current
        if (textarea) {
          const coords = getCaretCoordinates(textarea, 0)
          const textareaRect = textarea.getBoundingClientRect()
          const distanceFromBottom = textareaRect.height - coords.top - coords.height
          setCommandPosition({ top: Math.max(distanceFromBottom, 8), left: coords.left })
        }
        return
      }
    }
    setCommandQuery(null)
  }, [])

  /** Handle change: update value and detect mention/command */
  const handleChange = useCallback((newValue: string) => {
    onChange(newValue)
    // Use requestAnimationFrame to read cursor position after React updates the textarea
    requestAnimationFrame(() => {
      const cursor = textareaRef.current?.selectionStart ?? newValue.length
      detectMention(newValue, cursor)
      detectCommand(newValue, cursor)
      detectTicketMention(newValue, cursor)
    })
  }, [onChange, detectMention, detectCommand, detectTicketMention])

  /** Insert selected mention into the text */
  const handleMentionSelect = useCallback((item: MentionItem) => {
    const before = value.slice(0, mentionStartIndex)
    const after = value.slice(mentionStartIndex + 1 + (mentionQuery?.length ?? 0)) // +1 for the @
    const newValue = `${before}@${item.handle} ${after}`
    onChange(newValue)
    setMentionQuery(null)

    // Place cursor right after the inserted mention
    const cursorPos = mentionStartIndex + 1 + item.handle.length + 1
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(cursorPos, cursorPos)
      textareaRef.current?.focus()
    })
  }, [value, onChange, mentionStartIndex, mentionQuery])

  /** Insert the selected ticket mention into the textarea. The inserted form
   *  is the minimum readable representation:
   *    - same project   → `#42`
   *    - other project  → `slug#42`
   *  This relies on the renderer (remark-ticket-mentions) to keep both forms
   *  clickable post-render. */
  const handleTicketSelect = useCallback((hit: TicketSearchHit) => {
    // The matched token spans from ticketStartIndex to the current cursor.
    // We replace it with the canonical form + trailing space for ergonomics.
    const cursor = textareaRef.current?.selectionStart ?? value.length
    const before = value.slice(0, ticketStartIndex)
    const after = value.slice(cursor)

    const insertion =
      hit.projectSlug && hit.projectSlug !== activeProjectSlug
        ? `${hit.projectSlug}#${hit.number}`
        : `#${hit.number}`

    const newValue = `${before}${insertion} ${after}`
    onChange(newValue)
    setTicketQuery(null)
    setTicketProjectSlug(null)

    const cursorPos = ticketStartIndex + insertion.length + 1
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(cursorPos, cursorPos)
      textareaRef.current?.focus()
    })
  }, [value, onChange, ticketStartIndex, activeProjectSlug])

  /** Handle selecting a slash command from the popover */
  const handleCommandSelect = useCallback((cmd: SlashCommand) => {
    if (cmd.hasArg) {
      // Commands with args: insert "/name " and let user type the argument
      const newValue = `/${cmd.name} `
      onChange(newValue)
      setCommandQuery(null)
      requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(newValue.length, newValue.length)
        textareaRef.current?.focus()
      })
    } else {
      // Commands without args: execute immediately
      onChange('')
      setCommandQuery(null)
      onCommand?.(cmd.name)
    }
  }, [onChange, onCommand])

  const hasPendingFiles = pendingFiles && pendingFiles.length > 0
  const readyFileIds = pendingFiles?.filter((f) => f.status === 'done').map((f) => f.serverId!)

  const handleSubmit = () => {
    const trimmed = value.trim()
    if ((!trimmed && !hasPendingFiles) || disabled || isUploading || trimmed.length > MAX_MESSAGE_LENGTH) return

    // Handle slash commands
    const cmdMatch = trimmed.match(/^\/(\S+)(?:\s+(.+))?$/s)
    if (cmdMatch) {
      const cmdName = cmdMatch[1]!.toLowerCase()
      const cmdArg = cmdMatch[2]?.trim()

      // /btw: inject into current streaming response
      if (cmdName === 'btw' && cmdArg && (isStreaming || isProcessing) && onInject) {
        onInject(cmdArg)
        onChange('')
        return
      }

      // All other known commands: delegate to onCommand
      const knownCommands = SLASH_COMMANDS.map((c) => c.name)
      if (knownCommands.includes(cmdName) && onCommand) {
        onCommand(cmdName, cmdArg)
        onChange('')
        return
      }
    }

    history.push(trimmed)
    onSend(trimmed, readyFileIds?.length ? readyFileIds : undefined)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Command popover keyboard navigation
    if (isCommandOpen) {
      const cmds = getFilteredCommands(commandQuery!, isStreaming)
      if (cmds.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setCommandSelectedIndex((prev) => (prev + 1) % cmds.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setCommandSelectedIndex((prev) => (prev - 1 + cmds.length) % cmds.length)
          return
        }
        if (e.key === 'Tab') {
          e.preventDefault()
          const cmd = cmds[commandSelectedIndex]
          if (cmd) handleCommandSelect(cmd)
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setCommandQuery(null)
        return
      }
    }

    // Ticket mention popover keyboard navigation. Handled before the user
    // mention popover so they can't both react to the same key on a frame
    // where both happen to be open (only one is ever open in practice).
    if (isTicketOpen) {
      const count = visibleTicketHits.length
      if (count > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setTicketSelectedIndex((prev) => (prev + 1) % count)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setTicketSelectedIndex((prev) => (prev - 1 + count) % count)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const hit = visibleTicketHits[ticketSelectedIndex]
          if (hit) handleTicketSelect(hit)
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setTicketQuery(null)
        setTicketProjectSlug(null)
        return
      }
    }

    // Mention popover keyboard navigation
    if (isMentionOpen && mentionableUsers && mentionableKins) {
      const count = getMentionItemCount(mentionQuery!, mentionableUsers, mentionableKins)
      if (count > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setMentionSelectedIndex((prev) => (prev + 1) % count)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setMentionSelectedIndex((prev) => (prev - 1 + count) % count)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const item = getMentionItemAt(mentionSelectedIndex, mentionQuery!, mentionableUsers, mentionableKins)
          if (item) handleMentionSelect(item)
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionQuery(null)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
      return
    }

    // Input history navigation: Up/Down arrows when cursor is at position 0 (start of input)
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const textarea = e.currentTarget
      const cursorAtStart = textarea.selectionStart === 0 && textarea.selectionEnd === 0
      // Only navigate history when cursor is at position 0 (for Up) or input came from history (for Down)
      if (e.key === 'ArrowUp' && cursorAtStart) {
        const prev = history.navigate('up', value)
        if (prev !== null) {
          e.preventDefault()
          onChange(prev)
        }
      } else if (e.key === 'ArrowDown') {
        const next = history.navigate('down', value)
        if (next !== null) {
          e.preventDefault()
          onChange(next)
        }
      }
    }

    // Escape resets history browsing
    if (e.key === 'Escape') {
      history.reset()
    }

    // Formatting shortcuts
    const mod = e.ctrlKey || e.metaKey
    if (mod && !e.altKey) {
      if (e.key === 'b') { e.preventDefault(); e.stopPropagation(); wrapSelection('**', '**') }
      else if (e.key === 'i') { e.preventDefault(); e.stopPropagation(); wrapSelection('_', '_') }
      else if (e.key === 'e' && e.shiftKey) { e.preventDefault(); e.stopPropagation(); wrapSelection('```\n', '\n```') }
      else if (e.key === 'e') { e.preventDefault(); e.stopPropagation(); wrapSelection('`', '`') }
      else if (e.key === 'x' && e.shiftKey) { e.preventDefault(); e.stopPropagation(); wrapSelection('~~', '~~') }
    }
  }

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0 && onAddFiles) {
        onAddFiles(e.target.files)
      }
      // Reset so the same file can be re-selected
      e.target.value = ''
    },
    [onAddFiles],
  )

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (dragCounterRef.current === 1) setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) setIsDragging(false)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current = 0
      setIsDragging(false)
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0 && onAddFiles) {
        onAddFiles(e.dataTransfer.files)
      }
    },
    [onAddFiles],
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (!onAddFiles) return
      const items = e.clipboardData?.items
      if (!items) return

      const files: File[] = []
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile()
          if (file) files.push(file)
        }
      }

      if (files.length > 0) {
        e.preventDefault()
        onAddFiles(files)
      }
    },
    [onAddFiles],
  )

  /** Wrap the current selection (or insert at cursor) with markdown syntax */
  const wrapSelection = useCallback(
    (prefix: string, suffix: string) => {
      const textarea = textareaRef.current
      if (!textarea) return
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const selected = value.slice(start, end)

      const newValue =
        value.slice(0, start) + prefix + selected + suffix + value.slice(end)
      onChange(newValue)

      // Restore cursor position after React re-render
      requestAnimationFrame(() => {
        if (selected) {
          // Select the wrapped text
          textarea.setSelectionRange(start + prefix.length, end + prefix.length)
        } else {
          // Place cursor between prefix and suffix
          textarea.setSelectionRange(start + prefix.length, start + prefix.length)
        }
        textarea.focus()
      })
    },
    [value, onChange],
  )

  return (
    <div
      className="relative border-t bg-background/80 backdrop-blur-sm px-3 py-3 sm:px-4 sm:py-4"
      onDragEnter={onAddFiles ? handleDragEnter : undefined}
      onDragLeave={onAddFiles ? handleDragLeave : undefined}
      onDragOver={onAddFiles ? handleDragOver : undefined}
      onDrop={onAddFiles ? handleDrop : undefined}
    >
      {/* Drop zone overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/10">
          <p className="text-sm font-medium text-primary">{t('chat.dropFiles')}</p>
        </div>
      )}

      {/* Hidden file input */}
      {onAddFiles && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />
      )}

      {/* Composer surface — borderless, blends into its container */}
      <div className={cn(
        'mx-auto max-w-3xl rounded-2xl bg-muted/50 transition-all duration-200',
        'focus-within:bg-muted/70 focus-within:shadow-sm',
        isDragging && 'ring-2 ring-primary/50',
      )}>

        {/* Pending file chips */}
        {hasPendingFiles && (
          <div className="flex flex-wrap gap-2 px-3 pt-3 pb-1">
            {pendingFiles.map((pf) => (
              <div
                key={pf.localId}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs',
                  pf.status === 'error'
                    ? 'border-destructive/50 bg-destructive/10 text-destructive'
                    : 'border-border bg-muted/50 text-muted-foreground',
                )}
              >
                {/* Thumbnail or icon */}
                {pf.previewUrl ? (
                  <img
                    src={pf.previewUrl}
                    alt={pf.name}
                    className="size-8 rounded object-cover"
                  />
                ) : (
                  <FileIcon className="size-4 shrink-0" />
                )}

                <span className="max-w-28 truncate">{pf.name}</span>

                {pf.status === 'uploading' && (
                  <Loader2 className="size-3 shrink-0 animate-spin" />
                )}

                {onRemoveFile && (
                  <button
                    type="button"
                    onClick={() => onRemoveFile(pf.localId)}
                    className="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20 transition-colors"
                    aria-label={t('chat.removeFile')}
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Textarea — borderless, blends into the card */}
        <div className="relative">
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={disabledReason ?? t('chat.placeholder')}
            disabled={disabled}
            rows={1}
            className={cn(
              'min-h-12 max-h-48 resize-none border-0 bg-transparent dark:bg-transparent shadow-none outline-none',
              'focus-visible:ring-0 focus-visible:border-0 rounded-none',
              'px-4 py-3 text-sm',
              disabledReason && 'placeholder:text-warning/70',
            )}
          />

          {/* @mention autocomplete popover */}
          {isMentionOpen && mentionableUsers && mentionableKins && (
            <MentionPopover
              query={mentionQuery!}
              users={mentionableUsers}
              kins={mentionableKins}
              selectedIndex={mentionSelectedIndex}
              position={mentionPosition}
              onSelect={handleMentionSelect}
            />
          )}

          {/* #ticket autocomplete popover */}
          {isTicketOpen && (
            <TicketMentionPopover
              hits={visibleTicketHits}
              isLoading={isTicketLoading}
              selectedIndex={ticketSelectedIndex}
              position={ticketPosition}
              scopeProjectSlug={ticketProjectSlug}
              onSelect={handleTicketSelect}
              onHover={setTicketSelectedIndex}
            />
          )}

          {/* /command autocomplete popover */}
          {isCommandOpen && !isMentionOpen && !isTicketOpen && (
            <CommandPopover
              query={commandQuery!}
              selectedIndex={commandSelectedIndex}
              position={commandPosition}
              isStreaming={isStreaming}
              onSelect={handleCommandSelect}
            />
          )}
        </div>

        {/* Action bar */}
        <div className="flex items-center gap-1 px-2 pb-2 pt-0.5">
          {/* Left: attach + model + thinking */}
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            {onAddFiles && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                    disabled={disabled}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Paperclip className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('chat.attachFile')}</TooltipContent>
              </Tooltip>
            )}

            {llmModels && model && onModelChange && (
              <ModelPicker
                models={llmModels}
                value={modelPickerValue(model, providerId ?? '')}
                onValueChange={onModelChange}
                variant="ghost"
                className="h-8 w-auto min-w-0 max-w-[160px] shrink gap-1.5 rounded-lg px-2 text-xs font-normal text-muted-foreground hover:text-foreground sm:max-w-[200px]"
              />
            )}

            {onChangeThinking && (
              <ThinkingEffortPicker
                enabled={thinkingEnabled}
                effort={thinkingEffort}
                onChange={onChangeThinking}
                compact
              />
            )}
          </div>

          {/* Right: char count + stop + send */}
          <div className="flex shrink-0 items-center gap-1.5">
            {/* Character count */}
            <span className={cn(
              'text-[10px] tabular-nums transition-opacity duration-150 hidden sm:block',
              value.length > 0 ? 'opacity-100' : 'opacity-0',
              value.length > MAX_MESSAGE_LENGTH
                ? 'text-destructive font-medium'
                : value.length > MAX_MESSAGE_LENGTH * 0.75
                  ? 'text-destructive'
                  : value.length > MAX_MESSAGE_LENGTH * 0.5
                    ? 'text-warning'
                    : 'text-muted-foreground/50',
            )}>
              {value.length > MAX_MESSAGE_LENGTH
                ? t('chat.messageTooLong', { count: value.length, max: MAX_MESSAGE_LENGTH })
                : value.length > 0
                  ? t('chat.charCount', { count: value.length })
                  : '\u00A0'}
            </span>

            {/* Send / Stop — one button that morphs with the Kin's state.
                Follow-ups can still be queued while streaming via the Enter key. */}
            {(isStreaming || isProcessing) ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={onStop}
                    size="icon"
                    className="size-8 shrink-0 rounded-full bg-foreground text-background transition-transform hover:bg-foreground/90 hover:scale-105 active:scale-95"
                  >
                    <Square className="size-3 fill-current" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('chat.stop')}</TooltipContent>
              </Tooltip>
            ) : (
              <Button
                onClick={handleSubmit}
                disabled={disabled || isUploading || (!value.trim() && !hasPendingFiles) || value.length > MAX_MESSAGE_LENGTH}
                size="icon"
                className="size-8 shrink-0 rounded-full transition-transform hover:scale-105 active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
              >
                <ArrowUp className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}))
