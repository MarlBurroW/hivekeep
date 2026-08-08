import { useEffect, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/client/components/ui/button'
import { Textarea } from '@/client/components/ui/textarea'
import { Checkbox } from '@/client/components/ui/checkbox'
import { ChatAvatar } from '@/client/components/chat/ChatAvatar'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/client/components/ui/alert-dialog'
import { MessageBubble } from '@/client/components/chat/MessageBubble'
import { MessageInput } from '@/client/components/chat/MessageInput'
import { TypingIndicator } from '@/client/components/chat/TypingIndicator'
import { useQuickChat } from '@/client/hooks/useQuickChat'
import { WorkspacePathProvider } from '@/client/contexts/WorkspacePathContext'
import { useToolCalls } from '@/client/hooks/useToolCalls'
import { useDraftMessage } from '@/client/hooks/useDraftMessage'
import { useFileUpload } from '@/client/hooks/useFileUpload'
import { useAuth } from '@/client/hooks/useAuth'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/client/components/ui/tooltip'
// The composer's model/effort pickers here write PER-SESSION overrides (PATCH
// /quick-sessions/:id) — never the Agent's own configuration. (The original
// ModelPicker was removed in #71 precisely because it mutated the Agent
// globally; this is the session-scoped replacement.)
import { X, Zap, MessageSquare, LogOut, History, Pin, PinOff } from 'lucide-react'
import type { AgentThinkingEffort } from '@/shared/types'
import { AgentToolsModal } from '@/client/components/agent/AgentToolsModal'
import { useAgentTools } from '@/client/hooks/useAgentTools'
import { useAutoScroll } from '@/client/hooks/useAutoScroll'
import { cn } from '@/client/lib/utils'
import { ContextBar } from '@/client/components/chat/ContextBar'
import type { ContextTokenBreakdown } from '@/shared/types'

interface LLMModel {
  id: string
  name: string
  providerId: string
  providerName: string
  providerType: string
  capability: string
}

interface QuickChatPanelProps {
  agentId: string
  agentName: string
  agentAvatarUrl: string | null
  agentModel?: string
  llmModels?: LLMModel[]
  sessionId: string
  expiresAt?: number | null
  onHide: () => void
  onEnd: (saveMemory?: boolean, memorySummary?: string) => void
  onShowHistory?: () => void
  /** The agent's thinking defaults — shown until the session overrides them. */
  agentThinkingEnabled?: boolean
  agentThinkingEffort?: AgentThinkingEffort | null
  /** Opens the agent's tools management (forwarded to the tools modal). */
  onEditTools?: () => void
}

export function QuickChatPanel({ agentId, agentName, agentAvatarUrl, agentModel, llmModels, sessionId, expiresAt, onHide, onEnd, onShowHistory, agentThinkingEnabled, agentThinkingEffort, onEditTools }: QuickChatPanelProps) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { messages, session, streamingMessage, isProcessing, isStreaming, sendMessage, stopStreaming, updateSessionOverrides } = useQuickChat(sessionId, agentId)
  // Tools badge: the quick-session variant of the resolved toolset (the
  // session-excluded tools — tasks, crons, inter-agent… — are not counted).
  const { tools: quickTools, count: quickToolCount, refetch: refetchQuickTools } = useAgentTools(agentId, { quick: true })
  const [toolsModalOpen, setToolsModalOpen] = useState(false)
  const { toolCallsByMessage } = useToolCalls(agentId, messages)
  const { content: draftContent, setContent: setDraftContent, clearDraft } = useDraftMessage(`quick-${sessionId}`)
  const { pendingFiles, addFiles, removeFile, clearFiles, isUploading } = useFileUpload(agentId)
  const [showCloseDialog, setShowCloseDialog] = useState(false)
  const [saveAsMemory, setSaveAsMemory] = useState(false)
  const [memorySummary, setMemorySummary] = useState('')
  const [timeLeft, setTimeLeft] = useState<string | null>(null)

  // Fetch context-preview for the quick session (shows the session's actual context)
  const [contextData, setContextData] = useState<{
    tokenEstimate: ContextTokenBreakdown
    contextWindow: number
    apiContextTokens?: number
  } | null>(null)
  useEffect(() => {
    fetch(`/api/agents/${agentId}/context-preview?sessionId=${sessionId}`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data?.tokenEstimate) {
          setContextData({
            tokenEstimate: data.tokenEstimate,
            contextWindow: data.contextWindow ?? 0,
            apiContextTokens: data.apiContextTokens ?? undefined,
          })
        }
      })
      .catch(() => {})
  }, [agentId, sessionId])

  // Update remaining time display
  useEffect(() => {
    if (!expiresAt) return
    const update = () => {
      const remaining = expiresAt - Date.now()
      if (remaining <= 0) { setTimeLeft(null); return }
      const hours = Math.floor(remaining / 3600000)
      const mins = Math.floor((remaining % 3600000) / 60000)
      setTimeLeft(hours > 0 ? `${hours}h${mins > 0 ? ` ${mins}m` : ''}` : `${mins}m`)
    }
    update()
    const interval = setInterval(update, 60000)
    return () => clearInterval(interval)
  }, [expiresAt])

  // Auto-scroll with toggle
  const { autoScroll, toggleAutoScroll, containerRef: scrollContainerRef, bottomRef } = useAutoScroll([
    messages.length,
    streamingMessage,
    isStreaming,
    isProcessing,
  ])

  const handleSend = useCallback(
    (content: string, fileIds?: string[]) => {
      const optimisticFiles = pendingFiles
        .filter((f) => f.status === 'done' && f.serverId && f.serverUrl)
        .map((f) => ({
          id: f.serverId!,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size,
          url: f.serverUrl!,
        }))

      sendMessage(content, fileIds, optimisticFiles.length > 0 ? optimisticFiles : undefined)
      clearDraft()
      clearFiles()
    },
    [sendMessage, clearDraft, clearFiles, pendingFiles],
  )

  const handleEndSession = useCallback(() => {
    if (messages.length > 0) {
      setShowCloseDialog(true)
    } else {
      onEnd(false)
    }
  }, [messages.length, onEnd])

  const handleConfirmEnd = useCallback(() => {
    setShowCloseDialog(false)
    onEnd(saveAsMemory, saveAsMemory ? memorySummary : undefined)
  }, [onEnd, saveAsMemory, memorySummary])

  return (
    <WorkspacePathProvider agentId={agentId}>
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <ChatAvatar
            avatarUrl={agentAvatarUrl}
            name={agentName}
            className="size-8"
            fallbackClassName="bg-primary/10 text-primary text-xs"
            fallbackIcon={<Zap className="size-3.5" />}
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight">{t('quickChat.title')}</p>
            <p className="text-xs text-muted-foreground truncate">
              {agentName}
              {timeLeft && <span className="ml-1.5 opacity-60">· {timeLeft}</span>}
            </p>
          </div>
          {contextData && (
            <ContextBar
              agentId={agentId}
              sessionId={sessionId}
              estimatedTokens={contextData.tokenEstimate.total}
              maxTokens={contextData.contextWindow}
              apiContextTokens={contextData.apiContextTokens}
              contextBreakdown={contextData.tokenEstimate}
              compact
            />
          )}
        </div>
        <div className="flex items-center gap-1">
          {onShowHistory && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8" onClick={onShowHistory}>
                  <History className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('quickChat.history.open')}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={handleEndSession}>
                <LogOut className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('quickChat.endSession')}</TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="icon" className="size-8" onClick={onHide}>
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Messages */}
      <div className="relative min-h-0 flex-1 overflow-y-auto" ref={scrollContainerRef}>
        <div className="p-4">
          {messages.length === 0 && !streamingMessage ? (
            <div className="flex flex-col items-center justify-center py-12 animate-fade-in">
              <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-primary/10">
                <MessageSquare className="size-5 text-primary" />
              </div>
              <p className="text-xs text-muted-foreground text-center max-w-[200px]">
                {t('quickChat.empty')}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {messages.map((msg) => {
                const isFromUser = msg.role === 'user' && msg.sourceType === 'user'
                return (
                  <MessageBubble
                    key={msg.id}
                    role={msg.role}
                    content={msg.content}
                    sourceType={msg.sourceType}
                    files={msg.files}
                    avatarUrl={isFromUser ? user?.avatarUrl : agentAvatarUrl}
                    senderName={isFromUser ? (user?.pseudonym ?? user?.firstName) : agentName}
                    timestamp={msg.createdAt}
                    toolCalls={toolCallsByMessage.get(msg.id)}
                    stepLimitReached={msg.stepLimitReached}
                    emptyTurn={msg.emptyTurn}
                    finishReason={msg.finishReason}
                    silentStop={msg.silentStop}
                    tokenUsage={msg.tokenUsage}
                    reasoning={msg.reasoning ?? undefined}
                  />
                )
              })}
              {streamingMessage && (
                <MessageBubble
                  key={streamingMessage.id}
                  role={streamingMessage.role}
                  content={streamingMessage.content}
                  sourceType={streamingMessage.sourceType}
                  avatarUrl={agentAvatarUrl}
                  senderName={agentName}
                  timestamp={streamingMessage.createdAt}
                  toolCalls={toolCallsByMessage.get(streamingMessage.id)}
                />
              )}
              {(isProcessing || isStreaming) && !streamingMessage && <TypingIndicator agentName={agentName} agentAvatarUrl={agentAvatarUrl} />}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        {/* Auto-scroll toggle — pinned bottom-right */}
        <button
          onClick={toggleAutoScroll}
          className={cn(
            'absolute bottom-2 right-2 z-10 flex items-center justify-center size-7 rounded-full shadow-lg transition-colors',
            autoScroll
              ? 'bg-primary text-primary-foreground hover:opacity-90'
              : 'bg-muted text-muted-foreground hover:bg-muted/80',
          )}
          title={autoScroll ? t('chat.autoScroll.on') : t('chat.autoScroll.off')}
        >
          {autoScroll ? <Pin className="size-3" /> : <PinOff className="size-3" />}
        </button>
      </div>

      {/* Input */}
      <MessageInput
        value={draftContent}
        onChange={setDraftContent}
        onSend={handleSend}
        onStop={stopStreaming}
        isStreaming={isStreaming}
        pendingFiles={pendingFiles}
        isUploading={isUploading}
        onAddFiles={addFiles}
        onRemoveFile={removeFile}
        agentId={agentId}
        llmModels={llmModels}
        model={session?.model ?? agentModel}
        providerId={session?.providerId ?? null}
        onModelChange={(modelId, providerId) => void updateSessionOverrides({ model: modelId, providerId })}
        thinkingEnabled={session?.thinkingEnabled ?? agentThinkingEnabled ?? false}
        thinkingEffort={session?.thinkingEffort ?? agentThinkingEffort ?? null}
        onChangeThinking={(next) => void updateSessionOverrides({ thinkingEnabled: next.enabled, thinkingEffort: next.effort })}
        toolCount={quickToolCount}
        onShowTools={() => { void refetchQuickTools(); setToolsModalOpen(true) }}
      />

      {/* Tools listing modal (composer tools badge — quick-session variant) */}
      {toolsModalOpen && (
        <AgentToolsModal
          open={toolsModalOpen}
          onOpenChange={setToolsModalOpen}
          agentId={agentId}
          agentName={agentName}
          tools={quickTools}
          isQuickSession
          onEditTools={onEditTools}
        />
      )}

      {/* Close confirmation dialog */}
      <AlertDialog open={showCloseDialog} onOpenChange={(open) => {
          setShowCloseDialog(open)
          if (!open) {
            setSaveAsMemory(false)
            setMemorySummary('')
          }
        }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('quickChat.closing.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('quickChat.closing.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3 py-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={saveAsMemory}
                onCheckedChange={(checked) => setSaveAsMemory(checked === true)}
              />
              <span className="text-sm">{t('quickChat.closing.saveMemory')}</span>
            </label>

            {saveAsMemory && (
              <div className="space-y-1.5">
                <Textarea
                  value={memorySummary}
                  onChange={(e) => setMemorySummary(e.target.value)}
                  placeholder={t('quickChat.closing.summaryPlaceholder')}
                  rows={3}
                  className="resize-none"
                />
                {!memorySummary.trim() && (
                  <p className="text-xs text-muted-foreground">{t('quickChat.closing.summaryRequired')}</p>
                )}
              </div>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmEnd} disabled={saveAsMemory && !memorySummary.trim()}>
              {saveAsMemory ? t('quickChat.closing.save') : t('quickChat.closing.closeOnly')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </WorkspacePathProvider>
  )
}
