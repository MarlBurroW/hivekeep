/**
 * Hivekeep React SDK — ES Module
 * Served at /api/mini-apps/sdk/hivekeep-react.js
 *
 * Provides React hooks that layer on top of the vanilla Hivekeep SDK (window.Hivekeep).
 * The vanilla SDK is always auto-injected as a regular <script> before any ES modules,
 * so window.Hivekeep is guaranteed to exist when this module runs.
 *
 * Usage in mini-apps:
 *   import { useState } from 'react'
 *   import { createRoot } from 'react-dom/client'
 *   import { useHivekeep, useStorage, toast } from '@hivekeep/react'
 *
 *   function App() {
 *     const { app, ready } = useHivekeep()
 *     const [todos, setTodos, loading] = useStorage('todos', [])
 *     if (!ready || loading) return <div>Loading...</div>
 *     return <div>{app.name}</div>
 *   }
 *
 *   createRoot(document.getElementById('root')).render(<App />)
 */

import { useState, useEffect, useRef, useCallback } from 'react'

// ─── useHivekeep ──────────────────────────────────────────────────────────────

/**
 * Core hook — manages Hivekeep.ready() lifecycle and provides reactive app state.
 * Call once at the root of your app. All other hooks can be used independently.
 *
 * @returns {{ app: object|null, ready: boolean, theme: {mode,palette}, locale: string, isFullPage: boolean, api: object }}
 */
export function useHivekeep() {
  const [app, setApp] = useState(null)
  const [ready, setReady] = useState(false)
  const [theme, setTheme] = useState(window.Hivekeep.theme)
  const [locale, setLocale] = useState(window.Hivekeep.locale)
  const [isFullPage, setIsFullPage] = useState(window.Hivekeep.isFullPage)

  useEffect(() => {
    let mounted = true

    window.Hivekeep.ready().then((meta) => {
      if (mounted) {
        setApp(meta)
        setReady(true)
      }
    })

    const offTheme = window.Hivekeep.on('theme-changed', (t) => {
      if (mounted) setTheme(t)
    })
    const offLocale = window.Hivekeep.on('locale-changed', (d) => {
      if (mounted) setLocale(d.locale)
    })
    const offFullpage = window.Hivekeep.on('fullpage-changed', (d) => {
      if (mounted) setIsFullPage(d.isFullPage)
    })

    return () => {
      mounted = false
      offTheme()
      offLocale()
      offFullpage()
    }
  }, [])

  return { app, ready, theme, locale, isFullPage, api: window.Hivekeep.api }
}

// ─── useStorage ─────────────────────────────────────────────────────────────

/**
 * Reactive key-value storage hook backed by Hivekeep.storage.
 * Automatically loads the initial value and persists on every set call.
 * Awaits Hivekeep.ready() internally, so it's safe to use anywhere.
 *
 * @param {string} key — storage key
 * @param {any} defaultValue — value to use until loaded or if key doesn't exist
 * @returns {[value, setValue, loading]} — like useState + loading flag
 */
export function useStorage(key, defaultValue) {
  const [value, setValue] = useState(defaultValue)
  const [loading, setLoading] = useState(true)
  const valueRef = useRef(defaultValue)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    setLoading(true)

    window.Hivekeep.ready()
      .then(() => window.Hivekeep.storage.get(key))
      .then((stored) => {
        if (mountedRef.current && stored != null) {
          setValue(stored)
          valueRef.current = stored
        }
      })
      .catch((err) => {
        console.error('[Hivekeep React] useStorage load failed:', err)
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false)
      })

    return () => {
      mountedRef.current = false
    }
  }, [key])

  const set = useCallback(
    (newValue) => {
      const val = typeof newValue === 'function' ? newValue(valueRef.current) : newValue
      setValue(val)
      valueRef.current = val
      window.Hivekeep.storage.set(key, val).catch((err) => {
        console.error('[Hivekeep React] useStorage save failed:', err)
      })
    },
    [key],
  )

  return [value, set, loading]
}

// ─── useTheme ───────────────────────────────────────────────────────────────

/**
 * Lightweight reactive theme hook.
 * Use this instead of useHivekeep() when you only need theme info.
 *
 * @returns {{ mode: 'light'|'dark', palette: string }}
 */
export function useTheme() {
  const [theme, setTheme] = useState(window.Hivekeep.theme)

  useEffect(() => {
    return window.Hivekeep.on('theme-changed', setTheme)
  }, [])

  return theme
}

// ─── useAgent ─────────────────────────────────────────────────────────────────

/**
 * Reactive access to the parent Agent info (id, name, avatarUrl).
 * Waits for Hivekeep.ready() then returns Hivekeep.agent.
 *
 * @returns {{ agent: object|null, loading: boolean }}
 */
export function useAgent() {
  const [agent, setAgent] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    window.Hivekeep.ready().then(() => {
      if (mounted) {
        setAgent(window.Hivekeep.agent)
        setLoading(false)
      }
    })
    return () => { mounted = false }
  }, [])

  return { agent, loading }
}

// ─── useUser ────────────────────────────────────────────────────────────────

/**
 * Reactive access to the current user info (id, name, locale, timezone, avatarUrl).
 * Waits for Hivekeep.ready() then returns Hivekeep.user.
 *
 * @returns {{ user: object|null, loading: boolean }}
 */
export function useUser() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    window.Hivekeep.ready().then(() => {
      if (mounted) {
        setUser(window.Hivekeep.user)
        setLoading(false)
      }
    })
    return () => { mounted = false }
  }, [])

  return { user, loading }
}

// ─── useMediaQuery ──────────────────────────────────────────────────────────

/**
 * Reactive CSS media query hook.
 * Returns true when the query matches.
 *
 * @param {string} query — CSS media query string, e.g. '(min-width: 768px)'
 * @returns {boolean}
 *
 * @example
 *   const isDesktop = useMediaQuery('(min-width: 1024px)')
 *   const prefersDark = useMediaQuery('(prefers-color-scheme: dark)')
 */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => {
    try { return window.matchMedia(query).matches } catch { return false }
  })

  useEffect(() => {
    let mql
    try { mql = window.matchMedia(query) } catch { return }
    const handler = (e) => setMatches(e.matches)
    setMatches(mql.matches)
    if (mql.addEventListener) {
      mql.addEventListener('change', handler)
      return () => mql.removeEventListener('change', handler)
    }
    // fallback for older browsers
    mql.addListener(handler)
    return () => mql.removeListener(handler)
  }, [query])

  return matches
}

// ─── useDebounce ────────────────────────────────────────────────────────────

/**
 * Debounce a value. The returned value only updates after the specified delay
 * of inactivity.
 *
 * @param {any} value — value to debounce
 * @param {number} delayMs — debounce delay in milliseconds (default: 300)
 * @returns {any} — debounced value
 *
 * @example
 *   const [search, setSearch] = useState('')
 *   const debouncedSearch = useDebounce(search, 500)
 *   useEffect(() => { fetchResults(debouncedSearch) }, [debouncedSearch])
 */
export function useDebounce(value, delayMs = 300) {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}

// ─── useInterval ────────────────────────────────────────────────────────────

/**
 * Declarative setInterval hook. Pass null as delay to pause.
 *
 * @param {Function} callback — function to call on each interval
 * @param {number|null} delayMs — interval in ms, or null to pause
 *
 * @example
 *   const [count, setCount] = useState(0)
 *   useInterval(() => setCount(c => c + 1), 1000)
 */
export function useInterval(callback, delayMs) {
  const savedCallback = useRef(callback)

  useEffect(() => {
    savedCallback.current = callback
  }, [callback])

  useEffect(() => {
    if (delayMs == null) return
    const id = setInterval(() => savedCallback.current(), delayMs)
    return () => clearInterval(id)
  }, [delayMs])
}

// ─── useClickOutside ────────────────────────────────────────────────────────

/**
 * Call a handler when a click happens outside the referenced element.
 * Useful for closing dropdowns, modals, popovers, etc.
 *
 * @param {React.RefObject} ref — ref attached to the element
 * @param {Function} handler — called when click is outside
 *
 * @example
 *   const ref = useRef(null)
 *   useClickOutside(ref, () => setOpen(false))
 *   return <div ref={ref}>...</div>
 */
export function useClickOutside(ref, handler) {
  const savedHandler = useRef(handler)

  useEffect(() => {
    savedHandler.current = handler
  }, [handler])

  useEffect(() => {
    const listener = (e) => {
      if (!ref.current || ref.current.contains(e.target)) return
      savedHandler.current(e)
    }
    document.addEventListener('mousedown', listener)
    document.addEventListener('touchstart', listener)
    return () => {
      document.removeEventListener('mousedown', listener)
      document.removeEventListener('touchstart', listener)
    }
  }, [ref])
}

// ─── useForm ────────────────────────────────────────────────────────────────

/**
 * Simple form state management hook with validation support.
 *
 * @param {object} initialValues — initial form field values
 * @param {Function} [validate] — optional validation function: (values) => { fieldName: 'error message' }
 * @returns {{ values, errors, touched, setValue, setValues, handleChange, handleBlur, handleSubmit, reset, isValid, isDirty }}
 *
 * @example
 *   const form = useForm({ name: '', email: '' }, (v) => {
 *     const errs = {}
 *     if (!v.name) errs.name = 'Required'
 *     if (!v.email.includes('@')) errs.email = 'Invalid email'
 *     return errs
 *   })
 *
 *   <Input value={form.values.name} onChange={form.handleChange('name')}
 *          onBlur={form.handleBlur('name')} error={form.touched.name && form.errors.name} />
 *   <Button onClick={form.handleSubmit((values) => save(values))} disabled={!form.isValid}>Save</Button>
 */
export function useForm(initialValues, validate) {
  const [values, setValues] = useState(initialValues)
  const [touched, setTouched] = useState({})
  const [errors, setErrors] = useState({})
  const initialRef = useRef(initialValues)

  // Run validation whenever values change
  useEffect(() => {
    if (validate) {
      const errs = validate(values) || {}
      setErrors(errs)
    }
  }, [values])

  const setValue = useCallback((field, value) => {
    setValues((prev) => ({ ...prev, [field]: value }))
  }, [])

  const handleChange = useCallback((field) => {
    return (e) => {
      const val = e && e.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e
      setValues((prev) => ({ ...prev, [field]: val }))
    }
  }, [])

  const handleBlur = useCallback((field) => {
    return () => setTouched((prev) => ({ ...prev, [field]: true }))
  }, [])

  const handleSubmit = useCallback((onSubmit) => {
    return (e) => {
      if (e && e.preventDefault) e.preventDefault()
      // Mark all fields as touched
      const allTouched = Object.keys(values).reduce((acc, k) => ({ ...acc, [k]: true }), {})
      setTouched(allTouched)

      if (validate) {
        const errs = validate(values) || {}
        setErrors(errs)
        if (Object.keys(errs).length > 0) return
      }
      onSubmit(values)
    }
  }, [values, validate])

  const reset = useCallback(() => {
    setValues(initialRef.current)
    setTouched({})
    setErrors({})
  }, [])

  const isValid = Object.keys(errors).length === 0
  const isDirty = JSON.stringify(values) !== JSON.stringify(initialRef.current)

  return { values, errors, touched, setValue, setValues, handleChange, handleBlur, handleSubmit, reset, isValid, isDirty }
}

// ─── useMemory ──────────────────────────────────────────────────────────────

/**
 * Hook for searching and storing Agent memories from within a mini-app.
 * Wraps Hivekeep.memory.search() and Hivekeep.memory.store().
 *
 * @returns {{ search: (query, limit?) => Promise<Array>, store: (content, options?) => Promise<object>, results: Array, loading: boolean }}
 *
 * @example
 *   const memory = useMemory()
 *   const results = await memory.search('user preferences')
 *   await memory.store('User prefers dark mode')
 */
export function useMemory() {
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)

  const search = useCallback(async (query, limit) => {
    setLoading(true)
    try {
      const res = await window.Hivekeep.memory.search(query, limit)
      setResults(res)
      return res
    } catch (err) {
      console.error('[Hivekeep React] useMemory search failed:', err)
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  const store = useCallback(async (content, options) => {
    try {
      return await window.Hivekeep.memory.store(content, options)
    } catch (err) {
      console.error('[Hivekeep React] useMemory store failed:', err)
      throw err
    }
  }, [])

  return { search, store, results, loading }
}

// ─── useConversation ────────────────────────────────────────────────────────

/**
 * Hook for interacting with the Agent's conversation.
 * Wraps Hivekeep.conversation.history() and Hivekeep.conversation.send().
 *
 * @returns {{ history: (limit?) => Promise<Array>, send: (text, options?) => Promise, messages: Array, loading: boolean }}
 *
 * @example
 *   const conv = useConversation()
 *   useEffect(() => { conv.history(10) }, [])
 *   conv.send('Hello from my mini-app!')
 */
export function useConversation() {
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(false)

  const history = useCallback(async (limit) => {
    setLoading(true)
    try {
      const msgs = await window.Hivekeep.conversation.history(limit)
      setMessages(msgs)
      return msgs
    } catch (err) {
      console.error('[Hivekeep React] useConversation history failed:', err)
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  const send = useCallback(async (text, options) => {
    try {
      return await window.Hivekeep.conversation.send(text, options)
    } catch (err) {
      console.error('[Hivekeep React] useConversation send failed:', err)
      throw err
    }
  }, [])

  return { history, send, messages, loading }
}

// ─── useShortcut ────────────────────────────────────────────────────────────

/**
 * Register a keyboard shortcut within the mini-app.
 * Automatically cleans up on unmount or when key/callback changes.
 *
 * @param {string} key — key combo, e.g. 'ctrl+k', 'meta+shift+p', 'escape'
 * @param {Function} callback — called when shortcut fires
 *
 * @example
 *   useShortcut('ctrl+k', () => setSearchOpen(true))
 *   useShortcut('escape', () => setSearchOpen(false))
 */
export function useShortcut(key, callback) {
  const savedCallback = useRef(callback)

  useEffect(() => {
    savedCallback.current = callback
  }, [callback])

  useEffect(() => {
    if (!key) return
    const unregister = window.Hivekeep.shortcut(key, (...args) => savedCallback.current(...args))
    return () => {
      if (typeof unregister === 'function') unregister()
      else window.Hivekeep.shortcut(key, null)
    }
  }, [key])
}

// ─── useApps ────────────────────────────────────────────────────────────────

/**
 * List other mini-apps from the same Agent.
 * Fetches on mount and returns the list reactively.
 *
 * @returns {{ apps: Array, loading: boolean, refresh: () => Promise<Array> }}
 *
 * @example
 *   const { apps, loading } = useApps()
 *   return apps.map(a => <div key={a.id}>{a.name}</div>)
 */
export function useApps() {
  const [apps, setApps] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.Hivekeep.apps.list()
      setApps(list)
      return list
    } catch (err) {
      console.error('[Hivekeep React] useApps failed:', err)
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    window.Hivekeep.ready().then(refresh)
  }, [refresh])

  return { apps, loading, refresh }
}

// ─── useSharedData ──────────────────────────────────────────────────────────

/**
 * Listen for data shared from another mini-app via Hivekeep.share().
 * Calls the handler when shared data arrives. Also returns the last received data.
 *
 * @param {Function} [onData] — optional callback when data arrives
 * @returns {{ data: object|null, clear: () => void }}
 *
 * @example
 *   const { data } = useSharedData((shared) => {
 *     console.log('Received from', shared.fromName, shared.data)
 *   })
 */
export function useSharedData(onData) {
  const [data, setData] = useState(null)
  const handlerRef = useRef(onData)

  useEffect(() => {
    handlerRef.current = onData
  }, [onData])

  useEffect(() => {
    return window.Hivekeep.on('shared-data', (payload) => {
      setData(payload)
      if (handlerRef.current) handlerRef.current(payload)
    })
  }, [])

  const clear = useCallback(() => setData(null), [])

  return { data, clear }
}

// ─── usePrevious ────────────────────────────────────────────────────────────

/**
 * Returns the previous value of a variable (from the last render).
 * Useful for comparing current vs previous state.
 *
 * @param {any} value — value to track
 * @returns {any} — previous value (undefined on first render)
 *
 * @example
 *   const [count, setCount] = useState(0)
 *   const prevCount = usePrevious(count)
 *   // prevCount is the value from the previous render
 */
export function usePrevious(value) {
  const ref = useRef()
  useEffect(() => {
    ref.current = value
  })
  return ref.current
}

// ─── useOnline ──────────────────────────────────────────────────────────────

/**
 * Reactive network status hook.
 * Returns true when the browser is online.
 *
 * @returns {boolean}
 *
 * @example
 *   const isOnline = useOnline()
 *   if (!isOnline) return <Alert variant="warning">You're offline</Alert>
 */
export function useOnline() {
  const [online, setOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  return online
}

// ─── useClipboard ───────────────────────────────────────────────────────────

/**
 * Reactive clipboard hook.
 * Provides `copy(text)` and `paste()` with loading/success state.
 *
 * @returns {{ copy: (text: string) => Promise<boolean>, paste: () => Promise<string|null>, copied: boolean, loading: boolean }}
 *
 * @example
 *   const { copy, paste, copied } = useClipboard()
 *   <Button onClick={() => copy('hello')}>{copied ? 'Copied!' : 'Copy'}</Button>
 */
export function useClipboard() {
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(false)
  const timerRef = useRef(null)

  const copy = useCallback(async (text) => {
    setLoading(true)
    try {
      await window.Hivekeep.clipboard.write(text)
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 2000)
      return true
    } catch {
      return false
    } finally {
      setLoading(false)
    }
  }, [])

  const paste = useCallback(async () => {
    setLoading(true)
    try {
      return await window.Hivekeep.clipboard.read()
    } catch {
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [])

  return { copy, paste, copied, loading }
}

// ─── useNotification ────────────────────────────────────────────────────────

/**
 * Hook for sending browser notifications via the parent window.
 * Wraps `Hivekeep.notification()` with a reactive API and permission state.
 *
 * @returns {{ notify: (title: string, body?: string) => Promise<boolean>, lastSent: string|null }}
 *
 * @example
 *   const { notify } = useNotification()
 *   <Button onClick={() => notify('Timer done!', 'Your 5-minute timer has finished.')}>Notify</Button>
 */
export function useNotification() {
  const [lastSent, setLastSent] = useState(null)

  const notify = useCallback(async (title, body) => {
    const ok = await window.Hivekeep.notification(title, body)
    if (ok) setLastSent(new Date().toISOString())
    return ok
  }, [])

  return { notify, lastSent }
}

// ─── useDownload ────────────────────────────────────────────────────────────

/**
 * Hook for triggering file downloads from within a mini-app.
 * Wraps `Hivekeep.download()` with a reactive downloading state.
 *
 * @returns {{ download: (filename: string, content: string|object|Blob|ArrayBuffer, mimeType?: string) => Promise<boolean>, downloading: boolean }}
 *
 * @example
 *   const { download, downloading } = useDownload()
 *   <Button onClick={() => download('data.json', myData)} disabled={downloading}>Export</Button>
 *   <Button onClick={() => download('report.csv', csvString, 'text/csv')}>CSV</Button>
 */
export function useDownload() {
  const [downloading, setDownloading] = useState(false)

  const doDownload = useCallback(async (filename, content, mimeType) => {
    setDownloading(true)
    try {
      const ok = await window.Hivekeep.download(filename, content, mimeType)
      return ok
    } catch {
      return false
    } finally {
      setDownloading(false)
    }
  }, [])

  return { download: doDownload, downloading }
}

// ─── useFetch ───────────────────────────────────────────────────────────────

/**
 * Hook for fetching external data via `Hivekeep.http()` with automatic
 * loading/error/refetch states. Fetches on mount and when `url` changes.
 *
 * @param {string|null} url - URL to fetch (pass null to skip/pause)
 * @param {object} [options] - Options: { method, body, headers, json (default true), enabled (default true) }
 * @returns {{ data: any, loading: boolean, error: string|null, refetch: () => void, status: number|null }}
 *
 * @example
 *   const { data, loading, error, refetch } = useFetch('https://api.example.com/items')
 *   if (loading) return <Spinner />
 *   if (error) return <Alert variant="error">{error}</Alert>
 *   return <List items={data.map(i => ({ content: i.name }))} />
 *
 * @example
 *   // POST request
 *   const { data, loading } = useFetch('https://api.example.com/search', {
 *     method: 'POST', body: { query: searchTerm }
 *   })
 *
 * @example
 *   // Conditional fetch (skip when no ID)
 *   const { data } = useFetch(userId ? `https://api.example.com/users/${userId}` : null)
 */
export function useFetch(url, options = {}) {
  const { method, body, headers, json = true, enabled = true } = options
  const [state, setState] = useState({ data: null, loading: !!url && enabled, error: null, status: null })
  const [tick, setTick] = useState(0)

  // Serialize options for dependency tracking
  const optKey = JSON.stringify({ method, body, headers, json, enabled })

  useEffect(() => {
    if (!url || !enabled) {
      setState(s => s.loading ? { ...s, loading: false } : s)
      return
    }
    let cancelled = false
    setState(s => ({ ...s, loading: true, error: null }))

    const doFetch = async () => {
      try {
        let result, status
        if (json && (!method || method === 'GET')) {
          result = await window.Hivekeep.http.json(url, headers)
          status = 200
        } else if (method === 'POST' || body) {
          result = await window.Hivekeep.http.post(url, body, headers)
          status = 200
        } else {
          const resp = await window.Hivekeep.http(url, { method, body: body ? JSON.stringify(body) : undefined, headers })
          status = resp.status
          result = json ? await resp.json() : await resp.text()
        }
        if (!cancelled) setState({ data: result, loading: false, error: null, status })
      } catch (err) {
        if (!cancelled) setState(s => ({ ...s, loading: false, error: err?.message || String(err), status: null }))
      }
    }
    doFetch()
    return () => { cancelled = true }
  }, [url, optKey, tick])

  const refetch = useCallback(() => setTick(t => t + 1), [])

  return { ...state, refetch }
}

// ─── useApi ─────────────────────────────────────────────────────────────────

/**
 * Hook for calling the mini-app's backend API (`_server.js`) via `Hivekeep.api()`
 * with automatic loading/error/refetch states. Fetches on mount when path is provided.
 *
 * @param {string|null} path - API path (e.g. "/items") or null to skip
 * @param {object} [options] - Options: { method (default "GET"), body, enabled (default true) }
 * @returns {{ data: any, loading: boolean, error: string|null, refetch: () => void }}
 *
 * @example
 *   const { data: items, loading, refetch } = useApi('/items')
 *   const handleAdd = async (item) => {
 *     await api.post('/items', item)
 *     refetch()
 *   }
 *
 * @example
 *   // Conditional fetch
 *   const { data } = useApi(activeTab === 'stats' ? '/stats' : null)
 */
export function useApi(path, options = {}) {
  const { method = 'GET', body, enabled = true } = options
  const [state, setState] = useState({ data: null, loading: !!path && enabled, error: null })
  const [tick, setTick] = useState(0)

  const optKey = JSON.stringify({ method, body, enabled })

  useEffect(() => {
    if (!path || !enabled) {
      setState(s => s.loading ? { ...s, loading: false } : s)
      return
    }
    let cancelled = false
    setState(s => ({ ...s, loading: true, error: null }))

    const doFetch = async () => {
      try {
        const apiObj = window.Hivekeep.api
        let result
        if (method === 'GET') {
          result = await apiObj.get(path)
        } else if (method === 'POST') {
          result = await apiObj.post(path, body)
        } else if (method === 'PUT') {
          result = await apiObj.put(path, body)
        } else if (method === 'DELETE') {
          result = await apiObj.delete(path)
        } else {
          result = await apiObj.json(path, { method, body })
        }
        if (!cancelled) setState({ data: result, loading: false, error: null })
      } catch (err) {
        if (!cancelled) setState(s => ({ ...s, loading: false, error: err?.message || String(err) }))
      }
    }
    doFetch()
    return () => { cancelled = true }
  }, [path, optKey, tick])

  const refetch = useCallback(() => setTick(t => t + 1), [])

  return { ...state, refetch }
}

// ─── useAsync ───────────────────────────────────────────────────────────────

/**
 * Hook that wraps an async function with loading/error states. Unlike useFetch/useApi,
 * this doesn't auto-execute — you call `run()` manually. Great for mutations (POST, DELETE, etc.).
 *
 * @param {Function} asyncFn - Async function to wrap
 * @returns {{ run: (...args) => Promise<any>, data: any, loading: boolean, error: string|null, reset: () => void }}
 *
 * @example
 *   const { run: deleteItem, loading: deleting } = useAsync(async (id) => {
 *     await api.delete(`/items/${id}`)
 *   })
 *   <Button onClick={() => deleteItem(item.id)} disabled={deleting}>
 *     {deleting ? 'Deleting...' : 'Delete'}
 *   </Button>
 *
 * @example
 *   const { run: submitForm, loading, error } = useAsync(async (values) => {
 *     return await api.post('/submit', values)
 *   })
 *   <Form onSubmit={(vals) => submitForm(vals)}>...</Form>
 *   {error && <Alert variant="error">{error}</Alert>}
 */
export function useAsync(asyncFn) {
  const [state, setState] = useState({ data: null, loading: false, error: null })
  const fnRef = useRef(asyncFn)
  fnRef.current = asyncFn

  const run = useCallback(async (...args) => {
    setState({ data: null, loading: true, error: null })
    try {
      const result = await fnRef.current(...args)
      setState({ data: result, loading: false, error: null })
      return result
    } catch (err) {
      const error = err?.message || String(err)
      setState(s => ({ ...s, loading: false, error }))
      throw err
    }
  }, [])

  const reset = useCallback(() => setState({ data: null, loading: false, error: null }), [])

  return { ...state, run, reset }
}

// ─── useEventStream ─────────────────────────────────────────────────────────

/**
 * Hook for subscribing to real-time SSE events from the mini-app backend.
 * Wraps `Hivekeep.events` with automatic connect/disconnect on mount/unmount.
 *
 * @param {string} [eventName] - Specific event name to listen for (omit to receive all events)
 * @param {Function} [callback] - Callback for each event. If omitted, events accumulate in `messages`.
 * @returns {{ messages: Array, connected: boolean, clear: () => void }}
 *
 * @example
 *   // Listen for specific events
 *   const { messages } = useEventStream('update')
 *   // messages = [{event: 'update', data: {...}, ts: ...}, ...]
 *
 * @example
 *   // With callback (no accumulation)
 *   useEventStream('notification', (data) => {
 *     toast(data.message, { type: data.level })
 *   })
 *
 * @example
 *   // All events
 *   const { messages, clear } = useEventStream()
 */
export function useEventStream(eventName, callback) {
  const [messages, setMessages] = useState([])
  const [connected, setConnected] = useState(false)
  const cbRef = useRef(callback)
  cbRef.current = callback

  useEffect(() => {
    const evts = window.Hivekeep.events
    if (!evts) return

    const handler = (data) => {
      const entry = { event: eventName || '*', data, ts: Date.now() }
      if (cbRef.current) {
        cbRef.current(data)
      } else {
        setMessages(prev => [...prev, entry])
      }
    }

    let unsub
    if (eventName) {
      unsub = evts.on(eventName, handler)
    } else {
      unsub = evts.subscribe(handler)
    }
    setConnected(true)

    return () => {
      if (typeof unsub === 'function') unsub()
      else evts.close?.()
      setConnected(false)
    }
  }, [eventName])

  const clear = useCallback(() => setMessages([]), [])

  return { messages, connected, clear }
}

// ─── useInfiniteScroll ──────────────────────────────────────────────────────

/**
 * Hook for infinite-scroll / "load more" pagination patterns. Fetches pages from
 * a backend API (`Hivekeep.api()`) or external URL (`Hivekeep.http()`) and merges results.
 *
 * @param {string|null} path - API path (e.g. "/items") or full URL. Pass null to disable.
 * @param {object} [options] - Configuration options
 * @param {string} [options.source='api'] - 'api' for Hivekeep.api(), 'http' for Hivekeep.http()
 * @param {number} [options.pageSize=20] - Items per page
 * @param {string} [options.pageParam='page'] - Query param name for page number
 * @param {string} [options.limitParam='limit'] - Query param name for page size
 * @param {Function} [options.getItems] - Extract items array from response (default: response itself or response.items/data)
 * @param {Function} [options.getHasMore] - Determine if more pages exist (default: items.length >= pageSize)
 * @param {boolean} [options.autoLoad=false] - Auto-load next page when scrolling near bottom
 * @param {number} [options.threshold=200] - Pixels from bottom to trigger auto-load
 * @returns {{ items: Array, loading: boolean, loadingMore: boolean, error: string|null, hasMore: boolean, loadMore: () => void, reset: () => void, sentinelRef: React.RefObject }}
 *
 * @example
 *   // Basic usage with backend API
 *   const { items, loading, hasMore, loadMore, loadingMore } = useInfiniteScroll('/items', {
 *     pageSize: 10
 *   })
 *   return (
 *     <div>
 *       {items.map(item => <div key={item.id}>{item.name}</div>)}
 *       {loadingMore && <Spinner />}
 *       {hasMore && <Button onClick={loadMore}>Load more</Button>}
 *     </div>
 *   )
 *
 * @example
 *   // Auto-load with sentinel element
 *   const { items, loading, loadingMore, sentinelRef } = useInfiniteScroll('/feed', {
 *     autoLoad: true, threshold: 300
 *   })
 *   return (
 *     <div>
 *       {items.map(item => <Card key={item.id}>{item.text}</Card>)}
 *       <div ref={sentinelRef}>{loadingMore && <Spinner />}</div>
 *     </div>
 *   )
 *
 * @example
 *   // External API with custom response parsing
 *   const { items, hasMore, loadMore } = useInfiniteScroll('https://api.example.com/posts', {
 *     source: 'http',
 *     getItems: (res) => res.results,
 *     getHasMore: (res, items) => res.next !== null
 *   })
 */
export function useInfiniteScroll(path, options = {}) {
  const {
    source = 'api',
    pageSize = 20,
    pageParam = 'page',
    limitParam = 'limit',
    getItems: getItemsFn,
    getHasMore: getHasMoreFn,
    autoLoad = false,
    threshold = 200
  } = options

  const [items, setItems] = useState([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(!!path)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  const [hasMore, setHasMore] = useState(true)
  const sentinelRef = useRef(null)
  const fetchingRef = useRef(false)

  const extractItems = useCallback((response) => {
    if (getItemsFn) return getItemsFn(response)
    if (Array.isArray(response)) return response
    if (response?.items) return response.items
    if (response?.data) return response.data
    if (response?.results) return response.results
    return []
  }, [getItemsFn])

  const checkHasMore = useCallback((response, extracted) => {
    if (getHasMoreFn) return getHasMoreFn(response, extracted)
    return extracted.length >= pageSize
  }, [getHasMoreFn, pageSize])

  const fetchPage = useCallback(async (pageNum, isReset) => {
    if (!path || fetchingRef.current) return
    fetchingRef.current = true

    const isFirst = pageNum === 1
    if (isFirst) setLoading(true)
    else setLoadingMore(true)
    setError(null)

    try {
      const separator = path.includes('?') ? '&' : '?'
      const url = `${path}${separator}${pageParam}=${pageNum}&${limitParam}=${pageSize}`

      let response
      if (source === 'http') {
        response = await window.Hivekeep.http.json(url)
      } else {
        response = await window.Hivekeep.api.get(url)
      }

      const extracted = extractItems(response)
      const more = checkHasMore(response, extracted)

      setItems(prev => isFirst || isReset ? extracted : [...prev, ...extracted])
      setHasMore(more)
    } catch (err) {
      setError(err?.message || String(err))
    } finally {
      setLoading(false)
      setLoadingMore(false)
      fetchingRef.current = false
    }
  }, [path, source, pageSize, pageParam, limitParam, extractItems, checkHasMore])

  // Initial fetch
  useEffect(() => {
    if (!path) {
      setLoading(false)
      return
    }
    setItems([])
    setPage(1)
    setHasMore(true)
    fetchPage(1, true)
  }, [path]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback(() => {
    if (!hasMore || fetchingRef.current) return
    const next = page + 1
    setPage(next)
    fetchPage(next, false)
  }, [hasMore, page, fetchPage])

  const reset = useCallback(() => {
    setItems([])
    setPage(1)
    setHasMore(true)
    setError(null)
    fetchPage(1, true)
  }, [fetchPage])

  // IntersectionObserver for auto-load
  useEffect(() => {
    if (!autoLoad || !sentinelRef.current) return
    const el = sentinelRef.current

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !fetchingRef.current) {
          loadMore()
        }
      },
      { rootMargin: `0px 0px ${threshold}px 0px` }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [autoLoad, threshold, hasMore, loadMore])

  return { items, loading, loadingMore, error, hasMore, loadMore, reset, sentinelRef }
}

// ─── usePagination ──────────────────────────────────────────────────────────

/**
 * Hook for traditional page-based pagination (page 1, 2, 3... with navigation).
 * Unlike useInfiniteScroll, this replaces items on each page change.
 *
 * @param {string|null} path - API path or full URL. Pass null to disable.
 * @param {object} [options] - Configuration options
 * @param {string} [options.source='api'] - 'api' for Hivekeep.api(), 'http' for Hivekeep.http()
 * @param {number} [options.pageSize=20] - Items per page
 * @param {string} [options.pageParam='page'] - Query param name for page number
 * @param {string} [options.limitParam='limit'] - Query param name for page size
 * @param {Function} [options.getItems] - Extract items from response
 * @param {Function} [options.getTotal] - Extract total count from response (enables page count)
 * @returns {{ items: Array, loading: boolean, error: string|null, page: number, totalPages: number|null, setPage: (n: number) => void, next: () => void, prev: () => void, refetch: () => void }}
 *
 * @example
 *   const { items, loading, page, totalPages, next, prev } = usePagination('/items', {
 *     pageSize: 10,
 *     getTotal: (res) => res.total
 *   })
 *   return (
 *     <div>
 *       <List items={items.map(i => ({ content: i.name }))} />
 *       <div>Page {page}{totalPages ? ` / ${totalPages}` : ''}</div>
 *       <Button onClick={prev} disabled={page <= 1}>Prev</Button>
 *       <Button onClick={next} disabled={totalPages && page >= totalPages}>Next</Button>
 *     </div>
 *   )
 */
export function usePagination(path, options = {}) {
  const {
    source = 'api',
    pageSize = 20,
    pageParam = 'page',
    limitParam = 'limit',
    getItems: getItemsFn,
    getTotal: getTotalFn
  } = options

  const [items, setItems] = useState([])
  const [page, setPageState] = useState(1)
  const [loading, setLoading] = useState(!!path)
  const [error, setError] = useState(null)
  const [totalPages, setTotalPages] = useState(null)
  const [tick, setTick] = useState(0)

  const extractItems = useCallback((response) => {
    if (getItemsFn) return getItemsFn(response)
    if (Array.isArray(response)) return response
    if (response?.items) return response.items
    if (response?.data) return response.data
    if (response?.results) return response.results
    return []
  }, [getItemsFn])

  useEffect(() => {
    if (!path) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)

    const doFetch = async () => {
      try {
        const separator = path.includes('?') ? '&' : '?'
        const url = `${path}${separator}${pageParam}=${page}&${limitParam}=${pageSize}`

        let response
        if (source === 'http') {
          response = await window.Hivekeep.http.json(url)
        } else {
          response = await window.Hivekeep.api.get(url)
        }

        if (cancelled) return
        setItems(extractItems(response))

        if (getTotalFn) {
          const total = getTotalFn(response)
          if (typeof total === 'number') {
            setTotalPages(Math.ceil(total / pageSize))
          }
        }
      } catch (err) {
        if (!cancelled) setError(err?.message || String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    doFetch()
    return () => { cancelled = true }
  }, [path, page, pageSize, pageParam, limitParam, source, extractItems, getTotalFn, tick])

  const setPage = useCallback((n) => {
    if (n < 1) return
    if (totalPages && n > totalPages) return
    setPageState(n)
  }, [totalPages])

  const next = useCallback(() => setPage(page + 1), [page, setPage])
  const prev = useCallback(() => setPage(page - 1), [page, setPage])
  const refetch = useCallback(() => setTick(t => t + 1), [])

  return { items, loading, error, page, totalPages, setPage, next, prev, refetch }
}

// ─── Convenience re-exports from vanilla SDK ─────────────────────────────────

export const toast = window.Hivekeep.toast
export const confirm = window.Hivekeep.confirm
export const prompt = window.Hivekeep.prompt
export const navigate = window.Hivekeep.navigate
export const fullpage = window.Hivekeep.fullpage
export const setTitle = window.Hivekeep.setTitle
export const setBadge = window.Hivekeep.setBadge
export const openApp = window.Hivekeep.openApp
export const clipboard = window.Hivekeep.clipboard
export const storage = window.Hivekeep.storage
export const api = window.Hivekeep.api
export const http = window.Hivekeep.http
export const events = window.Hivekeep.events
export const agent = window.Hivekeep.agent
export const user = window.Hivekeep.user
export const memory = window.Hivekeep.memory
export const conversation = window.Hivekeep.conversation
export const notification = window.Hivekeep.notification
export const resize = window.Hivekeep.resize
export const share = window.Hivekeep.share
export const shortcut = window.Hivekeep.shortcut
export const apps = window.Hivekeep.apps
export const download = window.Hivekeep.download

// ─── useLocalStorage ────────────────────────────────────────────────────────
/**
 * Persistent state using browser localStorage (not synced via Hivekeep storage).
 * Useful for UI preferences, collapsed states, and other non-critical local data.
 * @param {string} key - localStorage key (auto-prefixed with 'kb:')
 * @param {*} defaultValue - fallback when key doesn't exist
 */
export function useLocalStorage(key, defaultValue) {
  const prefixedKey = 'kb:' + key
  const [value, setValue] = useState(() => {
    try {
      const item = localStorage.getItem(prefixedKey)
      return item !== null ? JSON.parse(item) : defaultValue
    } catch {
      return defaultValue
    }
  })

  const set = useCallback((newValue) => {
    setValue((prev) => {
      const resolved = typeof newValue === 'function' ? newValue(prev) : newValue
      try {
        localStorage.setItem(prefixedKey, JSON.stringify(resolved))
      } catch { /* quota exceeded — silently fail */ }
      return resolved
    })
  }, [prefixedKey])

  const remove = useCallback(() => {
    localStorage.removeItem(prefixedKey)
    setValue(defaultValue)
  }, [prefixedKey, defaultValue])

  // Sync across tabs
  useEffect(() => {
    function onStorage(e) {
      if (e.key === prefixedKey) {
        try {
          setValue(e.newValue !== null ? JSON.parse(e.newValue) : defaultValue)
        } catch { /* ignore parse errors */ }
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [prefixedKey, defaultValue])

  return [value, set, remove]
}

// ─── useBreakpoint ──────────────────────────────────────────────────────────
/**
 * Returns the current responsive breakpoint name based on window width.
 * Breakpoints: 'xs' (<640px), 'sm' (≥640px), 'md' (≥768px), 'lg' (≥1024px), 'xl' (≥1280px).
 * Reactive — updates on window resize.
 */
export function useBreakpoint() {
  const getBreakpoint = useCallback(() => {
    const w = window.innerWidth
    if (w >= 1280) return 'xl'
    if (w >= 1024) return 'lg'
    if (w >= 768) return 'md'
    if (w >= 640) return 'sm'
    return 'xs'
  }, [])

  const [bp, setBp] = useState(getBreakpoint)

  useEffect(() => {
    function onResize() {
      setBp(getBreakpoint())
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [getBreakpoint])

  return bp
}

// ─── useHashRouter ──────────────────────────────────────────────────────────
/**
 * Simple hash-based router for multi-page mini-apps.
 *
 * Usage:
 *   const { path, params, navigate, back } = useHashRouter('/')
 *   // URL hash "#/settings?tab=general" → path="/settings", params={tab:"general"}
 *
 * Routes are defined via hash fragments: #/page, #/page?key=val&key2=val2
 * Supports browser back/forward navigation.
 *
 * @param defaultPath - fallback path when hash is empty (default: '/')
 */
export function useHashRouter(defaultPath = '/') {
  const parse = useCallback(() => {
    const hash = window.location.hash.slice(1) || defaultPath
    const qIdx = hash.indexOf('?')
    const path = qIdx >= 0 ? hash.slice(0, qIdx) : hash
    const params = {}
    if (qIdx >= 0) {
      const sp = new URLSearchParams(hash.slice(qIdx + 1))
      for (const [k, v] of sp) params[k] = v
    }
    return { path: path || '/', params }
  }, [defaultPath])

  const [state, setState] = useState(parse)

  useEffect(() => {
    function onHash() { setState(parse()) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [parse])

  const navigate = useCallback((path, params) => {
    let hash = path
    if (params && Object.keys(params).length > 0) {
      hash += '?' + new URLSearchParams(params).toString()
    }
    window.location.hash = hash
  }, [])

  const back = useCallback(() => { history.back() }, [])

  return { path: state.path, params: state.params, navigate, back }
}

// ─── Route / Switch ─────────────────────────────────────────────────────────
/**
 * Declarative route matching component.
 *
 * Usage:
 *   const { path } = useHashRouter()
 *   return (
 *     <>
 *       <Route path="/" current={path}><HomePage /></Route>
 *       <Route path="/settings" current={path}><SettingsPage /></Route>
 *       <Route fallback current={path}><NotFound /></Route>
 *     </>
 *   )
 *
 * @param path - route to match (exact match)
 * @param current - current path from useHashRouter
 * @param fallback - if true, renders when no other Route matched (place last)
 * @param children - content to render
 */
export function Route({ path, current, fallback, children }) {
  if (fallback) {
    // Fallback renders only when current doesn't match any explicit path —
    // caller is responsible for placing it last; we just check path vs current.
    return current === path || path == null ? children : null
  }
  return current === path ? children : null
}

// ─── Link ───────────────────────────────────────────────────────────────────
/**
 * Anchor component for hash navigation. Renders a styled <a> tag.
 *
 * Usage:
 *   <Link to="/settings" params={{tab: 'general'}}>Settings</Link>
 *   <Link to="/" className="nav-link" active={path === '/'}>Home</Link>
 */
export function Link({ to, params, children, active, className = '', style, ...rest }) {
  let href = '#' + to
  if (params && Object.keys(params).length > 0) {
    href += '?' + new URLSearchParams(params).toString()
  }

  const cls = [className, active ? 'link-active' : ''].filter(Boolean).join(' ')

  return React.createElement('a', { href, className: cls || undefined, style, ...rest }, children)
}

// ─── Backward-compat aliases (pre-Hivekeep-rebrand mini-apps) ───────────────
// Mini-apps authored before the KinBot → Hivekeep rebrand import `useKinBot`
// from `@kinbot/react`. The hook was renamed to `useHivekeep`; this alias keeps
// those apps running (the legacy `kinbot-*` SDK URLs are served by the route
// aliases in routes/mini-apps.ts).
export const useKinBot = useHivekeep
