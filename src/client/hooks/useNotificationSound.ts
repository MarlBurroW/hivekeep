import { useCallback, useEffect, useRef } from 'react'
import { useSSE } from '@/client/hooks/useSSE'

const STORAGE_KEY = 'gezy:notification-sound'

/** Read the user preference from localStorage (default: enabled). */
export function getNotificationSoundEnabled(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === null ? true : stored === 'true'
  } catch {
    return true
  }
}

export function setNotificationSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled))
  } catch {
    // Ignore storage errors
  }
}

/**
 * Play a subtle two-tone chime using the Web Audio API.
 * No audio file needed - generated programmatically.
 */
function playChime(): void {
  try {
    const ctx = new AudioContext()
    const now = ctx.currentTime

    // First tone (higher)
    const osc1 = ctx.createOscillator()
    const gain1 = ctx.createGain()
    osc1.type = 'sine'
    osc1.frequency.setValueAtTime(880, now) // A5
    gain1.gain.setValueAtTime(0.15, now)
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.15)
    osc1.connect(gain1).connect(ctx.destination)
    osc1.start(now)
    osc1.stop(now + 0.15)

    // Second tone (slightly higher, delayed)
    const osc2 = ctx.createOscillator()
    const gain2 = ctx.createGain()
    osc2.type = 'sine'
    osc2.frequency.setValueAtTime(1174.66, now + 0.1) // D6
    gain2.gain.setValueAtTime(0, now)
    gain2.gain.setValueAtTime(0.12, now + 0.1)
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.3)
    osc2.connect(gain2).connect(ctx.destination)
    osc2.start(now + 0.1)
    osc2.stop(now + 0.3)

    // Cleanup
    setTimeout(() => ctx.close(), 500)
  } catch {
    // Web Audio API not available - silently ignore
  }
}

/**
 * Hook that plays a notification chime when a new notification arrives.
 * Respects the user's sound preference stored in localStorage.
 */
export function useNotificationSound(): void {
  const enabledRef = useRef(getNotificationSoundEnabled())

  // Keep ref in sync with localStorage changes (e.g. from preferences toggle)
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        enabledRef.current = e.newValue === null ? true : e.newValue === 'true'
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  // Also poll localStorage on a short interval for same-tab updates
  useEffect(() => {
    const interval = setInterval(() => {
      enabledRef.current = getNotificationSoundEnabled()
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  const handleNotification = useCallback(() => {
    if (enabledRef.current && !document.hidden) {
      playChime()
    }
  }, [])

  useSSE({
    'notification:new': handleNotification,
  })
}
