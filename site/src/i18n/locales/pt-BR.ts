import en from './en'

const dict: typeof en = {
  meta: {
    plugins: {
      title: 'Plugins',
      description: 'Explore todos os plugins do Hivekeep publicados no npm: provedores, canais, ferramentas e hooks, instaláveis com um clique no marketplace integrado.',
    },
    home: {
      title: 'Hivekeep · Seu time de IA. Na sua casa.',
      description:
        'Um time de agentes de IA self-hosted que lembram, colaboram e constroem as próprias ferramentas. Um container, zero infraestrutura externa. Seu time de IA, na sua casa.',
    },
    install: {
      title: 'Instale o Hivekeep',
      description:
        'Instale o Hivekeep do seu jeito: Docker para experimentar, ou instalação nativa para dar aos seus agentes um lar de verdade. Gere o comando exato para o seu setup.',
    },
  },

  nav: {
    plugins: 'Plugins',
    features: 'Recursos',
    household: 'A casa',
    why: 'Por que o Hivekeep',
    docs: 'Docs',
    github: 'GitHub ↗',
    getStarted: 'Comece agora',
    configure: 'Configurar',
  },

  footer: {
    line: 'Open-source · MIT · Feito com Bun · © 2026',
  },

  languages: {
    kicker: 'Multilíngue',
    heading: 'Fala a sua língua.',
    p: 'A interface vem em 10 idiomas, e seus agentes não param por aí: eles respondem no idioma que você falar (mais de 40), independente do idioma da interface.',
  },

  home: {
    hero: {
      meta: 'self-hosted · MIT',
      kicker: 'Uma colmeia de agentes autônomos',
      h1a: 'Seu time de IA.',
      h1b: 'Na sua casa.',
      sub: 'Um time de agentes que <b>lembram</b>, <b>colaboram</b> e <b>constroem as próprias ferramentas</b>, rodando inteiramente no seu servidor. Não é um chatbot. É uma casa cheia de especialistas que funciona como uma colmeia.',
      colophon: {
        runsOnK: 'Roda em',
        runsOnV: 'um container',
        infraK: 'Infra externa',
        infraV: 'nenhuma',
        setupK: 'Configurado por',
        setupV: 'uma conversa',
        channelsK: 'Canais',
        channelsV: '6 nativos',
      },
      ctaStart: 'Comece em 2 minutos',
      ctaDemo: 'Veja a demo',
      everywhere: 'em todo lugar:',
      webPwa: 'Web · PWA',
    },

    health: {
      kicker: 'ao vivo do GitHub',
      latestRelease: 'última versão',
      ciPrefix: 'CI',
      ciPassing: 'passando',
      ciFailing: 'falhando',
      mainBranch: 'branch main',
      stars: 'estrelas',
      openIssue: 'issue aberta',
      openIssues: 'issues abertas',
      lastCommit: 'último commit',
      contributor: 'contribuidor',
      contributors: 'contribuidores',
    },

    video: {
      kicker: 'Veja em ação',
      heading: 'Do zero ao seu próprio time com um comando.',
      sub: 'Um container. Depois a Queenie assume: provedores, avatares, um time completo, e seus agentes começam a construir para você.',
    },

    s1memory: {
      stage: 'Persistente',
      heading: 'Eles nunca esquecem você.',
      p1: 'Nada de "nova conversa". Uma sessão contínua e uma memória híbrida que constrói contexto ao longo de meses. Nada é apagado: turnos antigos são resumidos, nunca jogados fora.',
      p2: 'Um agente passa o trabalho para outro, ou dispara um enxame de subagentes para ir mais rápido. A colônia compartilha um único histórico e uma única agenda de contatos.',
      tagSession: 'sessão contínua',
      tagHandoff: 'passagem entre agentes',
      figCap: 'Fig. 1 · recall("orçamento do mercado")',
      figTag: 'memória',
      card1: {
        cat: 'decisão',
        topic: 'orçamento',
        text: 'Orçamento mensal de mercado definido em R$ 600, com a meta de cortar gastos desnecessários.',
      },
      card2: {
        cat: 'preferência',
        topic: 'compras',
        text: 'Prefere comprar itens básicos de marca própria e cozinhar em lote nos fins de semana.',
      },
    },

    s2sovereign: {
      stage: 'Soberano',
      heading: 'Um container. Nada sai do seu servidor.',
      p1: 'Sem Postgres, Redis, Mongo nem message broker. Bun e SQLite em um único binário. Seus dados, suas chaves, sua máquina.',
      p2: 'Os segredos vivem em um cofre criptografado. Os agentes referenciam uma chave do cofre para acessar um serviço; eles <b>nunca leem o valor</b>, então ele <b>nunca chega ao LLM</b>.',
      termComment: '# depois abra o navegador. A Queenie faz o resto.',
      specs: {
        footprintK: 'Footprint',
        footprintV: '1 processo · 1 arquivo SQLite',
        infraK: 'Infra externa',
        infraV: 'nenhuma',
        secretsK: 'Segredos',
        secretsV: 'cofre AES-256-GCM, só por referência',
        dataK: 'Dados e chaves',
        dataV: 'seus, no seu hardware',
      },
    },

    s3extensible: {
      stage: 'Autoevolutivo',
      heading: 'Seus agentes estendem a plataforma sozinhos.',
      shotAlt: 'Ferramenta de clima renderizada como um card temático na conversa',
      p1: 'Os agentes escrevem ferramentas na linguagem que quiserem, com as próprias dependências, mais um renderer que mostra o resultado como um <b>card temático, não JSON cru</b>. Eles constroem mini-apps completos (dashboards, painéis de controle) dentro do Hivekeep e ainda publicam plugins NPM.',
      p2: 'Delimite cada agente com <b>toolboxes</b>: um agente focado vê só as ferramentas de que precisa, o que o mantém afiado e deixa modelos mais leves darem conta do trabalho.',
      tagCustomTools: 'ferramentas customizadas',
      tagMiniApps: 'mini-apps',
      tagNpm: 'plugins NPM',
      tagMcp: 'MCP',
      tagToolboxes: 'toolboxes',
    },

    s4channels: {
      stage: 'Em todo lugar',
      heading: 'Uma única caixa de entrada para o time inteiro.',
      p1: 'Fale com qualquer agente pelos apps de mensagem que você já usa. Fora da alçada dele? O agente na linha <b>encaminha seu pedido ao especialista certo</b> e retransmite a resposta, ou, se você pedir, <b>passa o canal adiante</b> em tempo real. Sem comandos, sem trocar de app.',
      shotAlt: 'Um pedido de casa inteligente enviado ao agente errado, encaminhado ao especialista responsável, que apaga as luzes',
    },

    s5pocket: {
      stage: 'Mobile',
      heading: 'A colmeia inteira, no seu bolso.',
      p1: 'O Hivekeep é um app de verdade no seu celular: instale <b>direto do navegador</b> (sem loja de apps, sem conta com ninguém, nada extra para subir). Tela cheia, um ícone na sua tela inicial e <b>badges de não lidas</b> que funcionam de verdade.',
      p2: 'E é a <b>mesma sessão ao vivo</b> do desktop: uma resposta que chega na sua mesa já está no seu celular. Responda por <b>voz</b>, mande fotos, aprove o plano de um agente direto do sofá.',
      tagPwa: 'PWA instalável',
      tagDesktopMobile: 'desktop + mobile',
      tagBadges: 'badges de não lidas',
      tagVoice: 'voz para falar e ouvir',
      phone: {
        aria: 'Hivekeep rodando como app instalado em um celular',
        online: 'online',
        userBubble: 'Indo pra casa, deixa tudo aconchegante 🛋️',
        tool1Name: 'Ajustar aquecimento',
        tool1Detail: ' · sala → 21.5°',
        tool2Name: 'Cena',
        tool2Detail: ' · Noite',
        agentBubble: 'Aquecedor ligado, luzes no modo <strong>Noite</strong>. O trânsito indica 18 min. Quer que eu preaqueça o forno também?',
        inputPlaceholder: 'Mensagem para Nest…',
      },
      chipInstallB: 'Instale do navegador',
      chipInstallI: 'sem loja de apps',
      chipBadgesB: 'Badges de não lidas',
      chipBadgesI: 'na sua tela inicial',
      chipSyncB: 'Sincronizado com o desktop',
      chipSyncI: 'uma sessão ao vivo',
    },

    s6transparency: {
      stage: 'Transparente',
      heading: 'Sem caixa-preta. Sem sustos na conta.',
      p1: 'Veja exatamente o que vai para o modelo: o system prompt destrinchado bloco por bloco, o custo de tokens <b>por agente e por modelo</b>, e a divisão read / write / fresh do cache de prompt com sua taxa de acerto. O Hivekeep é incomumente honesto sobre o que envia e quanto gasta, com qualquer provedor.',
      tagCost: 'custo de tokens por agente',
      tagPreview: 'preview do contexto',
      figCap: 'Fig. 4 · visualizador de contexto',
      figTag: 'tokens',
      barTools: 'Ferramentas',
      barMemory: 'Memória',
      barIdentity: 'Identidade',
      barChannels: 'Canais',
      cacheTitle: 'cache de prompt · aquecido · faltam 4:12',
      cacheHit: '72% de acerto',
      legendRead: 'read 9.1k',
      legendWrite: 'write 1.2k',
      legendFresh: 'fresh 2.4k',
    },

    s7setup: {
      stage: 'Setup',
      heading: 'A configuração é uma conversa, não um arquivo YAML.',
      p1: 'A Queenie, sua agente de configuração, conecta seus provedores, protege seus segredos e cria seus primeiros agentes conversando com você. E ela fica por perto para sempre, pronta para adicionar um agente ou plugar um novo provedor a qualquer momento.',
      tagSecure: 'entrada segura → cofre',
      tagGenerates: 'gera agentes para você',
    },

    s8household: {
      stage: 'Exemplos',
      heading: 'Monte uma casa para a sua vida.',
      p1: 'O Hivekeep vem com um agente: a <b>Queenie</b>, sua guia de configuração. O resto você cria, ou simplesmente pede para a Queenie montar para você. Cada um ganha nome, domínio, memória, ferramentas e um avatar gerado.',
      p2: 'Os avatares vêm no <b>estilo de arte padrão</b> do Hivekeep, então uma colmeia recém-criada já parece um conjunto. Quer um visual só seu? Defina um <b>estilo de avatar customizado</b> uma vez, pixel art, aquarela, a sua própria marca, e cada agente é regenerado nele, mantendo o time inteiro no mesmo tema.',
      examplesNote: 'Alguns exemplos do que as pessoas constroem →',
      builtIn: 'nativo',
      eg: 'ex.',
    },

    morefx: {
      kicker: 'Por baixo do capô',
      heading: 'E mais {count} recursos.',
      sub: 'Tudo abaixo já vem na caixa: sem add-ons, sem planos pagos.',
      categories: [
        {
          label: 'Agentes e colaboração',
          icon: 'users',
          cards: [
            {
              title: 'Agentes falam com agentes',
              blurb: 'Seus especialistas trocam mensagens com padrões de <b>request/reply</b>: pergunte a um agente e veja-o consultar outro por conta própria.',
              icon: 'messages-square',
            },
            {
              title: 'Delegação a subagentes',
              blurb: 'Os agentes disparam subagentes efêmeros para o trabalho pesado (<b>bloqueante ou paralelo</b>), com limites de concorrência e relatórios limpos na volta.',
              icon: 'git-branch',
            },
            {
              title: 'Modo batedor',
              blurb: 'Delegue pesquisas somente leitura a um <b>modelo barato e rápido</b> e receba um resumo de volta sem queimar tokens do modelo top de linha.',
              icon: 'binoculars',
            },
            {
              title: 'CRM embutido',
              blurb: 'Os agentes mantêm uma agenda de contatos preenchida automaticamente, com notas e preferências, mais sincronização somente leitura com <b>iCloud e CardDAV</b>.',
              icon: 'users',
            },
          ],
        },
        {
          label: 'Automação',
          icon: 'workflow',
          cards: [
            {
              title: 'Crons que aprendem',
              blurb: 'Jobs agendados disparam agentes em um cron, mantêm um <b>diário de execuções</b> e salvam aprendizados para melhorar cada execução futura.',
              icon: 'calendar-clock',
            },
            {
              title: 'Webhooks de entrada',
              blurb: 'Qualquer evento HTTP pode acordar um agente, com <b>filtragem de payload</b> (dot-path ou regex), rate limits e log de requisições.',
              icon: 'webhook',
            },
            {
              title: 'Gatilhos de e-mail',
              blurb: 'E-mails recebidos que batem com suas regras acordam automaticamente o agente certo, na conversa dele ou em uma <b>tarefa isolada</b>.',
              icon: 'mail-check',
            },
            {
              title: 'Despertadores',
              blurb: 'Os agentes agendam o próprio trabalho futuro (<b>"me acorde em 2 horas"</b>) para que follow-ups e lembretes realmente aconteçam.',
              icon: 'alarm-clock',
            },
            {
              title: 'Kanban tocado por agentes',
              blurb: 'Organize o trabalho em projetos e tickets, depois <b>atribua tickets a agentes</b> que os executam e reportam de volta em comentários.',
              icon: 'kanban',
            },
          ],
        },
        {
          label: 'Memória e contexto',
          icon: 'brain-circuit',
          cards: [
            {
              title: 'Uma conversa sem fim',
              blurb: 'Sem botão de "novo chat": as mensagens antigas são compactadas em <b>resumos datados</b> enquanto as originais ficam seguras no banco de dados.',
              icon: 'infinity',
            },
            {
              title: 'Memória que se limpa sozinha',
              blurb: 'As memórias são consolidadas, repontuadas pelo uso, e as obsoletas são podadas, então a recuperação continua <b>afiada, sem virar entulho</b>.',
              icon: 'brain',
            },
            {
              title: 'Bases de conhecimento',
              blurb: 'Envie documentos uma vez; os trechos relevantes <b>aparecem automaticamente</b> no contexto sempre que o assunto surgir.',
              icon: 'book-open',
            },
            {
              title: 'Conhecimento de projeto',
              blurb: 'Cada projeto guarda fatos, decisões e pegadinhas selecionados a dedo: as <b>entradas fixadas</b> acompanham cada turno do agente.',
              icon: 'notebook-pen',
            },
            {
              title: 'Passado pesquisável',
              blurb: 'Os agentes buscam em todo o próprio histórico com fusão de ranking <b>semântica + texto completo</b>, então nada do que foi dito se perde de verdade.',
              icon: 'history',
            },
          ],
        },
        {
          label: 'Mundo conectado',
          icon: 'globe',
          cards: [
            {
              title: 'E-mail, resolvido',
              blurb: 'Leia, busque e envie pelo <b>Gmail, Outlook, iCloud e IMAP</b>, com um modo de aprovação para os e-mails enviados.',
              icon: 'mail',
            },
            {
              title: 'Controle da agenda',
              blurb: 'Os agentes criam, atualizam e buscam eventos em agendas do <b>Google, Outlook e CalDAV</b> em seu nome.',
              icon: 'calendar-days',
            },
            {
              title: 'Automação de navegador de verdade',
              blurb: 'Os agentes pilotam um <b>navegador com estado</b> (fazem login, preenchem formulários, clicam, tiram screenshots) e salvam as sessões para a próxima vez.',
              icon: 'mouse-pointer-click',
            },
            {
              title: 'Busca e leitura na web',
              blurb: 'Backends de busca plugáveis (<b>Brave, Tavily, SerpAPI, Perplexity</b>), mais captura de páginas, extração de links e screenshots.',
              icon: 'globe',
            },
            {
              title: 'Voz para falar e ouvir',
              blurb: 'Speech-to-text e <b>text-to-speech</b> por qualquer provedor configurado: fale com seus agentes e ouça as respostas.',
              icon: 'mic',
            },
          ],
        },
        {
          label: 'Controle e confiança',
          icon: 'shield',
          cards: [
            {
              title: 'Cofre criptografado',
              blurb: 'Segredos guardados com <b>AES-256-GCM</b>, nunca injetados em prompts: os agentes só os acessam por uma ferramenta com escopo.',
              icon: 'key-round',
            },
            {
              title: 'Segredos não passam pelo LLM',
              blurb: 'As chaves são digitadas em <b>popups seguros</b> que ignoram o modelo por completo, e valores vazados podem ser mascarados retroativamente.',
              icon: 'shield-check',
            },
            {
              title: 'Humano no circuito',
              blurb: 'Os agentes pausam e perguntam antes de agir: prompts bloqueantes, <b>etapas de aprovação</b>, até passagem de captcha no meio da automação.',
              icon: 'hand',
            },
            {
              title: 'Casa compartilhada',
              blurb: 'Convide a família ou o time para uma única instância: todos compartilham os agentes, e os agentes <b>sabem quem está falando</b>.',
              icon: 'users-round',
            },
            {
              title: 'Rebobinar e exportar',
              blurb: 'Apague mensagens, <b>rebobine</b> uma conversa até qualquer ponto, ou exporte tudo como Markdown ou JSON. Seu histórico, sua decisão.',
              icon: 'undo-2',
            },
          ],
        },
        {
          label: 'Experiência',
          icon: 'sparkles',
          cards: [
            {
              title: '18 paletas de cores',
              blurb: 'De Aurora a Citrus: <b>18 paletas</b> com modos claro, escuro e de contraste suave, a um clique de distância.',
              icon: 'palette',
            },
            {
              title: 'Instale em qualquer lugar',
              blurb: 'Um <b>PWA</b> completo: instale no desktop ou no celular, receba badges de não lidas e fique sincronizado entre dispositivos em tempo real.',
              icon: 'smartphone',
            },
            {
              title: 'Sessões rápidas',
              blurb: 'Conversas paralelas efêmeras com <b>troca de modelo por sessão</b>: experimente à vontade, depois salve o que prestou como memórias.',
              icon: 'zap',
            },
            {
              title: 'Controles por mensagem',
              blurb: 'Troque o modelo e o <b>esforço de raciocínio</b> para uma única mensagem, direto do campo de mensagem.',
              icon: 'sliders-horizontal',
            },
            {
              title: 'Navegador de arquivos do workspace',
              blurb: 'Navegue, edite e compartilhe cada arquivo que seus agentes produzem: <b>abas, detecção de conflitos</b>, arrastar e soltar e caminhos clicáveis no chat.',
              icon: 'folder',
            },
            {
              title: 'Imagens e avatares',
              blurb: 'Os agentes <b>geram e editam imagens</b> sob demanda, incluindo avatares consistentes e estilizados para a equipe inteira.',
              icon: 'image',
            },
          ],
        },
      ],
    },

    why: {
      kicker: 'Por que o Hivekeep',
      heading: 'Lado a lado com os projetos mais próximos.',
      intro:
        'Assistentes de IA self-hosted como o <b>OpenClaw</b> e o <b>Hermes</b> são excelentes: eles também mandam bem em memória, alcance omnichannel e self-hosting. Onde o Hivekeep sai na frente é no <b>time</b>, na <b>interface polida de produto</b> e na <b>transparência</b>.',
      rows: [
        'Self-hosted, seus dados',
        'Memória persistente',
        'Omnichannel nativo',
        'Contas conectadas (e-mail, agenda)',
        'Agentes constroem as próprias ferramentas / skills',
        'Tarefas agendadas (cron)',
        'Um time de agentes que colaboram',
        'Web app polido (PWA)',
        'Chamadas de ferramenta renderizadas (UI, não JSON)',
        'Mini-apps e projetos (Kanban)',
        'Configuração por conversa (sem CLI)',
        'Segredos nunca enviados ao LLM',
        'Transparência de tokens e contexto',
      ],
      legend: '✓ nativo · ✕ na prática não · o resto é parcial ou incerto. Avaliações de boa-fé a partir de docs públicas.',
    },

    getstarted: {
      kicker: 'Comece agora',
      heading: 'Coloque seu time para rodar em dois minutos.',
      p: 'Cole um comando na sua máquina Linux ou macOS. Ele instala tudo e abre no seu navegador, onde a <b>Queenie</b> guia você pelo resto.',
      recTag: 'O jeito mais simples de instalar',
      needCustom: 'Precisa de uma porta customizada, do seu próprio domínio ou de Docker?',
      seeAll: 'Ver todas as opções de instalação',
      installBtn: 'Instalar o Hivekeep',
      starBtn: 'Dê uma estrela no GitHub',
      copyAria: 'Copiar comando',
    },
  },

  install: {
    intro: {
      kicker: 'Instalação',
      heading: 'Coloque o Hivekeep no ar.',
      p: 'Um comando faz tudo. Quando estiver no ar, a <b>Queenie</b> configura o resto conversando com você, então não há arquivos de config para editar.',
    },

    rec: {
      tag: 'Recomendado · o jeito mais simples',
      heading: 'Cole uma linha. Só isso.',
      p: 'Rode isto em um terminal na sua máquina Linux ou macOS. Ele instala tudo para você.',
      copyAria: 'Copiar comando de instalação',
      copy: 'Copiar',
      copied: 'Copiado',
      then: 'Quando terminar, abra no navegador o link que ele imprime. <b>A Queenie faz o resto.</b>',
    },

    configure: {
      kicker: 'Opcional',
      heading: 'Quer uma porta customizada, um domínio ou Docker?',
      p: 'Pule esta parte se a linha única acima resolve para você. Caso contrário, responda algumas perguntas e geramos o comando exato para o seu setup.',
    },

    more: {
      label: 'Avançado e outras opções',
      hint: 'Requisitos, e Docker vs nativo vs código-fonte',
    },

    prereqs: {
      kicker: 'Antes de começar',
      heading: 'O que a linha única precisa.',
      sub: 'A maioria das máquinas já tem tudo isso.',
      items: [
        {
          icon: 'lucide:shield',
          title: 'Você pode rodar sudo',
          desc: 'O instalador precisa dele para instalar pacotes de sistema que faltarem (git, curl, unzip).',
        },
        {
          icon: 'lucide:hard-drive',
          title: 'Uns 500 MB livres em disco',
          desc: 'Espaço para clonar e compilar. Com 1 GB ou mais fica confortável.',
        },
        {
          icon: 'lucide:cpu',
          title: 'Uma máquina 64 bits',
          desc: 'x86_64 ou ARM64. 32 bits (Raspberry Pi mais antigos) não é suportado.',
        },
        {
          icon: 'lucide:globe',
          title: 'HTTPS de saída',
          desc: 'Ele baixa de github.com e bun.sh, então esses endereços precisam estar acessíveis.',
        },
        {
          icon: 'lucide:key-round',
          title: 'openssl presente',
          desc: 'Usado para gerar as chaves. Vem com praticamente todo Linux e macOS.',
        },
      ],
      windows:
        '<b>No Windows?</b> O instalador nativo não roda direto no Windows. Use o <b>WSL2</b> (rode a linha única dentro da sua distro Linux) ou o <b>Docker Desktop</b>.',
    },

    compare: {
      kicker: 'Compare',
      heading: 'Nativo, Docker ou do código-fonte?',
      sub: 'Os três rodam exatamente o mesmo app. A diferença está em como ele vive na máquina.',
    },

    methods: [
      {
        tag: 'Recomendado',
        name: 'Nativo (install.sh)',
        pick: 'Escolha este se você só quer que funcione. Um comando, na sua própria máquina Linux ou macOS.',
        points: [
          ['y', 'Um comando, compila localmente, sem imagem para publicar ou baixar'],
          ['y', 'Salva sua chave de criptografia automaticamente, os segredos persistem'],
          ['y', 'Roda como serviço (systemd / launchd), atualização automática com rollback'],
          ['y', 'Os agentes são donos da máquina: instalam ferramentas e dependências, acesso direto ao hardware'],
          ['n', 'Modifica o sistema host (de propósito)'],
          ['n', 'Só Linux e macOS (Windows via WSL2)'],
        ],
      },
      {
        tag: 'Container',
        name: 'Docker',
        pick: 'Escolha este se você já vive no Docker e quer um appliance limpo e isolado.',
        points: [
          ['y', 'Totalmente isolado, zero poluição no host'],
          ['y', 'Roda onde o Docker rodar, inclusive no Windows'],
          ['n', 'A imagem publicada ainda não está disponível, prefira o nativo por enquanto'],
          ['n', 'Ferramentas e binários instalados pelos agentes não sobrevivem a um restart'],
          ['n', 'Você precisa persistir o volume de dados ou perde seus segredos'],
        ],
      },
      {
        tag: 'Do código-fonte',
        name: 'Manual',
        pick: 'Escolha este se você quer ler o código, mexer nele ou rodar do seu próprio jeito.',
        points: [
          ['y', 'Controle total: você mesmo clona, compila e roda com Bun'],
          ['y', 'Ideal para quem contribui e desenvolve'],
          ['n', 'Sem serviço, sem atualização automática, você monta isso por conta própria'],
          ['n', 'Bun, build, migrações e chave de criptografia ficam na sua mão'],
        ],
      },
    ],

    configurator: {
      step1: '1 · Como você vai usar?',
      step2: '2 · Configurações',
      step3: '3 · Rode',
      useCases: {
        try: { label: 'Só experimentando', hint: 'Rode nesta máquina, só em localhost. Zero config.' },
        permanent: {
          label: 'Permanente nesta máquina',
          hint: 'Um lar duradouro para seus agentes. Acesso opcional de outros dispositivos.',
        },
        server: { label: 'Servidor com domínio', hint: 'Público, HTTPS, acessível no seu próprio domínio.' },
      },
      method: 'Método',
      methodNative: 'Nativo (recomendado)',
      methodDocker: 'Docker',
      port: 'Porta',
      lanAccess: 'Acesso de outros dispositivos da minha rede',
      lanPlaceholder: 'o IP desta máquina na LAN, ex. 192.168.1.50',
      domain: 'Seu domínio',
      reverseProxy: 'Reverse proxy (HTTPS)',
      proxyOwn: 'Já tenho o meu',
      fixedKey: 'Definir uma chave de criptografia fixa (avançado: faça backup dela)',
      generate: 'Gerar',
      copy: 'Copiar',
      copied: 'Copiado',
      copyAria: 'Copiar para a área de transferência',
      blockRun: 'Rodar',
      blockStart: 'Iniciar',
      blockInstall: 'Instalar',
      dockerWarn: {
        title: 'Atenção: a imagem Docker publicada ainda não está disponível.',
        beforeImage: 'Estes comandos baixam ',
        afterImage: ', que no momento não está pública no registry, então eles vão falhar com ',
        or: ' ou ',
        beforeLink: '. Até ela ser publicada, use a ',
        link: 'instalação nativa',
        afterLink: ' (ela compila localmente e dispensa imagem), ou construa a imagem você mesmo a partir de um clone do repositório.',
      },
      dockerKeynote:
        '<strong>Guarde sua chave de criptografia.</strong> A chave fica armazenada dentro do volume <code>hivekeep-data</code>. Se você apagar ou recriar esse volume sem persistir a chave (ou sem fixar uma <code>ENCRYPTION_KEY</code> com o toggle avançado acima), todos os segredos do cofre se tornam irrecuperáveis.',
      composeKeynote:
        '<strong>Guarde sua chave de criptografia.</strong> Ela vive no volume <code>hivekeep-data</code>. Recriar o volume sem persistir a chave (ou sem definir uma <code>ENCRYPTION_KEY</code> fixa no <code>.env</code>) torna todos os segredos armazenados irrecuperáveis.',
      dockerRecover: {
        head: 'Se um comando falhar',
        port: '<code>port is already allocated</code>: a porta {port} está em uso. Mude o campo Porta acima e copie o novo comando.',
        manifest: {
          before: 'a imagem publicada ainda não está disponível. Use a ',
          link: 'instalação nativa',
          after: ' no lugar, ou compile localmente.',
        },
        daemon:
          '<code>Cannot connect to the Docker daemon</code>: o Docker não está rodando. Inicie o Docker Desktop, ou rode <code>sudo systemctl start docker</code> no Linux.',
      },
      nativeKeynote:
        '<strong>Sua chave de criptografia é cuidada para você.</strong> O instalador a gera e salva automaticamente em <code>$DATA_DIR/.encryption-key</code> para que seus segredos sobrevivam a restarts. Faça backup desse arquivo junto com seu banco de dados. (Fixe uma <code>ENCRYPTION_KEY</code> com o toggle avançado acima se preferir gerenciá-la você mesmo.)',
      nativeRecover: {
        head: 'Se a instalação falhar',
        port: '<code>port already in use</code> / <code>EADDRINUSE</code>: a porta {port} está ocupada. Mude o campo Porta acima e rode de novo.',
        windows:
          '<strong>Windows</strong>: o instalador é só para Linux e macOS. Rode-o dentro do <strong>WSL2</strong>, ou use o Docker Desktop.',
        network:
          '<strong>O download ou o clone trava</strong>: confira se a máquina alcança <code>github.com</code> e <code>bun.sh</code> via HTTPS (um proxy pode estar bloqueando).',
      },
      proxyCaddy:
        "O Caddy cuida do HTTPS automaticamente (Let's Encrypt). Coloque isto no seu <code>Caddyfile</code> e rode <code>caddy run</code>.",
      proxyNginx: 'Um server block do nginx fazendo proxy para o Hivekeep, depois o certbot para o HTTPS.',
      proxyOwnNote:
        'Aponte seu reverse proxy para <code>http://localhost:{port}</code>, garanta que <code>PUBLIC_URL={url}</code> esteja definida (já está, acima) e desative o buffering de resposta em <code>/api/sse</code> para que os server-sent events passem em streaming.',
      foot: 'Abra <code>{url}</code> no seu navegador. A Queenie guia você pelo resto (conta de admin, seu primeiro provedor de IA, seus primeiros agentes). Nenhum arquivo de config para editar.',
      envComments: {
        publicUrl: '# URL pública: usada em links de convite, webhooks, callbacks OAuth, CORS.',
        key1: '# Chave de criptografia (AES-256-GCM, 64 caracteres hex). Gerada e guardada',
        key2: '# automaticamente no volume de dados se você deixar isto vazio. Defini-la você',
        key3: '# mesmo permite fazer backup: perdê-la torna todo segredo do cofre irrecuperável.',
      },
      nginxComments: {
        sse: '# SSE: transmite eventos sem buffering',
        https: '# Depois adicione HTTPS:  sudo certbot --nginx -d {host}',
      },
    },
  },

  pluginsPage: {
    kicker: 'Marketplace',
    heading: 'Plugins, direto do npm.',
    sub: 'Esta lista vem automaticamente do npm: todo pacote com a tag <code>hivekeep-plugin</code> aparece aqui. Instale com um clique no marketplace integrado, sem terminal.',
    count: '{count} plugins, e a lista cresce',
    by: 'por {author}',
    downloads: '{count} downloads/mês',
    updated: 'atualizado {date}',
    viewNpm: 'npm',
    viewGithub: 'GitHub',
    publishHeading: 'Publique o seu.',
    publishText: 'Um plugin pode adicionar <b>provedores, canais, ferramentas e hooks</b>. Crie um (ou peça para um agente escrever), publique no npm com a palavra-chave <code>hivekeep-plugin</code> e ele aparece aqui e no marketplace integrado automaticamente.',
    publishCta: 'Ler o guia de plugins',
  },

  components: {
    marquee: {
      kicker: 'Mini-apps · criados pelos seus agentes',
      heading: 'Peça um app. Receba um app.',
      sub: 'Aplicativos web de verdade que seus agentes criam e hospedam dentro do Hivekeep: com o tema da plataforma, instaláveis e conectados às suas ferramentas e APIs quando precisar. Tudo abaixo sai de uma única frase.',
      note: 'Prévias ilustrativas. Os agentes criam, estilizam e melhoram tudo sob demanda: <b>“adicione um gráfico”</b> é uma mensagem, não um ticket.',
    },
    providers: {
      browseAll: 'Ver todos os plugins',
      kicker: 'Provedores e plugins',
      heading: 'Traga qualquer provedor, ou adicione o seu.',
      intro: 'Esses provedores vêm integrados em todas as capacidades. Uma configuração por provedor, e as capacidades são detectadas automaticamente (uma chave da OpenAI ativa de uma vez LLM, imagem, embeddings e voz). Precisa de outro? Adicione com um plugin.',
      subCallout: '<b>Já paga pelo Claude ou ChatGPT?</b> Entre com sua assinatura <b>Claude Pro/Max</b> ou <b>ChatGPT</b>: seus agentes rodam nela, sem chave de API.',
      groupLlm: 'Modelos de linguagem',
      groupImage: 'Geração de imagens',
      groupSearch: 'Busca na web',
      groupSpeech: 'Voz (STT / TTS)',
      groupEmbeddings: 'Embeddings',
      groupAccounts: 'Contas conectadas',
      plugNote: 'Não achou o seu? Instale um plugin do npm (qualquer pacote com a tag <code>hivekeep-plugin</code>) direto do marketplace integrado, ou peça para um agente escrever um. Um plugin pode adicionar <b>provedores, canais, ferramentas e hooks</b>. Alguns reais:',
      tagChannel: 'canal',
      tagLlm: 'provedor LLM',
      tagImageLlm: 'provedor imagem / LLM',
      twilioDesc: 'Envie e receba <b>SMS</b> pela API REST da Twilio e webhooks. Um adaptador de canal de verdade.',
      mistralDesc: 'Adiciona a <b>Mistral AI</b> como provedor: modelos de chat com chamadas de ferramentas, visão e streaming.',
      replicateDesc: 'Traz os <b>modelos hospedados na Replicate</b>: imagem (Flux), LLM (Llama 3, Mixtral) e embeddings.',
      viewGithub: 'Ver no GitHub',
    },
    agentDemo: {
      rosterTitle: '// seus agentes',
      active: '{count} ativos',
      seeInAction: 'Veja {name} em ação',
      demoTag: 'demo',
      close: 'Fechar',
      replay: 'Repetir',
      placeholder: 'Mensagem para {name}…',
      note: 'Esta é uma prévia roteirizada. A versão real roda no seu servidor.',
      statusOnline: 'online',
      statusWorking: 'trabalhando',
      statusIdle: 'ocioso',
    },
    queenieDemo: {
      cap: 'Fig. 5 · Onboarding da Queenie',
      liveDemo: 'demo ao vivo',
      online: 'online',
      role: 'Sua guia de configuração · coloca a colmeia para funcionar',
      placeholder: 'Mensagem para Queenie…',
    },
    domains: {
      Queenie: 'Configuração e onboarding',
      Atlas: 'DevOps e infra',
      Forge: 'Dev e código',
      Inbox: 'E-mail e agenda',
      Sentinel: 'Segurança e pentest',
      Prism: 'Dados e BI',
      Ledger: 'Finanças e orçamento',
      Quill: 'Escrita e copywriting',
      Sage: 'Pesquisa e síntese',
      Pixel: 'Design UI/UX',
      Beacon: 'Notícias e radar tech',
      Nest: 'Automação residencial',
      Compass: 'Planejamento de viagens',
      Vitals: 'Saúde e fitness',
      Cuisine: 'Receitas e refeições',
      Tutor: 'Aprendizado e tutoria',
      Sprout: 'Jardinagem e plantas',
      Lexicon: 'Tradução e localização',
      Archive: 'Documentos e organização',
      Pulse: 'Social e comunidade',
    },
  },
}

export default dict
