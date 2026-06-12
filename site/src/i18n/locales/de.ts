import en from './en'

const dict: typeof en = {
  meta: {
    plugins: {
      title: 'Plugins',
      description: 'Alle auf npm veröffentlichten Hivekeep-Plugins im Überblick: Provider, Kanäle, Tools und Hooks, mit einem Klick aus dem eingebauten Marketplace installierbar.',
    },
    home: {
      title: 'Hivekeep · Dein KI-Team. Bei dir zuhause.',
      description:
        'Ein selbst gehostetes Team aus KI-Agenten, die sich erinnern, zusammenarbeiten und ihre eigenen Tools bauen. Ein Container, null externe Infrastruktur. Dein KI-Team, bei dir zuhause.',
    },
    install: {
      title: 'Hivekeep installieren',
      description:
        'Installiere Hivekeep so, wie du willst: Docker zum Ausprobieren oder eine native Installation als echtes Zuhause für deine Agenten. Generiere den exakten Befehl für dein Setup.',
    },
  },

  nav: {
    plugins: 'Plugins',
    features: 'Features',
    household: 'Der Haushalt',
    why: 'Warum Hivekeep',
    docs: 'Doku',
    github: 'GitHub ↗',
    getStarted: 'Loslegen',
    configure: 'Konfigurieren',
  },

  footer: {
    line: 'Open Source · MIT · Gebaut mit Bun · © 2026',
  },

  languages: {
    kicker: 'Mehrsprachig',
    heading: 'Spricht deine Sprache.',
    p: 'Die Oberfläche gibt es in 10 Sprachen, und deine Agenten sind daran nicht gebunden: Sie antworten in der Sprache, in der du schreibst (40+), unabhängig von der UI-Sprache.',
  },

  home: {
    hero: {
      meta: 'self-hosted · MIT',
      kicker: 'Ein Bienenstock autonomer Agenten',
      h1a: 'Dein KI-Team.',
      h1b: 'Bei dir zuhause.',
      sub: 'Ein Team aus Agenten, die sich <b>erinnern</b>, <b>zusammenarbeiten</b> und <b>ihre eigenen Tools bauen</b>, komplett auf deinem Server. Kein Chatbot. Ein Haushalt voller Spezialisten, der wie ein Bienenstock arbeitet.',
      colophon: {
        runsOnK: 'Läuft in',
        runsOnV: 'einem Container',
        infraK: 'Externe Infrastruktur',
        infraV: 'keine',
        setupK: 'Eingerichtet per',
        setupV: 'Gespräch',
        channelsK: 'Kanäle',
        channelsV: '6 integriert',
      },
      ctaStart: 'In 2 Minuten starten',
      ctaDemo: 'Demo ansehen',
      everywhere: 'überall:',
      webPwa: 'Web · PWA',
    },

    health: {
      kicker: 'live von GitHub',
      latestRelease: 'neuestes Release',
      ciPrefix: 'CI',
      ciPassing: 'grün',
      ciFailing: 'rot',
      mainBranch: 'main-Branch',
      stars: 'Stars',
      openIssue: 'offenes Issue',
      openIssues: 'offene Issues',
      lastCommit: 'letzter Commit',
      contributor: 'Contributor',
      contributors: 'Contributors',
    },

    video: {
      kicker: 'In Aktion erleben',
      heading: 'Von null zum eigenen Team mit einem Befehl.',
      sub: 'Ein Container. Dann übernimmt Queenie: Provider, Avatare, ein ganzes Team, und deine Agenten fangen an, für dich zu bauen.',
    },

    s1memory: {
      stage: 'Persistent',
      heading: 'Sie vergessen dich nie.',
      p1: 'Kein "neuer Chat". Eine fortlaufende Session und ein hybrides Gedächtnis, das über Monate Kontext aufbaut. Nichts wird gelöscht: Alte Nachrichten werden zusammengefasst, nie weggeworfen.',
      p2: 'Ein Agent reicht Arbeit an einen anderen weiter oder startet einen Schwarm von Sub-Agenten, um schneller voranzukommen. Die Kolonie teilt eine Historie und ein Adressbuch.',
      tagSession: 'fortlaufende Session',
      tagHandoff: 'Übergabe zwischen Agenten',
      figCap: 'Abb. 1 · recall("grocery budget")',
      figTag: 'memory',
      card1: {
        cat: 'decision',
        topic: 'budget',
        text: 'Monatliches Lebensmittelbudget auf 600 $ gesetzt, mit dem Ziel, unnötige Ausgaben zu senken.',
      },
      card2: {
        cat: 'preference',
        topic: 'shopping',
        text: 'Kauft bevorzugt Eigenmarken-Basics und kocht am Wochenende auf Vorrat.',
      },
    },

    s2sovereign: {
      stage: 'Souverän',
      heading: 'Ein Container. Nichts verlässt deinen Server.',
      p1: 'Kein Postgres, Redis, Mongo, kein Message Broker. Bun und SQLite in einem einzigen Binary. Deine Daten, deine Schlüssel, deine Maschine.',
      p2: 'Secrets liegen in einem verschlüsselten Vault. Agenten referenzieren einen Vault-Schlüssel, um einen Dienst zu erreichen; sie <b>lesen den Wert nie</b>, also <b>erreicht er nie das LLM</b>.',
      termComment: '# dann den Browser öffnen. Queenie erledigt den Rest.',
      specs: {
        footprintK: 'Footprint',
        footprintV: '1 Prozess · 1 SQLite-Datei',
        infraK: 'Externe Infrastruktur',
        infraV: 'keine',
        secretsK: 'Secrets',
        secretsV: 'AES-256-GCM-Vault, nur per Referenz',
        dataK: 'Daten & Schlüssel',
        dataV: 'deine, auf deiner Hardware',
      },
    },

    s3extensible: {
      stage: 'Selbstverbessernd',
      heading: 'Deine Agenten erweitern die Plattform selbst.',
      shotAlt: 'Wetter-Tool als gestaltete Karte in der Konversation gerendert',
      p1: 'Agenten schreiben Tools in der Sprache ihrer Wahl, mit eigenen Dependencies, plus einem Renderer, der das Ergebnis als <b>gestaltete Karte statt rohem JSON</b> zeigt. Sie bauen komplette Mini-Apps (Dashboards, Bedienpanels) direkt in Hivekeep und können NPM-Plugins veröffentlichen.',
      p2: 'Grenze jeden Agenten mit <b>Toolboxen</b> ein, damit ein fokussierter Agent nur die Tools sieht, die er braucht. Das hält ihn scharf und lässt auch leichtere Modelle den Job machen.',
      tagCustomTools: 'eigene Tools',
      tagMiniApps: 'Mini-Apps',
      tagNpm: 'NPM-Plugins',
      tagMcp: 'MCP',
      tagToolboxes: 'Toolboxen',
    },

    s4channels: {
      stage: 'Überall',
      heading: 'Ein Posteingang für dein ganzes Team.',
      p1: 'Sprich mit jedem Agenten über die Messenger, die du sowieso nutzt. Nicht sein Fachgebiet? Der Agent am Apparat <b>reicht deine Anfrage an den richtigen Spezialisten weiter</b> und liefert dir die Antwort, oder er <b>übergibt den Kanal</b> in Echtzeit, wenn du danach fragst. Keine Befehle, kein App-Wechsel.',
      shotAlt: 'Eine Smart-Home-Anfrage an den falschen Agenten, weitergeleitet an den zuständigen Spezialisten, der das Licht ausschaltet',
    },

    s5pocket: {
      stage: 'Mobil',
      heading: 'Der ganze Bienenstock, in deiner Tasche.',
      p1: 'Hivekeep ist eine echte App auf deinem Handy: Installiere sie <b>direkt aus dem Browser</b> (kein App Store, kein Konto bei irgendwem, nichts extra zu deployen). Vollbild, ein Icon auf deinem Homescreen, <b>Ungelesen-Badges</b>, die wirklich funktionieren.',
      p2: 'Und es ist <b>dieselbe Live-Session</b> wie am Desktop: Eine Antwort, die am Schreibtisch eintrifft, ist schon auf deinem Handy. Antworte per <b>Sprache</b>, schick Fotos, genehmige den Plan eines Agenten vom Sofa aus.',
      tagPwa: 'installierbare PWA',
      tagDesktopMobile: 'Desktop + Mobil',
      tagBadges: 'Ungelesen-Badges',
      tagVoice: 'Sprache rein & raus',
      phone: {
        aria: 'Hivekeep als installierte App auf einem Handy',
        online: 'online',
        userBubble: 'Bin auf dem Heimweg, mach es gemütlich 🛋️',
        tool1Name: 'Heizung einstellen',
        tool1Detail: ' · Wohnzimmer → 21,5°',
        tool2Name: 'Szene',
        tool2Detail: ' · Abend',
        agentBubble: 'Heizung läuft, Licht steht auf <strong>Abend</strong>. Laut Verkehr 18 Minuten. Soll ich den Ofen auch vorheizen?',
        inputPlaceholder: 'Nachricht an Nest…',
      },
      chipInstallB: 'Aus dem Browser installieren',
      chipInstallI: 'kein App Store nötig',
      chipBadgesB: 'Ungelesen-Badges',
      chipBadgesI: 'auf deinem Homescreen',
      chipSyncB: 'Mit dem Desktop synchron',
      chipSyncI: 'eine Live-Session',
    },

    s6transparency: {
      stage: 'Transparent',
      heading: 'Keine Blackbox. Keine Kostenüberraschungen.',
      p1: 'Sieh genau, was ans Modell geht: der System-Prompt Block für Block aufgeschlüsselt, Token-Kosten <b>pro Agent und pro Modell</b>, und die Prompt-Cache-Aufteilung in Read / Write / Fresh samt Trefferquote. Hivekeep ist ungewöhnlich ehrlich darüber, was es sendet und was es kostet, bei jedem Provider.',
      tagCost: 'Token-Kosten pro Agent',
      tagPreview: 'Kontext-Vorschau',
      figCap: 'Abb. 4 · Kontext-Viewer',
      figTag: 'tokens',
      barTools: 'Tools',
      barMemory: 'Gedächtnis',
      barIdentity: 'Identität',
      barChannels: 'Kanäle',
      cacheTitle: 'Prompt-Cache · warm · noch 4:12',
      cacheHit: '72% Treffer',
      legendRead: 'read 9.1k',
      legendWrite: 'write 1.2k',
      legendFresh: 'fresh 2.4k',
    },

    s7setup: {
      stage: 'Setup',
      heading: 'Das Setup ist ein Gespräch, keine YAML-Datei.',
      p1: 'Queenie, dein Setup-Agent, verbindet deine Provider, sichert deine Secrets und erstellt deine ersten Agenten, indem sie mit dir chattet. Sie bleibt dauerhaft an Bord, jederzeit bereit, einen Agenten hinzuzufügen oder einen neuen Provider anzubinden.',
      tagSecure: 'sichere Eingabe → Vault',
      tagGenerates: 'erstellt Agenten für dich',
    },

    s8household: {
      stage: 'Beispiele',
      heading: 'Bau dir einen Haushalt für dein Leben.',
      p1: 'Hivekeep kommt mit einem Agenten: <b>Queenie</b>, deinem Setup-Guide. Den Rest erstellst du selbst, oder du bittest einfach Queenie darum. Jeder bekommt einen eigenen Namen, ein Fachgebiet, Gedächtnis, Tools und einen generierten Avatar.',
      p2: 'Avatare kommen im <b>Standard-Stil von Hivekeep</b>, sodass ein frischer Bienenstock direkt wie aus einem Guss aussieht. Du willst deinen eigenen Look? Lege einmal einen <b>eigenen Avatar-Stil</b> fest, Pixel Art, Aquarell, deine eigene Marke, und jeder Agent wird darin neu generiert. So bleibt dein ganzes Team im Thema.',
      examplesNote: 'Ein paar Beispiele, was Leute bauen →',
      builtIn: 'integriert',
      eg: 'z. B.',
    },

    morefx: {
      kicker: 'Unter der Haube',
      heading: 'Und {count} weitere Features.',
      sub: 'Alles hier unten ist mit dabei: keine Add-ons, keine Bezahlstufen.',
      categories: [
        {
          label: 'Agenten & Zusammenarbeit',
          icon: 'users',
          cards: [
            {
              title: 'Agenten reden mit Agenten',
              blurb: 'Deine Spezialisten schreiben sich gegenseitig per <b>Request/Reply</b>: Frag einen Agenten und sieh zu, wie er von selbst einen anderen konsultiert.',
              icon: 'messages-square',
            },
            {
              title: 'Delegation an Sub-Agenten',
              blurb: 'Agenten starten kurzlebige Sub-Agenten für schwere Arbeit (<b>blockierend oder parallel</b>), mit Parallelitätslimits und sauberen Berichten zurück.',
              icon: 'git-branch',
            },
            {
              title: 'Scout-Modus',
              blurb: 'Delegiere reine Recherche an ein <b>günstiges, schnelles Modell</b> und bekomm eine Zusammenfassung zurück, ohne Flaggschiff-Tokens zu verbrennen.',
              icon: 'binoculars',
            },
            {
              title: 'Eingebautes CRM',
              blurb: 'Agenten pflegen ein automatisch befülltes Kontaktbuch mit Notizen und Vorlieben, plus Lesesync von <b>iCloud und CardDAV</b>.',
              icon: 'users',
            },
          ],
        },
        {
          label: 'Automatisierung',
          icon: 'workflow',
          cards: [
            {
              title: 'Crons, die dazulernen',
              blurb: 'Geplante Jobs starten Agenten per Cron, führen ein <b>Lauf-Journal</b> und speichern Erkenntnisse, um jeden künftigen Lauf zu verbessern.',
              icon: 'calendar-clock',
            },
            {
              title: 'Eingehende Webhooks',
              blurb: 'Jedes HTTP-Event kann einen Agenten wecken, mit <b>Payload-Filterung</b> (Dot-Path oder Regex), Rate Limits und Request-Logs.',
              icon: 'webhook',
            },
            {
              title: 'E-Mail-Trigger',
              blurb: 'Eingehende Mails, die auf deine Regeln passen, wecken automatisch den richtigen Agenten, in seiner Konversation oder als <b>isolierter Task</b>.',
              icon: 'mail-check',
            },
            {
              title: 'Weck-Timer',
              blurb: 'Agenten planen ihre eigene künftige Arbeit (<b>„weck mich in 2 Stunden“</b>), damit Follow-ups und Erinnerungen wirklich passieren.',
              icon: 'alarm-clock',
            },
            {
              title: 'Kanban, von Agenten betrieben',
              blurb: 'Organisiere Arbeit in Projekten und Tickets, dann <b>weise Tickets Agenten zu</b>, die sie abarbeiten und als Kommentare berichten.',
              icon: 'kanban',
            },
          ],
        },
        {
          label: 'Gedächtnis & Kontext',
          icon: 'brain-circuit',
          cards: [
            {
              title: 'Eine endlose Konversation',
              blurb: 'Kein „Neuer Chat“-Button: Alte Nachrichten werden zu <b>datierten Zusammenfassungen</b> verdichtet, die Originale bleiben sicher in der Datenbank.',
              icon: 'infinity',
            },
            {
              title: 'Selbstreinigendes Gedächtnis',
              blurb: 'Erinnerungen werden konsolidiert, nach Nutzung neu bewertet und veraltete aussortiert, damit der Abruf <b>scharf bleibt statt zugemüllt</b>.',
              icon: 'brain',
            },
            {
              title: 'Wissensdatenbanken',
              blurb: 'Lade Dokumente einmal hoch; relevante Auszüge landen <b>automatisch im Kontext</b>, sobald das Thema aufkommt.',
              icon: 'book-open',
            },
            {
              title: 'Projektwissen',
              blurb: 'Jedes Projekt sammelt kuratierte Fakten, Entscheidungen und Stolperfallen: <b>Angepinnte Einträge</b> reisen in jedem Agenten-Turn mit.',
              icon: 'notebook-pen',
            },
            {
              title: 'Durchsuchbare Vergangenheit',
              blurb: 'Agenten durchsuchen ihre komplette Historie mit <b>semantischer + Volltext</b>-Rangfusion, sodass nichts Gesagtes je wirklich verloren geht.',
              icon: 'history',
            },
          ],
        },
        {
          label: 'Vernetzte Welt',
          icon: 'globe',
          cards: [
            {
              title: 'E-Mail, erledigt',
              blurb: 'Lesen, suchen und senden über <b>Gmail, Outlook, iCloud und IMAP</b>, mit Freigabemodus für ausgehende Mails.',
              icon: 'mail',
            },
            {
              title: 'Kalender im Griff',
              blurb: 'Agenten erstellen, ändern und durchsuchen Termine in <b>Google-, Outlook- und CalDAV</b>-Kalendern in deinem Auftrag.',
              icon: 'calendar-days',
            },
            {
              title: 'Echte Browser-Automatisierung',
              blurb: 'Agenten steuern einen <b>zustandsbehafteten Browser</b> (einloggen, Formulare ausfüllen, klicken, Screenshots) und speichern Sessions fürs nächste Mal.',
              icon: 'mouse-pointer-click',
            },
            {
              title: 'Websuche & Lesen',
              blurb: 'Austauschbare Such-Backends (<b>Brave, Tavily, SerpAPI, Perplexity</b>) plus Seitenabruf, Link-Extraktion und Screenshots.',
              icon: 'globe',
            },
            {
              title: 'Sprache rein, Sprache raus',
              blurb: 'Speech-to-Text und <b>Text-to-Speech</b> über jeden konfigurierten Provider: Sprich mit deinen Agenten und hör ihre Antworten.',
              icon: 'mic',
            },
          ],
        },
        {
          label: 'Kontrolle & Vertrauen',
          icon: 'shield',
          cards: [
            {
              title: 'Verschlüsselter Vault',
              blurb: 'Secrets liegen <b>AES-256-GCM</b>-verschlüsselt und landen nie in Prompts: Agenten holen sie nur über ein begrenztes Tool.',
              icon: 'key-round',
            },
            {
              title: 'Secrets umgehen das LLM',
              blurb: 'Schlüssel werden in <b>sichere Popups</b> getippt, die das Modell komplett umgehen, und geleakte Werte lassen sich nachträglich schwärzen.',
              icon: 'shield-check',
            },
            {
              title: 'Human-in-the-Loop',
              blurb: 'Agenten halten an und fragen, bevor sie handeln: blockierende Rückfragen, <b>Freigabe-Gates</b>, sogar Captcha-Übergaben mitten in der Automatisierung.',
              icon: 'hand',
            },
            {
              title: 'Geteilter Haushalt',
              blurb: 'Lade Familie oder Teamkollegen in eine Instanz ein: Alle teilen sich die Agenten, und Agenten <b>wissen, wer gerade spricht</b>.',
              icon: 'users-round',
            },
            {
              title: 'Zurückspulen & Export',
              blurb: 'Lösche Nachrichten, <b>spule</b> eine Konversation an jeden Punkt zurück oder exportiere alles als Markdown oder JSON. Deine Historie, deine Entscheidung.',
              icon: 'undo-2',
            },
          ],
        },
        {
          label: 'Erlebnis',
          icon: 'sparkles',
          cards: [
            {
              title: '18 Farbpaletten',
              blurb: 'Von Aurora bis Citrus: <b>18 Paletten</b> mit Hell-, Dunkel- und Soft-Kontrast-Modus, nur einen Klick entfernt.',
              icon: 'palette',
            },
            {
              title: 'Überall installierbar',
              blurb: 'Eine vollwertige <b>PWA</b>: auf Desktop oder Handy installieren, Ungelesen-Badges bekommen und in Echtzeit über alle Geräte synchron bleiben.',
              icon: 'smartphone',
            },
            {
              title: 'Quick Sessions',
              blurb: 'Kurzlebige Neben-Chats mit <b>Modell-Overrides pro Session</b>: Experimentiere frei und speichere die guten Stücke als Erinnerungen.',
              icon: 'zap',
            },
            {
              title: 'Steuerung pro Nachricht',
              blurb: 'Überschreibe Modell und <b>Denkaufwand</b> für eine einzelne Nachricht, direkt im Eingabefeld.',
              icon: 'sliders-horizontal',
            },
            {
              title: 'Workspace-Dateibrowser',
              blurb: 'Durchstöbere, bearbeite und teile jede Datei, die deine Agenten erzeugen: <b>Tabs, Konflikterkennung</b>, Drag-and-drop und klickbare Pfade im Chat.',
              icon: 'folder',
            },
            {
              title: 'Bilder & Avatare',
              blurb: 'Agenten <b>generieren und bearbeiten Bilder</b> auf Zuruf, inklusive konsistenter, stilvoller Avatare für dein ganzes Team.',
              icon: 'image',
            },
          ],
        },
      ],
    },

    why: {
      kicker: 'Warum Hivekeep',
      heading: 'Im Vergleich zu den nächsten Projekten.',
      intro:
        'Selbst gehostete KI-Assistenten wie <b>OpenClaw</b> und <b>Hermes</b> sind exzellent: Auch sie punkten bei Gedächtnis, Omnichannel und Self-Hosting. Wo Hivekeep davonzieht, sind das <b>Team</b>, die <b>ausgereifte Produkt-UI</b> und die <b>Transparenz</b>.',
      rows: [
        'Self-hosted, deine Daten',
        'Persistentes Gedächtnis',
        'Natives Omnichannel',
        'Verbundene Konten (Mail, Kalender)',
        'Agenten bauen eigene Tools / Skills',
        'Geplante Aufgaben (Cron)',
        'Ein Team aus Agenten, die zusammenarbeiten',
        'Ausgereifte Web-App (PWA)',
        'Gerenderte Tool-Aufrufe (UI statt JSON)',
        'Mini-Apps & Projekte (Kanban)',
        'Setup per Gespräch (kein CLI)',
        'Secrets gehen nie ans LLM',
        'Token- & Kontext-Transparenz',
      ],
      legend: '✓ nativ · ✕ eher nicht · der Rest ist teilweise oder unklar. Einordnung nach bestem Wissen aus öffentlicher Doku.',
    },

    getstarted: {
      kicker: 'Loslegen',
      heading: 'Dein Team läuft in zwei Minuten.',
      p: 'Füge einen Befehl auf deiner Linux- oder macOS-Maschine ein. Er installiert alles und öffnet sich dann im Browser, wo <b>Queenie</b> dich durch den Rest führt.',
      recTag: 'Der einfachste Weg zur Installation',
      needCustom: 'Du brauchst einen eigenen Port, deine eigene Domain oder Docker?',
      seeAll: 'Alle Installationsoptionen ansehen',
      installBtn: 'Hivekeep installieren',
      starBtn: 'Stern auf GitHub',
      copyAria: 'Befehl kopieren',
    },
  },

  install: {
    intro: {
      kicker: 'Installation',
      heading: 'Bring Hivekeep zum Laufen.',
      p: 'Ein Befehl erledigt alles. Sobald es läuft, richtet <b>Queenie</b> den Rest im Chat mit dir ein, du musst also keine Config-Dateien anfassen.',
    },

    rec: {
      tag: 'Empfohlen · der einfachste Weg',
      heading: 'Eine Zeile einfügen. Fertig.',
      p: 'Führe das in einem Terminal auf deiner Linux- oder macOS-Maschine aus. Es installiert alles für dich.',
      copyAria: 'Installationsbefehl kopieren',
      copy: 'Kopieren',
      copied: 'Kopiert',
      then: 'Wenn er fertig ist, öffne den ausgegebenen Link im Browser. <b>Queenie erledigt den Rest.</b>',
    },

    configure: {
      kicker: 'Optional',
      heading: 'Eigener Port, eigene Domain oder Docker?',
      p: 'Überspring das, wenn der Einzeiler oben alles ist, was du brauchst. Sonst beantworte ein paar Fragen und wir generieren den exakten Befehl für dein Setup.',
    },

    more: {
      label: 'Fortgeschritten & weitere Optionen',
      hint: 'Voraussetzungen, und Docker vs. nativ vs. Quellcode',
    },

    prereqs: {
      kicker: 'Bevor du startest',
      heading: 'Was der Einzeiler braucht.',
      sub: 'Die meisten Maschinen haben das alles schon.',
      items: [
        {
          icon: 'lucide:shield',
          title: 'Du kannst sudo nutzen',
          desc: 'Der Installer braucht es, um fehlende Systempakete zu installieren (git, curl, unzip).',
        },
        {
          icon: 'lucide:hard-drive',
          title: 'Etwa 500 MB freier Speicher',
          desc: 'Platz zum Klonen und Bauen. 1 GB oder mehr ist komfortabel.',
        },
        {
          icon: 'lucide:cpu',
          title: 'Eine 64-Bit-Maschine',
          desc: 'x86_64 oder ARM64. 32-Bit (ältere Raspberry Pi) wird nicht unterstützt.',
        },
        {
          icon: 'lucide:globe',
          title: 'Ausgehendes HTTPS',
          desc: 'Es lädt von github.com und bun.sh herunter, die müssen also erreichbar sein.',
        },
        {
          icon: 'lucide:key-round',
          title: 'openssl vorhanden',
          desc: 'Wird zum Generieren von Schlüsseln genutzt. Ist bei fast jedem Linux und macOS dabei.',
        },
      ],
      windows:
        '<b>Auf Windows?</b> Der native Installer läuft nicht direkt unter Windows. Nutze <b>WSL2</b> (führe den Einzeiler in deiner Linux-Distro aus) oder <b>Docker Desktop</b>.',
    },

    compare: {
      kicker: 'Vergleich',
      heading: 'Nativ, Docker oder aus dem Quellcode?',
      sub: 'Alle drei führen exakt dieselbe App aus. Sie unterscheiden sich darin, wie sie auf der Maschine lebt.',
    },

    methods: [
      {
        tag: 'Empfohlen',
        name: 'Nativ (install.sh)',
        pick: 'Nimm das, wenn es einfach funktionieren soll. Ein Befehl, auf deiner eigenen Linux- oder macOS-Maschine.',
        points: [
          ['y', 'Ein Befehl, baut lokal, kein Image zu veröffentlichen oder zu ziehen'],
          ['y', 'Speichert deinen Verschlüsselungsschlüssel automatisch, Secrets bleiben erhalten'],
          ['y', 'Läuft als Dienst (systemd / launchd), Auto-Update mit Rollback'],
          ['y', 'Agenten gehört die Maschine: Tools & Dependencies installieren, direkter Hardware-Zugriff'],
          ['n', 'Verändert das Host-System (mit Absicht)'],
          ['n', 'Nur Linux & macOS (Windows über WSL2)'],
        ],
      },
      {
        tag: 'Container',
        name: 'Docker',
        pick: 'Nimm das, wenn du sowieso in Docker lebst und eine saubere, isolierte Appliance willst.',
        points: [
          ['y', 'Voll isoliert, null Müll auf dem Host'],
          ['y', 'Läuft überall, wo Docker läuft, auch unter Windows'],
          ['n', 'Das veröffentlichte Image ist noch nicht verfügbar, nimm vorerst lieber nativ'],
          ['n', 'Von Agenten installierte Tools & Binaries überleben keinen Neustart'],
          ['n', 'Du musst das Daten-Volume persistieren, sonst verlierst du deine Secrets'],
        ],
      },
      {
        tag: 'Aus dem Quellcode',
        name: 'Manuell',
        pick: 'Nimm das, wenn du den Code lesen, daran basteln oder ihn auf deine Art betreiben willst.',
        points: [
          ['y', 'Volle Kontrolle: selbst klonen, bauen und mit Bun starten'],
          ['y', 'Am besten für Contributors und Entwicklung'],
          ['n', 'Kein Dienst, kein Auto-Update, das verkabelst du selbst'],
          ['n', 'Bun, Build, Migrationen und den Verschlüsselungsschlüssel managst du von Hand'],
        ],
      },
    ],

    configurator: {
      step1: '1 · Wie wirst du es nutzen?',
      step2: '2 · Einstellungen',
      step3: '3 · Ausführen',
      useCases: {
        try: { label: 'Nur mal ausprobieren', hint: 'Läuft auf dieser Maschine, nur localhost. Null Konfiguration.' },
        permanent: {
          label: 'Dauerhaft auf dieser Maschine',
          hint: 'Ein festes Zuhause für deine Agenten. Optional Zugriff von anderen Geräten.',
        },
        server: { label: 'Server mit Domain', hint: 'Öffentlich, HTTPS, erreichbar unter deiner eigenen Domain.' },
      },
      method: 'Methode',
      methodNative: 'Nativ (empfohlen)',
      methodDocker: 'Docker',
      port: 'Port',
      lanAccess: 'Zugriff von anderen Geräten in meinem Netzwerk',
      lanPlaceholder: 'die LAN-IP dieser Maschine, z. B. 192.168.1.50',
      domain: 'Deine Domain',
      reverseProxy: 'Reverse Proxy (HTTPS)',
      proxyOwn: 'Ich habe meinen eigenen',
      fixedKey: 'Festen Verschlüsselungsschlüssel setzen (fortgeschritten: sichere ihn)',
      generate: 'Generieren',
      copy: 'Kopieren',
      copied: 'Kopiert',
      copyAria: 'In die Zwischenablage kopieren',
      blockRun: 'Ausführen',
      blockStart: 'Starten',
      blockInstall: 'Installieren',
      dockerWarn: {
        title: 'Achtung: Das veröffentlichte Docker-Image ist noch nicht verfügbar.',
        beforeImage: 'Diese Befehle ziehen ',
        afterImage: ', das aktuell nicht öffentlich in der Registry liegt, also schlagen sie fehl mit ',
        or: ' oder ',
        beforeLink: '. Bis es veröffentlicht ist, nutze die ',
        link: 'native Installation',
        afterLink: ' (sie baut lokal und braucht kein Image), oder baue das Image selbst aus einem Klon des Repos.',
      },
      dockerKeynote:
        '<strong>Bewahre deinen Verschlüsselungsschlüssel auf.</strong> Der Schlüssel liegt im Volume <code>hivekeep-data</code>. Wenn du dieses Volume löschst oder neu erstellst, ohne den Schlüssel zu sichern (oder einen festen <code>ENCRYPTION_KEY</code> über den Schalter oben zu setzen), wird jedes Vault-Secret unwiederbringlich verloren.',
      composeKeynote:
        '<strong>Bewahre deinen Verschlüsselungsschlüssel auf.</strong> Er lebt im Volume <code>hivekeep-data</code>. Wer das Volume neu erstellt, ohne den Schlüssel zu sichern (oder einen festen <code>ENCRYPTION_KEY</code> in <code>.env</code> zu setzen), macht jedes gespeicherte Secret unwiederbringlich.',
      dockerRecover: {
        head: 'Wenn ein Befehl fehlschlägt',
        port: '<code>port is already allocated</code>: Port {port} ist belegt. Ändere oben das Port-Feld und kopiere den neuen Befehl.',
        manifest: {
          before: 'Das veröffentlichte Image ist noch nicht verfügbar. Nutze stattdessen die ',
          link: 'native Installation',
          after: ' oder baue lokal.',
        },
        daemon:
          '<code>Cannot connect to the Docker daemon</code>: Docker läuft nicht. Starte Docker Desktop oder führe unter Linux <code>sudo systemctl start docker</code> aus.',
      },
      nativeKeynote:
        '<strong>Um deinen Verschlüsselungsschlüssel wird sich gekümmert.</strong> Der Installer generiert ihn automatisch und speichert ihn unter <code>$DATA_DIR/.encryption-key</code>, damit deine Secrets Neustarts überleben. Sichere diese Datei zusammen mit deiner Datenbank. (Setze einen festen <code>ENCRYPTION_KEY</code> über den Schalter oben, wenn du ihn lieber selbst verwalten willst.)',
      nativeRecover: {
        head: 'Wenn die Installation fehlschlägt',
        port: '<code>port already in use</code> / <code>EADDRINUSE</code>: Port {port} ist belegt. Ändere oben das Port-Feld und führe es erneut aus.',
        windows:
          '<strong>Windows</strong>: Der Installer läuft nur unter Linux und macOS. Führe ihn in <strong>WSL2</strong> aus oder nutze Docker Desktop.',
        network:
          '<strong>Download oder Klonen hängt</strong>: Stell sicher, dass die Maschine <code>github.com</code> und <code>bun.sh</code> über HTTPS erreicht (vielleicht blockiert ein Proxy).',
      },
      proxyCaddy:
        "Caddy übernimmt HTTPS automatisch (Let's Encrypt). Pack das in dein <code>Caddyfile</code> und führe <code>caddy run</code> aus.",
      proxyNginx: 'Ein nginx-Server-Block, der zu Hivekeep weiterleitet, dann certbot für HTTPS.',
      proxyOwnNote:
        'Richte deinen Reverse Proxy auf <code>http://localhost:{port}</code>, stell sicher, dass <code>PUBLIC_URL={url}</code> gesetzt ist (oben ist es das schon), und deaktiviere Response-Buffering auf <code>/api/sse</code>, damit Server-Sent Events durchgestreamt werden.',
      foot: 'Öffne <code>{url}</code> in deinem Browser. Queenie führt dich durch den Rest (Admin-Konto, dein erster KI-Provider, deine ersten Agenten). Keine Config-Dateien zu bearbeiten.',
      envComments: {
        publicUrl: '# Öffentliche URL: genutzt für Einladungslinks, Webhooks, OAuth-Callbacks, CORS.',
        key1: '# Verschlüsselungsschlüssel (AES-256-GCM, 64 Hex-Zeichen). Wird automatisch generiert und',
        key2: '# im Daten-Volume gespeichert, wenn du das leer lässt. Ihn selbst zu setzen erlaubt dir,',
        key3: '# ihn zu sichern: Geht er verloren, ist jedes Vault-Secret unwiederbringlich weg.',
      },
      nginxComments: {
        sse: '# SSE: Events ohne Buffering streamen',
        https: '# Danach HTTPS hinzufügen:  sudo certbot --nginx -d {host}',
      },
    },
  },

  pluginsPage: {
    kicker: 'Marketplace',
    heading: 'Plugins, direkt von npm.',
    sub: 'Diese Liste kommt automatisch von npm: jedes Paket mit dem Tag <code>hivekeep-plugin</code> taucht hier auf. Installiere sie mit einem Klick aus dem eingebauten Marketplace, ganz ohne Terminal.',
    count: '{count} Plugins, Tendenz steigend',
    by: 'von {author}',
    downloads: '{count} Downloads/Monat',
    updated: 'aktualisiert {date}',
    viewNpm: 'npm',
    viewGithub: 'GitHub',
    publishHeading: 'Veröffentliche deins.',
    publishText: 'Ein Plugin kann <b>Provider, Kanäle, Tools und Hooks</b> hinzufügen. Bau eins (oder lass es einen Agenten schreiben), veröffentliche es auf npm mit dem Keyword <code>hivekeep-plugin</code>, und es erscheint automatisch hier und im eingebauten Marketplace.',
    publishCta: 'Plugin-Guide lesen',
  },

  components: {
    marquee: {
      kicker: 'Mini-Apps · von deinen Agenten gebaut',
      heading: 'Frag nach einer App. Bekomm eine App.',
      sub: 'Echte Web-Apps, die deine Agenten in Hivekeep bauen und hosten: im Theme der Plattform, installierbar und bei Bedarf mit deinen Tools und APIs verbunden. Alles hier unten bekommst du mit einem Satz.',
      note: 'Illustrative Vorschauen. Agenten bauen, gestalten und verbessern sie auf Zuruf: <b>„füg ein Diagramm hinzu“</b> ist eine Nachricht, kein Ticket.',
    },
    providers: {
      browseAll: 'Alle Plugins ansehen',
      kicker: 'Provider & Plugins',
      heading: 'Bring jeden Provider mit, oder bau deinen eigenen.',
      intro: 'Diese Provider sind über alle Fähigkeiten hinweg eingebaut. Eine Konfiguration pro Provider, Fähigkeiten werden automatisch erkannt (ein OpenAI-Key schaltet LLM, Bild, Embeddings und Sprache auf einmal frei). Brauchst du einen anderen? Füg ihn per Plugin hinzu.',
      subCallout: '<b>Zahlst du schon für Claude oder ChatGPT?</b> Melde dich mit deinem <b>Claude Pro/Max</b>- oder <b>ChatGPT</b>-Abo an: deine Agenten laufen darauf, ganz ohne API-Key.',
      groupLlm: 'Sprachmodelle',
      groupImage: 'Bildgenerierung',
      groupSearch: 'Websuche',
      groupSpeech: 'Sprache (STT / TTS)',
      groupEmbeddings: 'Embeddings',
      groupAccounts: 'Verbundene Konten',
      plugNote: 'Deiner fehlt? Installiere ein Plugin von npm (alles mit dem Tag <code>hivekeep-plugin</code>) direkt aus dem eingebauten Marketplace, oder lass einen Agenten eins schreiben. Ein Plugin kann <b>Provider, Kanäle, Tools und Hooks</b> hinzufügen. Ein paar echte Beispiele:',
      tagChannel: 'Kanal',
      tagLlm: 'LLM-Provider',
      tagImageLlm: 'Bild- / LLM-Provider',
      twilioDesc: 'Sende und empfange <b>SMS</b> über die Twilio-REST-API und Webhooks. Ein echter Kanal-Adapter.',
      mistralDesc: 'Fügt <b>Mistral AI</b> als Provider hinzu: Chat-Modelle mit Tool-Aufrufen, Vision und Streaming.',
      replicateDesc: 'Bringt <b>Replicate-gehostete Modelle</b>: Bild (Flux), LLM (Llama 3, Mixtral) und Embeddings.',
      viewGithub: 'Auf GitHub ansehen',
    },
    agentDemo: {
      rosterTitle: '// deine Agenten',
      active: '{count} aktiv',
      seeInAction: '{name} in Aktion sehen',
      demoTag: 'Demo',
      close: 'Schließen',
      replay: 'Wiederholen',
      placeholder: 'Nachricht an {name}…',
      note: 'Das ist eine geskriptete Vorschau. Das Original läuft auf deinem Server.',
      statusOnline: 'online',
      statusWorking: 'arbeitet',
      statusIdle: 'inaktiv',
    },
    queenieDemo: {
      cap: 'Abb. 5 · Queenie-Onboarding',
      liveDemo: 'Live-Demo',
      online: 'online',
      role: 'Dein Setup-Guide · bringt den Bienenstock zum Laufen',
      placeholder: 'Nachricht an Queenie…',
    },
    domains: {
      Queenie: 'Setup & Onboarding',
      Atlas: 'DevOps & Infrastruktur',
      Forge: 'Entwicklung & Code',
      Inbox: 'E-Mail & Kalender',
      Sentinel: 'Security & Pentesting',
      Prism: 'Daten & BI',
      Ledger: 'Finanzen & Budget',
      Quill: 'Texte & Copywriting',
      Sage: 'Recherche & Synthese',
      Pixel: 'UI/UX-Design',
      Beacon: 'News & Tech-Radar',
      Nest: 'Smart Home',
      Compass: 'Reiseplanung',
      Vitals: 'Gesundheit & Fitness',
      Cuisine: 'Rezepte & Mahlzeiten',
      Tutor: 'Lernen & Nachhilfe',
      Sprout: 'Garten & Pflanzen',
      Lexicon: 'Übersetzung & Lokalisierung',
      Archive: 'Dokumente & Organisation',
      Pulse: 'Social & Community',
    },
  },
}

export default dict
