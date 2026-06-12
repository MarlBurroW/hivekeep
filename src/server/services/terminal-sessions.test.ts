import { describe, it, expect, beforeEach, mock } from 'bun:test'

// Mock bun-pty before importing the service: no real shell is spawned, and the
// fake PTY lets tests drive onData/onExit deterministically. (mock.module is
// global for the whole `bun test` process — harmless here, the fake honours
// the same IPty surface the real module exposes.)
interface FakePty {
  pid: number
  cols: number
  rows: number
  written: string[]
  killed: boolean
  emitData: (data: string) => void
  emitExit: (exitCode: number) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  onData: (cb: (data: string) => void) => { dispose: () => void }
  onExit: (cb: (e: { exitCode: number }) => void) => { dispose: () => void }
}

const spawned: FakePty[] = []

function makeFakePty(cols: number, rows: number): FakePty {
  let dataCb: ((data: string) => void) | null = null
  let exitCb: ((e: { exitCode: number }) => void) | null = null
  const pty: FakePty = {
    pid: 1000 + spawned.length,
    cols,
    rows,
    written: [],
    killed: false,
    emitData: (data) => dataCb?.(data),
    emitExit: (exitCode) => exitCb?.({ exitCode }),
    write: (data) => pty.written.push(data),
    resize: (c, r) => {
      pty.cols = c
      pty.rows = r
    },
    kill: () => {
      pty.killed = true
    },
    onData: (cb) => {
      dataCb = cb
      return { dispose: () => {} }
    },
    onExit: (cb) => {
      exitCb = cb
      return { dispose: () => {} }
    },
  }
  return pty
}

mock.module('bun-pty', () => ({
  spawn: (_file: string, _args: string[], opts: { cols: number; rows: number }) => {
    const pty = makeFakePty(opts.cols, opts.rows)
    spawned.push(pty)
    return pty
  },
}))

const { config } = await import('@/server/config')
// The config object is typed readonly; tests shrink the caps to keep fixtures small.
const terminalConfig = config.terminal as { scrollbackKb: number; maxSessions: number }
const {
  createSession,
  attach,
  detach,
  write,
  resize,
  destroySession,
  getSession,
} = await import('@/server/services/terminal-sessions')

describe('terminal-sessions', () => {
  beforeEach(() => {
    // Drain any sessions left by a previous test, then reset the spawn log.
    for (const pty of spawned) pty.emitExit(0)
    spawned.length = 0
  })

  it('creates a session and routes input/output through the PTY', () => {
    const session = createSession('user-1', 100, 40)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.cols).toBe(100)
    expect(spawned[0]!.rows).toBe(40)

    const received: string[] = []
    const scrollback = attach(session.id, 'user-1', (d) => received.push(d), () => {})
    expect(scrollback).toBe('')

    write(session.id, 'user-1', 'ls\r')
    expect(spawned[0]!.written).toEqual(['ls\r'])

    spawned[0]!.emitData('file-a  file-b\r\n')
    expect(received).toEqual(['file-a  file-b\r\n'])

    resize(session.id, 'user-1', 120, 30)
    expect(spawned[0]!.cols).toBe(120)
    expect(spawned[0]!.rows).toBe(30)
  })

  it('replays buffered scrollback on reattach and trims it to the cap', () => {
    const prevKb = terminalConfig.scrollbackKb
    terminalConfig.scrollbackKb = 1 // 1 KB cap for the test
    try {
      const session = createSession('user-1', 80, 24)
      spawned[0]!.emitData('x'.repeat(600))
      spawned[0]!.emitData('y'.repeat(600))

      const scrollback = attach(session.id, 'user-1', () => {}, () => {})
      expect(scrollback).not.toBeNull()
      expect(scrollback!.length).toBe(1024)
      expect(scrollback!.endsWith('y'.repeat(600))).toBe(true)
    } finally {
      terminalConfig.scrollbackKb = prevKb
    }
  })

  it('enforces session ownership', () => {
    const session = createSession('user-1', 80, 24)
    expect(attach(session.id, 'intruder', () => {}, () => {})).toBeNull()
    expect(getSession(session.id, 'intruder')).toBeNull()

    write(session.id, 'intruder', 'rm -rf /\r')
    expect(spawned[0]!.written).toEqual([])
  })

  it('destroys the session and notifies the attached client when the shell exits', () => {
    const session = createSession('user-1', 80, 24)
    let closed = false
    attach(session.id, 'user-1', () => {}, () => {
      closed = true
    })

    spawned[0]!.emitExit(0)
    expect(closed).toBe(true)
    expect(getSession(session.id, 'user-1')).toBeNull()
    expect(attach(session.id, 'user-1', () => {}, () => {})).toBeNull()
  })

  it('kills the PTY on explicit destroy', () => {
    const session = createSession('user-1', 80, 24)
    destroySession(session.id)
    expect(spawned[0]!.killed).toBe(true)
    expect(getSession(session.id, 'user-1')).toBeNull()
  })

  it('a stale sink cannot steal the session from the client that replaced it', () => {
    const session = createSession('user-1', 80, 24)
    const sinkA = () => {}
    const received: string[] = []
    attach(session.id, 'user-1', sinkA, () => {})
    attach(session.id, 'user-1', (d) => received.push(d), () => {})

    // The old socket closing must not detach the new client.
    detach(session.id, sinkA)
    spawned[0]!.emitData('still-here')
    expect(received).toEqual(['still-here'])
  })

  it('caps the number of concurrent sessions', () => {
    const prevMax = terminalConfig.maxSessions
    terminalConfig.maxSessions = 2
    try {
      createSession('user-1', 80, 24)
      createSession('user-1', 80, 24)
      expect(() => createSession('user-1', 80, 24)).toThrow('TERMINAL_MAX_SESSIONS')
    } finally {
      terminalConfig.maxSessions = prevMax
    }
  })
})
