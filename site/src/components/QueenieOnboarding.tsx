/**
 * Animated "Queenie onboarding" figure for section 06 (Setup is a conversation).
 * Replays a scripted first-run conversation — provider key via SECURE INPUT
 * (dots typed into a vault field, never into the chat), capability detection,
 * then two agents created — using the same dm-* chat styles as the hero demo so
 * it looks exactly like the product. Autoplays when scrolled into view, loops
 * with a pause, pauses offscreen. prefers-reduced-motion gets the full
 * conversation statically (no playback).
 */
import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Check,
  KeyRound,
  Loader2,
  ShieldCheck,
  SlidersHorizontal,
  User,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react'

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')
const QUEENIE = `${BASE}/avatars/queenie.jpg`

type Step =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; icon: 'config' | 'wand'; tone: string; name: string; detail?: string }
  | { kind: 'secure'; label: string; stored: string }

const TOOL_ICON: Record<'config' | 'wand', LucideIcon> = {
  config: SlidersHorizontal,
  wand: WandSparkles,
}

const SCRIPT: Step[] = [
  { kind: 'text', text: "Welcome to your hive! I'm Queenie 🐝 Let's get you set up — do you have an AI provider key (OpenAI, Anthropic, Gemini…)?" },
  { kind: 'user', text: 'Yes, an OpenAI key.' },
  { kind: 'secure', label: 'OpenAI API key', stored: 'OPENAI_API_KEY' },
  { kind: 'tool', icon: 'config', tone: 'config', name: 'Detect capabilities', detail: 'LLM · embeddings · images · voice' },
  { kind: 'text', text: 'Connected ✅ One key just unlocked **4 capabilities** and 28 models. Now — who should join the hive first?' },
  { kind: 'user', text: 'Someone for my smart home. And a chef!' },
  { kind: 'tool', icon: 'wand', tone: 'memory', name: 'Create agent', detail: 'Nest · home automation' },
  { kind: 'tool', icon: 'wand', tone: 'memory', name: 'Create agent', detail: 'Cuisine · recipes & meals' },
  { kind: 'tool', icon: 'wand', tone: 'browse', name: 'Generate avatars', detail: 'hive style · 2 portraits' },
  { kind: 'text', text: 'Done — **Nest** and **Cuisine** just joined the hive 🐝 Talk to them anytime, and come back whenever you want to grow the team.' },
]

// Very small inline markdown: **bold** and `code`.
function renderRich(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>
    return <span key={i}>{p}</span>
  })
}

export default function QueenieOnboarding() {
  const reduce =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const [shown, setShown] = useState(reduce ? SCRIPT.length : 0)
  const [typing, setTyping] = useState(false)
  const [toolDone, setToolDone] = useState<Record<number, boolean>>(
    reduce ? Object.fromEntries(SCRIPT.map((_, i) => [i, true])) : {},
  )
  const [playing, setPlaying] = useState(false)
  const timers = useRef<number[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms))
  }
  const clearTimers = () => {
    timers.current.forEach((t) => clearTimeout(t))
    timers.current = []
  }

  // Play / pause with viewport visibility.
  useEffect(() => {
    if (reduce) return
    const el = rootRef.current
    if (!el || !('IntersectionObserver' in window)) {
      setPlaying(true)
      return
    }
    const io = new IntersectionObserver((es) => setPlaying(es[0].isIntersecting), { threshold: 0.35 })
    io.observe(el)
    return () => io.disconnect()
  }, [reduce])

  // Sequential playback, mirrors the hero demo pacing. Loops after a pause.
  useEffect(() => {
    if (reduce || !playing) return
    if (shown >= SCRIPT.length) {
      later(() => {
        setToolDone({})
        setShown(0)
      }, 4200)
      return clearTimers
    }
    const next = SCRIPT[shown]
    // If the step we just revealed was the secure input, hold the next step
    // until its dots finish typing and the vault confirms (≈2.1s resolve).
    const afterSecure = shown > 0 && SCRIPT[shown - 1].kind === 'secure' ? 2300 : 0
    if (next.kind === 'user') {
      later(() => setShown((s) => s + 1), 700 + afterSecure)
    } else if (next.kind === 'text') {
      later(() => {
        setTyping(true)
        later(() => {
          setTyping(false)
          setShown((s) => s + 1)
        }, shown === 0 ? 900 : 1200)
      }, afterSecure)
    } else if (next.kind === 'secure') {
      const idx = shown
      later(() => {
        setShown((s) => s + 1)
        later(() => setToolDone((d) => ({ ...d, [idx]: true })), 2100)
      }, 500)
    } else {
      const idx = shown
      later(() => {
        setShown((s) => s + 1)
        later(() => setToolDone((d) => ({ ...d, [idx]: true })), 950)
      }, 460 + afterSecure)
    }
    return clearTimers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, shown, reduce])

  // Stick to the bottom like a real chat.
  useEffect(() => {
    const b = bodyRef.current
    if (!b) return
    b.scrollTo({ top: b.scrollHeight, behavior: reduce ? 'auto' : 'smooth' })
  }, [shown, typing, toolDone, reduce])

  // Group consecutive non-user steps into one Queenie turn (avatar shown once).
  function conversation() {
    const steps = SCRIPT.slice(0, shown)
    const blocks: React.ReactNode[] = []
    let i = 0
    while (i < steps.length) {
      const s = steps[i]
      if (s.kind === 'user') {
        blocks.push(
          <div className="dm-row user" key={`u-${i}`}>
            <span className="dm-av dm-av-you">
              <User />
            </span>
            <div className="dm-bubble user">{renderRich(s.text)}</div>
          </div>,
        )
        i++
      } else {
        const group: React.ReactNode[] = []
        const startI = i
        while (i < steps.length && steps[i].kind !== 'user') {
          const step = steps[i]
          const key = i
          const done = toolDone[key]
          if (step.kind === 'text') {
            group.push(
              <div className="dm-bubble agent" key={`t-${key}`}>
                {renderRich(step.text)}
              </div>,
            )
          } else if (step.kind === 'secure') {
            group.push(
              <div className={`qd-secure${done ? ' done' : ''}`} key={`s-${key}`}>
                <div className="qd-sec-head">
                  <KeyRound /> Secure input · {step.label}
                </div>
                <div className="qd-sec-field" aria-hidden="true">
                  <span className="qd-sec-dots" />
                  <span className="qd-sec-caret" />
                </div>
                <div className="qd-sec-foot">
                  <span className="qd-sec-note">
                    <ShieldCheck /> straight to the encrypted vault — <b>never sent to the model</b>
                  </span>
                  <span className="qd-sec-ok">
                    {done ? <Check /> : <Loader2 className="dm-spin" />} <code>{step.stored}</code>
                  </span>
                </div>
              </div>,
            )
          } else {
            const Icon = TOOL_ICON[step.icon]
            group.push(
              <div className="dm-tool" key={`x-${key}`}>
                <span className={`dm-tool-ic dm-t-${step.tone}`}>
                  <Icon />
                </span>
                <span className="dm-tool-nm">
                  {step.name}
                  {step.detail && <span className="dm-tool-detail"> · {step.detail}</span>}
                </span>
                <span className="dm-tool-status">{done ? <Check className="dm-ok" /> : <Loader2 className="dm-spin" />}</span>
              </div>,
            )
          }
          i++
        }
        blocks.push(
          <div className="dm-row" key={`a-${startI}`}>
            <img className="dm-av" src={QUEENIE} alt="Queenie" width={36} height={36} />
            <div className="dm-col">
              <span className="dm-sender">Queenie</span>
              {group}
            </div>
          </div>,
        )
      }
    }
    if (typing) {
      blocks.push(
        <div className="dm-row" key="typing">
          <img className="dm-av" src={QUEENIE} alt="Queenie" width={36} height={36} />
          <div className="dm-col">
            <span className="dm-sender">Queenie</span>
            <div className="dm-typing">
              <span className="dm-dot" />
              <span className="dm-dot" />
              <span className="dm-dot" />
            </div>
          </div>
        </div>,
      )
    }
    return blocks
  }

  return (
    <div className="figure glass qd" ref={rootRef}>
      <div className="cap">
        <span>Fig. 5 · Queenie onboarding</span>
        <span className="amb">live demo</span>
      </div>
      <div className="qd-head">
        <img className="dm-head-av" src={QUEENIE} alt="Queenie" width={40} height={40} />
        <div className="dm-head-meta">
          <div className="dm-head-top">
            <span className="dm-head-nm">Queenie</span>
            <span className="dm-chip">
              <span className="pip" />
              online
            </span>
          </div>
          <span className="dm-head-role">Your setup guide · gets the hive running</span>
        </div>
      </div>
      <div className="dm-body qd-body" ref={bodyRef}>
        {conversation()}
      </div>
      <div className="dm-input" aria-hidden="true">
        <div className="dm-input-box">
          <span className="dm-input-ph">Message Queenie…</span>
          <span className="dm-send">
            <ArrowUp />
          </span>
        </div>
      </div>
    </div>
  )
}
