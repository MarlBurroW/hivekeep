import { useRef, useState, useCallback, useEffect, useMemo, forwardRef, useImperativeHandle, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/client/components/ui/button'
import { Textarea } from '@/client/components/ui/textarea'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/client/components/ui/tooltip'
import { cn } from '@/client/lib/utils'
import { ArrowUp, Square, Paperclip, X, FileIcon, Loader2, Wrench } from 'lucide-react'
import { useInputHistory } from '@/client/hooks/useInputHistory'
import { MAX_MESSAGE_LENGTH } from '@/shared/constants'
import { MentionPopover, getMentionItemCount, getMentionItemAt, type MentionItem } from '@/client/components/chat/MentionPopover'
import { CommandPopover, getFilteredCommands, SLASH_COMMANDS, type SlashCommand } from '@/client/components/chat/CommandPopover'
import { useWorkspaceFileSearch } from '@/client/hooks/useWorkspaceFileSearch'
import { getCaretCoordinates } from '@/client/lib/getCaretCoordinates'
import type { MentionableUser, MentionableAgent } from '@/client/hooks/useMentionables'
import type { PendingFile } from '@/client/hooks/useFileUpload'
import { ModelPicker, modelPickerValue } from '@/client/components/common/ModelPicker'
import { ThinkingEffortPicker } from '@/client/components/chat/ThinkingEffortPicker'
import type { AgentThinkingEffort } from '@/shared/types'
import type { ProviderModel } from '@/client/hooks/useModels'
import { modelReasoningInfo } from '@/client/lib/model-efforts'

export interface MessageInputHandle {
  focus: () => void
}

interface MessageInputProps {
  onSend: (content: string, fileIds?: string[]) => void
  onStop?: () => void
  isStreaming?: boolean
  /** Agent is processing (dequeued) but may not have started streaming tokens yet */
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
  /** Agent ID for input history (Up/Down arrow to cycle through sent messages) */
  agentId?: string
  /** Users available for @mention autocomplete */
  mentionableUsers?: MentionableUser[]
  /** Agents available for @mention autocomplete */
  mentionableAgents?: MentionableAgent[]
  // ── Generation controls (relocated from the conversation header) ──
  /** Models available for the model picker. When omitted the picker is hidden. */
  llmModels?: ProviderModel[]
  /** Currently selected model id. */
  model?: string
  /** Provider id backing the selected model (disambiguates same-id models). */
  providerId?: string | null
  /** Change the model for the next message. */
  onModelChange?: (modelId: string, providerId: string) => void
  /** Whether extended thinking is enabled. */
  thinkingEnabled?: boolean
  /** Current thinking effort level. */
  thinkingEffort?: AgentThinkingEffort | null
  /** Change thinking enabled/effort. When omitted the effort picker is hidden. */
  onChangeThinking?: (next: { enabled: boolean; effort: AgentThinkingEffort | null }) => void
  /** Number of tools currently exposed to the agent — shown as a badge next to
   *  the effort picker. Hidden when undefined. */
  toolCount?: number
  /** Opens the tools listing modal (owned by the parent panel). */
  onShowTools?: () => void
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
  agentId,
  mentionableUsers,
  mentionableAgents,
  llmModels,
  model,
  providerId,
  onModelChange,
  thinkingEnabled = false,
  thinkingEffort = null,
  onChangeThinking,
  toolCount,
  onShowTools,
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

  // Workspace files group of the @ palette (files.md § 5.1) — scoped to the
  // conversation agent, server-side search-as-you-type.
  // Stable reference: an inline `{ type, id }` here would be a new object every
  // render, which (via this hook's effect deps) re-runs the search effect on
  // every render. Memoize so it only changes when the agent does.
  const mentionFileSource = useMemo(
    () => (agentId ? { type: 'agent' as const, id: agentId } : null),
    [agentId],
  )
  const { hits: mentionFileHits } = useWorkspaceFileSearch({
    query: mentionQuery ?? '',
    source: mentionFileSource,
    enabled: mentionQuery !== null && !!agentId,
  })
  const isMentionOpen =
    mentionQuery !== null &&
    ((mentionableUsers?.length ?? 0) > 0 || (mentionableAgents?.length ?? 0) > 0 || mentionFileHits.length > 0)

  // Slash command autocomplete state
  const [commandQuery, setCommandQuery] = useState<string | null>(null)
  const [commandSelectedIndex, setCommandSelectedIndex] = useState(0)
  const [commandPosition, setCommandPosition] = useState<{ top: number; left: number }>({ top: 8, left: 0 })
  const isCommandOpen = commandQuery !== null

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }))

  const history = useInputHistory(agentId ?? '__default__')

  /** Detect @mention trigger from the current cursor position */
  const detectMention = useCallback((text: string, cursorPos: number) => {
    // Walk backwards from cursor to find @ that starts this mention.
    // `.` and `/` are allowed inside the query so file paths (`@docs/report.md`)
    // keep the palette open — user/agent handles never contain them anyway.
    let i = cursorPos - 1
    while (i >= 0 && /[a-zA-Z0-9_./-]/.test(text[i]!)) i--

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
    })
  }, [onChange, detectMention, detectCommand])

  /** Insert selected mention into the text */
  const handleMentionSelect = useCallback((item: MentionItem) => {
    const before = value.slice(0, mentionStartIndex)
    const after = value.slice(mentionStartIndex + 1 + (mentionQuery?.length ?? 0)) // +1 for the @
    // Files drop the @ and insert the relative path in backticks: agents read
    // the path with their filesystem tools and the renderer turns it into a
    // clickable chip; backticks delimit spaces/accents (files.md § 5.1).
    const insertion = item.type === 'file' ? `\`${item.handle}\`` : `@${item.handle}`
    const newValue = `${before}${insertion} ${after}`
    onChange(newValue)
    setMentionQuery(null)

    // Place cursor right after the inserted mention
    const cursorPos = before.length + insertion.length + 1
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(cursorPos, cursorPos)
      textareaRef.current?.focus()
    })
  }, [value, onChange, mentionStartIndex, mentionQuery])

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

    // Mention popover keyboard navigation
    if (isMentionOpen) {
      const count = getMentionItemCount(mentionQuery!, mentionableUsers ?? [], mentionableAgents ?? [], mentionFileHits)
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
          const item = getMentionItemAt(mentionSelectedIndex, mentionQuery!, mentionableUsers ?? [], mentionableAgents ?? [], mentionFileHits)
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

  // Gate image/PDF attachments the selected model explicitly can't accept (the
  // registry exposes the capability). Fail-open on unknown — only block on a hard
  // `false`. Text files always pass (they're inlined as text).
  const addFilesGated = useCallback(
    (files: FileList | File[]) => {
      if (!onAddFiles) return
      const selected = llmModels?.find((m) => m.id === model && (!providerId || m.providerId === providerId))
      const imageBlocked = selected?.supportsImageInput === false
      const pdfBlocked = selected?.supportsPdfInput === false
      const arr = Array.from(files)
      if (!imageBlocked && !pdfBlocked) { onAddFiles(arr); return }
      const accepted: File[] = []
      const rejected: string[] = []
      for (const f of arr) {
        if (imageBlocked && f.type.startsWith('image/')) rejected.push(f.name)
        else if (pdfBlocked && f.type === 'application/pdf') rejected.push(f.name)
        else accepted.push(f)
      }
      if (rejected.length > 0) {
        toast.warning(t('chat.attachmentUnsupported', {
          model: selected?.name ?? model,
          files: rejected.join(', '),
          defaultValue: "{{model}} can't read these — skipped: {{files}}",
        }))
      }
      if (accepted.length > 0) onAddFiles(accepted)
    },
    [onAddFiles, llmModels, model, providerId, t],
  )

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        addFilesGated(e.target.files)
      }
      // Reset so the same file can be re-selected
      e.target.value = ''
    },
    [addFilesGated],
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
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        addFilesGated(e.dataTransfer.files)
      }
    },
    [addFilesGated],
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
        addFilesGated(files)
      }
    },
    [onAddFiles, addFilesGated],
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
          {isMentionOpen && (
            <MentionPopover
              query={mentionQuery!}
              users={mentionableUsers ?? []}
              agents={mentionableAgents ?? []}
              files={mentionFileHits}
              selectedIndex={mentionSelectedIndex}
              position={mentionPosition}
              onSelect={handleMentionSelect}
            />
          )}

          {/* /command autocomplete popover */}
          {isCommandOpen && !isMentionOpen && (
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
                reasoning={llmModels && model
                  ? modelReasoningInfo(llmModels.find((m) => m.id === model && (!providerId || m.providerId === providerId)))
                  : undefined}
                compact
              />
            )}

            {onShowTools && toolCount !== undefined && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0 gap-1 rounded-lg px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
                    onClick={onShowTools}
                  >
                    <Wrench className="size-3.5" />
                    <span className="tabular-nums">{toolCount}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('chat.toolsBadge.tooltip', { count: toolCount, defaultValue: '{{count}} tools available — click to list them' })}</TooltipContent>
              </Tooltip>
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

            {/* Send / Stop — one button that morphs with the Agent's state.
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
