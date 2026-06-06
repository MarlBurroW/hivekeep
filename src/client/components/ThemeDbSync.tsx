import { useEffect, useRef } from 'react'
import { useAuth } from '@/client/hooks/useAuth'
import { usePalette, useTheme, type ContrastMode } from '@/client/components/theme-provider'
import { api } from '@/client/lib/api'
import type { PaletteId } from '@/shared/types'

/**
 * Persists the user's appearance preferences (theme mode, palette, contrast) to
 * the DB (`user_profiles` via PATCH /api/me) and hydrates them from the DB on
 * login, so they follow the user across devices/browsers.
 *
 * localStorage stays as a fast pre-auth cache (written by the theme provider's
 * setters) to avoid a flash before /me resolves; the DB is the source of truth
 * once authenticated. Mounted inside AuthProvider (itself inside ThemeProvider)
 * so it can read both useAuth() and usePalette()/useTheme(). Renders nothing.
 */
export function ThemeDbSync() {
  const { user, isAuthenticated } = useAuth()
  const { palette, setPalette, contrastMode, setContrastMode } = usePalette()
  const { theme, setTheme } = useTheme()

  // The user we've already hydrated (hydrate once per login, not every render).
  const hydratedUserRef = useRef<string | null>(null)
  // While set, we're applying DB values — suppress persistence until local state
  // converges to them (so the transient pre-hydration render can't re-save the
  // stale cache over the freshly-loaded DB values).
  const pendingRef = useRef<{ theme: string; palette: string; contrast: string } | null>(null)
  // The values we know are already in the DB (so we only PATCH real changes).
  const lastSyncedRef = useRef<{ theme: string; palette: string; contrast: string } | null>(null)

  // Reset on logout so a different user re-hydrates cleanly.
  useEffect(() => {
    if (!isAuthenticated) {
      hydratedUserRef.current = null
      pendingRef.current = null
      lastSyncedRef.current = null
    }
  }, [isAuthenticated])

  // Hydrate from the DB once per authenticated user. A saved DB value wins; when
  // the DB has none we keep the current (localStorage/default) value.
  useEffect(() => {
    if (!isAuthenticated || !user) return
    if (hydratedUserRef.current === user.id) return
    hydratedUserRef.current = user.id

    const desired = {
      theme: user.theme ?? theme ?? 'system',
      palette: (user.palette as PaletteId | null | undefined) || palette,
      contrast: (user.contrastMode as ContrastMode | null | undefined) || contrastMode,
    }
    pendingRef.current = desired
    if (desired.theme !== theme) setTheme(desired.theme)
    if (desired.palette !== palette) setPalette(desired.palette as PaletteId)
    if (desired.contrast !== contrastMode) setContrastMode(desired.contrast as ContrastMode)
    // Intentionally keyed on the user only — we read the live theme/palette at
    // hydration time but don't want to re-run when the user changes them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, user?.id])

  // Persist genuine changes; also drives the hydration "settling" gate.
  useEffect(() => {
    if (!isAuthenticated || hydratedUserRef.current == null || !user) return
    const current = { theme: theme ?? 'system', palette, contrast: contrastMode }

    // Still hydrating: wait until local state matches the DB target, then take
    // over persistence and migrate any value the DB didn't have yet (so an
    // existing localStorage preference gets written to the DB once).
    if (pendingRef.current) {
      const p = pendingRef.current
      if (current.theme === p.theme && current.palette === p.palette && current.contrast === p.contrast) {
        lastSyncedRef.current = { ...current }
        pendingRef.current = null
        const migrate: Record<string, string> = {}
        if (!user.theme) migrate.theme = current.theme
        if (!user.palette) migrate.palette = current.palette
        if (!user.contrastMode) migrate.contrastMode = current.contrast
        if (Object.keys(migrate).length > 0) api.patch('/me', migrate).catch(() => {})
      }
      return
    }

    const last = lastSyncedRef.current
    const patch: Record<string, string> = {}
    if (last?.theme !== current.theme) patch.theme = current.theme
    if (last?.palette !== current.palette) patch.palette = current.palette
    if (last?.contrast !== current.contrast) patch.contrastMode = current.contrast
    if (Object.keys(patch).length === 0) return
    lastSyncedRef.current = { ...current }
    api.patch('/me', patch).catch(() => {})
  }, [theme, palette, contrastMode, isAuthenticated, user])

  return null
}
