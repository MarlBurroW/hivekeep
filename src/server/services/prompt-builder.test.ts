import { describe, it, expect } from 'bun:test'
import {
  buildSystemPrompt as buildSystemPromptSegmented,
  joinSystemPrompt,
} from '@/server/services/prompt-builder'

// Legacy single-string wrapper so existing assertions keep working.
// New segmentation-aware tests live at the bottom of the file and call
// `buildSystemPromptSegmented` directly.
function buildSystemPrompt(params: Parameters<typeof buildSystemPromptSegmented>[0]): string {
  return joinSystemPrompt(buildSystemPromptSegmented(params))
}

// Minimal valid params factory
function makeParams(overrides: Record<string, unknown> = {}) {
  return {
    agent: {
      name: 'TestBot',
      slug: 'test-bot',
      role: 'a helpful assistant',
      character: 'Friendly and concise.',
      expertise: 'General knowledge.',
    },
    contacts: [],
    agentDirectory: [],
    isSubAgent: false,
    userLanguage: 'en' as const,
    ...overrides,
  }
}

describe('buildSystemPrompt', () => {
  // --- Platform context ---

  it('includes platform context block for main agent', () => {
    const result = buildSystemPrompt(makeParams())
    expect(result).toContain('## Platform context')
    expect(result).toContain('specialized AI agent (Agent) on Hivekeep')
    expect(result).toContain('session is continuous and permanent')
    expect(result).toContain('Multiple users may talk to you')
  })

  it('omits platform context block for sub-agents', () => {
    const result = buildSystemPrompt(makeParams({
      isSubAgent: true,
      taskDescription: 'Do something',
    }))
    expect(result).not.toContain('## Platform context')
  })

  it('includes agent identity with slug', () => {
    const result = buildSystemPrompt(makeParams())
    expect(result).toContain('You are TestBot (slug: test-bot)')
    expect(result).toContain('a helpful assistant')
  })

  it('includes personality and expertise blocks', () => {
    const result = buildSystemPrompt(makeParams())
    expect(result).toContain('## Personality')
    expect(result).toContain('Friendly and concise.')
    expect(result).toContain('## Expertise')
    expect(result).toContain('General knowledge.')
  })

  it('omits personality block when empty', () => {
    const result = buildSystemPrompt(makeParams({
      agent: { name: 'Bot', slug: 'bot', role: 'assistant', character: '', expertise: '' },
    }))
    expect(result).not.toContain('## Personality')
    expect(result).not.toContain('## Expertise')
  })

  it('omits slug suffix when slug is null', () => {
    const result = buildSystemPrompt(makeParams({
      agent: { name: 'Bot', slug: null, role: 'assistant', character: '', expertise: '' },
    }))
    expect(result).toContain('You are Bot,')
    expect(result).not.toContain('slug:')
  })

  it('includes contacts when provided', () => {
    const result = buildSystemPrompt(makeParams({
      contacts: [
        { id: 'c1', displayName: 'Alice', firstName: 'Alice', lastName: null, nicknames: [], identifierSummary: 'email: alice@test.com' },
      ],
    }))
    expect(result).toContain('## Known contacts')
    expect(result).toContain('Alice')
    expect(result).toContain('email: alice@test.com')
    expect(result).toContain('[id: c1]')
  })

  it('omits contacts section when empty', () => {
    const result = buildSystemPrompt(makeParams({ contacts: [] }))
    expect(result).not.toContain('## Known contacts')
  })

  it('injects the memory profile verbatim', () => {
    const result = buildSystemPrompt(makeParams({
      profile: '## Active projects\n\n- Ship memory v2.\n\n## Pinned\n\n- Never use em-dashes.',
    }))
    expect(result).toContain('## Your memory')
    expect(result).toContain('- Ship memory v2.')
    expect(result).toContain('- Never use em-dashes.')
    expect(result).toContain('It is always current; trust it.')
  })

  it('states the profile is empty rather than omitting the block', () => {
    const result = buildSystemPrompt(makeParams({ profile: '' }))
    expect(result).toContain('## Your memory')
    expect(result).toContain('Your profile is still empty')
    expect(result).not.toContain('It is always current; trust it.')
  })

  it('points at recall for anything episodic', () => {
    const result = buildSystemPrompt(makeParams({ profile: '## Pinned\n\n- Keep me.' }))
    expect(result).toContain('searchable with recall(query)')
    expect(result).toContain("BEFORE saying you don't remember")
  })

  it('offers edit_profile in a normal session but not in a quick session', () => {
    const normal = buildSystemPrompt(makeParams({ profile: '## Pinned\n\n- Keep me.' }))
    expect(normal).toContain('use edit_profile')

    const quick = buildSystemPrompt(makeParams({ isQuickSession: true, profile: '## Pinned\n\n- Keep me.' }))
    expect(quick).toContain('## Your memory')
    expect(quick).toContain('- Keep me.')
    // Quick sessions are told not to offer saving memories, so the block there
    // stays read-only.
    expect(quick).not.toContain('use edit_profile')
  })

  it('drops the memory block entirely when the model cannot call tools and has no profile', () => {
    const result = buildSystemPrompt(makeParams({ profile: '', toolsEnabled: false }))
    expect(result).not.toContain('## Your memory')
  })

  it('includes agent directory with collaboration instructions for main agent', () => {
    const result = buildSystemPrompt(makeParams({
      agentDirectory: [
        { slug: 'helper', name: 'Helper', role: 'research assistant' },
      ],
    }))
    expect(result).toContain('## Agent directory')
    expect(result).toContain('Helper (slug: helper)')
    expect(result).toContain('### Collaboration and delegation')
    expect(result).toContain('delegate to the most appropriate Agent')
    expect(result).toContain('spawn sub-tasks')
  })

  it('includes compact agent directory for sub-agents with inter-agent instructions', () => {
    const result = buildSystemPrompt(makeParams({
      isSubAgent: true,
      taskDescription: 'Do something',
      agentDirectory: [
        { slug: 'helper', name: 'Helper', role: 'research assistant' },
      ],
    }))
    expect(result).toContain('## Agent directory')
    expect(result).toContain('Inter-Agent communication')
    expect(result).toContain('Helper (slug: helper)')
  })

  it('sets language to French when userLanguage is fr', () => {
    const result = buildSystemPrompt(makeParams({ userLanguage: 'fr' }))
    expect(result).toContain('You MUST respond in French (fr)')
  })

  it('sets language to English when userLanguage is en', () => {
    const result = buildSystemPrompt(makeParams({ userLanguage: 'en' }))
    expect(result).toContain('You MUST respond in English (en)')
  })

  it('includes date context', () => {
    const result = buildSystemPrompt(makeParams())
    expect(result).toContain('Current date:')
    expect(result).toContain('Platform: Hivekeep')
  })

  // --- Initiative ---

  it('includes initiative and proactivity instructions for main agent', () => {
    const result = buildSystemPrompt(makeParams())
    expect(result).toContain('### Initiative and proactivity')
    expect(result).toContain('not a passive Q&A bot')
    expect(result).toContain('suggest creating a cron job')
    expect(result).toContain('spawn_self/spawn_agent')
  })

  // --- Sub-Agent prompts ---

  it('builds sub-agent prompt with task description and platform awareness', () => {
    const result = buildSystemPrompt(makeParams({
      isSubAgent: true,
      taskDescription: 'Analyze the data and report findings.',
    }))
    expect(result).toContain('specialized AI agent on Hivekeep')
    expect(result).toContain('executing a delegated task')
    expect(result).toContain('## Your mission')
    expect(result).toContain('Analyze the data and report findings.')
    expect(result).toContain('## Constraints')
    expect(result).toContain('update_task_status()')
  })

  it('sub-agent prompt does not include internal instructions', () => {
    const result = buildSystemPrompt(makeParams({
      isSubAgent: true,
      taskDescription: 'Do stuff',
    }))
    expect(result).not.toContain('## Internal instructions')
  })

  it('includes previous cron runs for recurring tasks', () => {
    const result = buildSystemPrompt(makeParams({
      isSubAgent: true,
      taskDescription: 'Check metrics',
      previousCronRuns: [
        {
          status: 'completed',
          result: 'All metrics normal',
          createdAt: new Date('2025-01-01T00:00:00Z'),
          updatedAt: new Date('2025-01-01T00:00:30Z'),
        },
        {
          status: 'failed',
          result: null,
          createdAt: new Date('2024-12-31T00:00:00Z'),
          updatedAt: new Date('2024-12-31T00:01:00Z'),
        },
      ],
    }))
    expect(result).toContain('## Previous runs')
    expect(result).toContain('All metrics normal')
    expect(result).toContain('(failed)')
    // Cron journal instruction
    expect(result).toContain('recurring scheduled task')
  })

  it('includes MCP tools block when provided', () => {
    const result = buildSystemPrompt(makeParams({
      mcpTools: [
        {
          serverName: 'weather-server',
          tools: [
            { name: 'get_weather', description: 'Get current weather for a city' },
          ],
        },
      ],
    }))
    expect(result).toContain('## MCP Tools (external servers)')
    expect(result).toContain('**weather-server** (1 tools)')
  })

  it('includes active channels block', () => {
    const result = buildSystemPrompt(makeParams({
      activeChannels: [
        { platform: 'telegram', name: 'Main Chat' },
        { platform: 'discord', name: 'Dev Server' },
      ],
    }))
    expect(result).toContain('## External channels')
    expect(result).toContain('telegram: "Main Chat"')
    expect(result).toContain('discord: "Dev Server"')
  })

  it('includes global prompt (platform directives)', () => {
    const result = buildSystemPrompt(makeParams({
      globalPrompt: 'Always be polite. Never use profanity.',
    }))
    expect(result).toContain('## Platform directives')
    expect(result).toContain('Always be polite. Never use profanity.')
  })

  it('includes global prompt for sub-agents too', () => {
    const result = buildSystemPrompt(makeParams({
      isSubAgent: true,
      taskDescription: 'Do task',
      globalPrompt: 'Be concise.',
    }))
    expect(result).toContain('## Platform directives')
    expect(result).toContain('Be concise.')
  })

  // --- Quick session ---

  it('quick session skips contacts, agent directory, and internal instructions', () => {
    const result = buildSystemPrompt(makeParams({
      isQuickSession: true,
      contacts: [{ id: 'c1', displayName: 'Alice', firstName: 'Alice', lastName: null, nicknames: [] }],
      agentDirectory: [{ slug: 'helper', name: 'Helper', role: 'assistant' }],
    }))
    expect(result).toContain('## Quick session')
    expect(result).not.toContain('## Known contacts')
    expect(result).not.toContain('## Agent directory')
    expect(result).not.toContain('## Internal instructions')
  })

  // --- Contact formatting ---

  it('formats contacts with nicknames as aka list', () => {
    const result = buildSystemPrompt(makeParams({
      contacts: [
        { id: 'c1', displayName: 'Alice Dupont', firstName: 'Alice', lastName: 'Dupont', nicknames: ['ali', 'lily'] },
      ],
    }))
    expect(result).toContain('Alice Dupont')
    expect(result).toContain('aka "ali", "lily"')
  })

  it('formats contacts with linked user name', () => {
    const result = buildSystemPrompt(makeParams({
      contacts: [
        { id: 'c1', displayName: 'Admin', firstName: 'Admin', lastName: null, nicknames: [], linkedUserName: 'admin_user' },
      ],
    }))
    expect(result).toContain('system user "admin_user"')
  })

  // --- Current message source ---

  it('includes current message source hint for channel messages', () => {
    const result = buildSystemPrompt(makeParams({
      currentMessageSource: { platform: 'telegram', senderName: 'Nicolas' },
    }))
    expect(result).toContain('Current message from: **telegram**')
    expect(result).toContain('sender: Nicolas')
    expect(result).toContain('Keep moderate length')
  })

  it('includes current message source hint for web UI', () => {
    const result = buildSystemPrompt(makeParams({
      currentMessageSource: { platform: 'web' },
    }))
    expect(result).toContain('Current message from: **web**')
    expect(result).toContain('Full Markdown support')
  })

  it('omits current message source hint when not provided', () => {
    const result = buildSystemPrompt(makeParams())
    expect(result).not.toContain('Current message from')
  })

  it('includes discord formatting hints', () => {
    const result = buildSystemPrompt(makeParams({
      currentMessageSource: { platform: 'discord' },
    }))
    expect(result).toContain('No tables')
  })

  // --- Participants ---

  it('includes participants block for group conversation', () => {
    const now = new Date()
    const result = buildSystemPrompt(makeParams({
      participants: [
        { name: 'Alice', platform: 'telegram', messageCount: 5, lastSeenAt: now },
        { name: 'Bob', platform: 'discord', messageCount: 3, lastSeenAt: now },
      ],
    }))
    expect(result).toContain('## Active participants')
    expect(result).toContain('**group conversation**')
    expect(result).toContain('2 participants')
    expect(result).toContain('Alice via telegram')
    expect(result).toContain('Bob via discord')
  })

  it('detects one-on-one conversation with single participant', () => {
    const now = new Date()
    const result = buildSystemPrompt(makeParams({
      participants: [
        { name: 'Alice', platform: 'web', messageCount: 10, lastSeenAt: now },
      ],
    }))
    expect(result).toContain('**one-on-one conversation** with Alice')
    expect(result).not.toContain('group conversation')
  })

  it('treats same person from multiple platforms as one-on-one', () => {
    const now = new Date()
    const result = buildSystemPrompt(makeParams({
      participants: [
        { name: 'Alice', platform: 'telegram', messageCount: 3, lastSeenAt: now },
        { name: 'Alice', platform: 'discord', messageCount: 2, lastSeenAt: now },
      ],
    }))
    // Same name = 1 unique participant → one-on-one
    expect(result).toContain('**one-on-one conversation**')
  })

  it('omits participants section when empty', () => {
    const result = buildSystemPrompt(makeParams({ participants: [] }))
    expect(result).not.toContain('## Active participants')
  })

  // --- Conversation state ---

  it('includes conversation state for full history', () => {
    const result = buildSystemPrompt(makeParams({
      conversationState: {
        visibleMessageCount: 42,
        totalMessageCount: 42,
        hasCompactedHistory: false,
      },
    }))
    expect(result).toContain('## Conversation state')
    expect(result).toContain('full conversation history: 42 messages')
    // Conversation state block should NOT suggest search_history for non-compacted
    expect(result).toContain('## Conversation state')
    expect(result).not.toContain('If you need details from before your visible history')
  })

  it('includes conversation state for compacted history', () => {
    const result = buildSystemPrompt(makeParams({
      conversationState: {
        visibleMessageCount: 20,
        totalMessageCount: 150,
        hasCompactedHistory: true,
      },
    }))
    expect(result).toContain('130 older messages have been summarized')
    expect(result).toContain('20 most recent messages')
    expect(result).toContain('search_history()')
  })

  it('uses singular for 1 compacted message', () => {
    const result = buildSystemPrompt(makeParams({
      conversationState: {
        visibleMessageCount: 10,
        totalMessageCount: 11,
        hasCompactedHistory: true,
      },
    }))
    expect(result).toContain('1 older message has been summarized')
  })

  it('omits conversation state when not provided', () => {
    const result = buildSystemPrompt(makeParams())
    expect(result).not.toContain('## Conversation state')
  })

  // --- Compacting summary ---

  it('includes compacting summaries when provided', () => {
    const result = buildSystemPrompt(makeParams({
      compactingSummaries: [{
        summary: 'User discussed project setup and database migration.',
        firstMessageAt: new Date('2025-06-10T10:00:00Z'),
        lastMessageAt: new Date('2025-06-15T14:00:00Z'),
        depth: 0,
      }],
    }))
    expect(result).toContain('## Conversation history summaries')
    expect(result).toContain('User discussed project setup and database migration.')
    expect(result).toContain('faithful summaries')
  })

  it('includes date range in compacting summary', () => {
    const result = buildSystemPrompt(makeParams({
      compactingSummaries: [{
        summary: 'Earlier discussion.',
        firstMessageAt: new Date('2025-06-10T10:00:00Z'),
        lastMessageAt: new Date('2025-06-15T10:00:00Z'),
        depth: 0,
      }],
    }))
    expect(result).toContain('## Conversation history summaries')
    expect(result).toContain('Jun 15, 2025')
  })

  it('marks compressed summaries with depth > 0', () => {
    const result = buildSystemPrompt(makeParams({
      compactingSummaries: [{
        summary: 'Merged summary.',
        firstMessageAt: new Date('2025-06-01T10:00:00Z'),
        lastMessageAt: new Date('2025-06-10T10:00:00Z'),
        depth: 2,
      }],
    }))
    expect(result).toContain('[compressed]')
  })

  it('omits compacting summaries when not provided', () => {
    const result = buildSystemPrompt(makeParams())
    expect(result).not.toContain('## Conversation history summaries')
  })

  // --- Cron run results are included in full ---

  it('includes full cron run results without truncation', () => {
    const longResult = 'x'.repeat(600)
    const result = buildSystemPrompt(makeParams({
      isSubAgent: true,
      taskDescription: 'Recurring task',
      previousCronRuns: [
        {
          status: 'completed',
          result: longResult,
          createdAt: new Date('2025-01-01T00:00:00Z'),
          updatedAt: new Date('2025-01-01T00:01:00Z'),
        },
      ],
    }))
    expect(result).toContain('## Previous runs')
    // Full result should be present, not truncated
    expect(result).toContain('x'.repeat(600))
  })

  it('includes short cron run results', () => {
    const shortResult = 'All good'
    const result = buildSystemPrompt(makeParams({
      isSubAgent: true,
      taskDescription: 'Check stuff',
      previousCronRuns: [
        {
          status: 'completed',
          result: shortResult,
          createdAt: new Date('2025-01-01T00:00:00Z'),
          updatedAt: new Date('2025-01-01T00:00:30Z'),
        },
      ],
    }))
    expect(result).toContain('All good')
  })

  it('shows execution time in seconds for cron runs', () => {
    const result = buildSystemPrompt(makeParams({
      isSubAgent: true,
      taskDescription: 'Task',
      previousCronRuns: [
        {
          status: 'completed',
          result: 'Done',
          createdAt: new Date('2025-01-01T00:00:00Z'),
          updatedAt: new Date('2025-01-01T00:00:45Z'),
        },
      ],
    }))
    expect(result).toContain('(45s)')
  })

  // --- WhatsApp formatting hint ---

  it('includes whatsapp formatting hints', () => {
    const result = buildSystemPrompt(makeParams({
      currentMessageSource: { platform: 'whatsapp' },
    }))
    expect(result).toContain('Very limited formatting')
  })

  // --- Quick session with global prompt ---

  it('quick session includes global prompt', () => {
    const result = buildSystemPrompt(makeParams({
      isQuickSession: true,
      globalPrompt: 'Always sign off with a smiley.',
    }))
    expect(result).toContain('## Platform directives')
    expect(result).toContain('Always sign off with a smiley.')
    expect(result).toContain('## Quick session')
  })

  // --- Stable / volatile segmentation (Anthropic prompt caching) ---

  describe('segmentation', () => {
    it('places identity, character, expertise and hidden instructions in the stable segment', () => {
      const { stable, volatile } = buildSystemPromptSegmented(makeParams())
      // Identity / character / expertise / hidden instructions live in `stable`
      // because they only change when the Agent is edited.
      expect(stable).toContain('You are TestBot')
      expect(stable).toContain('## Personality')
      expect(stable).toContain('Friendly and concise.')
      expect(stable).toContain('## Expertise')
      expect(stable).toContain('## Internal instructions')
      expect(stable).toContain('## Platform context')
      expect(stable).toContain('## Core principles')
      // None of those should leak into the volatile segment
      expect(volatile).not.toContain('## Personality')
      expect(volatile).not.toContain('## Internal instructions')
      expect(volatile).not.toContain('## Platform context')
    })

    it('places date, language, contacts and current speaker in the volatile segment', () => {
      const { stable, volatile } = buildSystemPromptSegmented(makeParams({
        contacts: [{ id: 'c1', displayName: 'Alice', firstName: 'Alice', lastName: null, nicknames: [] }],
        currentSpeaker: { firstName: 'Alice', lastName: null, pseudonym: 'alice', role: 'user' },
      }))
      expect(volatile).toContain('## Known contacts')
      expect(volatile).toContain('## Current speaker')
      expect(volatile).toContain('## Language')
      expect(volatile).toContain('## Context')
      expect(volatile).toContain('Current date:')
      // None of those should pollute the stable segment
      expect(stable).not.toContain('## Known contacts')
      expect(stable).not.toContain('## Current speaker')
      expect(stable).not.toContain('## Language')
      expect(stable).not.toContain('Current date:')
    })

    it('places the memory profile in the stable segment, so it stays cacheable', () => {
      const { stable, volatile } = buildSystemPromptSegmented(makeParams({
        profile: '## Active projects\n\n- Memory v2 redesign.',
      }))
      expect(stable).toContain('## Your memory')
      expect(stable).toContain('- Memory v2 redesign.')
      expect(volatile).not.toContain('## Your memory')
    })

    it('places agent directory in the stable segment', () => {
      const { stable, volatile } = buildSystemPromptSegmented(makeParams({
        agentDirectory: [{ slug: 'helper', name: 'Helper', role: 'assistant' }],
      }))
      expect(stable).toContain('## Agent directory')
      expect(volatile).not.toContain('## Agent directory')
    })

    it('places workspace tree in the volatile segment', () => {
      const { stable, volatile } = buildSystemPromptSegmented(makeParams({
        workspacePath: '/tmp/test-workspace-segmentation',
      }))
      expect(volatile).toContain('## Workspace')
      expect(stable).not.toContain('## Workspace')
    })

    it('joinSystemPrompt(buildSystemPrompt(...)) produces the legacy single-string output', () => {
      const segmented = buildSystemPromptSegmented(makeParams())
      const joined = joinSystemPrompt(segmented)
      // Equivalent to a manual concat
      expect(joined).toBe(`${segmented.stable}\n\n${segmented.volatile}`)
    })

    it('sub-Agent task: mission and constraints are stable, date is volatile', () => {
      const { stable, volatile } = buildSystemPromptSegmented(makeParams({
        isSubAgent: true,
        taskDescription: 'Compute the answer.',
      }))
      expect(stable).toContain('## Your mission')
      expect(stable).toContain('Compute the answer.')
      expect(stable).toContain('## Constraints')
      expect(volatile).toContain('Current date:')
    })

    it('renders task_todos in the volatile segment when present', () => {
      const { stable, volatile } = buildSystemPromptSegmented(makeParams({
        isSubAgent: true,
        taskDescription: 'Ship the feature.',
        taskTodos: [
          { id: 'a', subject: 'Read the spec', status: 'completed' },
          { id: 'b', subject: 'Implement the change', status: 'in_progress' },
          { id: 'c', subject: 'Write the test', status: 'pending' },
        ],
      }))
      expect(volatile).toContain('## Current plan')
      expect(volatile).toContain('1/3 done')
      expect(volatile).toContain('in progress: "Implement the change"')
      expect(volatile).toContain('[x] Read the spec')
      expect(volatile).toContain('[.] Implement the change')
      expect(volatile).toContain('[ ] Write the test')
      expect(stable).not.toContain('## Current plan')
    })

    it('omits the task_todos block when the list is empty', () => {
      const { volatile } = buildSystemPromptSegmented(makeParams({
        isSubAgent: true,
        taskDescription: 'Anything.',
        taskTodos: [],
      }))
      expect(volatile).not.toContain('## Current plan')
    })

    it('quick session: identity is stable, language and date are volatile', () => {
      const { stable, volatile } = buildSystemPromptSegmented(makeParams({
        isQuickSession: true,
      }))
      expect(stable).toContain('You are TestBot')
      expect(stable).toContain('## Quick session')
      expect(volatile).toContain('## Language')
      expect(volatile).toContain('Current date:')
    })
  })
})
