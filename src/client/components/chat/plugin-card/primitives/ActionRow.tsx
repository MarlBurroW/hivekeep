import { memo, useState } from 'react'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { api, getErrorMessage } from '@/client/lib/api'
import { toast } from 'sonner'
import type { PluginCardAction } from '@/shared/types/plugin-cards'
import { buttonVariantFor } from '../variants'

interface ActionRowProps {
  cardInstanceId: string
  actions: PluginCardAction[]
}

export const ActionRow = memo(function ActionRow({ cardInstanceId, actions }: ActionRowProps) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [inputValues, setInputValues] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<string | null>(null)

  if (!Array.isArray(actions) || actions.length === 0) return null

  const submit = async (action: PluginCardAction) => {
    const value = inputValues[action.id]
    if (action.confirm && !window.confirm(`Run "${action.label}"?`)) return
    setPending(action.id)
    try {
      await api.post(`/plugin-cards/${cardInstanceId}/action`, { actionId: action.id, input: value })
      setExpanded(null)
      setInputValues((prev) => {
        const next = { ...prev }
        delete next[action.id]
        return next
      })
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action.id}
            type="button"
            size="sm"
            variant={buttonVariantFor(action.variant)}
            disabled={pending === action.id}
            onClick={() => {
              if (action.input) {
                setExpanded((current) => (current === action.id ? null : action.id))
                return
              }
              void submit(action)
            }}
          >
            {pending === action.id ? 'Running...' : action.label}
          </Button>
        ))}
      </div>

      {actions.filter((a) => a.input && expanded === a.id).map((action) => (
        <div key={`input-${action.id}`} className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-2">
          {action.input?.type === 'textarea' ? (
            <textarea
              value={inputValues[action.id] ?? ''}
              onChange={(e) => setInputValues((prev) => ({ ...prev, [action.id]: e.target.value }))}
              placeholder={action.input?.placeholder}
              className="min-h-[80px] resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            />
          ) : (
            <Input
              value={inputValues[action.id] ?? ''}
              onChange={(e) => setInputValues((prev) => ({ ...prev, [action.id]: e.target.value }))}
              placeholder={action.input?.placeholder}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setExpanded(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant={buttonVariantFor(action.variant)}
              disabled={pending === action.id || !(inputValues[action.id] ?? '').trim()}
              onClick={() => void submit(action)}
            >
              {pending === action.id ? 'Sending...' : 'Send'}
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
})
