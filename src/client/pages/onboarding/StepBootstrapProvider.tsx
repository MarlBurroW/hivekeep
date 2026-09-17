import { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { ProviderFormDialog } from '@/client/components/agent/AddProviderDialog'
import { useProviderTypes } from '@/client/hooks/useProviderTypes'
import { api, getErrorMessage, toastError } from '@/client/lib/api'

/**
 * Onboarding bootstrap: connect ONE native LLM provider. This is the
 * unavoidable manual step — the configurator Agent (Queenie) can't talk without a
 * working LLM. On success we seed Queenie (bound to this provider) and finish
 * onboarding; the conversational setup takes over on the dashboard.
 */
export function StepBootstrapProvider({ onComplete }: { onComplete: () => void }) {
  const { t } = useTranslation()
  const catalogue = useProviderTypes()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [error, setError] = useState('')
  const [existingProvider, setExistingProvider] = useState(false)
  useEffect(() => {
    let active = true
    api.get<{ providers: Array<{ capabilities: string[]; isValid: boolean }> }>('/providers')
      .then(({ providers }) => { if (active) setExistingProvider(providers.some((p) => p.isValid && p.capabilities.includes('llm'))) })
      .catch(() => {})
    return () => { active = false }
  }, [])

  // Native LLM provider types only (a fresh install has no plugins anyway).
  const llmTypes = useMemo(
    () => catalogue.types.filter((tp) => (catalogue.capabilities[tp] ?? []).includes('llm')),
    [catalogue.types, catalogue.capabilities],
  )

  const handleSaved = async () => {
    setDialogOpen(false)
    setSeeding(true)
    setError('')
    try {
      const { providers } = await api.get<{ providers: Array<{ id: string; capabilities: string[]; isValid: boolean }> }>('/providers')
      const llm = providers.find((p) => p.isValid && p.capabilities.includes('llm'))
      if (!llm) {
        setError(t('onboarding.bootstrap.noLlm', 'No LLM provider found — please connect one.'))
        setSeeding(false)
        return
      }
      setExistingProvider(true)
      await api.post('/onboarding/configurator', { providerId: llm.id })
      onComplete()
    } catch (err) {
      toastError(err)
      setError(getErrorMessage(err))
      setSeeding(false)
    }
  }

  if (seeding) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <Loader2 className="size-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">
          {t('onboarding.bootstrap.seeding', 'Bringing your assistant to life…')}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2 text-center">
        <Sparkles className="mx-auto size-8 text-primary" />
        <h2 className="text-lg font-semibold">{t('onboarding.bootstrap.title', 'Connect your AI')}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            'onboarding.bootstrap.description',
            'To bring your assistant to life, connect one AI provider. Pick a built-in one to start — you can add more later, including plugins for other providers.',
          )}
        </p>
      </div>
      <div className="rounded-xl border border-border bg-muted/40 p-3 text-center text-xs text-muted-foreground">
        {t('onboarding.connectAi.why')}
      </div>
      {error && <p className="text-center text-sm text-destructive">{error}</p>}
      {existingProvider && (
        <Button className="w-full" onClick={handleSaved}>{t('experience.onboarding.resume', 'Continue with the connected provider')}</Button>
      )}
      <Button variant={existingProvider ? 'outline' : 'default'} className="btn-shine w-full" onClick={() => setDialogOpen(true)}>
        {t('onboarding.bootstrap.connect', 'Connect a provider')}
      </Button>
      <ProviderFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={handleSaved}
        providerTypes={llmTypes}
      />
    </div>
  )
}
