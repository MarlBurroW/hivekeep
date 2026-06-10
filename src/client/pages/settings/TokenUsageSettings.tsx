import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Button } from '@/client/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import { Card, CardContent } from '@/client/components/ui/card'
import { Skeleton } from '@/client/components/ui/skeleton'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { ProviderIcon } from '@/client/components/common/ProviderIcon'
import { ArrowDownRight, ArrowUpRight, Activity, Hash, Zap, X, ChevronLeft, ChevronRight, DollarSign } from 'lucide-react'
import { api } from '@/client/lib/api'
import { computeCacheHitRate, computeNonCacheInput } from '@/shared/billing'
import type { LlmUsageRow, UsageSummaryRow } from '@/shared/types'

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

function hitRateColor(ratio: number): string {
  if (ratio >= 0.7) return 'text-success'
  if (ratio >= 0.3) return 'text-warning'
  return 'text-muted-foreground/70'
}

type Period = '24h' | '7d' | '30d' | 'all'
type GroupBy = 'provider_type' | 'model_id' | 'agent_id' | 'call_site' | 'day'

interface AgentInfo {
  id: string
  name: string
  role: string
  avatarUrl: string | null
}

const PERIODS: Period[] = ['24h', '7d', '30d', 'all']
const GROUP_OPTIONS: GroupBy[] = ['model_id', 'provider_type', 'agent_id', 'call_site', 'day']

function periodToFrom(period: Period): number | undefined {
  if (period === 'all') return undefined
  const ms = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 }
  return Date.now() - ms[period]
}

function formatTokens(n: number): string {
  if (n === 0) return '0'
  if (n < 1_000) return n.toLocaleString()
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function formatNumber(n: number): string {
  return n.toLocaleString()
}

function formatUsd(n: number): string {
  if (!n) return '$0'
  if (n < 0.01) return '<$0.01'
  if (n < 100) return `$${n.toFixed(2)}`
  if (n < 10_000) return `$${n.toFixed(0)}`
  return `$${(n / 1_000).toFixed(1)}k`
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')
  return qs ? `?${qs}` : ''
}

// ─── Summary Cards ──────────────────────────────────────────────────────────

function SummaryCards({ data, loading, t }: {
  data: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; calls: number }
  loading: boolean
  t: TFunction
}) {
  // Raw token counts, no weighting. We split input into tokens served from
  // cache (cache hit) and tokens that were not (fresh + cache write).
  const cacheHit = data.cacheReadTokens
  const nonCache = computeNonCacheInput(data)
  const hitRate = computeCacheHitRate(data)
  const cards = [
    {
      label: t('settings.tokenUsage.costEstimate', 'Cost (est.)'),
      value: formatUsd(data.costUsd),
      icon: DollarSign,
      color: 'text-primary',
      sub: t('settings.tokenUsage.costEstimateSub', 'from models.dev pricing'),
      subClass: 'text-muted-foreground',
    },
    {
      label: t('settings.tokenUsage.cacheHitInput', 'Cache hit'),
      value: formatTokens(cacheHit),
      icon: Zap,
      color: 'text-success',
      sub: hitRate > 0 ? `${formatPercent(hitRate)} ${t('settings.tokenUsage.cacheHit')}` : undefined,
      subClass: hitRateColor(hitRate),
    },
    { label: t('settings.tokenUsage.nonCacheInput', 'Non-cache'), value: formatTokens(nonCache), icon: ArrowDownRight, color: 'text-foreground' },
    { label: t('settings.tokenUsage.outputTokens'), value: formatTokens(data.outputTokens), icon: ArrowUpRight, color: 'text-chart-2' },
    { label: t('settings.tokenUsage.apiCalls'), value: formatNumber(data.calls), icon: Hash, color: 'text-muted-foreground' },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      {cards.map((card) => (
        <Card key={card.label} className="py-3 px-4 gap-1">
          <CardContent className="p-0">
            {loading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <card.icon className={`size-3.5 ${card.color}`} />
                  {card.label}
                </div>
                <div className="text-xl font-semibold tabular-nums">{card.value}</div>
                {card.sub && (
                  <div className={`text-[10px] tabular-nums ${card.subClass ?? 'text-muted-foreground'}`}>{card.sub}</div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ─── Daily Sparkline ────────────────────────────────────────────────────────

function DailySparkline({ data, t }: { data: UsageSummaryRow[]; t: (key: string) => string }) {
  if (data.length === 0) return null

  const width = 320
  const height = 40
  const barWidth = Math.max(2, width / data.length - 1)
  const gap = 1
  // Real token counts (input + output), no weighting.
  const maxTotal = Math.max(1, ...data.map((d) => d.inputTokens + d.outputTokens))

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Activity className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{t('settings.tokenUsage.dailyTrend')}</span>
      </div>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="w-full">
        {data.map((d, i) => {
          const total = d.inputTokens + d.outputTokens
          const totalH = (total / maxTotal) * height
          const inputH = (d.inputTokens / maxTotal) * height
          const outputH = (d.outputTokens / maxTotal) * height
          const x = i * (barWidth + gap)
          return (
            <g key={d.group}>
              {outputH > 0 && (
                <rect x={x} y={height - totalH} width={barWidth} height={outputH} rx={1} className="fill-chart-2/60" />
              )}
              {inputH > 0 && (
                <rect x={x} y={height - totalH + outputH} width={barWidth} height={inputH} rx={1} className="fill-primary/60" />
              )}
            </g>
          )
        })}
      </svg>
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground/60">
        <span className="flex items-center gap-1">
          <span className="inline-block size-1.5 rounded-full bg-primary/60" />
          {t('settings.tokenUsage.legendInput')}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-1.5 rounded-full bg-chart-2/60" />
          {t('settings.tokenUsage.legendOutput')}
        </span>
      </div>
    </div>
  )
}

// ─── Row Label (with avatar/icon) ──────────────────────────────────────────

function RowLabel({ group, groupBy, agentMap }: {
  group: string
  groupBy: GroupBy
  agentMap: Map<string, AgentInfo>
}) {
  if (groupBy === 'agent_id') {
    if (!group) return <span className="truncate font-medium text-muted-foreground">(unknown)</span>
    const agent = agentMap.get(group)
    if (agent) {
      const name = agent.name || group.slice(0, 8)
      const initials = name.slice(0, 2).toUpperCase()
      return (
        <div className="flex items-center gap-2 min-w-0">
          <Avatar className="size-5 shrink-0">
            {agent.avatarUrl && <AvatarImage src={agent.avatarUrl} alt={name} />}
            <AvatarFallback className="text-[8px] bg-secondary">{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <span className="block truncate text-xs font-medium">{name}</span>
            {agent.role && (
              <span className="block truncate text-[10px] text-muted-foreground leading-tight">{agent.role}</span>
            )}
          </div>
        </div>
      )
    }
    // Fallback for unknown agent — show truncated UUID
    return <span className="truncate font-medium text-muted-foreground" title={group}>{group.slice(0, 8)}…</span>
  }

  if (groupBy === 'provider_type') {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <ProviderIcon providerType={group} className="size-4 shrink-0" variant="color" />
        <span className="truncate font-medium capitalize">{group}</span>
      </div>
    )
  }

  return <span className="truncate font-medium" title={group}>{group || '(unknown)'}</span>
}

// ─── Breakdown Table ────────────────────────────────────────────────────────

function BreakdownTable({ rows, loading, groupBy, agentMap, t }: {
  rows: UsageSummaryRow[]
  loading: boolean
  groupBy: GroupBy
  agentMap: Map<string, AgentInfo>
  t: TFunction
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        {t('settings.tokenUsage.noData')}
      </div>
    )
  }

  return (
    <div className="glass-strong rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <div className="min-w-[480px]">
          {/* Header — group | cache hit | non-cache | output | hit% | cost | calls */}
          <div className="grid grid-cols-[1fr_80px_80px_80px_50px_70px_50px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground/60 border-b border-border/30">
            <span>{t('settings.tokenUsage.columnGroup')}</span>
            <span className="text-right" title={t('settings.tokenUsage.cacheHitInput', 'Cache hit')}>{t('settings.tokenUsage.columnCacheHit', 'Cache hit')}</span>
            <span className="text-right" title={t('settings.tokenUsage.nonCacheInput', 'Non-cache')}>{t('settings.tokenUsage.columnNonCache', 'Non-cache')}</span>
            <span className="text-right">{t('settings.tokenUsage.columnOutput')}</span>
            <span className="text-right" title={t('settings.tokenUsage.columnCacheHitFull')}>%</span>
            <span className="text-right">{t('settings.tokenUsage.columnCost', 'Cost')}</span>
            <span className="text-right">{t('settings.tokenUsage.columnCalls')}</span>
          </div>
          {/* Rows */}
          <div className="max-h-[300px] overflow-y-auto">
            {rows.map((row) => {
          const cacheHit = row.cacheReadTokens
          const nonCache = computeNonCacheInput(row)
          const hit = computeCacheHitRate(row)
          const hasCache = (row.cacheReadTokens > 0) || (row.cacheWriteTokens > 0)
          const fresh = Math.max(0, row.inputTokens - row.cacheReadTokens - row.cacheWriteTokens)
          const tooltip = !hasCache
            ? undefined
            : `Input ${formatTokens(row.inputTokens)} = fresh ${formatTokens(fresh)} + cache write ${formatTokens(row.cacheWriteTokens)} + cache read ${formatTokens(row.cacheReadTokens)}`
          return (
            <div
              key={row.group}
              className="grid grid-cols-[1fr_80px_80px_80px_50px_70px_50px] gap-2 px-3 py-1.5 text-xs hover:bg-muted/30 border-b border-border/20 items-center"
              title={tooltip}
            >
              <RowLabel group={row.group} groupBy={groupBy} agentMap={agentMap} />
              <span className="text-right font-mono tabular-nums font-semibold text-success">
                {formatTokens(cacheHit)}
              </span>
              <span className="text-right font-mono tabular-nums text-foreground">
                {formatTokens(nonCache)}
              </span>
              <span className="text-right font-mono tabular-nums text-muted-foreground">
                {formatTokens(row.outputTokens)}
              </span>
              <span className={`text-right font-mono tabular-nums ${hasCache ? hitRateColor(hit) : 'text-muted-foreground/40'}`}>
                {hasCache ? formatPercent(hit) : '—'}
              </span>
              <span className="text-right font-mono tabular-nums text-primary">
                {row.costUsd > 0 ? formatUsd(row.costUsd) : '—'}
              </span>
              <span className="text-right font-mono tabular-nums text-muted-foreground">
                {formatNumber(row.count)}
              </span>
            </div>
          )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Agent Filter ─────────────────────────────────────────────────────────────

function AgentFilter({ value, onValueChange, agents, t }: {
  value: string
  onValueChange: (v: string) => void
  agents: AgentInfo[]
  t: TFunction
}) {
  const selectedAgent = agents.find((k) => k.id === value)

  return (
    <div className="relative w-full sm:w-auto">
      <Select value={value || '__all__'} onValueChange={(v) => onValueChange(v === '__all__' ? '' : v)}>
        <SelectTrigger className={`w-full sm:w-[200px] h-8 text-xs ${value ? 'pr-7' : ''}`}>
          {selectedAgent ? (
            <div className="flex items-center gap-2 min-w-0">
              <Avatar className="size-4 shrink-0">
                {selectedAgent.avatarUrl && <AvatarImage src={selectedAgent.avatarUrl} alt={selectedAgent.name} />}
                <AvatarFallback className="text-[7px] bg-secondary">{(selectedAgent.name || '??').slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span className="truncate">{selectedAgent.name}</span>
            </div>
          ) : (
            <span className="text-muted-foreground">{t('settings.tokenUsage.filterAgent')}</span>
          )}
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="__all__" className="text-xs">{t('settings.tokenUsage.filterAgent')}</SelectItem>
          {agents.map((agent) => (
            <SelectItem key={agent.id} value={agent.id} className="text-xs py-1.5">
              <div className="flex items-center gap-2 min-w-0">
                <Avatar className="size-5 shrink-0">
                  {agent.avatarUrl && <AvatarImage src={agent.avatarUrl} alt={agent.name} />}
                  <AvatarFallback className="text-[8px] bg-secondary">{agent.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <span className="block truncate text-xs">{agent.name}</span>
                  {agent.role && (
                    <span className="block truncate text-[10px] text-muted-foreground leading-tight">{agent.role}</span>
                  )}
                </div>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onValueChange('') }}
          className="absolute right-7 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}

// ─── Provider Filter ────────────────────────────────────────────────────────

function ProviderFilter({ value, onValueChange, providers, t }: {
  value: string
  onValueChange: (v: string) => void
  providers: string[]
  t: TFunction
}) {
  return (
    <div className="relative w-full sm:w-auto">
      <Select value={value || '__all__'} onValueChange={(v) => onValueChange(v === '__all__' ? '' : v)}>
        <SelectTrigger className={`w-full sm:w-[200px] h-8 text-xs ${value ? 'pr-7' : ''}`}>
          {value ? (
            <div className="flex items-center gap-2 min-w-0">
              <ProviderIcon providerType={value} className="size-3.5 shrink-0" variant="color" />
              <span className="truncate capitalize">{value}</span>
            </div>
          ) : (
            <span className="text-muted-foreground">{t('settings.tokenUsage.filterProvider')}</span>
          )}
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="__all__" className="text-xs">{t('settings.tokenUsage.filterProvider')}</SelectItem>
          {providers.map((p) => (
            <SelectItem key={p} value={p} className="text-xs">
              <span className="flex items-center gap-2">
                <ProviderIcon providerType={p} className="size-4" variant="color" />
                <span className="capitalize">{p}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onValueChange('') }}
          className="absolute right-7 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}

// ─── Detail Table (individual requests) ────────────────────────────────────

const PAGE_SIZE = 25

function DetailTable({ rows, loading, page, totalCount, onPageChange, agentMap, t }: {
  rows: LlmUsageRow[]
  loading: boolean
  page: number
  totalCount: number
  onPageChange: (page: number) => void
  agentMap: Map<string, AgentInfo>
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  if (loading && rows.length === 0) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        {t('settings.tokenUsage.noData')}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="glass-strong rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <div className="min-w-[800px]">
            {/* Header */}
            <div className="grid grid-cols-[140px_1fr_1fr_70px_70px_70px_60px_45px_45px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground/60 border-b border-border/30">
              <span>{t('settings.tokenUsage.detailDate')}</span>
              <span>{t('settings.tokenUsage.detailAgent')}</span>
              <span>{t('settings.tokenUsage.detailModel')}</span>
              <span>{t('settings.tokenUsage.detailCallSite')}</span>
              <span className="text-right" title={t('settings.tokenUsage.cacheHitInput')}>{t('settings.tokenUsage.columnCacheHit')}</span>
              <span className="text-right" title={t('settings.tokenUsage.nonCacheInput')}>{t('settings.tokenUsage.columnNonCache')}</span>
              <span className="text-right">{t('settings.tokenUsage.columnOutput')}</span>
              <span className="text-right" title={t('settings.tokenUsage.columnCacheHitFull')}>%</span>
              <span className="text-right">{t('settings.tokenUsage.detailSteps')}</span>
            </div>
            {/* Rows */}
            <div className="max-h-[400px] overflow-y-auto">
              {rows.map((row) => {
            const agent = row.agentId ? agentMap.get(row.agentId) : null
            const date = new Date(row.createdAt)
            const usage = {
              inputTokens: row.inputTokens ?? 0,
              cacheReadTokens: row.cacheReadTokens ?? 0,
              cacheWriteTokens: row.cacheWriteTokens ?? 0,
            }
            const cacheHit = usage.cacheReadTokens
            const nonCache = computeNonCacheInput(usage)
            const hit = computeCacheHitRate(usage)
            const hasCache = (row.cacheReadTokens ?? 0) > 0 || (row.cacheWriteTokens ?? 0) > 0
            const fresh = Math.max(0, (row.inputTokens ?? 0) - (row.cacheReadTokens ?? 0) - (row.cacheWriteTokens ?? 0))
            return (
              <div
                key={row.id}
                className="grid grid-cols-[140px_1fr_1fr_70px_70px_70px_60px_45px_45px] gap-2 px-3 py-1.5 text-xs hover:bg-muted/30 border-b border-border/20 items-center"
                title={hasCache
                  ? `Input ${formatTokens(row.inputTokens ?? 0)} = fresh ${formatTokens(fresh)} + cache write ${formatTokens(row.cacheWriteTokens ?? 0)} + cache read ${formatTokens(row.cacheReadTokens ?? 0)}`
                  : `Input ${formatTokens(row.inputTokens ?? 0)} (no cache)`}
              >
                <span className="text-muted-foreground tabular-nums" title={date.toISOString()}>
                  {date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{' '}
                  {date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <div className="min-w-0">
                  {agent ? (
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Avatar className="size-4 shrink-0">
                        {agent.avatarUrl && <AvatarImage src={agent.avatarUrl} alt={agent.name} />}
                        <AvatarFallback className="text-[7px] bg-secondary">{agent.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <span className="truncate">{agent.name}</span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 min-w-0">
                  {row.providerType && <ProviderIcon providerType={row.providerType} className="size-3.5 shrink-0" variant="color" />}
                  <span className="truncate" title={row.modelId ?? undefined}>{row.modelId ?? '—'}</span>
                </div>
                <span className="truncate text-muted-foreground">{row.callSite}</span>
                <span className="text-right font-mono tabular-nums font-semibold text-success">
                  {formatTokens(cacheHit)}
                </span>
                <span className="text-right font-mono tabular-nums text-foreground">
                  {formatTokens(nonCache)}
                </span>
                <span className="text-right font-mono tabular-nums text-muted-foreground">
                  {formatTokens(row.outputTokens ?? 0)}
                </span>
                <span className={`text-right font-mono tabular-nums ${hasCache ? hitRateColor(hit) : 'text-muted-foreground/40'}`}>
                  {hasCache ? formatPercent(hit) : '—'}
                </span>
                <span className="text-right font-mono tabular-nums text-muted-foreground">
                  {row.stepCount}
                </span>
              </div>
            )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{t('settings.tokenUsage.detailShowing', { from: page * PAGE_SIZE + 1, to: Math.min((page + 1) * PAGE_SIZE, totalCount), total: totalCount })}</span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            disabled={page === 0}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="px-2 tabular-nums">{page + 1} / {totalPages}</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            disabled={page >= totalPages - 1}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function TokenUsageSettings({ initialAgentFilter }: { initialAgentFilter?: string } = {}) {
  const { t } = useTranslation()

  const [period, setPeriod] = useState<Period>('7d')
  const [groupBy, setGroupBy] = useState<GroupBy>(initialAgentFilter ? 'model_id' : 'model_id')
  const [agentFilter, setAgentFilter] = useState<string>(initialAgentFilter ?? '')
  const [providerFilter, setProviderFilter] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [summaryRows, setSummaryRows] = useState<UsageSummaryRow[]>([])
  const [dailyData, setDailyData] = useState<UsageSummaryRow[]>([])

  // Detail rows (individual requests)
  const [detailRows, setDetailRows] = useState<LlmUsageRow[]>([])
  const [detailCount, setDetailCount] = useState(0)
  const [detailPage, setDetailPage] = useState(0)
  const [detailLoading, setDetailLoading] = useState(false)

  // Agent info for resolving UUIDs to names/avatars
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const agentMap = useMemo(() => new Map(agents.map((k) => [k.id, k])), [agents])

  // Available filter options (populated from data)
  const [agentOptionIds, setAgentOptionIds] = useState<string[]>([])
  const [providerOptions, setProviderOptions] = useState<string[]>([])

  // Fetch agents + filter options on mount
  useEffect(() => {
    Promise.all([
      api.get<{ agents: AgentInfo[] }>('/agents'),
      api.get<{ summary: UsageSummaryRow[] }>('/usage/summary?groupBy=agent_id'),
      api.get<{ summary: UsageSummaryRow[] }>('/usage/summary?groupBy=provider_type'),
    ]).then(([agentsRes, agentUsageRes, providersRes]) => {
      setAgents(agentsRes.agents)
      setAgentOptionIds(agentUsageRes.summary.filter((r) => r.group).map((r) => r.group))
      setProviderOptions(providersRes.summary.filter((r) => r.group).map((r) => r.group))
    }).catch(() => {})
  }, [])

  // Agents that have usage data (for filter dropdown)
  const agentFilterOptions = useMemo(
    () => agents.filter((k) => agentOptionIds.includes(k.id)),
    [agents, agentOptionIds],
  )

  // Fetch data when filters change
  useEffect(() => {
    setLoading(true)
    const from = periodToFrom(period)
    const base = {
      from,
      agentId: agentFilter || undefined,
      providerType: providerFilter || undefined,
    }

    const mainQuery = buildQuery({ groupBy, ...base })
    const dailyQuery = groupBy === 'day' ? null : buildQuery({ groupBy: 'day', ...base })

    const promises: Promise<{ summary: UsageSummaryRow[] }>[] = [
      api.get<{ summary: UsageSummaryRow[] }>(`/usage/summary${mainQuery}`),
    ]
    if (dailyQuery) {
      promises.push(api.get<{ summary: UsageSummaryRow[] }>(`/usage/summary${dailyQuery}`))
    }

    Promise.all(promises)
      .then(([mainRes, dailyRes]) => {
        if (!mainRes) return
        setSummaryRows(mainRes.summary)
        setDailyData(dailyRes ? dailyRes.summary : mainRes.summary)
      })
      .catch(() => {
        setSummaryRows([])
        setDailyData([])
      })
      .finally(() => setLoading(false))
  }, [period, groupBy, agentFilter, providerFilter])

  // Reset detail page when filters change
  useEffect(() => {
    setDetailPage(0)
  }, [period, agentFilter, providerFilter])

  // Fetch detail rows (individual requests)
  const fetchDetail = useCallback((page: number) => {
    setDetailLoading(true)
    const from = periodToFrom(period)
    const query = buildQuery({
      from,
      agentId: agentFilter || undefined,
      providerType: providerFilter || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
    api.get<{ rows: LlmUsageRow[]; count: number }>(`/usage${query}`)
      .then((res) => {
        setDetailRows(res.rows)
        setDetailCount(res.count)
      })
      .catch(() => {
        setDetailRows([])
        setDetailCount(0)
      })
      .finally(() => setDetailLoading(false))
  }, [period, agentFilter, providerFilter])

  useEffect(() => {
    fetchDetail(detailPage)
  }, [detailPage, fetchDetail])

  const handleDetailPageChange = useCallback((page: number) => {
    setDetailPage(page)
  }, [])

  // Derive totals from summary rows — raw token counts, no weighting.
  const totals = useMemo(() => {
    return summaryRows.reduce(
      (acc, r) => ({
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        totalTokens: acc.totalTokens + r.totalTokens,
        cacheReadTokens: acc.cacheReadTokens + (r.cacheReadTokens ?? 0),
        cacheWriteTokens: acc.cacheWriteTokens + (r.cacheWriteTokens ?? 0),
        costUsd: acc.costUsd + (r.costUsd ?? 0),
        calls: acc.calls + r.count,
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, calls: 0 },
    )
  }, [summaryRows])

  return (
    <div className="space-y-6">
      {/* Header + Period selector */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">{t('settings.tokenUsage.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('settings.tokenUsage.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1 shrink-0">
          {PERIODS.map((p) => (
            <Button
              key={p}
              size="sm"
              variant={period === p ? 'secondary' : 'ghost'}
              className="h-7 px-2.5 text-xs"
              onClick={() => setPeriod(p)}
            >
              {t(`settings.tokenUsage.period${p === '24h' ? '24h' : p === '7d' ? '7d' : p === '30d' ? '30d' : 'All'}`)}
            </Button>
          ))}
        </div>
      </div>

      {/* Summary Cards */}
      <SummaryCards data={totals} loading={loading} t={t} />

      {/* Daily Sparkline */}
      {!loading && dailyData.length > 1 && (
        <DailySparkline data={dailyData} t={t} />
      )}

      {/* Group by — toggle buttons */}
      <div className="space-y-1.5">
        <span className="text-xs text-muted-foreground">{t('settings.tokenUsage.groupBy')}</span>
        <div className="flex flex-wrap items-center gap-1">
          {GROUP_OPTIONS.map((opt) => (
            <Button
              key={opt}
              size="sm"
              variant={groupBy === opt ? 'secondary' : 'ghost'}
              className="h-7 px-2.5 text-xs"
              onClick={() => setGroupBy(opt)}
            >
              {t(`settings.tokenUsage.groupBy${opt === 'provider_type' ? 'Provider' : opt === 'model_id' ? 'Model' : opt === 'agent_id' ? 'Agent' : opt === 'call_site' ? 'CallSite' : 'Day'}`)}
            </Button>
          ))}
        </div>
      </div>

      {/* Filters — dropdowns */}
      {(agentFilterOptions.length > 0 || providerOptions.length > 0) && (
        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">{t('settings.tokenUsage.filters')}</span>
          <div className="flex flex-wrap items-center gap-2">
            {agentFilterOptions.length > 0 && (
              <AgentFilter value={agentFilter} onValueChange={setAgentFilter} agents={agentFilterOptions} t={t} />
            )}
            {providerOptions.length > 0 && (
              <ProviderFilter value={providerFilter} onValueChange={setProviderFilter} providers={providerOptions} t={t} />
            )}
          </div>
        </div>
      )}

      {/* Breakdown Table */}
      <BreakdownTable rows={summaryRows} loading={loading} groupBy={groupBy} agentMap={agentMap} t={t} />

      {/* Detail Table — individual requests */}
      <div className="space-y-1.5">
        <h4 className="text-sm font-medium">{t('settings.tokenUsage.detailTitle')}</h4>
        <DetailTable
          rows={detailRows}
          loading={detailLoading}
          page={detailPage}
          totalCount={detailCount}
          onPageChange={handleDetailPageChange}
          agentMap={agentMap}
          t={t}
        />
      </div>
    </div>
  )
}
