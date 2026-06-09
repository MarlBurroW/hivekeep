/**
 * Shared logic for account triggers — the single source of truth used by BOTH
 * the HTTP routes and the Agent tools (validation), the poller (evaluation), and
 * the prompt builder + UI (summary). No zod here: a hand-written recursive
 * validator gives precise, LLM-friendly error messages and keeps the client
 * bundle lean.
 */
import type {
  ConditionField,
  ConditionLeaf,
  ConditionNode,
  ConditionOp,
} from '@/shared/types'

export const MAX_CONDITION_DEPTH = 4
export const MAX_CONDITION_LEAVES = 30

/** Fields that require fetching the full message body (extra API call). */
export const BODY_FIELDS: readonly ConditionField[] = ['body', 'attachment_name', 'attachment_type']

const ALL_FIELDS: readonly ConditionField[] = [
  'sender_email', 'sender_domain', 'sender_name', 'subject', 'snippet',
  'recipient', 'has_attachment', 'unread', 'label',
  'body', 'attachment_name', 'attachment_type',
]

const TEXT_OPS: readonly ConditionOp[] = ['equals', 'contains', 'starts_with', 'ends_with', 'matches']
const BOOL_OPS: readonly ConditionOp[] = ['is_true', 'is_false']

/** Operators allowed per field — drives `describe_trigger_conditions` and the UI op dropdown. */
export const FIELD_OPS: Record<ConditionField, ConditionOp[]> = {
  sender_email: ['equals', 'contains', 'starts_with', 'ends_with', 'matches', 'in'],
  sender_domain: ['equals', 'ends_with', 'in'],
  sender_name: ['equals', 'contains', 'matches'],
  subject: ['equals', 'contains', 'starts_with', 'ends_with', 'matches'],
  snippet: ['contains', 'matches'],
  recipient: ['equals', 'contains', 'in'],
  has_attachment: ['is_true', 'is_false'],
  unread: ['is_true', 'is_false'],
  label: ['equals', 'contains', 'in'],
  body: ['contains', 'matches'],
  attachment_name: ['equals', 'contains', 'ends_with', 'matches'],
  attachment_type: ['equals', 'contains', 'in'],
}

export type ConditionValueKind = 'string' | 'list' | 'none'

/** What kind of `value` an operator expects. */
export function opValueKind(op: ConditionOp): ConditionValueKind {
  if (op === 'is_true' || op === 'is_false') return 'none'
  if (op === 'in') return 'list'
  return 'string'
}

// ─── Validation ──────────────────────────────────────────────────────────────

export type ValidateResult =
  | { ok: true; tree: ConditionNode }
  | { ok: false; error: string }

function validateNode(node: unknown, depth: number, state: { leaves: number }): string | null {
  if (depth > MAX_CONDITION_DEPTH) return `nesting too deep (max ${MAX_CONDITION_DEPTH} levels)`
  if (!node || typeof node !== 'object') return 'each node must be an object'
  const n = node as Record<string, unknown>

  if (n.type === 'group') {
    if (n.op !== 'and' && n.op !== 'or') return `group "op" must be "and" or "or"`
    if (!Array.isArray(n.children) || n.children.length === 0) return 'a group must have at least one child'
    for (const child of n.children) {
      const err = validateNode(child, depth + 1, state)
      if (err) return err
    }
    return null
  }

  if (n.type === 'leaf') {
    state.leaves += 1
    if (state.leaves > MAX_CONDITION_LEAVES) return `too many conditions (max ${MAX_CONDITION_LEAVES})`
    if (!ALL_FIELDS.includes(n.field as ConditionField)) return `unknown field "${String(n.field)}"`
    const field = n.field as ConditionField
    if (!FIELD_OPS[field].includes(n.op as ConditionOp)) {
      return `operator "${String(n.op)}" is not valid for field "${field}" (allowed: ${FIELD_OPS[field].join(', ')})`
    }
    const kind = opValueKind(n.op as ConditionOp)
    if (kind === 'string') {
      if (typeof n.value !== 'string' || n.value.trim() === '') return `field "${field}" requires a non-empty string value`
      if (n.op === 'matches') {
        try { new RegExp(n.value) } catch (e) { return `invalid regular expression: ${e instanceof Error ? e.message : 'parse error'}` }
      }
    } else if (kind === 'list') {
      if (!Array.isArray(n.value) || n.value.length === 0 || !n.value.every((v) => typeof v === 'string' && v.trim() !== '')) {
        return `operator "in" on field "${field}" requires a non-empty list of strings`
      }
    }
    return null
  }

  return `node "type" must be "group" or "leaf"`
}

/** Validate a condition tree. Root must be a group. */
export function validateConditionTree(tree: unknown): ValidateResult {
  const t = tree as Record<string, unknown> | null
  if (!t || t.type !== 'group') return { ok: false, error: 'the root of the conditions must be a group ({ "type": "group", "op": "and"|"or", "children": [...] })' }
  const err = validateNode(tree, 1, { leaves: 0 })
  if (err) return { ok: false, error: err }
  return { ok: true, tree: tree as ConditionNode }
}

/** Parse a JSON string and validate it — used by the Agent tools. */
export function parseAndValidateConditions(json: string): ValidateResult {
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch (e) {
    return { ok: false, error: `conditions is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  return validateConditionTree(parsed)
}

/** Whether any leaf needs the full body (drives the poller's getMessage fetch). */
export function treeNeedsBody(node: ConditionNode): boolean {
  if (node.type === 'group') return node.children.some(treeNeedsBody)
  return BODY_FIELDS.includes(node.field)
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

/** Normalized view of an email a trigger evaluates against. Body-dependent
 *  fields are only populated when a trigger needs them. */
export interface EmailMatchContext {
  senderEmail: string
  senderName: string
  senderDomain: string
  subject: string
  snippet: string
  recipients: string[]
  hasAttachment: boolean
  unread: boolean
  labels: string[]
  body?: string
  attachmentNames?: string[]
  attachmentTypes?: string[]
}

function norm(s: string): string {
  return s.trim().toLowerCase()
}

/** Apply a text/`in` operator to a single string value. */
function matchText(op: ConditionOp, fieldValue: string, target: string | string[]): boolean {
  const fv = norm(fieldValue)
  if (op === 'in') {
    const list = Array.isArray(target) ? target : [target]
    return list.some((t) => fv === norm(t))
  }
  if (op === 'matches') {
    try { return new RegExp(typeof target === 'string' ? target : '', 'i').test(fieldValue.trim()) } catch { return false }
  }
  const t = norm(typeof target === 'string' ? target : '')
  switch (op) {
    case 'equals': return fv === t
    case 'contains': return fv.includes(t)
    case 'starts_with': return fv.startsWith(t)
    case 'ends_with': return fv.endsWith(t)
    default: return false
  }
}

/** Resolve a leaf field to its value(s) in the context. Multi-value fields
 *  (recipient, label, attachment_*) return arrays — the leaf matches if ANY
 *  element matches. Boolean fields are handled by the caller. */
function fieldValues(field: ConditionField, ctx: EmailMatchContext): string[] {
  switch (field) {
    case 'sender_email': return [ctx.senderEmail]
    case 'sender_domain': return [ctx.senderDomain]
    case 'sender_name': return [ctx.senderName]
    case 'subject': return [ctx.subject]
    case 'snippet': return [ctx.snippet]
    case 'recipient': return ctx.recipients
    case 'label': return ctx.labels
    case 'body': return [ctx.body ?? '']
    case 'attachment_name': return ctx.attachmentNames ?? []
    case 'attachment_type': return ctx.attachmentTypes ?? []
    default: return []
  }
}

function matchLeaf(leaf: ConditionLeaf, ctx: EmailMatchContext): boolean {
  if (leaf.op === 'is_true' || leaf.op === 'is_false') {
    const actual = leaf.field === 'has_attachment' ? ctx.hasAttachment : leaf.field === 'unread' ? ctx.unread : false
    return leaf.op === 'is_true' ? actual : !actual
  }
  const values = fieldValues(leaf.field, ctx)
  const target = leaf.value as string | string[]
  return values.some((v) => matchText(leaf.op, v, target))
}

export function evaluateConditions(node: ConditionNode, ctx: EmailMatchContext): boolean {
  if (node.type === 'group') {
    return node.op === 'and'
      ? node.children.every((c) => evaluateConditions(c, ctx))
      : node.children.some((c) => evaluateConditions(c, ctx))
  }
  const r = matchLeaf(node, ctx)
  return node.negate ? !r : r
}

// ─── Human-readable summary (prompt block + UI list) ─────────────────────────

const FIELD_LABEL: Record<ConditionField, string> = {
  sender_email: 'sender', sender_domain: 'sender domain', sender_name: 'sender name',
  subject: 'subject', snippet: 'preview', recipient: 'recipient',
  has_attachment: 'attachment', unread: 'unread', label: 'label',
  body: 'body', attachment_name: 'attachment name', attachment_type: 'attachment type',
}

const OP_LABEL: Partial<Record<ConditionOp, string>> = {
  equals: '=', contains: 'contains', starts_with: 'starts with', ends_with: 'ends with', matches: 'matches', in: 'in',
}

function summarizeLeaf(leaf: ConditionLeaf): string {
  const not = leaf.negate ? 'not ' : ''
  if (leaf.op === 'is_true' || leaf.op === 'is_false') {
    const truthy = leaf.op === 'is_true'
    if (leaf.field === 'has_attachment') return `${not}${truthy ? 'has attachment' : 'no attachment'}`
    if (leaf.field === 'unread') return `${not}${truthy ? 'unread' : 'read'}`
    return `${not}${FIELD_LABEL[leaf.field]} ${truthy}`
  }
  const valueStr = Array.isArray(leaf.value) ? `[${leaf.value.join(', ')}]` : `"${String(leaf.value)}"`
  return `${not}${FIELD_LABEL[leaf.field]} ${OP_LABEL[leaf.op] ?? leaf.op} ${valueStr}`
}

export function summarizeConditions(node: ConditionNode): string {
  if (node.type === 'leaf') return summarizeLeaf(node)
  if (node.children.length === 1) return summarizeConditions(node.children[0]!)
  const sep = node.op === 'and' ? ' AND ' : ' OR '
  const inner = node.children
    .map((c) => (c.type === 'group' && c.children.length > 1 ? `(${summarizeConditions(c)})` : summarizeConditions(c)))
    .join(sep)
  return inner
}
