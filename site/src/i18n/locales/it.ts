import en from './en'

const dict: typeof en = {
  meta: {
    plugins: {
      title: 'Plugin',
      description: 'Sfoglia tutti i plugin Hivekeep pubblicati su npm: provider, canali, strumenti e hook, installabili con un clic dal marketplace integrato.',
    },
    home: {
      title: 'Hivekeep · Il tuo team di IA. A casa tua.',
      description:
        'Un team self-hosted di agenti IA che ricordano, collaborano e costruiscono i propri strumenti. Un solo container, zero infrastruttura esterna. Il tuo team di IA, a casa tua.',
    },
    install: {
      title: 'Installa Hivekeep',
      description:
        "Installa Hivekeep come preferisci: Docker per provarlo, o un'installazione nativa per dare ai tuoi agenti una vera casa. Genera il comando esatto per la tua configurazione.",
    },
  },

  nav: {
    plugins: 'Plugin',
    features: 'Funzionalità',
    household: 'La famiglia',
    why: 'Perché Hivekeep',
    docs: 'Docs',
    github: 'GitHub ↗',
    getStarted: 'Inizia ora',
    configure: 'Configura',
  },

  footer: {
    line: 'Open source · MIT · Creato con Bun · © 2026',
  },

  languages: {
    kicker: 'Multilingue',
    heading: 'Parla la tua lingua.',
    p: "L'interfaccia è disponibile in 10 lingue, e i tuoi agenti non si fermano lì: rispondono in qualsiasi lingua tu parli (più di 40), indipendentemente dalla lingua dell'interfaccia.",
  },

  home: {
    hero: {
      meta: 'self-hosted · MIT',
      kicker: 'Un alveare di agenti autonomi',
      h1a: 'Il tuo team di IA.',
      h1b: 'A casa tua.',
      sub: 'Un team di agenti che <b>ricordano</b>, <b>collaborano</b> e <b>costruiscono i propri strumenti</b>, interamente sul tuo server. Non un chatbot. Una famiglia di specialisti che lavora come un alveare.',
      colophon: {
        runsOnK: 'Gira su',
        runsOnV: 'un solo container',
        infraK: 'Infrastruttura esterna',
        infraV: 'nessuna',
        setupK: 'Si configura con',
        setupV: 'una conversazione',
        channelsK: 'Canali',
        channelsV: '6 integrati',
      },
      ctaStart: 'Parti in 2 minuti',
      ctaDemo: 'Guarda la demo',
      everywhere: 'ovunque:',
      webPwa: 'Web · PWA',
    },

    health: {
      kicker: 'in diretta da GitHub',
      latestRelease: 'ultima release',
      ciPrefix: 'CI',
      ciPassing: 'passa',
      ciFailing: 'fallisce',
      mainBranch: 'branch main',
      stars: 'stelle',
      openIssue: 'issue aperta',
      openIssues: 'issue aperte',
      lastCommit: 'ultimo commit',
      contributor: 'contributore',
      contributors: 'contributori',
    },

    video: {
      kicker: 'Guardalo in azione',
      heading: 'Da zero al tuo team con un solo comando.',
      sub: 'Un container. Poi entra in gioco Queenie: provider, avatar, un team al completo, e i tuoi agenti iniziano a costruire per te.',
    },

    s1memory: {
      stage: 'Persistente',
      heading: 'Non ti dimenticano mai.',
      p1: 'Niente "nuova conversazione". Una sessione continua e una memoria ibrida che accumula contesto nel corso dei mesi. Nulla viene cancellato: i vecchi messaggi vengono riassunti, mai buttati via.',
      p2: 'Un agente passa il lavoro a un altro, o lancia uno sciame di sub-agenti per andare più veloce. La colonia condivide una sola cronologia e una sola rubrica.',
      tagSession: 'sessione continua',
      tagHandoff: 'passaggio tra agenti',
      figCap: 'Fig. 1 · recall("budget spesa")',
      figTag: 'memoria',
      card1: {
        cat: 'decisione',
        topic: 'budget',
        text: "Budget mensile per la spesa fissato a 600 $, con l'obiettivo di tagliare le spese superflue.",
      },
      card2: {
        cat: 'preferenza',
        topic: 'spesa',
        text: 'Preferisce i prodotti a marchio del supermercato e cucinare in grandi quantità nel weekend.',
      },
    },

    s2sovereign: {
      stage: 'Sovrano',
      heading: 'Un solo container. Nulla esce dal tuo server.',
      p1: 'Niente Postgres, Redis, Mongo o message broker. Bun e SQLite in un unico binario. I tuoi dati, le tue chiavi, la tua macchina.',
      p2: "I segreti vivono in un vault cifrato. Gli agenti usano una chiave del vault per raggiungere un servizio; <b>non ne leggono mai il valore</b>, che quindi <b>non arriva mai all'LLM</b>.",
      termComment: '# poi apri il browser. Al resto pensa Queenie.',
      specs: {
        footprintK: 'Ingombro',
        footprintV: '1 processo · 1 file SQLite',
        infraK: 'Infrastruttura esterna',
        infraV: 'nessuna',
        secretsK: 'Segreti',
        secretsV: 'vault AES-256-GCM, solo per riferimento',
        dataK: 'Dati e chiavi',
        dataV: 'tuoi, sul tuo hardware',
      },
    },

    s3extensible: {
      stage: 'Estensibile',
      heading: 'I tuoi agenti estendono la piattaforma da soli.',
      shotAlt: 'Strumento meteo mostrato come card a tema nella conversazione',
      p1: 'Gli agenti scrivono strumenti nel linguaggio che preferiscono, con le proprie dipendenze, più un renderer che mostra il risultato come <b>card a tema, non JSON grezzo</b>. Costruiscono vere mini-app (dashboard, pannelli di controllo) direttamente dentro Hivekeep, e possono pubblicare plugin NPM.',
      p2: 'Delimita ogni agente con le <b>toolbox</b>: un agente focalizzato vede solo gli strumenti che gli servono, resta lucido e lascia che il lavoro lo facciano modelli più leggeri.',
      tagCustomTools: 'strumenti personalizzati',
      tagMiniApps: 'mini-app',
      tagNpm: 'plugin NPM',
      tagMcp: 'MCP',
      tagToolboxes: 'toolbox',
    },

    s4channels: {
      stage: 'Ovunque',
      heading: 'Una sola inbox per tutto il tuo team.',
      p1: "Parla con ogni agente dalle app di messaggistica che usi già. Richiesta fuori tema? L'agente in linea <b>la passa allo specialista giusto</b> e ti riporta la risposta, oppure, se glielo chiedi, <b>gli cede il canale</b> in tempo reale. Niente comandi, niente cambi di app.",
      shotAlt: "Una richiesta domotica inviata all'agente sbagliato, inoltrata allo specialista responsabile che spegne le luci",
    },

    s5pocket: {
      stage: 'Mobile',
      heading: "Tutto l'alveare, in tasca.",
      p1: "Hivekeep è una vera app sul tuo telefono: installala <b>direttamente dal browser</b> (niente app store, nessun account presso terzi, nulla in più da installare). Schermo intero, un'icona nella home, <b>badge dei non letti</b> che funzionano davvero.",
      p2: 'Ed è la <b>stessa sessione live</b> del desktop: una risposta che arriva alla scrivania è già sul tuo telefono. Rispondi a <b>voce</b>, invia foto, approva il piano di un agente dal divano.',
      tagPwa: 'PWA installabile',
      tagDesktopMobile: 'desktop + mobile',
      tagBadges: 'badge dei non letti',
      tagVoice: 'voce in entrata e in uscita',
      phone: {
        aria: 'Hivekeep in esecuzione come app installata su un telefono',
        online: 'online',
        userBubble: 'Sto tornando a casa, rendila accogliente 🛋️',
        tool1Name: 'Imposta riscaldamento',
        tool1Detail: ' · soggiorno → 21,5°',
        tool2Name: 'Scena',
        tool2Detail: ' · Sera',
        agentBubble: 'Riscaldamento acceso, luci su <strong>Sera</strong>. Il traffico dice 18 min. Preriscaldo anche il forno?',
        inputPlaceholder: 'Scrivi a Nest…',
      },
      chipInstallB: 'Installa dal browser',
      chipInstallI: 'senza app store',
      chipBadgesB: 'Badge dei non letti',
      chipBadgesI: 'nella tua home',
      chipSyncB: 'Sincronizzato col desktop',
      chipSyncI: 'una sola sessione live',
    },

    s6transparency: {
      stage: 'Trasparente',
      heading: 'Nessuna scatola nera. Nessuna sorpresa sui costi.',
      p1: 'Vedi esattamente cosa arriva al modello: il system prompt scomposto blocco per blocco, il costo in token <b>per agente e per modello</b>, e la ripartizione read / write / fresh della prompt cache con il suo hit rate. Hivekeep è insolitamente onesto su cosa invia e cosa spende, con qualsiasi provider.',
      tagCost: 'costo token per agente',
      tagPreview: 'anteprima del contesto',
      figCap: 'Fig. 4 · visualizzatore di contesto',
      figTag: 'token',
      barTools: 'Strumenti',
      barMemory: 'Memoria',
      barIdentity: 'Identità',
      barChannels: 'Canali',
      cacheTitle: 'prompt cache · calda · 4:12 rimanenti',
      cacheHit: '72% di hit',
      legendRead: 'read 9.1k',
      legendWrite: 'write 1.2k',
      legendFresh: 'fresh 2.4k',
    },

    s7setup: {
      stage: 'Setup',
      heading: 'La configurazione è una conversazione, non un file YAML.',
      p1: 'Queenie, il tuo agente di setup, collega i provider, mette al sicuro i tuoi segreti e crea i tuoi primi agenti chiacchierando con te. E resta lì per sempre, pronta ad aggiungere un agente o collegare un nuovo provider in qualsiasi momento.',
      tagSecure: 'input sicuro → vault',
      tagGenerates: 'genera gli agenti per te',
    },

    s8household: {
      stage: 'Esempi',
      heading: 'Costruisci una famiglia su misura per la tua vita.',
      p1: 'Hivekeep arriva con un solo agente: <b>Queenie</b>, la tua guida alla configurazione. Gli altri li crei tu, o chiedi a Queenie di costruirli per te. Ognuno ha il suo nome, il suo dominio, memoria, strumenti e un avatar generato.',
      p2: 'Gli avatar nascono nello <b>stile grafico predefinito</b> di Hivekeep, così un alveare appena nato sembra già un set coordinato. Vuoi un look tutto tuo? Imposta una volta sola uno <b>stile avatar personalizzato</b>, pixel art, acquerello, il tuo brand, e ogni agente si rigenera in quello stile: tutto il team resta in tema.',
      examplesNote: 'Qualche esempio di cosa costruiscono le persone →',
      builtIn: 'integrato',
      eg: 'es.',
    },

    morefx: {
      kicker: 'Sotto il cofano',
      heading: 'E altre {count} funzionalità.',
      sub: 'Tutto quello che vedi qui sotto è incluso: niente add-on, niente piani a pagamento.',
      categories: [
        {
          label: 'Agenti e collaborazione',
          icon: 'users',
          cards: [
            {
              title: 'Gli agenti parlano tra loro',
              blurb: 'I tuoi specialisti si scambiano messaggi con pattern <b>request/reply</b>: chiedi a un agente e guardalo consultare un altro da solo.',
              icon: 'messages-square',
            },
            {
              title: 'Delega ai sub-agenti',
              blurb: 'Gli agenti lanciano sub-agenti effimeri per i lavori pesanti (<b>bloccanti o in parallelo</b>), con limiti di concorrenza e report puliti al ritorno.',
              icon: 'git-branch',
            },
            {
              title: 'Modalità scout',
              blurb: 'Delega le ricerche in sola lettura a un <b>modello economico e veloce</b> e ricevi un riepilogo senza bruciare i token del modello di punta.',
              icon: 'binoculars',
            },
            {
              title: 'CRM integrato',
              blurb: 'Gli agenti mantengono una rubrica auto-popolata con note e preferenze, più la sincronizzazione in sola lettura da <b>iCloud e CardDAV</b>.',
              icon: 'users',
            },
          ],
        },
        {
          label: 'Automazione',
          icon: 'workflow',
          cards: [
            {
              title: 'Cron che imparano',
              blurb: 'I job pianificati lanciano agenti su un cron, tengono un <b>diario delle esecuzioni</b> e salvano ciò che imparano per migliorare ogni run futura.',
              icon: 'calendar-clock',
            },
            {
              title: 'Webhook in entrata',
              blurb: 'Qualsiasi evento HTTP può svegliare un agente, con <b>filtri sul payload</b> (dot-path o regex), rate limit e log delle richieste.',
              icon: 'webhook',
            },
            {
              title: 'Trigger email',
              blurb: "Le mail in arrivo che corrispondono alle tue regole svegliano in automatico l'agente giusto, nella sua conversazione o in un <b>task isolato</b>.",
              icon: 'mail-check',
            },
            {
              title: 'Sveglie programmate',
              blurb: 'Gli agenti si pianificano da soli il lavoro futuro (<b>"svegliami tra 2 ore"</b>), così follow-up e promemoria succedono davvero.',
              icon: 'alarm-clock',
            },
            {
              title: 'Kanban gestito dagli agenti',
              blurb: 'Organizza il lavoro in progetti e ticket, poi <b>assegna i ticket agli agenti</b>, che li eseguono e riferiscono nei commenti.',
              icon: 'kanban',
            },
          ],
        },
        {
          label: 'Memoria e contesto',
          icon: 'brain-circuit',
          cards: [
            {
              title: 'Una conversazione infinita',
              blurb: 'Nessun pulsante "nuova chat": i vecchi messaggi si compattano in <b>riassunti datati</b> mentre gli originali restano al sicuro nel database.',
              icon: 'infinity',
            },
            {
              title: 'Memoria che si pulisce da sola',
              blurb: "I ricordi vengono consolidati, ripesati in base all'uso e potati quando invecchiano: il richiamo resta <b>affilato, non accumulato</b>.",
              icon: 'brain',
            },
            {
              title: 'Basi di conoscenza',
              blurb: "Carica i documenti una volta sola; gli estratti rilevanti <b>emergono da soli</b> nel contesto ogni volta che l'argomento salta fuori.",
              icon: 'book-open',
            },
            {
              title: 'Conoscenza di progetto',
              blurb: "Ogni progetto conserva fatti, decisioni e insidie selezionati: le <b>voci fissate</b> viaggiano in ogni turno dell'agente.",
              icon: 'notebook-pen',
            },
            {
              title: 'Un passato ricercabile',
              blurb: 'Gli agenti cercano in tutta la loro cronologia con rank fusion <b>semantica + full-text</b>: nulla di ciò che è stato detto va mai davvero perso.',
              icon: 'history',
            },
          ],
        },
        {
          label: 'Mondo connesso',
          icon: 'globe',
          cards: [
            {
              title: 'Email sotto controllo',
              blurb: 'Leggi, cerca e invia su <b>Gmail, Outlook, iCloud e IMAP</b>, con una modalità di approvazione sulla posta in uscita.',
              icon: 'mail',
            },
            {
              title: 'Controllo del calendario',
              blurb: 'Gli agenti creano, aggiornano e cercano eventi sui calendari <b>Google, Outlook e CalDAV</b> per conto tuo.',
              icon: 'calendar-days',
            },
            {
              title: 'Automazione browser vera',
              blurb: 'Gli agenti guidano un <b>browser con stato</b> (login, form, click, screenshot) e salvano le sessioni per la prossima volta.',
              icon: 'mouse-pointer-click',
            },
            {
              title: 'Ricerca e lettura web',
              blurb: 'Backend di ricerca intercambiabili (<b>Brave, Tavily, SerpAPI, Perplexity</b>), più recupero di pagine, estrazione di link e screenshot.',
              icon: 'globe',
            },
            {
              title: 'Voce in entrata, voce in uscita',
              blurb: 'Speech-to-text e <b>text-to-speech</b> con qualsiasi provider configurato: parla con i tuoi agenti e ascolta le loro risposte.',
              icon: 'mic',
            },
          ],
        },
        {
          label: 'Controllo e fiducia',
          icon: 'shield',
          cards: [
            {
              title: 'Vault cifrato',
              blurb: 'Segreti conservati con <b>AES-256-GCM</b>, mai iniettati nei prompt: gli agenti li recuperano solo tramite uno strumento dedicato.',
              icon: 'key-round',
            },
            {
              title: "I segreti saltano l'LLM",
              blurb: 'Le chiavi si digitano in <b>popup sicuri</b> che bypassano del tutto il modello, e i valori trapelati si possono oscurare a posteriori.',
              icon: 'shield-check',
            },
            {
              title: 'Human-in-the-loop',
              blurb: "Gli agenti si fermano e chiedono prima di agire: richieste bloccanti, <b>cancelli di approvazione</b>, perfino il passaggio di mano sui captcha a metà automazione.",
              icon: 'hand',
            },
            {
              title: 'Casa condivisa',
              blurb: "Invita famiglia o colleghi su un'unica istanza: gli agenti sono di tutti, e <b>sanno chi sta parlando</b>.",
              icon: 'users-round',
            },
            {
              title: 'Riavvolgi ed esporta',
              blurb: 'Cancella messaggi, <b>riavvolgi</b> una conversazione a qualsiasi punto, o esporta tutto in Markdown o JSON. La cronologia è tua, decidi tu.',
              icon: 'undo-2',
            },
          ],
        },
        {
          label: 'Esperienza',
          icon: 'sparkles',
          cards: [
            {
              title: '18 palette di colori',
              blurb: 'Da Aurora a Citrus: <b>18 palette</b> con modalità chiara, scura e a contrasto morbido, a un click di distanza.',
              icon: 'palette',
            },
            {
              title: 'Installala ovunque',
              blurb: 'Una <b>PWA</b> completa: installala su desktop o telefono, ricevi i badge dei non letti e resta sincronizzato tra i dispositivi in tempo reale.',
              icon: 'smartphone',
            },
            {
              title: 'Sessioni rapide',
              blurb: 'Chat laterali effimere con <b>override del modello per sessione</b>: sperimenta in libertà, poi salva il meglio come ricordi.',
              icon: 'zap',
            },
            {
              title: 'Controlli per messaggio',
              blurb: 'Cambia modello e <b>sforzo di ragionamento</b> per un singolo messaggio, direttamente dal composer.',
              icon: 'sliders-horizontal',
            },
            {
              title: 'File browser del workspace',
              blurb: 'Sfoglia, modifica e condividi ogni file prodotto dai tuoi agenti: <b>schede, rilevamento dei conflitti</b>, drag-and-drop e percorsi cliccabili in chat.',
              icon: 'folder',
            },
            {
              title: 'Immagini e avatar',
              blurb: 'Gli agenti <b>generano e modificano immagini</b> su richiesta, inclusi avatar coerenti e in stile per tutta la squadra.',
              icon: 'image',
            },
          ],
        },
      ],
    },

    why: {
      kicker: 'Perché Hivekeep',
      heading: 'A confronto con i progetti più vicini.',
      intro:
        'Gli assistenti IA self-hosted come <b>OpenClaw</b> e <b>Hermes</b> sono eccellenti: vincono anche loro su memoria, presenza omnicanale e self-hosting. Dove Hivekeep prende il largo è il <b>team</b>, la <b>UI curata da vero prodotto</b> e la <b>trasparenza</b>.',
      rows: [
        'Self-hosted, dati tuoi',
        'Memoria persistente',
        'Omnicanale nativo',
        'Account collegati (mail, calendario)',
        'Gli agenti costruiscono i propri strumenti / skill',
        'Attività pianificate (cron)',
        'Un team di agenti che collaborano',
        'Web app curata (PWA)',
        'Tool call renderizzate (UI, non JSON)',
        'Mini-app e progetti (Kanban)',
        'Setup conversazionale (niente CLI)',
        "Segreti mai inviati all'LLM",
        'Trasparenza su token e contesto',
      ],
      legend: '✓ nativo · ✕ non proprio · il resto è parziale o poco chiaro. Valutazioni fatte al meglio in base alla documentazione pubblica.',
    },

    getstarted: {
      kicker: 'Inizia ora',
      heading: 'Il tuo team operativo in due minuti.',
      p: 'Incolla un comando sulla tua macchina Linux o macOS. Installa tutto, poi si apre nel browser, dove <b>Queenie</b> ti accompagna per il resto.',
      recTag: 'Il modo più semplice di installare',
      needCustom: 'Ti serve una porta personalizzata, il tuo dominio o Docker?',
      seeAll: 'Vedi tutte le opzioni di installazione',
      installBtn: 'Installa Hivekeep',
      starBtn: 'Metti una stella su GitHub',
      copyAria: 'Copia il comando',
    },
  },

  install: {
    intro: {
      kicker: 'Installazione',
      heading: 'Metti in moto Hivekeep.',
      p: 'Un comando fa tutto. Una volta partito, <b>Queenie</b> configura il resto chiacchierando con te: nessun file di configurazione da modificare.',
    },

    rec: {
      tag: 'Consigliato · il modo più semplice',
      heading: 'Incolla una riga. Fine.',
      p: 'Eseguila in un terminale sulla tua macchina Linux o macOS. Installa tutto al posto tuo.',
      copyAria: 'Copia il comando di installazione',
      copy: 'Copia',
      copied: 'Copiato',
      then: 'Quando finisce, apri nel browser il link che stampa. <b>Al resto pensa Queenie.</b>',
    },

    configure: {
      kicker: 'Facoltativo',
      heading: 'Vuoi una porta personalizzata, un dominio o Docker?',
      p: 'Salta questa parte se la riga qui sopra ti basta. Altrimenti rispondi a un paio di domande e generiamo il comando esatto per la tua configurazione.',
    },

    more: {
      label: 'Opzioni avanzate e alternative',
      hint: 'Requisiti, e Docker vs nativo vs da sorgenti',
    },

    prereqs: {
      kicker: 'Prima di iniziare',
      heading: 'Cosa serve al comando di installazione.',
      sub: 'Quasi tutte le macchine hanno già tutto.',
      items: [
        {
          icon: 'lucide:shield',
          title: 'Puoi usare sudo',
          desc: "L'installer ne ha bisogno per installare i pacchetti di sistema mancanti (git, curl, unzip).",
        },
        {
          icon: 'lucide:hard-drive',
          title: 'Circa 500 MB liberi su disco',
          desc: 'Spazio per clonare e compilare. Con 1 GB o più si sta comodi.',
        },
        {
          icon: 'lucide:cpu',
          title: 'Una macchina a 64 bit',
          desc: 'x86_64 o ARM64. Il 32 bit (i Raspberry Pi più vecchi) non è supportato.',
        },
        {
          icon: 'lucide:globe',
          title: 'HTTPS in uscita',
          desc: 'Scarica da github.com e bun.sh, quindi devono essere raggiungibili.',
        },
        {
          icon: 'lucide:key-round',
          title: 'openssl presente',
          desc: 'Serve a generare le chiavi. È incluso in quasi ogni Linux e macOS.',
        },
      ],
      windows:
        "<b>Sei su Windows?</b> L'installer nativo non gira direttamente su Windows. Usa <b>WSL2</b> (esegui il comando dentro la tua distro Linux) o <b>Docker Desktop</b>.",
    },

    compare: {
      kicker: 'Confronto',
      heading: 'Nativo, Docker o da sorgenti?',
      sub: 'Tutti e tre eseguono esattamente la stessa app. Cambia solo il modo in cui vive sulla macchina.',
    },

    methods: [
      {
        tag: 'Consigliato',
        name: 'Nativo (install.sh)',
        pick: 'Scegli questo se vuoi solo che funzioni. Un comando, sulla tua macchina Linux o macOS.',
        points: [
          ['y', 'Un solo comando, compila in locale, nessuna immagine da pubblicare o scaricare'],
          ['y', 'Salva da solo la tua chiave di cifratura, i segreti persistono'],
          ['y', 'Gira come servizio (systemd / launchd), aggiornamenti automatici con rollback'],
          ['y', "Gli agenti sono padroni della macchina: installano strumenti e dipendenze, accesso diretto all'hardware"],
          ['n', 'Modifica il sistema host (per scelta)'],
          ['n', 'Solo Linux e macOS (Windows via WSL2)'],
        ],
      },
      {
        tag: 'Container',
        name: 'Docker',
        pick: "Scegli questo se vivi già in Docker e vuoi un'appliance pulita e isolata.",
        points: [
          ['y', "Completamente isolato, zero impatto sull'host"],
          ['y', 'Gira ovunque giri Docker, Windows compreso'],
          ['n', "L'immagine pubblicata non è ancora disponibile: per ora meglio il nativo"],
          ['n', 'Strumenti e binari installati dagli agenti non sopravvivono a un riavvio'],
          ['n', 'Devi rendere persistente il volume dati o perdi i tuoi segreti'],
        ],
      },
      {
        tag: 'Da sorgenti',
        name: 'Manuale',
        pick: 'Scegli questo se vuoi leggere il codice, metterci mano o eseguirlo a modo tuo.',
        points: [
          ['y', 'Controllo totale: cloni, compili ed esegui con Bun per conto tuo'],
          ['y', 'Ideale per chi contribuisce e per lo sviluppo'],
          ['n', 'Niente servizio, niente auto-update: li configuri tu'],
          ['n', 'Bun, build, migrazioni e chiave di cifratura li gestisci a mano'],
        ],
      },
    ],

    configurator: {
      step1: '1 · Come lo userai?',
      step2: '2 · Impostazioni',
      step3: '3 · Avvialo',
      useCases: {
        try: { label: 'Solo per provarlo', hint: 'Eseguilo su questa macchina, solo localhost. Zero configurazione.' },
        permanent: {
          label: 'Fisso su questa macchina',
          hint: 'Una casa stabile per i tuoi agenti. Accesso opzionale dagli altri dispositivi.',
        },
        server: { label: 'Server con un dominio', hint: 'Pubblico, HTTPS, raggiungibile al tuo dominio.' },
      },
      method: 'Metodo',
      methodNative: 'Nativo (consigliato)',
      methodDocker: 'Docker',
      port: 'Porta',
      lanAccess: 'Accesso dagli altri dispositivi della mia rete',
      lanPlaceholder: "l'IP LAN di questa macchina, es. 192.168.1.50",
      domain: 'Il tuo dominio',
      reverseProxy: 'Reverse proxy (HTTPS)',
      proxyOwn: 'Ne ho già uno mio',
      fixedKey: 'Imposta una chiave di cifratura fissa (avanzato: fanne un backup)',
      generate: 'Genera',
      copy: 'Copia',
      copied: 'Copiato',
      copyAria: 'Copia negli appunti',
      blockRun: 'Esegui',
      blockStart: 'Avvia',
      blockInstall: 'Installa',
      dockerWarn: {
        title: "Attenzione: l'immagine Docker pubblicata non è ancora disponibile.",
        beforeImage: 'Questi comandi scaricano ',
        afterImage: ', che al momento non è pubblica sul registry, quindi falliranno con ',
        or: ' o ',
        beforeLink: ". Finché non viene pubblicata, usa l'",
        link: 'installazione nativa',
        afterLink: " (compila in locale e non richiede immagini), oppure costruisci tu l'immagine da un clone del repo.",
      },
      dockerKeynote:
        "<strong>Conserva la tua chiave di cifratura.</strong> La chiave è salvata dentro il volume <code>hivekeep-data</code>. Se elimini o ricrei quel volume senza preservare la chiave (o senza fissare una <code>ENCRYPTION_KEY</code> con l'opzione avanzata qui sopra), ogni segreto del vault diventa irrecuperabile.",
      composeKeynote:
        '<strong>Conserva la tua chiave di cifratura.</strong> Vive nel volume <code>hivekeep-data</code>. Ricreare il volume senza preservare la chiave (o senza impostare una <code>ENCRYPTION_KEY</code> fissa in <code>.env</code>) rende irrecuperabile ogni segreto salvato.',
      dockerRecover: {
        head: 'Se un comando fallisce',
        port: '<code>port is already allocated</code>: la porta {port} è occupata. Cambia il campo Porta qui sopra e copia il nuovo comando.',
        manifest: {
          before: "l'immagine pubblicata non è ancora disponibile. Usa invece l'",
          link: 'installazione nativa',
          after: ', oppure compila in locale.',
        },
        daemon:
          '<code>Cannot connect to the Docker daemon</code>: Docker non è in esecuzione. Avvia Docker Desktop, o esegui <code>sudo systemctl start docker</code> su Linux.',
      },
      nativeKeynote:
        "<strong>La chiave di cifratura è gestita per te.</strong> L'installer la genera e la salva in automatico in <code>$DATA_DIR/.encryption-key</code>, così i tuoi segreti sopravvivono ai riavvii. Fai il backup di quel file insieme al database. (Se preferisci gestirla tu, fissa una <code>ENCRYPTION_KEY</code> con l'opzione avanzata qui sopra.)",
      nativeRecover: {
        head: "Se l'installazione fallisce",
        port: '<code>port already in use</code> / <code>EADDRINUSE</code>: la porta {port} è occupata. Cambia il campo Porta qui sopra e riesegui.',
        windows:
          "<strong>Windows</strong>: l'installer è solo per Linux e macOS. Eseguilo dentro <strong>WSL2</strong>, o usa Docker Desktop.",
        network:
          '<strong>Download o clone bloccato</strong>: assicurati che la macchina raggiunga <code>github.com</code> e <code>bun.sh</code> via HTTPS (un proxy potrebbe bloccarli).',
      },
      proxyCaddy:
        "Caddy gestisce l'HTTPS in automatico (Let's Encrypt). Metti questo nel tuo <code>Caddyfile</code> ed esegui <code>caddy run</code>.",
      proxyNginx: "Un server block nginx che fa da proxy verso Hivekeep, poi certbot per l'HTTPS.",
      proxyOwnNote:
        'Punta il tuo reverse proxy a <code>http://localhost:{port}</code>, assicurati che <code>PUBLIC_URL={url}</code> sia impostata (qui sopra lo è già), e disattiva il buffering delle risposte su <code>/api/sse</code> così i server-sent events passano in streaming.',
      foot: 'Apri <code>{url}</code> nel browser. Queenie ti accompagna per il resto (account admin, il tuo primo provider IA, i tuoi primi agenti). Nessun file di configurazione da modificare.',
      envComments: {
        publicUrl: '# URL pubblico: usato per link di invito, webhook, callback OAuth, CORS.',
        key1: '# Chiave di cifratura (AES-256-GCM, 64 caratteri hex). Generata e salvata',
        key2: '# automaticamente nel volume dati se la lasci vuota. Impostarla tu stesso',
        key3: '# ti permette di farne il backup: perderla rende irrecuperabile ogni segreto del vault.',
      },
      nginxComments: {
        sse: '# SSE: trasmetti gli eventi senza buffering',
        https: '# Poi aggiungi HTTPS:  sudo certbot --nginx -d {host}',
      },
    },
  },

  pluginsPage: {
    kicker: 'Marketplace',
    heading: 'Plugin, direttamente da npm.',
    sub: 'Questa lista arriva automaticamente da npm: ogni pacchetto con il tag <code>hivekeep-plugin</code> compare qui. Installali con un clic dal marketplace integrato, senza terminale.',
    count: '{count} plugin, e la lista cresce',
    by: 'di {author}',
    downloads: '{count} download/mese',
    updated: 'aggiornato {date}',
    viewNpm: 'npm',
    viewGithub: 'GitHub',
    publishHeading: 'Pubblica il tuo.',
    publishText: 'Un plugin può aggiungere <b>provider, canali, strumenti e hook</b>. Costruiscine uno (o fallo scrivere a un agente), pubblicalo su npm con la keyword <code>hivekeep-plugin</code> e comparirà qui e nel marketplace integrato automaticamente.',
    publishCta: 'Leggi la guida ai plugin',
  },

  components: {
    marquee: {
      kicker: 'Mini-app · costruite dai tuoi agenti',
      heading: 'Chiedi un\'app. Ottieni un\'app.',
      sub: 'Vere web app che i tuoi agenti costruiscono e ospitano dentro Hivekeep: a tema, installabili e collegate ai tuoi strumenti e alle tue API quando serve. Tutto quello che vedi qui sotto si ottiene con una frase.',
      note: 'Anteprime illustrative. Gli agenti le costruiscono, le vestono e le migliorano su richiesta: <b>«aggiungi un grafico»</b> è un messaggio, non un ticket.',
    },
    providers: {
      browseAll: 'Vedi tutti i plugin',
      kicker: 'Provider e plugin',
      heading: 'Porta qualsiasi provider, o aggiungi il tuo.',
      intro: 'Questi provider sono integrati su tutte le capacità. Una configurazione per provider, e le capacità vengono rilevate da sole (una chiave OpenAI attiva in un colpo LLM, immagini, embedding e voce). Te ne serve un altro? Aggiungilo con un plugin.',
      subCallout: '<b>Paghi già Claude o ChatGPT?</b> Accedi con il tuo abbonamento <b>Claude Pro/Max</b> o <b>ChatGPT</b>: i tuoi agenti girano su quello, senza chiave API.',
      groupLlm: 'Modelli linguistici',
      groupImage: 'Generazione di immagini',
      groupSearch: 'Ricerca web',
      groupSpeech: 'Voce (STT / TTS)',
      groupEmbeddings: 'Embedding',
      groupAccounts: 'Account collegati',
      plugNote: 'Non vedi il tuo? Installa un plugin da npm (qualsiasi pacchetto con tag <code>hivekeep-plugin</code>) direttamente dal marketplace integrato, o fanne scrivere uno a un agente. Un plugin può aggiungere <b>provider, canali, strumenti e hook</b>. Alcuni esempi reali:',
      tagChannel: 'canale',
      tagLlm: 'provider LLM',
      tagImageLlm: 'provider immagini / LLM',
      twilioDesc: 'Invia e ricevi <b>SMS</b> tramite l\'API REST di Twilio e i webhook. Un vero adattatore di canale.',
      mistralDesc: 'Aggiunge <b>Mistral AI</b> come provider: modelli di chat con chiamate agli strumenti, visione e streaming.',
      replicateDesc: 'Porta i <b>modelli ospitati su Replicate</b>: immagini (Flux), LLM (Llama 3, Mixtral) ed embedding.',
      viewGithub: 'Vedi su GitHub',
    },
    agentDemo: {
      rosterTitle: '// i tuoi agenti',
      active: '{count} attivi',
      seeInAction: 'Guarda {name} in azione',
      demoTag: 'demo',
      close: 'Chiudi',
      replay: 'Riproduci di nuovo',
      placeholder: 'Scrivi a {name}…',
      note: 'Questa è un\'anteprima con copione. La versione vera gira sul tuo server.',
      statusOnline: 'online',
      statusWorking: 'al lavoro',
      statusIdle: 'inattivo',
    },
    queenieDemo: {
      cap: 'Fig. 5 · Onboarding di Queenie',
      liveDemo: 'demo dal vivo',
      online: 'online',
      role: 'La tua guida alla configurazione · mette in moto l\'alveare',
      placeholder: 'Scrivi a Queenie…',
    },
    domains: {
      Queenie: 'Configurazione e onboarding',
      Atlas: 'DevOps e infrastruttura',
      Forge: 'Sviluppo e codice',
      Inbox: 'Email e calendario',
      Sentinel: 'Sicurezza e pentest',
      Prism: 'Dati e BI',
      Ledger: 'Finanze e budget',
      Quill: 'Scrittura e copywriting',
      Sage: 'Ricerca e sintesi',
      Pixel: 'Design UI/UX',
      Beacon: 'Notizie e radar tech',
      Nest: 'Domotica',
      Compass: 'Pianificazione viaggi',
      Vitals: 'Salute e fitness',
      Cuisine: 'Ricette e pasti',
      Tutor: 'Apprendimento e tutoraggio',
      Sprout: 'Giardinaggio e piante',
      Lexicon: 'Traduzione e localizzazione',
      Archive: 'Documenti e organizzazione',
      Pulse: 'Social e community',
    },
  },
}

export default dict
