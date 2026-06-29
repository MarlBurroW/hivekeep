/**
 * Hivekeep Mini-App SDK — TypeScript Definitions
 * @version 1.19.0
 *
 * These types describe the global `Hivekeep` object auto-injected into mini-app iframes.
 * Import type reference: `/// <reference path="gezy-sdk.d.ts" />`
 */

// ─── Core Types ─────────────────────────────────────────────────────────────

export interface HivekeepTheme {
  mode: 'light' | 'dark';
  palette: string;
}

export interface HivekeepAppMeta {
  id: string;
  name: string;
  slug: string;
  agentId: string;
  agentName: string;
  agentAvatarUrl: string | null;
  isFullPage: boolean;
  locale: string;
  user: HivekeepUser;
}

export interface HivekeepAgent {
  id: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface HivekeepUser {
  id: string | null;
  name: string | null;
  pseudonym: string | null;
  locale: string | null;
  timezone: string | null;
  avatarUrl: string | null;
}

export interface MiniAppInfo {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  version: string | null;
}

export interface MemoryResult {
  id: string;
  content: string;
  category: string;
  subject: string | null;
  score: number;
  updatedAt: string;
}

export interface CreatedMemory {
  id: string;
  content: string;
  category: string;
  subject: string | null;
}

export interface ConversationMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  sourceType: string;
}

export interface SharedData<T = unknown> {
  from: string;
  fromName: string;
  data: T;
  ts: number;
}

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export type EventName =
  | 'theme-changed'
  | 'app-meta'
  | 'locale-changed'
  | 'fullpage-changed'
  | 'shared-data'
  | string;

// ─── Storage ────────────────────────────────────────────────────────────────

export interface HivekeepStorage {
  /** Get a value by key. Returns parsed value or null if not found. */
  get<T = unknown>(key: string): Promise<T | null>;
  /** Set a value for a key. Value must be JSON-serializable. */
  set(key: string, value: unknown): Promise<void>;
  /** Delete a key. Returns true if deleted, false if not found. */
  delete(key: string): Promise<boolean>;
  /** List all keys with their sizes. */
  list(): Promise<Array<{ key: string; size: number }>>;
  /** Clear all storage for this app. Returns number of keys cleared. */
  clear(): Promise<number>;
}

// ─── Backend API ────────────────────────────────────────────────────────────

export interface HivekeepApi {
  /** Call a backend API route. Returns raw Response. */
  (path: string, options?: RequestInit): Promise<Response>;
  /** GET and parse JSON. */
  json<T = unknown>(path: string, headers?: Record<string, string>): Promise<T>;
  /** GET JSON shorthand. */
  get<T = unknown>(path: string, headers?: Record<string, string>): Promise<T>;
  /** POST JSON and parse response. */
  post<T = unknown>(path: string, data?: unknown): Promise<T>;
  /** PUT JSON and parse response. */
  put<T = unknown>(path: string, data?: unknown): Promise<T>;
  /** PATCH JSON and parse response. */
  patch<T = unknown>(path: string, data?: unknown): Promise<T>;
  /** DELETE and parse response. */
  delete<T = unknown>(path: string): Promise<T>;
}

// ─── Platform API (gated proxy to Hivekeep's own REST API) ───────────────────

export interface HivekeepPlatform {
  /** Call a platform REST route (same API as the settings UI). Returns raw Response. */
  (path: string, options?: RequestInit): Promise<Response>;
  /** Call and parse JSON. */
  json<T = unknown>(path: string, options?: RequestInit): Promise<T>;
  /** GET JSON shorthand. */
  get<T = unknown>(path: string, headers?: Record<string, string>): Promise<T>;
  /** POST JSON and parse response. */
  post<T = unknown>(path: string, data?: unknown): Promise<T>;
  /** PUT JSON and parse response. */
  put<T = unknown>(path: string, data?: unknown): Promise<T>;
  /** PATCH JSON and parse response. */
  patch<T = unknown>(path: string, data?: unknown): Promise<T>;
  /** DELETE and parse response (null for 204). */
  delete<T = unknown>(path: string): Promise<T>;
}

// ─── HTTP Proxy ─────────────────────────────────────────────────────────────

export interface HivekeepHttp {
  /** Fetch an external URL through server proxy (bypasses CORS). Returns raw Response. */
  (url: string, options?: RequestInit): Promise<Response>;
  /** GET external URL and parse JSON. */
  json<T = unknown>(url: string, headers?: Record<string, string>): Promise<T>;
  /** POST JSON to external URL and parse response. */
  post<T = unknown>(url: string, data?: unknown, headers?: Record<string, string>): Promise<T>;
}

// ─── Clipboard ──────────────────────────────────────────────────────────────

export interface HivekeepClipboard {
  /** Copy text to system clipboard (bypasses iframe restrictions). */
  write(text: string): Promise<void>;
  /** Read text from system clipboard (may require permission). */
  read(): Promise<string>;
}

// ─── Events (SSE) ───────────────────────────────────────────────────────────

export interface HivekeepEvents {
  /** Receive all SSE events from backend ctx.events.emit(). */
  subscribe(callback: (event: { event: string; data: unknown }) => void): void;
  /** Listen for a specific event name from backend. */
  on(eventName: string, callback: (data: unknown) => void): void;
  /**
   * Send an event to the backend's onClientEvent(ctx, event, data, meta) export.
   * Resolves with the handler's return value (handled=false when the backend
   * does not export onClientEvent).
   */
  send(eventName: string, data?: unknown): Promise<{ handled: boolean; result: unknown }>;
  /** Disconnect the SSE stream. */
  close(): void;
  /** Whether the SSE connection is active. */
  readonly connected: boolean;
}

// ─── Apps ───────────────────────────────────────────────────────────────────

export interface HivekeepApps {
  /** List all mini-apps from the same Agent. */
  list(): Promise<MiniAppInfo[]>;
  /** Get details of a specific mini-app by ID. */
  get(appId: string): Promise<MiniAppInfo>;
}

// ─── Memory ─────────────────────────────────────────────────────────────────

export interface HivekeepMemory {
  /** Semantic search the Agent's memories. */
  search(query: string, limit?: number): Promise<MemoryResult[]>;
  /** Store a new memory for the Agent. */
  store(content: string, options?: { category?: 'fact' | 'preference' | 'decision' | 'knowledge'; subject?: string }): Promise<CreatedMemory>;
}

// ─── Conversation ───────────────────────────────────────────────────────────

export interface HivekeepConversation {
  /** Get recent conversation messages. */
  history(limit?: number): Promise<ConversationMessage[]>;
  /** Send a message to the Agent's conversation. */
  send(text: string, options?: { silent?: boolean }): Promise<boolean>;
}

// ─── Main Hivekeep Object ────────────────────────────────────────────────────

export interface Hivekeep {
  /** Current theme (mode + palette). */
  readonly theme: HivekeepTheme;
  /** Current app metadata. */
  readonly app: HivekeepAppMeta | null;
  /** Info about the parent Agent. */
  readonly agent: HivekeepAgent;
  /** Info about the current user. */
  readonly user: HivekeepUser;
  /** Whether the app is in full-page mode. */
  readonly isFullPage: boolean;
  /** Current UI language code (e.g. 'en', 'fr'). */
  readonly locale: string;
  /** SDK version string. */
  readonly version: string;

  // ─── Events ─────────────────────────────────────────────────────────
  /** Listen for events from the parent. */
  on(event: EventName, callback: (data: unknown) => void): void;
  /** Send events to the parent. */
  emit(event: string, data?: unknown): void;

  // ─── UI ─────────────────────────────────────────────────────────────
  /** Show a toast notification in the parent UI. */
  toast(message: string, type?: ToastType): void;
  /** Show a confirmation dialog. Returns true if confirmed. */
  confirm(message: string, options?: { title?: string; confirmText?: string; cancelText?: string }): Promise<boolean>;
  /** Show a prompt dialog. Returns entered text or null if cancelled. */
  prompt(message: string, options?: { title?: string; defaultValue?: string; placeholder?: string; confirmText?: string; cancelText?: string }): Promise<string | null>;
  /** Dynamically update the panel header title. */
  setTitle(title: string): void;
  /** Show a badge on the app in the sidebar. Pass null to clear. */
  setBadge(value: string | number | null): void;
  /** Open another mini-app from the same Agent by slug. */
  openApp(slug: string): void;
  /** Navigate the parent Hivekeep UI to a path. */
  navigate(path: string): void;

  // ─── Lifecycle ──────────────────────────────────────────────────────
  /** Signal that the app has finished loading. */
  ready(): void;
  /** Request full-page or side-panel mode. */
  fullpage(value: boolean): void;
  /** Request the parent panel to resize. Width: 320-1200px, Height: 200-2000px. */
  resize(width?: number, height?: number): void;

  // ─── Data ───────────────────────────────────────────────────────────
  /** Persistent key-value storage per app. */
  storage: HivekeepStorage;
  /** Call backend API routes (_server.js). */
  api: HivekeepApi;
  /** Call Hivekeep's own REST API (manage contacts, crons, projects…), gated by platform:<resource>:<read|write> permissions. */
  platform: HivekeepPlatform;
  /** Fetch external URLs through server proxy (bypasses CORS). */
  http: HivekeepHttp;
  /** System clipboard access. */
  clipboard: HivekeepClipboard;
  /** Real-time SSE events from backend. */
  events: HivekeepEvents;

  // ─── Communication ──────────────────────────────────────────────────
  /** Send a message to the Agent's conversation. */
  sendMessage(text: string, options?: { silent?: boolean }): Promise<boolean>;
  /** Browser notification via parent window. */
  notification(title: string, body?: string): Promise<boolean>;

  // ─── Namespaces ─────────────────────────────────────────────────────
  /** List and get mini-apps from the same Agent. */
  apps: HivekeepApps;
  /** Search and store Agent memories. */
  memory: HivekeepMemory;
  /** Read and send conversation messages. */
  conversation: HivekeepConversation;

  // ─── Advanced ───────────────────────────────────────────────────────
  /** Register a keyboard shortcut. Returns unregister function. Pass null callback to remove. */
  shortcut(key: string, callback: ((e: KeyboardEvent) => void) | null): (() => void) | void;
  /** Share data with another mini-app by slug. */
  share(targetSlug: string, data: unknown): void;
  /** Trigger a file download. Supports string, object (auto-JSON), Blob, ArrayBuffer. */
  download(filename: string, content: string | object | Blob | ArrayBuffer, mimeType?: string): Promise<void>;
}

declare global {
  interface Window {
    Hivekeep: Hivekeep;
  }
  const Hivekeep: Hivekeep;
}
