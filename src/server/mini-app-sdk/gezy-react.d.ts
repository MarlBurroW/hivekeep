/**
 * @hivekeep/react — TypeScript Definitions
 * React hooks and convenience re-exports for Hivekeep mini-apps.
 */

import type {
  Hivekeep, HivekeepTheme, HivekeepAgent, HivekeepUser, HivekeepStorage,
  HivekeepApi, HivekeepHttp, HivekeepClipboard, HivekeepEvents, HivekeepApps,
  HivekeepMemory, HivekeepConversation, MiniAppInfo, MemoryResult,
  CreatedMemory, ConversationMessage, SharedData, ToastType,
} from './gezy-sdk';

// ─── useHivekeep ──────────────────────────────────────────────────────────────

export interface UseHivekeepReturn {
  hivekeep: Hivekeep;
  app: Hivekeep['app'];
  theme: HivekeepTheme;
  ready: () => void;
}

/** Access the Hivekeep SDK instance with reactive theme/app updates. */
export function useHivekeep(): UseHivekeepReturn;

// ─── useStorage ─────────────────────────────────────────────────────────────

/** Reactive storage hook. Returns [value, setValue, { loading, error, remove }]. */
export function useStorage<T = unknown>(
  key: string,
  defaultValue?: T
): [T | undefined, (value: T) => Promise<void>, { loading: boolean; error: Error | null; remove: () => Promise<void> }];

// ─── useTheme ───────────────────────────────────────────────────────────────

/** Reactive theme hook. */
export function useTheme(): HivekeepTheme;

// ─── useAgent ─────────────────────────────────────────────────────────────────

/** Reactive Agent info hook. */
export function useAgent(): { agent: HivekeepAgent; loading: boolean };

// ─── useUser ────────────────────────────────────────────────────────────────

/** Reactive user info hook. */
export function useUser(): { user: HivekeepUser; loading: boolean };

// ─── useForm ────────────────────────────────────────────────────────────────

export interface UseFormReturn<T extends Record<string, unknown>> {
  values: T;
  errors: Partial<Record<keyof T, string>>;
  touched: Partial<Record<keyof T, boolean>>;
  handleChange: (name: keyof T) => (e: { target: { value: unknown; type?: string; checked?: boolean } }) => void;
  handleBlur: (name: keyof T) => () => void;
  handleSubmit: (e?: { preventDefault?: () => void }) => void;
  reset: () => void;
  isValid: boolean;
  isDirty: boolean;
}

/** Form state management with validation. */
export function useForm<T extends Record<string, unknown>>(
  initialValues: T,
  validate?: (values: T) => Partial<Record<keyof T, string>>
): UseFormReturn<T>;

// ─── useMediaQuery ──────────────────────────────────────────────────────────

/** Reactive CSS media query matching. */
export function useMediaQuery(query: string): boolean;

// ─── useDebounce ────────────────────────────────────────────────────────────

/** Debounce a value. */
export function useDebounce<T>(value: T, delayMs?: number): T;

// ─── useInterval ────────────────────────────────────────────────────────────

/** Declarative setInterval. Pass null to pause. */
export function useInterval(callback: () => void, delayMs: number | null): void;

// ─── useClickOutside ────────────────────────────────────────────────────────

/** Detect clicks outside a ref element. */
export function useClickOutside(ref: React.RefObject<HTMLElement>, handler: () => void): void;

// ─── useMemory ──────────────────────────────────────────────────────────────

export interface UseMemoryReturn {
  search: (query: string, limit?: number) => Promise<MemoryResult[]>;
  store: (content: string, options?: { category?: string; subject?: string }) => Promise<CreatedMemory>;
  results: MemoryResult[];
  loading: boolean;
}

/** Search and store Agent memories with reactive state. */
export function useMemory(): UseMemoryReturn;

// ─── useConversation ────────────────────────────────────────────────────────

export interface UseConversationReturn {
  history: (limit?: number) => Promise<ConversationMessage[]>;
  send: (text: string, options?: { silent?: boolean }) => Promise<boolean>;
  messages: ConversationMessage[];
  loading: boolean;
}

/** Interact with Agent conversation. */
export function useConversation(): UseConversationReturn;

// ─── useShortcut ────────────────────────────────────────────────────────────

/** Register a keyboard shortcut with auto-cleanup. */
export function useShortcut(key: string, callback: (e: KeyboardEvent) => void): void;

// ─── useApps ────────────────────────────────────────────────────────────────

export interface UseAppsReturn {
  apps: MiniAppInfo[];
  loading: boolean;
  refresh: () => Promise<void>;
}

/** List mini-apps from the same Agent. */
export function useApps(): UseAppsReturn;

// ─── useSharedData ──────────────────────────────────────────────────────────

export interface UseSharedDataReturn<T = unknown> {
  data: SharedData<T> | null;
  clear: () => void;
}

/** Listen for data shared from another mini-app. */
export function useSharedData<T = unknown>(onData?: (data: SharedData<T>) => void): UseSharedDataReturn<T>;

// ─── usePrevious ────────────────────────────────────────────────────────────

/** Returns the previous render's value. */
export function usePrevious<T>(value: T): T | undefined;

// ─── useOnline ──────────────────────────────────────────────────────────────

/** Reactive network status. */
export function useOnline(): boolean;

// ─── useClipboard ───────────────────────────────────────────────────────────

export interface UseClipboardReturn {
  copy: (text: string) => Promise<void>;
  read: () => Promise<string>;
  copied: boolean;
}

/** Clipboard access with copied state. */
export function useClipboard(): UseClipboardReturn;

// ─── useNotification ────────────────────────────────────────────────────────

export interface UseNotificationReturn {
  notify: (title: string, body?: string) => Promise<boolean>;
  sending: boolean;
}

/** Browser notifications via parent. */
export function useNotification(): UseNotificationReturn;

// ─── useDownload ────────────────────────────────────────────────────────────

export interface UseDownloadReturn {
  download: (filename: string, content: string | object | Blob | ArrayBuffer, mimeType?: string) => Promise<void>;
  downloading: boolean;
}

/** File download trigger. */
export function useDownload(): UseDownloadReturn;

// ─── useFetch ───────────────────────────────────────────────────────────────

export interface UseFetchOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  json?: boolean;
  enabled?: boolean;
}

export interface UseFetchReturn<T = unknown> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  status: number | null;
}

/** Fetch external data via Hivekeep.http() proxy. Pass null URL to skip. */
export function useFetch<T = unknown>(url: string | null, options?: UseFetchOptions): UseFetchReturn<T>;

// ─── useApi ─────────────────────────────────────────────────────────────────

export interface UseApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface UseApiReturn<T = unknown> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/** Fetch from mini-app backend (_server.js) via Hivekeep.api(). Pass null path to skip. */
export function useApi<T = unknown>(path: string | null, options?: UseApiOptions): UseApiReturn<T>;

// ─── useAsync ───────────────────────────────────────────────────────────────

export interface UseAsyncReturn<T = unknown, A extends unknown[] = unknown[]> {
  run: (...args: A) => Promise<T>;
  data: T | null;
  loading: boolean;
  error: Error | null;
  reset: () => void;
}

/** Wrap any async function with loading/error states. */
export function useAsync<T = unknown, A extends unknown[] = unknown[]>(
  asyncFn: (...args: A) => Promise<T>
): UseAsyncReturn<T, A>;

// ─── useEventStream ─────────────────────────────────────────────────────────

export interface EventStreamMessage {
  event: string;
  data: unknown;
  ts: number;
}

export interface UseEventStreamReturn {
  messages: EventStreamMessage[];
  connected: boolean;
  clear: () => void;
}

/** Subscribe to real-time SSE events from backend. */
export function useEventStream(eventName?: string, callback?: (data: unknown) => void): UseEventStreamReturn;

// ─── useInfiniteScroll ──────────────────────────────────────────────────────

export interface UseInfiniteScrollOptions {
  source?: 'api' | 'http';
  pageSize?: number;
  pageParam?: string;
  limitParam?: string;
  getItems?: (response: unknown) => unknown[];
  getHasMore?: (response: unknown, items: unknown[]) => boolean;
  autoLoad?: boolean;
  threshold?: number;
}

export interface UseInfiniteScrollReturn<T = unknown> {
  items: T[];
  loading: boolean;
  loadingMore: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  reset: () => void;
  sentinelRef: React.RefObject<HTMLElement>;
}

/** Infinite scroll / "load more" pagination. */
export function useInfiniteScroll<T = unknown>(
  path: string,
  options?: UseInfiniteScrollOptions
): UseInfiniteScrollReturn<T>;

// ─── usePagination ──────────────────────────────────────────────────────────

export interface UsePaginationOptions {
  source?: 'api' | 'http';
  pageSize?: number;
  pageParam?: string;
  limitParam?: string;
  getItems?: (response: unknown) => unknown[];
  getTotal?: (response: unknown) => number;
}

export interface UsePaginationReturn<T = unknown> {
  items: T[];
  loading: boolean;
  error: Error | null;
  page: number;
  totalPages: number;
  setPage: (page: number) => void;
  next: () => void;
  prev: () => void;
  refetch: () => Promise<void>;
}

/** Traditional page-based pagination. */
export function usePagination<T = unknown>(
  path: string,
  options?: UsePaginationOptions
): UsePaginationReturn<T>;

// ─── Convenience Re-exports ─────────────────────────────────────────────────

export const toast: Hivekeep['toast'];
export const confirm: Hivekeep['confirm'];
export const prompt: Hivekeep['prompt'];
export const navigate: Hivekeep['navigate'];
export const fullpage: Hivekeep['fullpage'];
export const setTitle: Hivekeep['setTitle'];
export const setBadge: Hivekeep['setBadge'];
export const openApp: Hivekeep['openApp'];
export const clipboard: Hivekeep['clipboard'];
export const storage: Hivekeep['storage'];
export const api: Hivekeep['api'];
export const platform: Hivekeep['platform'];
export const http: Hivekeep['http'];
export const events: Hivekeep['events'];
export const agent: Hivekeep['agent'];
export const user: Hivekeep['user'];
export const memory: Hivekeep['memory'];
export const conversation: Hivekeep['conversation'];
export const notification: Hivekeep['notification'];
export const resize: Hivekeep['resize'];
export const share: Hivekeep['share'];
export const shortcut: Hivekeep['shortcut'];
export const apps: Hivekeep['apps'];
export const download: Hivekeep['download'];

/**
 * Persistent state using browser localStorage (not synced via Hivekeep storage).
 * Useful for UI preferences, collapsed states, and other non-critical local data.
 * Keys are auto-prefixed with 'kb:'. Syncs across tabs via storage events.
 * @param key - localStorage key
 * @param defaultValue - fallback when key doesn't exist
 * @returns [value, setValue, remove] tuple
 */
export function useLocalStorage<T>(key: string, defaultValue: T): [T, (value: T | ((prev: T) => T)) => void, () => void];

/**
 * Returns the current responsive breakpoint name based on window width.
 * Reactive — updates on window resize.
 * @returns 'xs' (<640px) | 'sm' (≥640px) | 'md' (≥768px) | 'lg' (≥1024px) | 'xl' (≥1280px)
 */
export function useBreakpoint(): 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * Hash-based router for multi-page mini-apps.
 * Routes via URL hash: #/page?key=val
 * @param defaultPath - fallback when hash is empty (default: '/')
 */
export function useHashRouter(defaultPath?: string): {
  /** Current path (e.g. '/settings') */
  path: string;
  /** Parsed query parameters from hash */
  params: Record<string, string>;
  /** Navigate to a new path with optional params */
  navigate: (path: string, params?: Record<string, string>) => void;
  /** Go back in browser history */
  back: () => void;
};

/**
 * Declarative route component. Renders children when path matches current.
 */
export function Route(props: {
  path?: string;
  current: string;
  fallback?: boolean;
  children: React.ReactNode;
}): React.ReactNode;

/**
 * Anchor component for hash-based navigation.
 */
export function Link(props: {
  to: string;
  params?: Record<string, string>;
  children: React.ReactNode;
  active?: boolean;
  className?: string;
  style?: React.CSSProperties;
  [key: string]: any;
}): React.ReactElement;

/** @deprecated Renamed to `useHivekeep`. Kept for pre-rebrand mini-apps. */
export const useKinBot: typeof useHivekeep;
