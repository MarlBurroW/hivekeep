import en from './en'

const dict: typeof en = {
  meta: {
    plugins: {
      title: '插件',
      description: '浏览发布在 npm 上的全部 Hivekeep 插件：服务商、频道、工具和钩子，在应用内市场一键安装。',
    },
    home: {
      title: 'Hivekeep · 你的 AI 团队，就在家中。',
      description:
        '一支可自托管的 AI 智能体团队：会记忆、会协作、还能自己打造工具。一个容器，零外部依赖。你的 AI 团队，就在家中。',
    },
    install: {
      title: '安装 Hivekeep',
      description:
        '按你的方式安装 Hivekeep：用 Docker 快速体验，或原生安装给智能体一个真正的家。一键生成适合你环境的安装命令。',
    },
  },

  nav: {
    plugins: '插件',
    features: '功能特性',
    household: '智能体之家',
    why: '为什么选 Hivekeep',
    docs: '文档',
    github: 'GitHub ↗',
    getStarted: '立即开始',
    configure: '配置',
  },

  footer: {
    line: '开源 · MIT · 基于 Bun 构建 · © 2026',
  },

  // Homepage band between sections 05 and 06: the UI ships in 10 languages,
  // the agents speak many more. Chips are rendered from LOCALE_LABELS.
  languages: {
    kicker: '多语言',
    heading: '说你的语言。',
    p: '界面内置 10 种语言，而你的智能体远不止于此：无论你说哪种语言（40 多种），它们都会用同样的语言回答，与界面语言无关。',
  },

  home: {
    hero: {
      meta: '自托管 · MIT',
      kicker: '一座自主智能体的蜂巢',
      h1a: '你的 AI 团队。',
      h1b: '就在家中。',
      sub: '一支会<b>记忆</b>、会<b>协作</b>、还能<b>自己打造工具</b>的智能体团队，完全运行在你自己的服务器上。它不是聊天机器人，而是一个像蜂巢一样运转的专家之家。',
      colophon: {
        runsOnK: '运行环境',
        runsOnV: '一个容器',
        infraK: '外部依赖',
        infraV: '零',
        setupK: '配置方式',
        setupV: '一场对话',
        channelsK: '消息渠道',
        channelsV: '内置 6 种',
      },
      ctaStart: '2 分钟上手',
      ctaDemo: '观看演示',
      everywhere: '随处可用：',
      webPwa: 'Web · PWA',
    },

    health: {
      kicker: 'GitHub 实时数据',
      latestRelease: '最新版本',
      ciPrefix: 'CI',
      ciPassing: '通过',
      ciFailing: '失败',
      mainBranch: 'main 分支',
      stars: 'star',
      openIssue: '个开放 issue',
      openIssues: '个开放 issue',
      lastCommit: '最近提交',
      contributor: '位贡献者',
      contributors: '位贡献者',
    },

    video: {
      kicker: '实际效果',
      heading: '一条命令，从零到拥有自己的团队。',
      sub: '一个容器。然后 Queenie 接手一切：接入服务商、生成头像、组建整支团队，你的智能体随即开始为你工作。',
    },

    s1memory: {
      stage: '持久记忆',
      heading: '它们永远不会忘记你。',
      p1: '没有「新建对话」。一段持续不断的会话，加上跨越数月不断积累上下文的混合记忆。任何内容都不会被删除：旧消息会被摘要归档，绝不丢弃。',
      p2: '一个智能体可以把工作交给另一个，或派出一群子智能体加速推进。整个蜂群共享同一份历史和同一本通讯录。',
      tagSession: '持续会话',
      tagHandoff: '智能体间交接',
      figCap: '图 1 · recall("grocery budget")',
      figTag: 'memory',
      card1: {
        cat: '决定',
        topic: '预算',
        text: '每月买菜预算定为 600 美元，目标是削减不必要的开支。',
      },
      card2: {
        cat: '偏好',
        topic: '购物',
        text: '偏好购买超市自有品牌的日常食材，并在周末批量备餐。',
      },
    },

    s2sovereign: {
      stage: '数据主权',
      heading: '一个容器，数据绝不离开你的服务器。',
      p1: '不需要 Postgres、Redis、Mongo，也不需要消息队列。Bun 加 SQLite，一个二进制搞定。你的数据、你的密钥、你的机器。',
      p2: '密钥存放在加密保险库中。智能体通过保险库键名访问服务，<b>从不读取明文值</b>，因此它<b>永远不会进入 LLM</b>。',
      termComment: '# 然后打开浏览器，剩下的交给 Queenie。',
      specs: {
        footprintK: '占用',
        footprintV: '1 个进程 · 1 个 SQLite 文件',
        infraK: '外部依赖',
        infraV: '零',
        secretsK: '密钥',
        secretsV: 'AES-256-GCM 保险库，仅按引用访问',
        dataK: '数据与密钥',
        dataV: '属于你，存在你的硬件上',
      },
    },

    s3extensible: {
      stage: '自我进化',
      heading: '你的智能体会自己扩展这个平台。',
      shotAlt: '天气工具在对话中渲染为主题化卡片',
      p1: '智能体可以用任意语言编写工具、自带依赖，并配上渲染器，把结果展示为<b>主题化卡片而非原始 JSON</b>。它们还能直接在 Hivekeep 里构建完整的迷你应用（仪表盘、控制面板），甚至发布 NPM 插件。',
      p2: '用<b>工具箱</b>为每个智能体划定范围，让专注的智能体只看到它需要的工具：既保持敏锐，也让更轻量的模型足以胜任。',
      tagCustomTools: '自定义工具',
      tagMiniApps: '迷你应用',
      tagNpm: 'NPM 插件',
      tagMcp: 'MCP',
      tagToolboxes: '工具箱',
    },

    s4channels: {
      stage: '无处不在',
      heading: '整个团队，共用一个收件箱。',
      p1: '在你常用的聊天软件里，直接和任何一个智能体对话。问错对象了？接线的智能体会<b>把你的请求转给对的专家</b>并转达答复；如果你点名要找某个智能体，它还能实时<b>把频道移交过去</b>。不用记命令，不用切换应用。',
      shotAlt: '一条发错对象的智能家居请求，被转交给负责的专家智能体并关掉了灯',
    },

    s5pocket: {
      stage: '移动端',
      heading: '整座蜂巢，装进口袋。',
      p1: 'Hivekeep 是手机上的真正应用：<b>直接从浏览器安装</b>（无需应用商店，无需注册任何账号，无需额外部署）。全屏体验、主屏幕图标，还有<b>真正好用的未读角标</b>。',
      p2: '而且它和桌面端是<b>同一个实时会话</b>：在电脑上收到的回复，手机上立刻就有。窝在沙发上，你也能<b>语音</b>回复、发照片、批准智能体的计划。',
      tagPwa: '可安装 PWA',
      tagDesktopMobile: '桌面 + 移动',
      tagBadges: '未读角标',
      tagVoice: '语音输入与播报',
      phone: {
        aria: 'Hivekeep 作为已安装应用在手机上运行',
        online: '在线',
        userBubble: '马上到家，把家里弄温馨点 🛋️',
        tool1Name: '设置暖气',
        tool1Detail: ' · 客厅 → 21.5°',
        tool2Name: '场景',
        tool2Detail: ' · 夜晚',
        agentBubble: '暖气已开，灯光切到<strong>夜晚</strong>模式。路况显示 18 分钟到家。要不要顺便预热烤箱？',
        inputPlaceholder: '发消息给 Nest…',
      },
      chipInstallB: '从浏览器安装',
      chipInstallI: '无需应用商店',
      chipBadgesB: '未读角标',
      chipBadgesI: '就在主屏幕上',
      chipSyncB: '与桌面端同步',
      chipSyncI: '同一个实时会话',
    },

    s6transparency: {
      stage: '完全透明',
      heading: '没有黑箱，没有账单惊吓。',
      p1: '清楚看到发给模型的一切：系统提示词逐块拆解，token 成本<b>按智能体、按模型</b>统计，还有提示缓存的读取 / 写入 / 新增明细及命中率。无论用哪家服务商，Hivekeep 对「发了什么、花了多少」都异常坦诚。',
      tagCost: '按智能体统计 token 成本',
      tagPreview: '上下文预览',
      figCap: '图 4 · 上下文查看器',
      figTag: 'tokens',
      barTools: '工具',
      barMemory: '记忆',
      barIdentity: '身份',
      barChannels: '渠道',
      cacheTitle: '提示缓存 · 已预热 · 剩余 4:12',
      cacheHit: '命中率 72%',
      legendRead: '读取 9.1k',
      legendWrite: '写入 1.2k',
      legendFresh: '新增 2.4k',
    },

    s7setup: {
      stage: '配置',
      heading: '配置是一场对话，不是一份 YAML。',
      p1: 'Queenie 是你的配置智能体：通过聊天为你接入服务商、保管密钥、创建第一批智能体。它会一直陪着你，随时帮你添加新智能体或接入新的服务商。',
      tagSecure: '安全输入 → 保险库',
      tagGenerates: '为你生成智能体',
    },

    s8household: {
      stage: '示例',
      heading: '为你的生活，组建一个智能体之家。',
      p1: 'Hivekeep 出厂只带一个智能体：<b>Queenie</b>，你的配置向导。其余的由你来创建，或者直接让 Queenie 替你搭建。每个智能体都有自己的名字、领域、记忆、工具，以及一张生成的头像。',
      p2: '头像默认采用 Hivekeep 的<b>统一画风</b>，新蜂巢一上来就像一套整齐的阵容。想要自己的风格？设置一次<b>自定义头像画风</b>（像素风、水彩、你的品牌风格），所有智能体都会按它重新生成，整个团队始终风格统一。',
      examplesNote: '看看大家都搭建了什么 →',
      builtIn: '内置',
      eg: '例如',
    },

    morefx: {
      kicker: '引擎盖之下',
      heading: '还有 {count} 项功能。',
      sub: '下面的一切开箱即用：没有附加组件，没有付费档位。',
      categories: [
        {
          label: '智能体与协作',
          icon: 'users',
          cards: [
            {
              title: '智能体之间互相对话',
              blurb: '你的专家们通过<b>请求/答复</b>模式互发消息：问一个智能体，看它自己去请教另一个。',
              icon: 'messages-square',
            },
            {
              title: '子智能体委派',
              blurb: '智能体可派出临时子智能体处理重活（<b>阻塞或并行</b>），有并发上限，完成后交回清晰的报告。',
              icon: 'git-branch',
            },
            {
              title: '侦察模式',
              blurb: '把只读调研委派给<b>便宜又快的模型</b>，拿回一份摘要，不浪费旗舰模型的 token。',
              icon: 'binoculars',
            },
            {
              title: '内置 CRM',
              blurb: '智能体维护一本自动填充的通讯录，含备注和偏好，还支持从 <b>iCloud 与 CardDAV</b> 只读同步。',
              icon: 'users',
            },
          ],
        },
        {
          label: '自动化',
          icon: 'workflow',
          cards: [
            {
              title: '会学习的定时任务',
              blurb: '定时任务按 cron 唤起智能体，保留<b>运行日志</b>，并沉淀经验让以后每次运行越来越好。',
              icon: 'calendar-clock',
            },
            {
              title: '入站 Webhook',
              blurb: '任何 HTTP 事件都能唤醒智能体，支持<b>载荷过滤</b>（点路径或正则）、限流和请求日志。',
              icon: 'webhook',
            },
            {
              title: '邮件触发器',
              blurb: '匹配规则的来信会自动唤醒对应的智能体，进入它的对话或一个<b>独立任务</b>。',
              icon: 'mail-check',
            },
            {
              title: '唤醒定时器',
              blurb: '智能体可以给自己安排未来的工作（<b>“两小时后叫醒我”</b>），跟进和提醒真正不会落空。',
              icon: 'alarm-clock',
            },
            {
              title: '智能体驱动的看板',
              blurb: '把工作组织为项目和工单，然后<b>把工单指派给智能体</b>，它们执行后以评论形式回报。',
              icon: 'kanban',
            },
          ],
        },
        {
          label: '记忆与上下文',
          icon: 'brain-circuit',
          cards: [
            {
              title: '一场没有尽头的对话',
              blurb: '没有「新对话」按钮：旧消息会压缩成<b>带日期的摘要</b>，原文安全地留在数据库里。',
              icon: 'infinity',
            },
            {
              title: '自我清理的记忆',
              blurb: '记忆会被合并、按使用频率重新评分，过期的会被清理，回忆始终<b>精准而不臃肿</b>。',
              icon: 'brain',
            },
            {
              title: '知识库',
              blurb: '文档只需上传一次；话题出现时，相关片段会<b>自动浮现</b>到上下文中。',
              icon: 'book-open',
            },
            {
              title: '项目知识',
              blurb: '每个项目都沉淀精选的事实、决定与坑点：<b>置顶条目</b>会随每一轮智能体对话一起携带。',
              icon: 'notebook-pen',
            },
            {
              title: '可搜索的过去',
              blurb: '智能体用<b>语义 + 全文</b>融合排序搜索全部历史，说过的话永远不会真正丢失。',
              icon: 'history',
            },
          ],
        },
        {
          label: '连接世界',
          icon: 'globe',
          cards: [
            {
              title: '邮件，交给它',
              blurb: '在 <b>Gmail、Outlook、iCloud 和 IMAP</b> 上阅读、搜索、发送邮件，外发邮件可开启审批模式。',
              icon: 'mail',
            },
            {
              title: '日历掌控',
              blurb: '智能体可代你在 <b>Google、Outlook 和 CalDAV</b> 日历上创建、更新、搜索日程。',
              icon: 'calendar-days',
            },
            {
              title: '真实浏览器自动化',
              blurb: '智能体驱动一个<b>有状态的浏览器</b>（登录、填表、点击、截图），并保存会话供下次使用。',
              icon: 'mouse-pointer-click',
            },
            {
              title: '网页搜索与阅读',
              blurb: '可插拔的搜索后端（<b>Brave、Tavily、SerpAPI、Perplexity</b>），外加页面抓取、链接提取和截图。',
              icon: 'globe',
            },
            {
              title: '语音进，语音出',
              blurb: '通过任意已配置的服务商实现语音转文字和<b>文字转语音</b>：跟智能体说话，听它们回答。',
              icon: 'mic',
            },
          ],
        },
        {
          label: '掌控与信任',
          icon: 'shield',
          cards: [
            {
              title: '加密保险库',
              blurb: '密钥以 <b>AES-256-GCM</b> 加密存储，从不注入提示词：智能体只能通过受限工具按需获取。',
              icon: 'key-round',
            },
            {
              title: '密钥绕过 LLM',
              blurb: '密钥通过<b>安全弹窗</b>输入，完全绕开模型；万一泄露的值还能事后脱敏。',
              icon: 'shield-check',
            },
            {
              title: '人在回路',
              blurb: '智能体行动前会停下来先问你：阻塞式提问、<b>审批关卡</b>，甚至自动化中途把验证码交还给你。',
              icon: 'hand',
            },
            {
              title: '共享之家',
              blurb: '邀请家人或同事加入同一个实例：大家共享智能体，而智能体<b>清楚是谁在说话</b>。',
              icon: 'users-round',
            },
            {
              title: '回退与导出',
              blurb: '删除消息、把对话<b>回退</b>到任意时间点，或整体导出为 Markdown 或 JSON。你的历史，你说了算。',
              icon: 'undo-2',
            },
          ],
        },
        {
          label: '使用体验',
          icon: 'sparkles',
          cards: [
            {
              title: '18 套配色',
              blurb: '从 Aurora 到 Citrus：<b>18 套配色</b>，支持浅色、深色和柔和对比模式，一键切换。',
              icon: 'palette',
            },
            {
              title: '随处安装',
              blurb: '完整的 <b>PWA</b>：在桌面或手机上安装，获得未读角标，多设备实时保持同步。',
              icon: 'smartphone',
            },
            {
              title: '快速会话',
              blurb: '临时旁路聊天，支持<b>按会话覆盖模型</b>：放心试验，再把好的部分存为记忆。',
              icon: 'zap',
            },
            {
              title: '按消息粒度控制',
              blurb: '直接在输入框为单条消息覆盖模型和<b>思考力度</b>。',
              icon: 'sliders-horizontal',
            },
            {
              title: '工作区文件浏览器',
              blurb: '浏览、编辑、分享智能体产出的每个文件：<b>多标签页、冲突检测</b>、拖拽上传，聊天中的路径还能点击打开。',
              icon: 'folder',
            },
            {
              title: '图像与头像',
              blurb: '智能体可按需<b>生成和编辑图像</b>，包括为整个阵容生成风格一致的头像。',
              icon: 'image',
            },
          ],
        },
      ],
    },

    why: {
      kicker: '为什么选 Hivekeep',
      heading: '与最接近的项目并排看。',
      intro:
        '<b>OpenClaw</b> 和 <b>Hermes</b> 这类自托管 AI 助手都很出色：在记忆、全渠道触达和自托管上同样表现优异。而 Hivekeep 的领先之处在于<b>团队协作</b>、<b>精致的产品级界面</b>和<b>透明度</b>。',
      rows: [
        '自托管，数据归你',
        '持久记忆',
        '原生全渠道',
        '账户连接（邮件、日历）',
        '智能体自建工具 / 技能',
        '定时任务（cron）',
        '一支会协作的智能体团队',
        '精致的 Web 应用（PWA）',
        '工具调用渲染为界面（而非 JSON）',
        '迷你应用与项目（看板）',
        '对话式配置（无需 CLI）',
        '密钥从不发送给 LLM',
        'token 与上下文透明',
      ],
      legend: '✓ 原生支持 · ✕ 基本没有 · 其余为部分支持或不明确。标注基于公开文档尽力整理。',
    },

    getstarted: {
      kicker: '立即开始',
      heading: '两分钟，跑起你的团队。',
      p: '在你的 Linux 或 macOS 机器上粘贴一条命令。它会装好一切，然后在浏览器中打开，由 <b>Queenie</b> 引导你完成剩下的步骤。',
      recTag: '最简单的安装方式',
      needCustom: '需要自定义端口、自己的域名，或者 Docker？',
      seeAll: '查看全部安装选项',
      installBtn: '安装 Hivekeep',
      starBtn: '在 GitHub 点个 Star',
      copyAria: '复制命令',
    },
  },

  install: {
    intro: {
      kicker: '安装',
      heading: '让 Hivekeep 跑起来。',
      p: '一条命令搞定一切。启动之后，<b>Queenie</b> 会通过聊天帮你完成其余配置，没有任何配置文件需要编辑。',
    },

    rec: {
      tag: '推荐 · 最简单的方式',
      heading: '粘贴一行，就这么简单。',
      p: '在你的 Linux 或 macOS 机器的终端里运行这条命令，它会为你装好一切。',
      copyAria: '复制安装命令',
      copy: '复制',
      copied: '已复制',
      then: '完成后，在浏览器中打开它输出的链接。<b>剩下的交给 Queenie。</b>',
    },

    configure: {
      kicker: '可选',
      heading: '需要自定义端口、域名，或者 Docker？',
      p: '如果上面那一行命令已经够用，直接跳过这里。否则回答几个问题，我们就为你的环境生成精确的安装命令。',
    },

    more: {
      label: '高级与其他选项',
      hint: '系统要求，以及 Docker、原生与源码安装的对比',
    },

    prereqs: {
      kicker: '开始之前',
      heading: '一行命令需要什么。',
      sub: '大多数机器早已具备这一切。',
      items: [
        {
          icon: 'lucide:shield',
          title: '可以运行 sudo',
          desc: '安装器需要它来补齐缺失的系统包（git、curl、unzip）。',
        },
        {
          icon: 'lucide:hard-drive',
          title: '约 500 MB 可用磁盘空间',
          desc: '用于克隆和构建。1 GB 以上会更宽裕。',
        },
        {
          icon: 'lucide:cpu',
          title: '64 位机器',
          desc: 'x86_64 或 ARM64。不支持 32 位（较老的树莓派）。',
        },
        {
          icon: 'lucide:globe',
          title: '可出站 HTTPS',
          desc: '需要从 github.com 和 bun.sh 下载，这两个地址必须可达。',
        },
        {
          icon: 'lucide:key-round',
          title: '已安装 openssl',
          desc: '用于生成密钥。几乎所有 Linux 和 macOS 都自带。',
        },
      ],
      windows:
        '<b>在 Windows 上？</b>原生安装器无法直接在 Windows 运行。请使用 <b>WSL2</b>（在你的 Linux 发行版里运行那行命令）或 <b>Docker Desktop</b>。',
    },

    compare: {
      kicker: '对比',
      heading: '原生、Docker，还是源码？',
      sub: '三种方式运行的是完全相同的应用，区别只在它如何驻留在机器上。',
    },

    // Order matters: the first method is the recommended (primary) one.
    methods: [
      {
        tag: '推荐',
        name: '原生（install.sh）',
        pick: '只想让它直接能用？选这个。一条命令，跑在你自己的 Linux 或 macOS 机器上。',
        points: [
          ['y', '一条命令，本地构建，无需发布或拉取镜像'],
          ['y', '自动保存加密密钥，机密数据持久保留'],
          ['y', '以服务运行（systemd / launchd），自动更新并支持回滚'],
          ['y', '智能体拥有整台机器：可安装工具与依赖，直接访问硬件'],
          ['n', '会修改宿主系统（这是设计使然）'],
          ['n', '仅限 Linux 与 macOS（Windows 需通过 WSL2）'],
        ],
      },
      {
        tag: '容器',
        name: 'Docker',
        pick: '如果你已经常驻 Docker，想要一个干净、沙箱化的开箱设备，就选这个。',
        points: [
          ['y', '完全隔离，零宿主污染'],
          ['y', '凡是能跑 Docker 的地方都能跑，包括 Windows'],
          ['n', '官方镜像暂未发布，目前请优先选择原生安装'],
          ['n', '智能体安装的工具和二进制在重启后不会保留'],
          ['n', '必须持久化数据卷，否则会丢失全部机密'],
        ],
      },
      {
        tag: '源码',
        name: '手动',
        pick: '想读代码、改代码，或按自己的方式运行？选这个。',
        points: [
          ['y', '完全掌控：自己用 Bun 克隆、构建、运行'],
          ['y', '最适合贡献者和开发场景'],
          ['n', '没有服务托管，没有自动更新，需要自己搭建'],
          ['n', 'Bun、构建、迁移和加密密钥都要手动处理'],
        ],
      },
    ],

    // All user-visible strings of the InstallConfigurator React component.
    // Rich strings ({port}, {url}, {host} placeholders + inline HTML) are
    // rendered with dangerouslySetInnerHTML after substitution.
    configurator: {
      step1: '1 · 你打算怎么用？',
      step2: '2 · 设置',
      step3: '3 · 运行',
      useCases: {
        try: { label: '只是试试看', hint: '在本机运行，仅限 localhost，零配置。' },
        permanent: {
          label: '在这台机器上长期运行',
          hint: '给智能体一个长久的家，可选开放给其他设备访问。',
        },
        server: { label: '带域名的服务器', hint: '公网可达，HTTPS，使用你自己的域名。' },
      },
      method: '方式',
      methodNative: '原生（推荐）',
      methodDocker: 'Docker',
      port: '端口',
      lanAccess: '允许局域网内的其他设备访问',
      lanPlaceholder: '本机的局域网 IP，例如 192.168.1.50',
      domain: '你的域名',
      reverseProxy: '反向代理（HTTPS）',
      proxyOwn: '我自己已有',
      fixedKey: '设置固定加密密钥（高级：请做好备份）',
      generate: '生成',
      copy: '复制',
      copied: '已复制',
      copyAria: '复制到剪贴板',
      blockRun: '运行',
      blockStart: '启动',
      blockInstall: '安装',
      dockerWarn: {
        title: '请注意：官方 Docker 镜像暂未发布。',
        beforeImage: '这些命令会拉取 ',
        afterImage: '，该镜像目前未在仓库公开，因此命令会失败并报 ',
        or: ' 或 ',
        beforeLink: '。在镜像发布之前，请使用',
        link: '原生安装',
        afterLink: '（它在本地构建，不需要镜像），或者自己从仓库克隆并构建镜像。',
      },
      dockerKeynote:
        '<strong>保管好你的加密密钥。</strong>密钥存放在 <code>hivekeep-data</code> 卷内。如果你删除或重建该卷而没有保留密钥（或没有通过上方的高级开关固定一个 <code>ENCRYPTION_KEY</code>），保险库中的所有机密都将无法恢复。',
      composeKeynote:
        '<strong>保管好你的加密密钥。</strong>它存放在 <code>hivekeep-data</code> 卷里。重建该卷而不保留密钥（或没有在 <code>.env</code> 中设置固定的 <code>ENCRYPTION_KEY</code>），所有已存储的机密都将无法恢复。',
      dockerRecover: {
        head: '如果命令失败',
        port: '<code>port is already allocated</code>：端口 {port} 已被占用。修改上方的端口字段，再复制新命令。',
        manifest: {
          before: '官方镜像暂未发布。请改用',
          link: '原生安装',
          after: '，或者在本地自行构建。',
        },
        daemon:
          '<code>Cannot connect to the Docker daemon</code>：Docker 没有在运行。启动 Docker Desktop，或在 Linux 上运行 <code>sudo systemctl start docker</code>。',
      },
      nativeKeynote:
        '<strong>加密密钥已自动为你处理。</strong>安装器会自动生成密钥并保存在 <code>$DATA_DIR/.encryption-key</code>，让你的机密在重启后依然可用。请把该文件和数据库一起备份。（如果你更想自己管理，可通过上方的高级开关固定一个 <code>ENCRYPTION_KEY</code>。）',
      nativeRecover: {
        head: '如果安装失败',
        port: '<code>port already in use</code> / <code>EADDRINUSE</code>：端口 {port} 已被占用。修改上方的端口字段后重新运行。',
        windows:
          '<strong>Windows</strong>：安装器仅支持 Linux 和 macOS。请在 <strong>WSL2</strong> 中运行，或使用 Docker Desktop。',
        network:
          '<strong>下载或克隆卡住</strong>：请确认机器能通过 HTTPS 访问 <code>github.com</code> 和 <code>bun.sh</code>（可能被代理拦截）。',
      },
      proxyCaddy:
        "Caddy 会自动处理 HTTPS（Let's Encrypt）。把这段配置放进你的 <code>Caddyfile</code>，然后运行 <code>caddy run</code>。",
      proxyNginx: '一个反向代理到 Hivekeep 的 nginx server 配置块，再用 certbot 配好 HTTPS。',
      proxyOwnNote:
        '把你的反向代理指向 <code>http://localhost:{port}</code>，确认已设置 <code>PUBLIC_URL={url}</code>（上面已经设好），并在 <code>/api/sse</code> 上关闭响应缓冲，让服务器推送事件顺畅流过。',
      foot: '在浏览器中打开 <code>{url}</code>。Queenie 会引导你完成其余步骤（管理员账号、第一个 AI 服务商、第一批智能体）。没有任何配置文件需要编辑。',
      envComments: {
        publicUrl: '# 公开 URL：用于邀请链接、webhook、OAuth 回调和 CORS。',
        key1: '# 加密密钥（AES-256-GCM，64 位十六进制字符）。留空则自动生成',
        key2: '# 并存放在数据卷内。自行设置的好处是便于备份：',
        key3: '# 一旦丢失，保险库中的所有机密都将无法恢复。',
      },
      nginxComments: {
        sse: '# SSE：事件流式传输，不做缓冲',
        https: '# 然后添加 HTTPS：  sudo certbot --nginx -d {host}',
      },
    },
  },

  pluginsPage: {
    kicker: '插件市场',
    heading: '插件，直接来自 npm。',
    sub: '这份列表自动来自 npm：所有带 <code>hivekeep-plugin</code> 标签的包都会出现在这里。在应用内市场一键安装，无需终端。',
    count: '{count} 个插件，还在增加',
    by: '作者：{author}',
    downloads: '{count} 次下载/月',
    updated: '更新于 {date}',
    viewNpm: 'npm',
    viewGithub: 'GitHub',
    publishHeading: '发布你自己的插件。',
    publishText: '插件可以添加<b>服务商、频道、工具和钩子</b>。自己构建一个（或让智能体来写），以 <code>hivekeep-plugin</code> 关键词发布到 npm，它就会自动出现在这里和应用内市场。',
    publishCta: '阅读插件开发指南',
  },

  components: {
    marquee: {
      kicker: '迷你应用 · 由你的智能体打造',
      heading: '开口要一个应用，就得到一个应用。',
      sub: '这些是智能体在 Hivekeep 内部构建并托管的真实网页应用：自带主题、可安装，需要时还能接入你的工具和 API。下面的一切，一句话就能得到。',
      note: '示意性预览。智能体会按需构建、美化和改进它们：<b>「加个图表」</b>只是一条消息，不是一张工单。',
    },
    providers: {
      browseAll: '查看全部插件',
      kicker: '服务商与插件',
      heading: '接入任意服务商，也能自己添加。',
      intro: '这些服务商已内置于所有能力。每个服务商只需一份配置，能力自动检测（一个 OpenAI 密钥同时点亮 LLM、图像、嵌入和语音）。需要别的？用插件添加。',
      subCallout: '<b>已经在订阅 Claude 或 ChatGPT？</b>直接用你的 <b>Claude Pro/Max</b> 或 <b>ChatGPT</b> 订阅登录：你的智能体就跑在上面，无需 API 密钥。',
      groupLlm: '语言模型',
      groupImage: '图像生成',
      groupSearch: '网页搜索',
      groupSpeech: '语音 (STT / TTS)',
      groupEmbeddings: '嵌入',
      groupAccounts: '关联账户',
      plugNote: '没看到你用的？从 npm 安装插件（任何带 <code>hivekeep-plugin</code> 标签的包），直接在应用内市场完成，或者让智能体写一个。插件可以添加<b>服务商、频道、工具和钩子</b>。几个真实例子：',
      tagChannel: '频道',
      tagLlm: 'LLM 服务商',
      tagImageLlm: '图像 / LLM 服务商',
      twilioDesc: '通过 Twilio REST API 和 Webhook 收发<b>短信</b>。一个真正的频道适配器。',
      mistralDesc: '将 <b>Mistral AI</b> 添加为服务商：支持工具调用、视觉和流式输出的对话模型。',
      replicateDesc: '带来 <b>Replicate 托管的模型</b>：图像 (Flux)、LLM (Llama 3、Mixtral) 和嵌入。',
      viewGithub: '在 GitHub 上查看',
    },
    agentDemo: {
      rosterTitle: '// 你的智能体',
      active: '{count} 个活跃',
      seeInAction: '看 {name} 的实际演示',
      demoTag: '演示',
      close: '关闭',
      replay: '重新播放',
      placeholder: '给 {name} 发消息…',
      note: '这是按脚本演示的预览，真实版本运行在你自己的服务器上。',
      statusOnline: '在线',
      statusWorking: '工作中',
      statusIdle: '空闲',
    },
    queenieDemo: {
      cap: '图 5 · Queenie 新手引导',
      liveDemo: '实时演示',
      online: '在线',
      role: '你的配置向导 · 让蜂巢运转起来',
      placeholder: '给 Queenie 发消息…',
    },
    domains: {
      Queenie: '配置与引导',
      Atlas: 'DevOps 与基础设施',
      Forge: '开发与代码',
      Inbox: '邮件与日历',
      Sentinel: '安全与渗透测试',
      Prism: '数据与 BI',
      Ledger: '财务与预算',
      Quill: '写作与文案',
      Sage: '调研与归纳',
      Pixel: 'UI/UX 设计',
      Beacon: '新闻与技术雷达',
      Nest: '家庭自动化',
      Compass: '旅行规划',
      Vitals: '健康与健身',
      Cuisine: '食谱与三餐',
      Tutor: '学习与辅导',
      Sprout: '园艺与植物',
      Lexicon: '翻译与本地化',
      Archive: '文档与整理',
      Pulse: '社交与社区',
    },
  },
}

export default dict
