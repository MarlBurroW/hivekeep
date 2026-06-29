import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/client/components/ui/button'
import { Switch } from '@/client/components/ui/switch'
import { Input } from '@/client/components/ui/input'
import { PasswordInput } from '@/client/components/ui/password-input'
import { Badge } from '@/client/components/ui/badge'
import { Textarea } from '@/client/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/client/components/ui/dialog'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/client/components/ui/collapsible'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
import { EmptyState } from '@/client/components/common/EmptyState'
import { ListToolbar } from '@/client/components/common/ListToolbar'
import { SettingsListSkeleton } from '@/client/components/common/SettingsListSkeleton'
import { useListControls } from '@/client/hooks/useListControls'
import { LIST_FILTER_THRESHOLD } from '@/shared/constants'
import { api, toastError } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import {
  Plug,
  RefreshCw,
  Settings2,
  ChevronDown,
  AlertTriangle,
  Shield,
  Wrench,
  Anchor,
  ExternalLink,
  Cpu,
  Radio,
  Plus,
  Trash2,
  ArrowUpCircle,
  GitBranch,
  Package,
  FolderOpen,
  Loader2,
  HeartPulse,
  Check,
  ShoppingBag,
} from 'lucide-react'
import type { PluginSummary, PluginConfigField } from '@/shared/types/plugin'
import { useSettingsNav } from '@/client/pages/settings/SettingsPage'

export function PluginsSettings() {
  const { t } = useTranslation()
  const navigate = useSettingsNav()
  const [plugins, setPlugins] = useState<PluginSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [reloading, setReloading] = useState(false)
  const [configPlugin, setConfigPlugin] = useState<PluginSummary | null>(null)
  const [configValues, setConfigValues] = useState<Record<string, any>>({})
  const [saving, setSaving] = useState(false)

  // Install dialog state (Git URL only — npm is in the Marketplace tab)
  const [installOpen, setInstallOpen] = useState(false)
  const [installUrl, setInstallUrl] = useState('')
  const [installing, setInstalling] = useState(false)

  // Uninstall confirmation
  const [uninstallPlugin, setUninstallPlugin] = useState<string | null>(null)
  const [uninstalling, setUninstalling] = useState(false)

  // Update state
  const [updatingPlugin, setUpdatingPlugin] = useState<string | null>(null)
  /** Plugin names that have an update available on the registry (npm)
   *  or remote (git). Computed from `/api/plugins/updates`. The Update
   *  button only renders for plugins in this set. */
  const [updatableNames, setUpdatableNames] = useState<Set<string>>(new Set())
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  /** True after at least one successful `/plugins/updates` round-trip.
   *  Gates the "up to date" badge — without this we'd flash a green
   *  check on every remote plugin before the registry has even been
   *  queried. */
  const [updatesChecked, setUpdatesChecked] = useState(false)

  // Health reset state
  const [resettingHealth, setResettingHealth] = useState<string | null>(null)

  const fetchPlugins = useCallback(async () => {
    try {
      const data = await api.get<PluginSummary[]>('/plugins')
      setPlugins(data)
    } catch {
      // ignore
    } finally {
      setIsLoading(false)
    }
  }, [])

  const fetchUpdates = useCallback(async (opts?: { silent?: boolean }) => {
    setCheckingUpdates(true)
    try {
      const data = await api.get<{ updates: { name: string }[] }>('/plugins/updates')
      const updates = data.updates ?? []
      setUpdatableNames(new Set(updates.map((u) => u.name)))
      setUpdatesChecked(true)
      if (!opts?.silent) {
        if (updates.length === 0) {
          toast.success(t('settings.plugins.allUpToDate'))
        } else {
          toast.info(t('settings.plugins.updatesAvailable', { count: updates.length }))
        }
      }
    } catch (err) {
      if (!opts?.silent) toastError(err)
    } finally {
      setCheckingUpdates(false)
    }
  }, [t])

  useEffect(() => {
    fetchPlugins()
    fetchUpdates({ silent: true })
  }, [fetchPlugins, fetchUpdates])

  // Keep plugin list in sync when other clients/the server changes plugin state
  useSSE({
    'plugin:installed': () => { fetchPlugins(); fetchUpdates({ silent: true }) },
    'plugin:uninstalled': () => { fetchPlugins(); fetchUpdates({ silent: true }) },
    'plugin:updated': () => { fetchPlugins(); fetchUpdates({ silent: true }) },
    'plugin:reloaded': () => fetchPlugins(),
    'plugin:enabled': () => fetchPlugins(),
    'plugin:disabled': () => fetchPlugins(),
    'plugin:configUpdated': () => fetchPlugins(),
    'plugin:autoDisabled': () => fetchPlugins(),
  })

  const handleToggle = async (name: string, enabled: boolean) => {
    try {
      if (enabled) {
        await api.post(`/plugins/${name}/enable`)
        toast.success(t('settings.plugins.enabled'))
      } else {
        await api.post(`/plugins/${name}/disable`)
        toast.success(t('settings.plugins.disabled'))
      }
      await fetchPlugins()
    } catch (err) {
      toastError(err)
    }
  }

  const handleReload = async () => {
    setReloading(true)
    try {
      await api.post('/plugins/reload')
      await fetchPlugins()
      toast.success(t('settings.plugins.reloaded'))
    } catch (err) {
      toastError(err)
    } finally {
      setReloading(false)
    }
  }

  const handleInstall = async () => {
    setInstalling(true)
    try {
      const result = await api.post<{ success: boolean; name: string }>('/plugins/install', {
        source: 'git' as const,
        url: installUrl,
      })
      toast.success(t('settings.plugins.installSuccess', { name: result.name }))
      setInstallOpen(false)
      setInstallUrl('')
      await fetchPlugins()
    } catch (err) {
      toastError(err)
    } finally {
      setInstalling(false)
    }
  }

  const handleUninstall = async () => {
    if (!uninstallPlugin) return
    setUninstalling(true)
    try {
      await api.delete(`/plugins/${uninstallPlugin}`)
      toast.success(t('settings.plugins.uninstallSuccess'))
      setUninstallPlugin(null)
      await fetchPlugins()
    } catch (err) {
      toastError(err)
    } finally {
      setUninstalling(false)
    }
  }

  const handleUpdate = async (name: string) => {
    setUpdatingPlugin(name)
    try {
      await api.post(`/plugins/${name}/update`)
      toast.success(t('settings.plugins.updateSuccess'))
      await fetchPlugins()
    } catch (err) {
      toastError(err)
    } finally {
      setUpdatingPlugin(null)
    }
  }

  const handleResetHealth = async (name: string) => {
    setResettingHealth(name)
    try {
      await api.post(`/plugins/${name}/health/reset`)
      toast.success(t('settings.plugins.healthReset', 'Health stats reset'))
      await fetchPlugins()
    } catch (err) {
      toastError(err)
    } finally {
      setResettingHealth(null)
    }
  }

  const openConfig = async (plugin: PluginSummary) => {
    try {
      const config = await api.get<Record<string, any>>(`/plugins/${plugin.name}/config`)
      setConfigValues(config)
      setConfigPlugin(plugin)
    } catch (err) {
      toastError(err)
    }
  }

  const saveConfig = async () => {
    if (!configPlugin) return
    setSaving(true)
    try {
      await api.put(`/plugins/${configPlugin.name}/config`, configValues)
      toast.success(t('settings.plugins.configSaved'))
      setConfigPlugin(null)
      await fetchPlugins()
    } catch (err) {
      toastError(err)
    } finally {
      setSaving(false)
    }
  }

  const getSourceIcon = (source?: string) => {
    switch (source) {
      case 'git': return <GitBranch className="size-3" />
      case 'npm': return <Package className="size-3" />
      default: return <FolderOpen className="size-3" />
    }
  }

  const getSourceLabel = (source?: string) => {
    switch (source) {
      case 'git': return 'Git'
      case 'npm': return 'npm'
      default: return t('settings.plugins.sourceLocal')
    }
  }

  const list = useListControls(plugins, {
    searchText: (p) => [p.displayName, p.name, p.description, p.author],
  })

  if (isLoading) return <SettingsListSkeleton />

  return (
    <div className="space-y-6">
      {/* Header — stacked: title/description on top, actions below.
          4 action buttons + a title don't fit on one line at the modal's
          max-w-2xl width without truncating the title. */}
      <div className="space-y-3">
        <div>
          <h3 className="text-lg font-semibold">{t('settings.plugins.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('settings.plugins.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Primary action: browse the npm marketplace. This is the
              90% case (most admins discover plugins from npm, not from
              a Git URL they happen to know). */}
          <Button size="sm" onClick={() => navigate('marketplace')}>
            <ShoppingBag className="size-4 mr-2" />
            {t('settings.plugins.browse')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setInstallOpen(true)}>
            <Plus className="size-4 mr-2" />
            {t('settings.plugins.installFromGit')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => fetchUpdates()} disabled={checkingUpdates}>
            <ArrowUpCircle className={`size-4 mr-2 ${checkingUpdates ? 'animate-spin' : ''}`} />
            {t('settings.plugins.checkUpdates')}
          </Button>
          <Button variant="outline" size="sm" onClick={handleReload} disabled={reloading}>
            <RefreshCw className={`size-4 mr-2 ${reloading ? 'animate-spin' : ''}`} />
            {t('settings.plugins.reload')}
          </Button>
        </div>
      </div>

      {/* Plugin list */}
      {plugins.length === 0 ? (
        <EmptyState
          icon={Plug}
          title={t('settings.plugins.empty.title')}
          description={t('settings.plugins.empty.description')}
        />
      ) : (
        <div className="space-y-3">
          {plugins.length >= LIST_FILTER_THRESHOLD && (
            <ListToolbar
              query={list.query}
              onQueryChange={list.setQuery}
              placeholder={t('settings.plugins.search', 'Search plugins...')}
              onClear={() => list.setQuery('')}
              active={list.isSearching}
            />
          )}
          {list.total === 0 && (
            <EmptyState minimal title={t('common.noResults', 'No results found')} />
          )}
          {list.filtered.map((plugin) => (
            <div
              key={plugin.name}
              className="rounded-lg border p-4 surface-card"
            >
              <div className="flex items-start justify-between gap-4">
                {plugin.logoUrl ? (
                  <img
                    src={plugin.logoUrl}
                    alt=""
                    className="size-10 shrink-0 rounded-md object-contain bg-muted/40 p-1"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                  />
                ) : plugin.icon ? (
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted/40 text-2xl">
                    {plugin.icon}
                  </span>
                ) : null}
                <div className="flex-1 min-w-0 space-y-1.5">
                  {/* Title row — display name only. Free to take all
                      the width it needs and truncate gracefully. */}
                  <h4 className="font-medium truncate">
                    {plugin.displayName || plugin.name}
                  </h4>

                  {/* Metadata strip — factual, low-emphasis. mono npm
                      slug + version + source on a single muted line,
                      separated by middle dots. break-all on the slug
                      so it can wrap inside a long string instead of
                      pushing siblings off the row. */}
                  <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    {plugin.displayName && (
                      <>
                        <span className="font-mono break-all">{plugin.name}</span>
                        <span aria-hidden="true">·</span>
                      </>
                    )}
                    <span>v{plugin.version}</span>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1">
                      {getSourceIcon(plugin.installSource)}
                      {getSourceLabel(plugin.installSource)}
                    </span>
                    {/* Subtle "up to date" indicator inline with metadata —
                        no need for a full badge when nothing's wrong. */}
                    {updatesChecked
                      && (plugin.installSource === 'git' || plugin.installSource === 'npm')
                      && !updatableNames.has(plugin.name) && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                            <Check className="size-3" />
                            {t('settings.plugins.upToDate')}
                          </span>
                        </>
                      )}
                  </div>

                  {/* Status badges — only the ones that warrant
                      attention. Update-available + error/health states.
                      Wrap freely since they signal something the user
                      should look at. */}
                  {(
                    ((plugin.installSource === 'git' || plugin.installSource === 'npm') && updatableNames.has(plugin.name))
                    || plugin.error
                    || plugin.compatible === false
                    || plugin.health?.autoDisabled
                    || (plugin.health?.totalErrors > 0 && !plugin.health?.autoDisabled)
                  ) && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {(plugin.installSource === 'git' || plugin.installSource === 'npm')
                        && updatableNames.has(plugin.name)
                        && (
                          <Badge variant="outline" className="text-xs gap-1 text-amber-600 border-amber-500/40">
                            <ArrowUpCircle className="size-3" />
                            {t('settings.plugins.updateAvailable')}
                          </Badge>
                        )}
                      {plugin.error && (
                        <Badge variant="destructive" className="text-xs">
                          <AlertTriangle className="size-3 mr-1" />
                          {t('settings.plugins.error')}
                        </Badge>
                      )}
                      {plugin.compatible === false && (
                        <Badge variant="outline" className="text-xs text-amber-600 border-amber-400">
                          <AlertTriangle className="size-3 mr-1" />
                          {plugin.compatibilityError ?? t('settings.plugins.incompatible', 'Incompatible')}
                        </Badge>
                      )}
                      {plugin.health?.autoDisabled && (
                        <Badge variant="destructive" className="text-xs">
                          <AlertTriangle className="size-3 mr-1" />
                          {t('settings.plugins.autoDisabled', 'Auto-disabled')}
                        </Badge>
                      )}
                      {plugin.health?.totalErrors > 0 && !plugin.health?.autoDisabled && (
                        <Badge variant="outline" className="text-xs text-amber-600 border-amber-400">
                          {plugin.health.totalErrors} {t('settings.plugins.errors', 'errors')}
                        </Badge>
                      )}
                    </div>
                  )}

                  <p className="text-sm text-muted-foreground">
                    {plugin.description}
                  </p>
                  {plugin.author && (
                    <p className="text-xs text-muted-foreground/70 mt-1">
                      {t('settings.plugins.by')} {plugin.author}
                    </p>
                  )}

                  {/* External links — source repo / npm page / homepage. */}
                  {(plugin.repositoryUrl || plugin.npmUrl || plugin.homepage) && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs text-muted-foreground">
                      {plugin.repositoryUrl && (
                        <a
                          href={plugin.repositoryUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 hover:text-foreground"
                        >
                          <ExternalLink className="size-3" />
                          {t('settings.marketplace.repository')}
                        </a>
                      )}
                      {plugin.npmUrl && (
                        <a
                          href={plugin.npmUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 hover:text-foreground"
                        >
                          <ExternalLink className="size-3" />
                          npm
                        </a>
                      )}
                      {plugin.homepage && plugin.homepage !== plugin.repositoryUrl && (
                        <a
                          href={plugin.homepage}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 hover:text-foreground"
                        >
                          <ExternalLink className="size-3" />
                          {t('settings.plugins.homepage')}
                        </a>
                      )}
                    </div>
                  )}

                  {/* Stats */}
                  <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                    {plugin.toolCount > 0 && (
                      <span className="flex items-center gap-1">
                        <Wrench className="size-3" />
                        {plugin.toolCount} {t('settings.plugins.tools')}
                      </span>
                    )}
                    {plugin.hookCount > 0 && (
                      <span className="flex items-center gap-1">
                        <Anchor className="size-3" />
                        {plugin.hookCount} {t('settings.plugins.hooks')}
                      </span>
                    )}
                    {plugin.providerCount > 0 && (
                      <span className="flex items-center gap-1">
                        <Cpu className="size-3" />
                        {plugin.providerCount} {t('settings.plugins.providers')}
                      </span>
                    )}
                    {plugin.channelCount > 0 && (
                      <span className="flex items-center gap-1">
                        <Radio className="size-3" />
                        {plugin.channelCount} {t('settings.plugins.channels')}
                      </span>
                    )}
                    {Object.keys(plugin.dependencies ?? {}).length > 0 && (
                      <span className="flex items-center gap-1">
                        <Plug className="size-3" />
                        {Object.keys(plugin.dependencies).length} dep{Object.keys(plugin.dependencies).length > 1 ? 's' : ''}
                      </span>
                    )}
                    {(plugin.permissions?.length ?? 0) > 0 && (
                      <span className="flex items-center gap-1">
                        <Shield className="size-3" />
                        {plugin.permissions?.length ?? 0} {t('settings.plugins.permissions')}
                      </span>
                    )}
                  </div>

                  {/* Permissions detail */}
                  {(plugin.permissions?.length ?? 0) > 0 && (
                    <Collapsible>
                      <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-1">
                        <ChevronDown className="size-3" />
                        {t('settings.plugins.viewPermissions')}
                      </CollapsibleTrigger>
                      <CollapsibleContent className="mt-1">
                        <div className="flex flex-wrap gap-1">
                          {(plugin.permissions ?? []).map((p) => (
                            <Badge key={p} variant="secondary" className="text-xs font-mono">
                              {p}
                            </Badge>
                          ))}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  )}

                  {/* Dependencies detail */}
                  {Object.keys(plugin.dependencies ?? {}).length > 0 && (
                    <Collapsible>
                      <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-1">
                        <ChevronDown className="size-3" />
                        {t('settings.plugins.viewDependencies', 'View dependencies')}
                      </CollapsibleTrigger>
                      <CollapsibleContent className="mt-1">
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(plugin.dependencies).map(([dep, range]) => (
                            <Badge key={dep} variant="secondary" className="text-xs font-mono">
                              {dep} {range}
                            </Badge>
                          ))}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  )}

                  {/* Dependents warning */}
                  {(plugin.dependents?.length ?? 0) > 0 && (
                    <p className="text-xs text-amber-600 mt-1">
                      {t('settings.plugins.requiredBy', 'Required by')}: {plugin.dependents.join(', ')}
                    </p>
                  )}

                  {plugin.error && (
                    <p className="text-xs text-destructive mt-2">{plugin.error}</p>
                  )}

                  {/* Health details */}
                  {plugin.health?.totalErrors > 0 && (
                    <div className="text-xs text-muted-foreground mt-2 space-y-0.5">
                      {plugin.health.autoDisabled && (
                        <p className="text-destructive font-medium">
                          {t('settings.plugins.autoDisabledMsg', 'Auto-disabled after {{count}} consecutive errors', { count: plugin.health.consecutiveErrors })}
                        </p>
                      )}
                      {plugin.health.lastError && (
                        <p>{t('settings.plugins.lastError', 'Last error')}: {plugin.health.lastError}</p>
                      )}
                      <p>{t('settings.plugins.totalErrors', 'Total errors')}: {plugin.health.totalErrors}</p>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  {/* Health reset button */}
                  {plugin.health?.totalErrors > 0 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleResetHealth(plugin.name)}
                      disabled={resettingHealth === plugin.name}
                      title={t('settings.plugins.resetHealth', 'Reset health stats')}
                    >
                      {resettingHealth === plugin.name ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <HeartPulse className="size-4" />
                      )}
                    </Button>
                  )}
                  {/* Update button — only shown when /api/plugins/updates
                      flagged this plugin as having a newer version on the
                      registry (npm) or remote (git). Avoids the dead-end
                      "re-install same version" UX. */}
                  {(plugin.installSource === 'git' || plugin.installSource === 'npm') && updatableNames.has(plugin.name) && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleUpdate(plugin.name)}
                      disabled={updatingPlugin === plugin.name}
                      title={t('settings.plugins.update')}
                    >
                      {updatingPlugin === plugin.name ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <ArrowUpCircle className="size-4" />
                      )}
                    </Button>
                  )}
                  {/* Uninstall button for non-local plugins */}
                  {plugin.installSource && plugin.installSource !== 'local' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setUninstallPlugin(plugin.name)}
                      title={t('settings.plugins.uninstall')}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                  {Object.keys(plugin.configSchema ?? {}).length > 0 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openConfig(plugin)}
                      title={t('settings.plugins.configure')}
                    >
                      <Settings2 className="size-4" />
                    </Button>
                  )}
                  <Switch
                    checked={plugin.enabled}
                    onCheckedChange={(checked) => handleToggle(plugin.name, checked)}
                  />
                </div>
              </div>

              {plugin.homepage && (
                <a
                  href={plugin.homepage}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-2"
                >
                  <ExternalLink className="size-3" />
                  {t('settings.plugins.homepage')}
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Install dialog */}
      <FormDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        title={t('settings.plugins.installTitle')}
        description={t('settings.plugins.installDescription')}
        size="lg"
        onSubmit={handleInstall}
        isSubmitting={installing}
        submitDisabled={!installUrl}
        submitLabel={t('settings.plugins.install')}
      >
        <FormField
          label={
            <>
              <GitBranch className="size-3" />
              {t('settings.plugins.gitUrl')}
            </>
          }
          htmlFor="git-url"
        >
          <Input
            id="git-url"
            placeholder="https://github.com/user/gezy-plugin-xxx.git"
            value={installUrl}
            onChange={(e) => setInstallUrl(e.target.value)}
          />
        </FormField>
      </FormDialog>

      {/* Uninstall confirmation dialog */}
      <Dialog open={!!uninstallPlugin} onOpenChange={(open) => !open && setUninstallPlugin(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.plugins.uninstallTitle')}</DialogTitle>
            <DialogDescription>
              {t('settings.plugins.uninstallDescription', { name: uninstallPlugin })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUninstallPlugin(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleUninstall} disabled={uninstalling}>
              {uninstalling ? (
                <Loader2 className="size-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="size-4 mr-2" />
              )}
              {t('settings.plugins.uninstall')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Config dialog */}
      <FormDialog
        open={!!configPlugin}
        onOpenChange={(open) => !open && setConfigPlugin(null)}
        title={t('settings.plugins.configureTitle', { name: configPlugin?.name })}
        description={t('settings.plugins.configureDescription')}
        size="lg"
        onSubmit={saveConfig}
        isSubmitting={saving}
      >
        {configPlugin &&
          Object.entries(configPlugin.configSchema).map(([key, field]) => (
            <ConfigFieldRenderer
              key={key}
              fieldKey={key}
              field={field}
              value={configValues[key] ?? field.default ?? ''}
              onChange={(v) => setConfigValues((prev) => ({ ...prev, [key]: v }))}
            />
          ))}
      </FormDialog>
    </div>
  )
}

// ─── Config field renderer ───────────────────────────────────────────────────

function ConfigFieldRenderer({
  fieldKey,
  field,
  value,
  onChange,
}: {
  fieldKey: string
  field: PluginConfigField
  value: any
  onChange: (value: any) => void
}) {
  return (
    <FormField
      label={field.label}
      htmlFor={fieldKey}
      required={field.required}
      hint={field.description}
    >
      {field.type === 'string' && (
        field.secret ? (
          <PasswordInput
            id={fieldKey}
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
          />
        ) : (
          <Input
            id={fieldKey}
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
          />
        )
      )}

      {field.type === 'number' && (
        <Input
          id={fieldKey}
          type="number"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}
          min={field.min}
          max={field.max}
          step={field.step}
        />
      )}

      {field.type === 'boolean' && (
        <Switch
          id={fieldKey}
          checked={!!value}
          onCheckedChange={onChange}
        />
      )}

      {field.type === 'select' && field.options && (
        <Select value={String(value ?? '')} onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {field.type === 'password' && (
        <PasswordInput
          id={fieldKey}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
        />
      )}

      {field.type === 'text' && (
        <Textarea
          id={fieldKey}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          rows={field.rows ?? 3}
          placeholder={field.placeholder}
        />
      )}
    </FormField>
  )
}
