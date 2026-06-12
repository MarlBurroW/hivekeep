// English dictionary: the source of truth for the site's copy. Every other
// locale file is typed against this shape (see src/i18n/index.ts).
//
// Conventions:
//  - Strings may carry inline <b>/<strong>/<a>/<code> HTML; they are rendered
//    with set:html (Astro) or dangerouslySetInnerHTML (React) where needed.
//  - {count}, {port}, {url}, {host} are placeholders substituted at render time.
//  - No em-dashes anywhere in this file. Use ":", ",", ".", parentheses,
//    or " - " instead, in every language.
export default {
  meta: {
    plugins: {
      title: 'Plugins',
      description:
        'Browse every Hivekeep plugin published on npm: providers, channels, tools and hooks, installed in one click from the in-app marketplace.',
    },
    home: {
      title: 'Hivekeep · Your AI team. At home.',
      description:
        'A self-hosted team of AI agents that remember, collaborate, and build their own tools. One container, zero external infra. Your AI team, at home.',
    },
    install: {
      title: 'Install Hivekeep',
      description:
        'Install Hivekeep your way: Docker to try it, or a native install to give your agents a real home. Generate the exact command for your setup.',
    },
  },

  nav: {
    features: 'Features',
    plugins: 'Plugins',
    household: 'The household',
    why: 'Why Hivekeep',
    docs: 'Docs',
    github: 'GitHub ↗',
    getStarted: 'Get started',
    configure: 'Configure',
  },

  footer: {
    line: 'Open-source · MIT · Built with Bun · © 2026',
  },

  // Homepage band between sections 05 and 06: the UI ships in 10 languages,
  // the agents speak many more. Chips are rendered from LOCALE_LABELS.
  languages: {
    kicker: 'Multilingual',
    heading: 'Speaks your language.',
    p: 'The interface ships in 10 languages, and your agents are not limited by that: they answer in whatever language you speak (40+), independent of the UI language.',
  },

  home: {
    hero: {
      meta: 'self-hosted · MIT',
      kicker: 'A hive of autonomous agents',
      h1a: 'Your AI team.',
      h1b: 'At home.',
      sub: 'A team of agents that <b>remember</b>, <b>collaborate</b>, and <b>build their own tools</b>, running entirely on your server. Not a chatbot. A household of specialists that works like a hive.',
      colophon: {
        runsOnK: 'Runs on',
        runsOnV: 'one container',
        infraK: 'External infra',
        infraV: 'none',
        setupK: 'Set up by',
        setupV: 'a conversation',
        channelsK: 'Channels',
        channelsV: '6 built-in',
      },
      ctaStart: 'Start in 2 minutes',
      ctaDemo: 'Watch the demo',
      everywhere: 'everywhere:',
      webPwa: 'Web · PWA',
    },

    health: {
      kicker: 'live from GitHub',
      latestRelease: 'latest release',
      ciPrefix: 'CI',
      ciPassing: 'passing',
      ciFailing: 'failing',
      mainBranch: 'main branch',
      stars: 'stars',
      openIssue: 'open issue',
      openIssues: 'open issues',
      lastCommit: 'last commit',
      contributor: 'contributor',
      contributors: 'contributors',
    },

    video: {
      kicker: 'See it in action',
      heading: 'From zero to your own team in one command.',
      sub: 'One container. Then Queenie takes over: providers, avatars, a whole team, and your agents start building for you.',
    },

    s1memory: {
      stage: 'Persistent',
      heading: 'They never forget you.',
      p1: 'No "new conversation". One continuous session, and a hybrid memory that builds context over months. Nothing is deleted: old turns are summarized, never thrown away.',
      p2: 'An Agent hands work to another, or spawns a swarm of sub-agents to move faster. The colony shares one history and one address book.',
      tagSession: 'continuous session',
      tagHandoff: 'inter-agent handoff',
      figCap: 'Fig. 1 · recall("grocery budget")',
      figTag: 'memory',
      card1: {
        cat: 'decision',
        topic: 'budget',
        text: 'Monthly grocery budget set to $600, with a goal to cut unnecessary spending.',
      },
      card2: {
        cat: 'preference',
        topic: 'shopping',
        text: 'Prefers buying store-brand staples and batch-cooking on weekends.',
      },
    },

    s2sovereign: {
      stage: 'Sovereign',
      heading: 'One container. Nothing leaves your server.',
      p1: 'No Postgres, Redis, Mongo, or message broker. Bun and SQLite in a single binary. Your data, your keys, your machine.',
      p2: 'Secrets live in an encrypted vault. Agents reference a vault key to reach a service; they <b>never read the value</b>, so it <b>never reaches the LLM</b>.',
      termComment: '# then open your browser. Queenie does the rest.',
      specs: {
        footprintK: 'Footprint',
        footprintV: '1 process · 1 SQLite file',
        infraK: 'External infra',
        infraV: 'none',
        secretsK: 'Secrets',
        secretsV: 'AES-256-GCM vault, by reference only',
        dataK: 'Data & keys',
        dataV: 'yours, on your hardware',
      },
    },

    s3extensible: {
      stage: 'Self-improving',
      heading: 'Your agents extend the platform themselves.',
      shotAlt: 'Weather tool rendered as a themed card in the conversation',
      p1: 'Agents write tools in the language they want, with their own dependencies, plus a renderer that shows the result as a <b>themed card, not raw JSON</b>. They build full mini-apps (dashboards, control panels) right inside Hivekeep, and can ship NPM plugins.',
      p2: 'Scope each Agent with <b>toolboxes</b> so a focused agent only sees the tools it needs, which keeps it sharp and lets lighter models do the job.',
      tagCustomTools: 'custom tools',
      tagMiniApps: 'mini-apps',
      tagNpm: 'NPM plugins',
      tagMcp: 'MCP',
      tagToolboxes: 'toolboxes',
    },

    s4channels: {
      stage: 'Everywhere',
      heading: 'One inbox for your whole team.',
      p1: 'Talk to every Agent from the messaging apps you already use. Out of their lane? The Agent on the line <b>passes your request to the right specialist</b> and relays the answer, or, if you ask for them, <b>hands the channel over</b> in real time. No commands, no switching apps.',
      shotAlt: 'A smart-home request sent to the wrong agent, forwarded to the responsible specialist who turns off the lights',
    },

    s5pocket: {
      stage: 'Mobile',
      heading: 'The whole hive, in your pocket.',
      p1: 'Hivekeep is a real app on your phone: install it <b>straight from the browser</b> (no app store, no account with anyone, nothing extra to deploy). Full-screen, an icon on your home screen, <b>unread badges</b> that actually work.',
      p2: "And it's the <b>same live session</b> as your desktop: an answer that lands at your desk is already on your phone. Reply by <b>voice</b>, send photos, approve an agent's plan from the couch.",
      tagPwa: 'installable PWA',
      tagDesktopMobile: 'desktop + mobile',
      tagBadges: 'unread badges',
      tagVoice: 'voice in & out',
      phone: {
        aria: 'Hivekeep running as an installed app on a phone',
        online: 'online',
        userBubble: 'Heading home, make it cozy 🛋️',
        tool1Name: 'Set heating',
        tool1Detail: ' · living room → 21.5°',
        tool2Name: 'Scene',
        tool2Detail: ' · Evening',
        agentBubble: "Heater's on, lights set to <strong>Evening</strong>. Traffic says 18 min. Want the oven preheated too?",
        inputPlaceholder: 'Message Nest…',
      },
      chipInstallB: 'Install from the browser',
      chipInstallI: 'no app store needed',
      chipBadgesB: 'Unread badges',
      chipBadgesI: 'on your home screen',
      chipSyncB: 'Synced with desktop',
      chipSyncI: 'one live session',
    },

    s6transparency: {
      stage: 'Transparent',
      heading: 'No black box. No cost surprises.',
      p1: 'See exactly what goes to the model: the system prompt broken down block by block, token cost <b>per Agent and per model</b>, and the prompt-cache read / write / fresh split with its hit rate. Hivekeep is unusually honest about what it sends and what it spends, across any provider.',
      tagCost: 'per-Agent token cost',
      tagPreview: 'context preview',
      figCap: 'Fig. 4 · context viewer',
      figTag: 'tokens',
      barTools: 'Tools',
      barMemory: 'Memory',
      barIdentity: 'Identity',
      barChannels: 'Channels',
      cacheTitle: 'prompt cache · warm · 4:12 left',
      cacheHit: '72% hit',
      legendRead: 'read 9.1k',
      legendWrite: 'write 1.2k',
      legendFresh: 'fresh 2.4k',
    },

    s7setup: {
      stage: 'Setup',
      heading: 'Setup is a conversation, not a YAML file.',
      p1: 'Queenie, your setup agent, connects your providers, secures your secrets, and creates your first Agents by chatting with you. It stays around for good, ready to add an Agent or wire up a new provider any time.',
      tagSecure: 'secure input → vault',
      tagGenerates: 'generates Agents for you',
    },

    s8household: {
      stage: 'Examples',
      heading: 'Build a household for your life.',
      p1: 'Hivekeep ships with one Agent: <b>Queenie</b>, your setup guide. You create the rest, or just ask Queenie to build them for you. Each one gets its own name, domain, memory, tools, and a generated avatar.',
      p2: "Avatars come in Hivekeep's <b>default art style</b>, so a fresh hive already looks like a set. Want your own look? Set a <b>custom avatar style</b> once, pixel art, watercolor, your own brand, and every Agent regenerates in it, so your whole team stays on theme.",
      examplesNote: 'A few examples of what people build →',
      builtIn: 'built-in',
      eg: 'e.g.',
    },

    morefx: {
      kicker: 'Under the hood',
      heading: 'And {count} more features.',
      sub: 'Everything below ships in the box: no add-ons, no paid tiers.',
      categories: [
        {
          label: 'Agents & collaboration',
          icon: 'users',
          cards: [
            {
              title: 'Agents talk to agents',
              blurb: 'Your specialists message each other with <b>request/reply</b> patterns: ask one agent, watch it consult another on its own.',
              icon: 'messages-square',
            },
            {
              title: 'Sub-agent delegation',
              blurb: 'Agents spawn ephemeral sub-agents for heavy work (<b>blocking or parallel</b>), with concurrency limits and clean reports back.',
              icon: 'git-branch',
            },
            {
              title: 'Scout mode',
              blurb: 'Delegate read-only research to a <b>cheap, fast model</b> and get a digest back without burning flagship tokens.',
              icon: 'binoculars',
            },
            {
              title: 'Built-in CRM',
              blurb: 'Agents keep an auto-populated contact book with notes and preferences, plus read-only sync from <b>iCloud and CardDAV</b>.',
              icon: 'users',
            },
          ],
        },
        {
          label: 'Automation',
          icon: 'workflow',
          cards: [
            {
              title: 'Crons that learn',
              blurb: 'Scheduled jobs spawn agents on a cron, keep a <b>run journal</b>, and save learnings to improve every future run.',
              icon: 'calendar-clock',
            },
            {
              title: 'Inbound webhooks',
              blurb: 'Any HTTP event can wake an agent, with <b>payload filtering</b> (dot-path or regex), rate limits, and request logs.',
              icon: 'webhook',
            },
            {
              title: 'Email triggers',
              blurb: 'Incoming mail matching your rules automatically wakes the right agent, into its conversation or an <b>isolated task</b>.',
              icon: 'mail-check',
            },
            {
              title: 'Wake-up timers',
              blurb: 'Agents schedule their own future work (<b>“wake me in 2 hours”</b>) so follow-ups and reminders actually happen.',
              icon: 'alarm-clock',
            },
            {
              title: 'Agent-run kanban',
              blurb: 'Organize work into projects and tickets, then <b>assign tickets to agents</b> that execute them and report back as comments.',
              icon: 'kanban',
            },
          ],
        },
        {
          label: 'Memory & context',
          icon: 'brain-circuit',
          cards: [
            {
              title: 'One endless conversation',
              blurb: 'No “new chat” button: old messages compact into <b>dated summaries</b> while the originals stay safe in the database.',
              icon: 'infinity',
            },
            {
              title: 'Self-cleaning memory',
              blurb: 'Memories are consolidated, re-scored by usage, and stale ones pruned, so recall stays <b>sharp, not hoarded</b>.',
              icon: 'brain',
            },
            {
              title: 'Knowledge bases',
              blurb: 'Upload documents once; relevant excerpts are <b>auto-surfaced</b> into context whenever the topic comes up.',
              icon: 'book-open',
            },
            {
              title: 'Project knowledge',
              blurb: 'Each project keeps curated facts, decisions, and gotchas: <b>pinned entries</b> ride along in every agent turn.',
              icon: 'notebook-pen',
            },
            {
              title: 'Searchable past',
              blurb: 'Agents search their entire history with <b>semantic + full-text</b> rank fusion, so nothing said is ever truly lost.',
              icon: 'history',
            },
          ],
        },
        {
          label: 'Connected world',
          icon: 'globe',
          cards: [
            {
              title: 'Email, handled',
              blurb: 'Read, search, and send across <b>Gmail, Outlook, iCloud, and IMAP</b>, with an approval mode on outgoing mail.',
              icon: 'mail',
            },
            {
              title: 'Calendar control',
              blurb: 'Agents create, update, and search events on <b>Google, Outlook, and CalDAV</b> calendars on your behalf.',
              icon: 'calendar-days',
            },
            {
              title: 'Real browser automation',
              blurb: 'Agents drive a <b>stateful browser</b> (log in, fill forms, click, screenshot) and save sessions for next time.',
              icon: 'mouse-pointer-click',
            },
            {
              title: 'Web search & reading',
              blurb: 'Pluggable search backends (<b>Brave, Tavily, SerpAPI, Perplexity</b>) plus page fetching, link extraction, and screenshots.',
              icon: 'globe',
            },
            {
              title: 'Voice in, voice out',
              blurb: 'Speech-to-text and <b>text-to-speech</b> through any configured provider: talk to your agents and hear them answer.',
              icon: 'mic',
            },
          ],
        },
        {
          label: 'Control & trust',
          icon: 'shield',
          cards: [
            {
              title: 'Encrypted vault',
              blurb: 'Secrets stored with <b>AES-256-GCM</b>, never injected into prompts: agents fetch them only through a scoped tool.',
              icon: 'key-round',
            },
            {
              title: 'Secrets skip the LLM',
              blurb: 'Keys are typed into <b>secure popups</b> that bypass the model entirely, and leaked values can be redacted after the fact.',
              icon: 'shield-check',
            },
            {
              title: 'Human-in-the-loop',
              blurb: 'Agents pause and ask before acting: blocking prompts, <b>approval gates</b>, even captcha hand-offs mid-automation.',
              icon: 'hand',
            },
            {
              title: 'Shared household',
              blurb: 'Invite family or teammates to one instance: everyone shares the agents, and agents <b>know who’s speaking</b>.',
              icon: 'users-round',
            },
            {
              title: 'Rewind & export',
              blurb: 'Delete messages, <b>rewind</b> a conversation to any point, or export it all as Markdown or JSON. Your history, your call.',
              icon: 'undo-2',
            },
          ],
        },
        {
          label: 'Experience',
          icon: 'sparkles',
          cards: [
            {
              title: '18 color palettes',
              blurb: 'From Aurora to Citrus: <b>18 palettes</b> with light, dark, and soft-contrast modes, one click away.',
              icon: 'palette',
            },
            {
              title: 'Install it anywhere',
              blurb: 'A full <b>PWA</b>: install on desktop or phone, get unread badges, and stay synced across devices in real time.',
              icon: 'smartphone',
            },
            {
              title: 'Quick sessions',
              blurb: 'Ephemeral side-chats with <b>per-session model overrides</b>: experiment freely, then save the good bits as memories.',
              icon: 'zap',
            },
            {
              title: 'Per-message controls',
              blurb: 'Override the model and <b>thinking effort</b> for a single message, right from the composer.',
              icon: 'sliders-horizontal',
            },
            {
              title: 'Workspace file browser',
              blurb: 'Browse, edit, and share every file your agents produce: <b>tabs, conflict detection</b>, drag-and-drop, and clickable paths in chat.',
              icon: 'folder',
            },
            {
              title: 'Images & avatars',
              blurb: 'Agents <b>generate and edit images</b> on demand, including consistent, styled avatars for your whole roster.',
              icon: 'image',
            },
          ],
        },
      ],
    },

    why: {
      kicker: 'Why Hivekeep',
      heading: 'Next to the closest projects.',
      intro:
        'Self-hosted AI assistants like <b>OpenClaw</b> and <b>Hermes</b> are excellent: they win on memory, omnichannel reach and self-hosting too. Where Hivekeep pulls ahead is the <b>team</b>, the <b>polished product UI</b>, and <b>transparency</b>.',
      rows: [
        'Self-hosted, your data',
        'Persistent memory',
        'Native omnichannel',
        'Connected accounts (mail, calendar)',
        'Agents build their own tools / skills',
        'Scheduled tasks (cron)',
        'A team of agents that collaborate',
        'Polished web app (PWA)',
        'Rendered tool calls (UI, not JSON)',
        'Mini-apps & projects (Kanban)',
        'Conversational setup (no CLI)',
        'Secrets never sent to the LLM',
        'Token & context transparency',
      ],
      legend: '✓ native · ✕ not really · the rest is partial or unclear. Marks are best-effort from public docs.',
    },

    getstarted: {
      kicker: 'Get started',
      heading: 'Run your team in two minutes.',
      p: 'Paste one command on your Linux or macOS machine. It installs everything, then opens in your browser where <b>Queenie</b> walks you through the rest.',
      recTag: 'The simplest way to install',
      needCustom: 'Need a custom port, your own domain, or Docker?',
      seeAll: 'See all install options',
      installBtn: 'Install Hivekeep',
      starBtn: 'Star on GitHub',
      copyAria: 'Copy command',
    },
  },

  install: {
    intro: {
      kicker: 'Install',
      heading: 'Get Hivekeep running.',
      p: "One command does everything. Once it's up, <b>Queenie</b> sets up the rest by chatting with you, so there are no config files to edit.",
    },

    rec: {
      tag: 'Recommended · the simplest way',
      heading: "Paste one line. That's it.",
      p: 'Run this in a terminal on your Linux or macOS machine. It installs everything for you.',
      copyAria: 'Copy install command',
      copy: 'Copy',
      copied: 'Copied',
      then: 'When it finishes, open the link it prints in your browser. <b>Queenie does the rest.</b>',
    },

    configure: {
      kicker: 'Optional',
      heading: 'Want a custom port, a domain, or Docker?',
      p: "Skip this if the one-liner above is all you need. Otherwise answer a couple of questions and we'll generate the exact command for your setup.",
    },

    more: {
      label: 'Advanced & other options',
      hint: 'Requirements, and Docker vs native vs source',
    },

    prereqs: {
      kicker: 'Before you start',
      heading: 'What the one-liner needs.',
      sub: 'Most machines already have all of this.',
      items: [
        {
          icon: 'lucide:shield',
          title: 'You can run sudo',
          desc: 'The installer needs it to install missing system packages (git, curl, unzip).',
        },
        {
          icon: 'lucide:hard-drive',
          title: 'About 500 MB free disk',
          desc: 'Room to clone and build. 1 GB or more is comfortable.',
        },
        {
          icon: 'lucide:cpu',
          title: 'A 64-bit machine',
          desc: 'x86_64 or ARM64. 32-bit (older Raspberry Pi) is not supported.',
        },
        {
          icon: 'lucide:globe',
          title: 'Outbound HTTPS',
          desc: 'It downloads from github.com and bun.sh, so those must be reachable.',
        },
        {
          icon: 'lucide:key-round',
          title: 'openssl present',
          desc: 'Used to generate keys. It ships with almost every Linux and macOS.',
        },
      ],
      windows:
        "<b>On Windows?</b> The native installer doesn't run on Windows directly. Use <b>WSL2</b> (run the one-liner inside your Linux distro) or <b>Docker Desktop</b>.",
    },

    compare: {
      kicker: 'Compare',
      heading: 'Native, Docker, or from source?',
      sub: 'All three run the exact same app. They differ in how it lives on the machine.',
    },

    // Order matters: the first method is the recommended (primary) one.
    methods: [
      {
        tag: 'Recommended',
        name: 'Native (install.sh)',
        pick: 'Pick this if you just want it to work. One command, on your own Linux or macOS box.',
        points: [
          ['y', 'One command, builds locally, no image to publish or pull'],
          ['y', 'Saves your encryption key automatically, secrets persist'],
          ['y', 'Runs as a service (systemd / launchd), auto-update with rollback'],
          ['y', 'Agents own the box: install tools & deps, direct hardware access'],
          ['n', 'Modifies the host system (by design)'],
          ['n', 'Linux & macOS only (Windows via WSL2)'],
        ],
      },
      {
        tag: 'Container',
        name: 'Docker',
        pick: 'Pick this if you already live in Docker and want a clean, sandboxed appliance.',
        points: [
          ['y', 'Fully isolated, zero host pollution'],
          ['y', 'Runs anywhere Docker runs, including Windows'],
          ['n', 'Published image is not available yet, prefer native for now'],
          ['n', "Agent-installed tools & binaries don't survive a restart"],
          ['n', 'You must persist the data volume or you lose your secrets'],
        ],
      },
      {
        tag: 'From source',
        name: 'Manual',
        pick: 'Pick this if you want to read the code, hack on it, or run it your own way.',
        points: [
          ['y', 'Full control: clone, build, run with Bun yourself'],
          ['y', 'Best for contributors and development'],
          ['n', 'No service, no auto-update, you wire those up'],
          ['n', 'You handle Bun, build, migrations and the encryption key by hand'],
        ],
      },
    ],

    // All user-visible strings of the InstallConfigurator React component.
    // Rich strings ({port}, {url}, {host} placeholders + inline HTML) are
    // rendered with dangerouslySetInnerHTML after substitution.
    configurator: {
      step1: '1 · How will you use it?',
      step2: '2 · Settings',
      step3: '3 · Run it',
      useCases: {
        try: { label: 'Just trying it out', hint: 'Run it on this machine, localhost only. Zero config.' },
        permanent: {
          label: 'Permanent on this machine',
          hint: 'A lasting home for your agents. Optional access from other devices.',
        },
        server: { label: 'Server with a domain', hint: 'Public, HTTPS, reachable at your own domain.' },
      },
      method: 'Method',
      methodNative: 'Native (recommended)',
      methodDocker: 'Docker',
      port: 'Port',
      lanAccess: 'Access from other devices on my network',
      lanPlaceholder: "this machine's LAN IP, e.g. 192.168.1.50",
      domain: 'Your domain',
      reverseProxy: 'Reverse proxy (HTTPS)',
      proxyOwn: 'I have my own',
      fixedKey: 'Set a fixed encryption key (advanced: back it up)',
      generate: 'Generate',
      copy: 'Copy',
      copied: 'Copied',
      copyAria: 'Copy to clipboard',
      blockRun: 'Run',
      blockStart: 'Start',
      blockInstall: 'Install',
      dockerWarn: {
        title: 'Heads up: the published Docker image is not available yet.',
        beforeImage: 'These commands pull ',
        afterImage: ', which is not public on the registry at the moment, so they will fail with ',
        or: ' or ',
        beforeLink: ". Until it's published, use the ",
        link: 'native install',
        afterLink: ' (it builds locally and needs no image), or build the image yourself from a clone of the repo.',
      },
      dockerKeynote:
        '<strong>Keep your encryption key.</strong> The key is stored inside the <code>hivekeep-data</code> volume. If you delete or recreate that volume without persisting the key (or pinning a fixed <code>ENCRYPTION_KEY</code> with the advanced toggle above), every vault secret becomes unrecoverable.',
      composeKeynote:
        '<strong>Keep your encryption key.</strong> It lives in the <code>hivekeep-data</code> volume. Recreating the volume without persisting the key (or setting a fixed <code>ENCRYPTION_KEY</code> in <code>.env</code>) makes every stored secret unrecoverable.',
      dockerRecover: {
        head: 'If a command fails',
        port: '<code>port is already allocated</code>: port {port} is in use. Change the Port field above and copy the new command.',
        manifest: {
          before: "the published image isn't available yet. Use the ",
          link: 'native install',
          after: ' instead, or build locally.',
        },
        daemon:
          "<code>Cannot connect to the Docker daemon</code>: Docker isn't running. Start Docker Desktop, or run <code>sudo systemctl start docker</code> on Linux.",
      },
      nativeKeynote:
        "<strong>Your encryption key is handled for you.</strong> The installer auto-generates and saves it at <code>$DATA_DIR/.encryption-key</code> so your secrets survive restarts. Back up that file alongside your database. (Pin a fixed <code>ENCRYPTION_KEY</code> with the advanced toggle above if you'd rather manage it yourself.)",
      nativeRecover: {
        head: 'If the install fails',
        port: '<code>port already in use</code> / <code>EADDRINUSE</code>: port {port} is taken. Change the Port field above and re-run.',
        windows:
          '<strong>Windows</strong>: the installer is Linux and macOS only. Run it inside <strong>WSL2</strong>, or use Docker Desktop.',
        network:
          '<strong>Download or clone hangs</strong>: make sure the machine can reach <code>github.com</code> and <code>bun.sh</code> over HTTPS (a proxy may be blocking them).',
      },
      proxyCaddy:
        "Caddy handles HTTPS automatically (Let's Encrypt). Put this in your <code>Caddyfile</code> and run <code>caddy run</code>.",
      proxyNginx: 'An nginx server block proxying to Hivekeep, then certbot for HTTPS.',
      proxyOwnNote:
        'Point your reverse proxy at <code>http://localhost:{port}</code>, make sure <code>PUBLIC_URL={url}</code> is set (it already is above), and disable response buffering on <code>/api/sse</code> so server-sent events stream through.',
      foot: 'Open <code>{url}</code> in your browser. Queenie walks you through the rest (admin account, your first AI provider, your first agents). No config files to edit.',
      envComments: {
        publicUrl: '# Public URL: used for invitation links, webhooks, OAuth callbacks, CORS.',
        key1: '# Encryption key (AES-256-GCM, 64 hex chars). Auto-generated and stored',
        key2: '# inside the data volume if you leave this unset. Setting it yourself lets',
        key3: '# you back it up: losing it makes every vault secret unrecoverable.',
      },
      nginxComments: {
        sse: '# SSE: stream events without buffering',
        https: '# Then add HTTPS:  sudo certbot --nginx -d {host}',
      },
    },
  },

  // Dedicated /plugins page: the list itself comes from site/src/data/plugins.json
  // (baked from the npm registry at deploy, fetch-plugins.mjs).
  pluginsPage: {
    kicker: 'Marketplace',
    heading: 'Plugins, straight from npm.',
    sub: 'This list is pulled automatically from npm: every package tagged <code>hivekeep-plugin</code> shows up here. Install any of them in one click from the in-app marketplace, no terminal needed.',
    count: '{count} plugins and counting',
    by: 'by {author}',
    downloads: '{count} downloads/month',
    updated: 'updated {date}',
    viewNpm: 'npm',
    viewGithub: 'GitHub',
    publishHeading: 'Publish yours.',
    publishText: 'A plugin can add <b>providers, channels, tools and hooks</b>. Build one (or have an Agent write it for you), publish it to npm with the <code>hivekeep-plugin</code> keyword, and it appears here and in the in-app marketplace automatically.',
    publishCta: 'Read the plugin guide',
  },

  // Section chrome for components that were initially scoped out: the mini-app
  // marquee, the providers/plugins section, the agent-directory domains and the
  // visible chrome of the scripted demos (transcripts stay English on purpose).
  components: {
    marquee: {
      kicker: 'Mini-apps · built by your agents',
      heading: 'Ask for an app. Get an app.',
      sub: 'Real web apps your agents build and host inside Hivekeep: themed, installable, and wired to your tools and APIs when you need it. Everything below is the kind of thing one sentence gets you.',
      note: 'Illustrative previews. Agents build, theme, and improve these on request: <b>\u201cadd a chart\u201d</b> is a message, not a ticket.',
    },
    providers: {
      kicker: 'Providers & plugins',
      heading: 'Bring any provider, or add your own.',
      intro: 'These providers are built in across every capability. One config per provider, and capabilities are auto-detected (an OpenAI key lights up LLM, image, embeddings and speech at once). Need another? Add it with a plugin.',
      subCallout: '<b>Already paying for Claude or ChatGPT?</b> Sign in with your <b>Claude Pro/Max</b> or <b>ChatGPT</b> subscription: your Agents run on it, no API key needed.',
      groupLlm: 'Language models',
      groupImage: 'Image generation',
      groupSearch: 'Web search',
      groupSpeech: 'Speech (STT / TTS)',
      groupEmbeddings: 'Embeddings',
      groupAccounts: 'Connected accounts',
      plugNote: "Don't see yours? Install a plugin from npm (anything tagged <code>hivekeep-plugin</code>) straight from the in-app marketplace, or have an Agent write one. A plugin can add <b>providers, channels, tools and hooks</b>. A few real ones:",
      tagChannel: 'channel',
      tagLlm: 'LLM provider',
      tagImageLlm: 'image / LLM provider',
      twilioDesc: 'Send and receive <b>SMS</b> through the Twilio REST API and webhooks. A real channel adapter.',
      mistralDesc: 'Adds <b>Mistral AI</b> as a provider: chat models with tool calling, vision and streaming.',
      replicateDesc: 'Brings <b>Replicate-hosted models</b>: image (Flux), LLM (Llama 3, Mixtral) and embeddings.',
      viewGithub: 'View on GitHub',
      browseAll: 'Browse all plugins',
    },
    agentDemo: {
      rosterTitle: '// your agents',
      active: '{count} active',
      seeInAction: 'See {name} in action',
      demoTag: 'demo',
      close: 'Close',
      replay: 'Replay',
      placeholder: 'Message {name}\u2026',
      note: 'This is a scripted preview. The real thing runs on your server.',
      statusOnline: 'online',
      statusWorking: 'working',
      statusIdle: 'idle',
    },
    queenieDemo: {
      cap: 'Fig. 5 · Queenie onboarding',
      liveDemo: 'live demo',
      online: 'online',
      role: 'Your setup guide · gets the hive running',
      placeholder: 'Message Queenie\u2026',
    },
    domains: {
      Queenie: 'Setup & onboarding',
      Atlas: 'DevOps & infra',
      Forge: 'Dev & code',
      Inbox: 'Email & calendar',
      Sentinel: 'Security & pentest',
      Prism: 'Data & BI',
      Ledger: 'Finance & budgeting',
      Quill: 'Writing & copy',
      Sage: 'Research & synthesis',
      Pixel: 'UI/UX design',
      Beacon: 'News & tech watch',
      Nest: 'Home automation',
      Compass: 'Travel planning',
      Vitals: 'Health & fitness',
      Cuisine: 'Recipes & meals',
      Tutor: 'Learning & tutoring',
      Sprout: 'Gardening & plants',
      Lexicon: 'Translation & l10n',
      Archive: 'Docs & organization',
      Pulse: 'Social & community',
    },
  },
}
