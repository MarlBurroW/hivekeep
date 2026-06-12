import en from './en'

const dict: typeof en = {
  meta: {
    plugins: {
      title: 'Wtyczki',
      description: 'Przeglądaj wszystkie wtyczki Hivekeep opublikowane na npm: dostawcy, kanały, narzędzia i hooki, instalowane jednym kliknięciem z wbudowanego marketplace\'u.',
    },
    home: {
      title: 'Hivekeep · Twój zespół AI. U ciebie w domu.',
      description:
        'Samodzielnie hostowany zespół agentów AI, którzy pamiętają, współpracują i budują własne narzędzia. Jeden kontener, zero zewnętrznej infrastruktury. Twój zespół AI, u ciebie w domu.',
    },
    install: {
      title: 'Zainstaluj Hivekeep',
      description:
        'Zainstaluj Hivekeep po swojemu: Docker na próbę albo instalacja natywna, by dać agentom prawdziwy dom. Wygeneruj dokładne polecenie dla swojej konfiguracji.',
    },
  },

  nav: {
    plugins: 'Wtyczki',
    features: 'Funkcje',
    household: 'Domowa ekipa',
    why: 'Dlaczego Hivekeep',
    docs: 'Dokumentacja',
    github: 'GitHub ↗',
    getStarted: 'Zacznij teraz',
    configure: 'Konfiguruj',
  },

  footer: {
    line: 'Open source · MIT · Zbudowano na Bun · © 2026',
  },

  languages: {
    kicker: 'Wielojęzyczny',
    heading: 'Mówi w twoim języku.',
    p: 'Interfejs jest dostępny w 10 językach, ale twoich agentów to nie ogranicza: odpowiadają w języku, w którym do nich piszesz (ponad 40), niezależnie od języka interfejsu.',
  },

  home: {
    hero: {
      meta: 'self-hosted · MIT',
      kicker: 'Rój autonomicznych agentów',
      h1a: 'Twój zespół AI.',
      h1b: 'U ciebie w domu.',
      sub: 'Zespół agentów, którzy <b>pamiętają</b>, <b>współpracują</b> i <b>budują własne narzędzia</b>, działający w całości na twoim serwerze. To nie chatbot. To ekipa specjalistów, która pracuje jak ul.',
      colophon: {
        runsOnK: 'Działa na',
        runsOnV: 'jednym kontenerze',
        infraK: 'Zewnętrzna infrastruktura',
        infraV: 'brak',
        setupK: 'Konfiguracja przez',
        setupV: 'rozmowę',
        channelsK: 'Kanały',
        channelsV: '6 wbudowanych',
      },
      ctaStart: 'Wystartuj w 2 minuty',
      ctaDemo: 'Zobacz demo',
      everywhere: 'wszędzie:',
      webPwa: 'Web · PWA',
    },

    health: {
      kicker: 'na żywo z GitHuba',
      latestRelease: 'najnowsze wydanie',
      ciPrefix: 'CI',
      ciPassing: 'przechodzi',
      ciFailing: 'nie przechodzi',
      mainBranch: 'gałąź main',
      stars: 'gwiazdek',
      openIssue: 'otwarte zgłoszenie',
      openIssues: 'otwartych zgłoszeń',
      lastCommit: 'ostatni commit',
      contributor: 'kontrybutor',
      contributors: 'kontrybutorów',
    },

    video: {
      kicker: 'Zobacz w akcji',
      heading: 'Od zera do własnego zespołu jednym poleceniem.',
      sub: 'Jeden kontener. Potem przejmuje Queenie: dostawcy, awatary, cały zespół, a twoi agenci zaczynają budować dla ciebie.',
    },

    s1memory: {
      stage: 'Trwałość',
      heading: 'Nigdy o tobie nie zapomną.',
      p1: 'Żadnych "nowych rozmów". Jedna ciągła sesja i hybrydowa pamięć, która buduje kontekst miesiącami. Nic nie znika: stare wątki są streszczane, nigdy wyrzucane.',
      p2: 'Agent przekazuje pracę innemu albo wypuszcza rój sub-agentów, żeby działać szybciej. Kolonia dzieli jedną historię i jedną książkę adresową.',
      tagSession: 'ciągła sesja',
      tagHandoff: 'przekazywanie między agentami',
      figCap: 'Rys. 1 · recall("budżet na zakupy")',
      figTag: 'pamięć',
      card1: {
        cat: 'decyzja',
        topic: 'budżet',
        text: 'Miesięczny budżet na zakupy spożywcze ustalony na 600 $, z celem ograniczenia zbędnych wydatków.',
      },
      card2: {
        cat: 'preferencja',
        topic: 'zakupy',
        text: 'Woli kupować podstawowe produkty marek własnych i gotować na zapas w weekendy.',
      },
    },

    s2sovereign: {
      stage: 'Suwerenność',
      heading: 'Jeden kontener. Nic nie opuszcza twojego serwera.',
      p1: 'Bez Postgresa, Redisa, Mongo ani brokera wiadomości. Bun i SQLite w jednym pliku binarnym. Twoje dane, twoje klucze, twoja maszyna.',
      p2: 'Sekrety żyją w zaszyfrowanym sejfie. Agenci sięgają do usług przez referencję do klucza w sejfie; <b>nigdy nie czytają jego wartości</b>, więc <b>nigdy nie trafia ona do LLM-a</b>.',
      termComment: '# potem otwórz przeglądarkę. Queenie zajmie się resztą.',
      specs: {
        footprintK: 'Ślad',
        footprintV: '1 proces · 1 plik SQLite',
        infraK: 'Zewnętrzna infrastruktura',
        infraV: 'brak',
        secretsK: 'Sekrety',
        secretsV: 'sejf AES-256-GCM, tylko przez referencję',
        dataK: 'Dane i klucze',
        dataV: 'twoje, na twoim sprzęcie',
      },
    },

    s3extensible: {
      stage: 'Samorozwój',
      heading: 'Twoi agenci sami rozbudowują platformę.',
      shotAlt: 'Narzędzie pogodowe wyświetlone jako stylizowana karta w rozmowie',
      p1: 'Agenci piszą narzędzia w języku, w jakim chcą, z własnymi zależnościami, plus renderer, który pokazuje wynik jako <b>stylizowaną kartę, a nie surowy JSON</b>. Budują pełne mini-aplikacje (dashboardy, panele sterowania) bezpośrednio w Hivekeep i potrafią wydawać wtyczki NPM.',
      p2: 'Ogranicz każdego agenta <b>skrzynkami narzędziowymi</b>, by wyspecjalizowany agent widział tylko potrzebne narzędzia: pozostaje skupiony, a robotę mogą wykonywać lżejsze modele.',
      tagCustomTools: 'własne narzędzia',
      tagMiniApps: 'mini-aplikacje',
      tagNpm: 'wtyczki NPM',
      tagMcp: 'MCP',
      tagToolboxes: 'skrzynki narzędziowe',
    },

    s4channels: {
      stage: 'Wszędzie',
      heading: 'Jedna skrzynka dla całego zespołu.',
      p1: 'Rozmawiaj z każdym agentem przez komunikatory, których już używasz. Pytanie nie z jego działki? Agent na linii <b>przekaże twoją prośbę właściwemu specjaliście</b> i prześle ci odpowiedź, a jeśli o to poprosisz, <b>odda mu kanał</b> w czasie rzeczywistym. Bez komend, bez przełączania aplikacji.',
      shotAlt: 'Prośba smart home wysłana do niewłaściwego agenta, przekazana odpowiedzialnemu specjaliście, który gasi światła',
    },

    s5pocket: {
      stage: 'Mobilnie',
      heading: 'Cały ul w twojej kieszeni.',
      p1: 'Hivekeep to prawdziwa aplikacja na telefonie: instalujesz ją <b>prosto z przeglądarki</b> (bez sklepu z aplikacjami, bez konta u kogokolwiek, bez dodatkowego wdrażania). Pełny ekran, ikona na ekranie głównym i <b>plakietki nieprzeczytanych</b>, które naprawdę działają.',
      p2: 'I to <b>ta sama sesja na żywo</b> co na komputerze: odpowiedź, która wpada na biurku, już jest na twoim telefonie. Odpowiadaj <b>głosem</b>, wysyłaj zdjęcia, zatwierdzaj plan agenta z kanapy.',
      tagPwa: 'instalowalna PWA',
      tagDesktopMobile: 'komputer + telefon',
      tagBadges: 'plakietki nieprzeczytanych',
      tagVoice: 'głos w obie strony',
      phone: {
        aria: 'Hivekeep działający jako zainstalowana aplikacja na telefonie',
        online: 'online',
        userBubble: 'Wracam do domu, zrób przytulnie 🛋️',
        tool1Name: 'Ustaw ogrzewanie',
        tool1Detail: ' · salon → 21,5°',
        tool2Name: 'Scena',
        tool2Detail: ' · Wieczór',
        agentBubble: 'Ogrzewanie włączone, światła ustawione na <strong>Wieczór</strong>. Nawigacja mówi: 18 min. Podgrzać też piekarnik?',
        inputPlaceholder: 'Napisz do Nest…',
      },
      chipInstallB: 'Instalacja z przeglądarki',
      chipInstallI: 'bez sklepu z aplikacjami',
      chipBadgesB: 'Plakietki nieprzeczytanych',
      chipBadgesI: 'na ekranie głównym',
      chipSyncB: 'Synchronizacja z komputerem',
      chipSyncI: 'jedna sesja na żywo',
    },

    s6transparency: {
      stage: 'Przejrzystość',
      heading: 'Żadnej czarnej skrzynki. Żadnych niespodzianek w kosztach.',
      p1: 'Zobacz dokładnie, co trafia do modelu: prompt systemowy rozbity blok po bloku, koszt tokenów <b>per agent i per model</b> oraz podział cache promptów na odczyt / zapis / świeże wraz ze skutecznością trafień. Hivekeep jest wyjątkowo szczery w kwestii tego, co wysyła i ile wydaje, u dowolnego dostawcy.',
      tagCost: 'koszt tokenów per agent',
      tagPreview: 'podgląd kontekstu',
      figCap: 'Rys. 4 · podgląd kontekstu',
      figTag: 'tokeny',
      barTools: 'Narzędzia',
      barMemory: 'Pamięć',
      barIdentity: 'Tożsamość',
      barChannels: 'Kanały',
      cacheTitle: 'cache promptów · rozgrzany · zostało 4:12',
      cacheHit: '72% trafień',
      legendRead: 'odczyt 9,1k',
      legendWrite: 'zapis 1,2k',
      legendFresh: 'świeże 2,4k',
    },

    s7setup: {
      stage: 'Konfiguracja',
      heading: 'Konfiguracja to rozmowa, nie plik YAML.',
      p1: 'Queenie, twoja agentka od konfiguracji, podłącza dostawców, zabezpiecza sekrety i tworzy pierwszych agentów, po prostu z tobą rozmawiając. Zostaje na stałe, gotowa w każdej chwili dodać agenta albo podpiąć nowego dostawcę.',
      tagSecure: 'bezpieczne wpisywanie → sejf',
      tagGenerates: 'generuje agentów za ciebie',
    },

    s8household: {
      stage: 'Przykłady',
      heading: 'Zbuduj ekipę skrojoną pod twoje życie.',
      p1: 'Hivekeep przychodzi z jednym agentem: <b>Queenie</b>, twoją przewodniczką po konfiguracji. Resztę tworzysz sam, albo po prostu prosisz Queenie, by zbudowała ją za ciebie. Każdy agent dostaje własne imię, dziedzinę, pamięć, narzędzia i wygenerowany awatar.',
      p2: 'Awatary powstają w <b>domyślnym stylu graficznym</b> Hivekeep, więc świeży ul od razu wygląda jak komplet. Chcesz własnego klimatu? Ustaw raz <b>własny styl awatarów</b>, pixel art, akwarela, twoja marka, a każdy agent wygeneruje się w nim na nowo, więc cały zespół trzyma jeden motyw.',
      examplesNote: 'Kilka przykładów tego, co budują ludzie →',
      builtIn: 'wbudowany',
      eg: 'np.',
    },

    morefx: {
      kicker: 'Pod maską',
      heading: 'I jeszcze {count} innych funkcji.',
      sub: 'Wszystko poniżej dostajesz w zestawie: bez dodatków, bez płatnych planów.',
      categories: [
        {
          label: 'Agenci i współpraca',
          icon: 'users',
          cards: [
            {
              title: 'Agenci rozmawiają z agentami',
              blurb: 'Twoi specjaliści piszą do siebie w schemacie <b>request/reply</b>: zapytaj jednego agenta i patrz, jak sam konsultuje się z innym.',
              icon: 'messages-square',
            },
            {
              title: 'Delegowanie do sub-agentów',
              blurb: 'Agenci wypuszczają efemerycznych sub-agentów do cięższej roboty (<b>blokująco lub równolegle</b>), z limitami współbieżności i czystym raportem na koniec.',
              icon: 'git-branch',
            },
            {
              title: 'Tryb zwiadowcy',
              blurb: 'Deleguj research tylko do odczytu do <b>taniego, szybkiego modelu</b> i odbierz streszczenie bez palenia tokenów flagowca.',
              icon: 'binoculars',
            },
            {
              title: 'Wbudowany CRM',
              blurb: 'Agenci prowadzą automatycznie uzupełnianą książkę kontaktów z notatkami i preferencjami, plus synchronizację tylko do odczytu z <b>iCloud i CardDAV</b>.',
              icon: 'users',
            },
          ],
        },
        {
          label: 'Automatyzacja',
          icon: 'workflow',
          cards: [
            {
              title: 'Crony, które się uczą',
              blurb: 'Zaplanowane zadania budzą agentów według crona, prowadzą <b>dziennik uruchomień</b> i zapisują wnioski, by każde kolejne uruchomienie było lepsze.',
              icon: 'calendar-clock',
            },
            {
              title: 'Webhooki przychodzące',
              blurb: 'Dowolne zdarzenie HTTP może obudzić agenta, z <b>filtrowaniem payloadu</b> (dot-path lub regex), limitami zapytań i logami żądań.',
              icon: 'webhook',
            },
            {
              title: 'Wyzwalacze e-mail',
              blurb: 'Przychodząca poczta pasująca do twoich reguł automatycznie budzi właściwego agenta, w jego rozmowie albo w <b>odizolowanym zadaniu</b>.',
              icon: 'mail-check',
            },
            {
              title: 'Budziki na przyszłość',
              blurb: 'Agenci sami planują swoją przyszłą pracę (<b>„obudź mnie za 2 godziny”</b>), więc follow-upy i przypomnienia naprawdę się dzieją.',
              icon: 'alarm-clock',
            },
            {
              title: 'Kanban prowadzony przez agentów',
              blurb: 'Organizuj pracę w projekty i tickety, a potem <b>przypisuj tickety agentom</b>, którzy je wykonują i raportują w komentarzach.',
              icon: 'kanban',
            },
          ],
        },
        {
          label: 'Pamięć i kontekst',
          icon: 'brain-circuit',
          cards: [
            {
              title: 'Jedna niekończąca się rozmowa',
              blurb: 'Bez przycisku „nowy czat”: stare wiadomości kompaktują się w <b>datowane streszczenia</b>, a oryginały zostają bezpieczne w bazie.',
              icon: 'infinity',
            },
            {
              title: 'Samoczyszcząca się pamięć',
              blurb: 'Wspomnienia są konsolidowane, oceniane na nowo według użycia, a nieaktualne usuwane, więc pamięć pozostaje <b>ostra, a nie zagracona</b>.',
              icon: 'brain',
            },
            {
              title: 'Bazy wiedzy',
              blurb: 'Wgraj dokumenty raz; trafne fragmenty są <b>automatycznie podsuwane</b> do kontekstu, gdy tylko temat wraca.',
              icon: 'book-open',
            },
            {
              title: 'Wiedza projektowa',
              blurb: 'Każdy projekt trzyma wyselekcjonowane fakty, decyzje i pułapki: <b>przypięte wpisy</b> jadą z każdą turą agenta.',
              icon: 'notebook-pen',
            },
            {
              title: 'Przeszukiwalna przeszłość',
              blurb: 'Agenci przeszukują całą swoją historię fuzją rankingu <b>semantycznego i pełnotekstowego</b>, więc nic, co padło, nie ginie naprawdę.',
              icon: 'history',
            },
          ],
        },
        {
          label: 'Połączony świat',
          icon: 'globe',
          cards: [
            {
              title: 'E-mail ogarnięty',
              blurb: 'Czytaj, wyszukuj i wysyłaj przez <b>Gmail, Outlook, iCloud i IMAP</b>, z trybem zatwierdzania poczty wychodzącej.',
              icon: 'mail',
            },
            {
              title: 'Kontrola kalendarza',
              blurb: 'Agenci tworzą, aktualizują i wyszukują wydarzenia w kalendarzach <b>Google, Outlook i CalDAV</b> w twoim imieniu.',
              icon: 'calendar-days',
            },
            {
              title: 'Prawdziwa automatyzacja przeglądarki',
              blurb: 'Agenci sterują <b>przeglądarką ze stanem</b> (logują się, wypełniają formularze, klikają, robią zrzuty) i zapisują sesje na następny raz.',
              icon: 'mouse-pointer-click',
            },
            {
              title: 'Wyszukiwanie i czytanie sieci',
              blurb: 'Wymienne backendy wyszukiwania (<b>Brave, Tavily, SerpAPI, Perplexity</b>) plus pobieranie stron, wyciąganie linków i zrzuty ekranu.',
              icon: 'globe',
            },
            {
              title: 'Głos w obie strony',
              blurb: 'Zamiana mowy na tekst i <b>tekstu na mowę</b> przez dowolnego skonfigurowanego dostawcę: mów do swoich agentów i słuchaj, jak odpowiadają.',
              icon: 'mic',
            },
          ],
        },
        {
          label: 'Kontrola i zaufanie',
          icon: 'shield',
          cards: [
            {
              title: 'Zaszyfrowany sejf',
              blurb: 'Sekrety przechowywane z <b>AES-256-GCM</b>, nigdy nie wstrzykiwane do promptów: agenci pobierają je wyłącznie przez narzędzie o ograniczonym zasięgu.',
              icon: 'key-round',
            },
            {
              title: 'Sekrety omijają LLM',
              blurb: 'Klucze wpisujesz w <b>bezpiecznych okienkach</b>, które całkowicie omijają model, a wartości, które wyciekły, można wymazać nawet po fakcie.',
              icon: 'shield-check',
            },
            {
              title: 'Człowiek w pętli',
              blurb: 'Agenci zatrzymują się i pytają, zanim zadziałają: blokujące pytania, <b>bramki zatwierdzania</b>, a nawet przekazanie captchy w trakcie automatyzacji.',
              icon: 'hand',
            },
            {
              title: 'Wspólny dom',
              blurb: 'Zaproś rodzinę lub zespół do jednej instancji: wszyscy dzielą tych samych agentów, a agenci <b>wiedzą, kto mówi</b>.',
              icon: 'users-round',
            },
            {
              title: 'Cofanie i eksport',
              blurb: 'Usuwaj wiadomości, <b>cofaj</b> rozmowę do dowolnego punktu albo eksportuj wszystko jako Markdown lub JSON. Twoja historia, twoja decyzja.',
              icon: 'undo-2',
            },
          ],
        },
        {
          label: 'Doświadczenie',
          icon: 'sparkles',
          cards: [
            {
              title: '18 palet kolorów',
              blurb: 'Od Aurora po Citrus: <b>18 palet</b> z trybem jasnym, ciemnym i miękkim kontrastem, na jedno kliknięcie.',
              icon: 'palette',
            },
            {
              title: 'Zainstaluj gdziekolwiek',
              blurb: 'Pełnoprawna <b>PWA</b>: zainstaluj na komputerze lub telefonie, dostawaj plakietki nieprzeczytanych i miej synchronizację między urządzeniami w czasie rzeczywistym.',
              icon: 'smartphone',
            },
            {
              title: 'Szybkie sesje',
              blurb: 'Efemeryczne boczne czaty z <b>nadpisaniem modelu per sesja</b>: eksperymentuj swobodnie, a udane fragmenty zapisuj jako wspomnienia.',
              icon: 'zap',
            },
            {
              title: 'Sterowanie per wiadomość',
              blurb: 'Nadpisz model i <b>wysiłek myślenia</b> dla pojedynczej wiadomości, prosto z pola pisania.',
              icon: 'sliders-horizontal',
            },
            {
              title: 'Przeglądarka plików roboczych',
              blurb: 'Przeglądaj, edytuj i udostępniaj każdy plik, który tworzą twoi agenci: <b>karty, wykrywanie konfliktów</b>, przeciągnij i upuść oraz klikalne ścieżki w czacie.',
              icon: 'folder',
            },
            {
              title: 'Obrazy i awatary',
              blurb: 'Agenci <b>generują i edytują obrazy</b> na żądanie, w tym spójne, stylowe awatary dla całej ekipy.',
              icon: 'image',
            },
          ],
        },
      ],
    },

    why: {
      kicker: 'Dlaczego Hivekeep',
      heading: 'Na tle najbliższych projektów.',
      intro:
        'Samodzielnie hostowani asystenci AI, jak <b>OpenClaw</b> i <b>Hermes</b>, są świetni: też wygrywają pamięcią, zasięgiem na wielu kanałach i self-hostingiem. Hivekeep wyrywa się do przodu <b>zespołem</b>, <b>dopracowanym interfejsem</b> i <b>przejrzystością</b>.',
      rows: [
        'Self-hosting, twoje dane',
        'Trwała pamięć',
        'Natywny omnichannel',
        'Połączone konta (poczta, kalendarz)',
        'Agenci budują własne narzędzia / umiejętności',
        'Zaplanowane zadania (cron)',
        'Zespół agentów, którzy współpracują',
        'Dopracowana aplikacja webowa (PWA)',
        'Renderowane wywołania narzędzi (UI, nie JSON)',
        'Mini-aplikacje i projekty (Kanban)',
        'Konfiguracja przez rozmowę (bez CLI)',
        'Sekrety nigdy nie trafiają do LLM-a',
        'Przejrzystość tokenów i kontekstu',
      ],
      legend: '✓ natywnie · ✕ raczej nie · reszta jest częściowa lub niejasna. Oceny w dobrej wierze, na podstawie publicznej dokumentacji.',
    },

    getstarted: {
      kicker: 'Zacznij teraz',
      heading: 'Uruchom swój zespół w dwie minuty.',
      p: 'Wklej jedno polecenie na maszynie z Linuksem lub macOS. Zainstaluje wszystko, a potem otworzy się w przeglądarce, gdzie <b>Queenie</b> przeprowadzi cię przez resztę.',
      recTag: 'Najprostszy sposób instalacji',
      needCustom: 'Potrzebujesz innego portu, własnej domeny albo Dockera?',
      seeAll: 'Zobacz wszystkie opcje instalacji',
      installBtn: 'Zainstaluj Hivekeep',
      starBtn: 'Daj gwiazdkę na GitHubie',
      copyAria: 'Kopiuj polecenie',
    },
  },

  install: {
    intro: {
      kicker: 'Instalacja',
      heading: 'Uruchom Hivekeep.',
      p: 'Jedno polecenie robi wszystko. Gdy już działa, <b>Queenie</b> konfiguruje resztę, rozmawiając z tobą, więc nie ma żadnych plików konfiguracyjnych do edycji.',
    },

    rec: {
      tag: 'Zalecane · najprostszy sposób',
      heading: 'Wklej jedną linię. To wszystko.',
      p: 'Uruchom to w terminalu na maszynie z Linuksem lub macOS. Zainstaluje wszystko za ciebie.',
      copyAria: 'Kopiuj polecenie instalacji',
      copy: 'Kopiuj',
      copied: 'Skopiowano',
      then: 'Gdy skończy, otwórz w przeglądarce link, który wypisze. <b>Queenie zajmie się resztą.</b>',
    },

    configure: {
      kicker: 'Opcjonalnie',
      heading: 'Chcesz inny port, domenę albo Dockera?',
      p: 'Pomiń ten krok, jeśli jedna linijka powyżej ci wystarcza. W przeciwnym razie odpowiedz na kilka pytań, a wygenerujemy dokładne polecenie dla twojej konfiguracji.',
    },

    more: {
      label: 'Zaawansowane i inne opcje',
      hint: 'Wymagania oraz Docker vs natywnie vs ze źródeł',
    },

    prereqs: {
      kicker: 'Zanim zaczniesz',
      heading: 'Czego potrzebuje ta jedna linijka.',
      sub: 'Większość maszyn ma już to wszystko.',
      items: [
        {
          icon: 'lucide:shield',
          title: 'Możesz używać sudo',
          desc: 'Instalator potrzebuje go do doinstalowania brakujących pakietów systemowych (git, curl, unzip).',
        },
        {
          icon: 'lucide:hard-drive',
          title: 'Około 500 MB wolnego miejsca',
          desc: 'Miejsce na klonowanie i build. 1 GB lub więcej to komfort.',
        },
        {
          icon: 'lucide:cpu',
          title: 'Maszyna 64-bitowa',
          desc: 'x86_64 lub ARM64. 32 bity (starsze Raspberry Pi) nie są wspierane.',
        },
        {
          icon: 'lucide:globe',
          title: 'Wychodzący HTTPS',
          desc: 'Pobiera z github.com i bun.sh, więc te adresy muszą być osiągalne.',
        },
        {
          icon: 'lucide:key-round',
          title: 'Dostępny openssl',
          desc: 'Służy do generowania kluczy. Jest w prawie każdym Linuksie i macOS.',
        },
      ],
      windows:
        '<b>Masz Windowsa?</b> Natywny instalator nie działa na Windowsie bezpośrednio. Użyj <b>WSL2</b> (uruchom jedną linijkę w swojej dystrybucji Linuksa) albo <b>Docker Desktop</b>.',
    },

    compare: {
      kicker: 'Porównanie',
      heading: 'Natywnie, Docker czy ze źródeł?',
      sub: 'Wszystkie trzy uruchamiają dokładnie tę samą aplikację. Różnią się tym, jak żyje ona na maszynie.',
    },

    methods: [
      {
        tag: 'Zalecane',
        name: 'Natywnie (install.sh)',
        pick: 'Wybierz to, jeśli ma po prostu działać. Jedno polecenie, na twoim Linuksie lub macOS.',
        points: [
          ['y', 'Jedno polecenie, build lokalny, bez obrazu do publikowania czy pobierania'],
          ['y', 'Automatycznie zapisuje klucz szyfrowania, sekrety przetrwają'],
          ['y', 'Działa jako usługa (systemd / launchd), auto-aktualizacja z rollbackiem'],
          ['y', 'Agenci są u siebie: instalują narzędzia i zależności, mają bezpośredni dostęp do sprzętu'],
          ['n', 'Modyfikuje system hosta (celowo)'],
          ['n', 'Tylko Linux i macOS (Windows przez WSL2)'],
        ],
      },
      {
        tag: 'Kontener',
        name: 'Docker',
        pick: 'Wybierz to, jeśli już żyjesz w Dockerze i chcesz czystego, odizolowanego pudełka.',
        points: [
          ['y', 'Pełna izolacja, zero śmiecenia na hoście'],
          ['y', 'Działa wszędzie tam, gdzie Docker, włącznie z Windowsem'],
          ['n', 'Opublikowany obraz nie jest jeszcze dostępny, na razie wybierz instalację natywną'],
          ['n', 'Narzędzia i binarki instalowane przez agentów nie przetrwają restartu'],
          ['n', 'Musisz utrwalić wolumen danych, inaczej stracisz sekrety'],
        ],
      },
      {
        tag: 'Ze źródeł',
        name: 'Ręcznie',
        pick: 'Wybierz to, jeśli chcesz czytać kod, grzebać w nim albo uruchamiać go po swojemu.',
        points: [
          ['y', 'Pełna kontrola: klonujesz, budujesz i uruchamiasz Bunem samodzielnie'],
          ['y', 'Najlepsze dla kontrybutorów i developmentu'],
          ['n', 'Bez usługi, bez auto-aktualizacji, podpinasz je samodzielnie'],
          ['n', 'Bun, build, migracje i klucz szyfrowania ogarniasz ręcznie'],
        ],
      },
    ],

    configurator: {
      step1: '1 · Jak będziesz tego używać?',
      step2: '2 · Ustawienia',
      step3: '3 · Uruchom',
      useCases: {
        try: { label: 'Tylko testuję', hint: 'Uruchom na tej maszynie, tylko localhost. Zero konfiguracji.' },
        permanent: {
          label: 'Na stałe na tej maszynie',
          hint: 'Trwały dom dla twoich agentów. Opcjonalny dostęp z innych urządzeń.',
        },
        server: { label: 'Serwer z domeną', hint: 'Publicznie, HTTPS, pod twoją własną domeną.' },
      },
      method: 'Metoda',
      methodNative: 'Natywnie (zalecane)',
      methodDocker: 'Docker',
      port: 'Port',
      lanAccess: 'Dostęp z innych urządzeń w mojej sieci',
      lanPlaceholder: 'adres LAN tej maszyny, np. 192.168.1.50',
      domain: 'Twoja domena',
      reverseProxy: 'Reverse proxy (HTTPS)',
      proxyOwn: 'Mam własny',
      fixedKey: 'Ustaw stały klucz szyfrowania (zaawansowane: zrób mu kopię)',
      generate: 'Generuj',
      copy: 'Kopiuj',
      copied: 'Skopiowano',
      copyAria: 'Kopiuj do schowka',
      blockRun: 'Uruchom',
      blockStart: 'Start',
      blockInstall: 'Instalacja',
      dockerWarn: {
        title: 'Uwaga: opublikowany obraz Dockera nie jest jeszcze dostępny.',
        beforeImage: 'Te polecenia pobierają ',
        afterImage: ', który nie jest obecnie publiczny w rejestrze, więc zakończą się błędem ',
        or: ' lub ',
        beforeLink: '. Dopóki nie zostanie opublikowany, użyj ',
        link: 'instalacji natywnej',
        afterLink: ' (buduje lokalnie i nie potrzebuje obrazu) albo zbuduj obraz samodzielnie z klona repozytorium.',
      },
      dockerKeynote:
        '<strong>Zachowaj swój klucz szyfrowania.</strong> Klucz jest przechowywany w wolumenie <code>hivekeep-data</code>. Jeśli usuniesz lub odtworzysz ten wolumen bez zachowania klucza (albo bez przypięcia stałego <code>ENCRYPTION_KEY</code> przełącznikiem zaawansowanym powyżej), każdy sekret w sejfie stanie się nie do odzyskania.',
      composeKeynote:
        '<strong>Zachowaj swój klucz szyfrowania.</strong> Żyje w wolumenie <code>hivekeep-data</code>. Odtworzenie wolumenu bez zachowania klucza (albo ustawienia stałego <code>ENCRYPTION_KEY</code> w <code>.env</code>) sprawia, że każdy zapisany sekret staje się nie do odzyskania.',
      dockerRecover: {
        head: 'Jeśli polecenie zawiedzie',
        port: '<code>port is already allocated</code>: port {port} jest zajęty. Zmień pole Port powyżej i skopiuj nowe polecenie.',
        manifest: {
          before: 'opublikowany obraz nie jest jeszcze dostępny. Użyj zamiast tego ',
          link: 'instalacji natywnej',
          after: ' albo zbuduj lokalnie.',
        },
        daemon:
          '<code>Cannot connect to the Docker daemon</code>: Docker nie działa. Uruchom Docker Desktop albo wykonaj <code>sudo systemctl start docker</code> na Linuksie.',
      },
      nativeKeynote:
        '<strong>Twoim kluczem szyfrowania zajmujemy się za ciebie.</strong> Instalator automatycznie go generuje i zapisuje w <code>$DATA_DIR/.encryption-key</code>, więc sekrety przetrwają restarty. Zrób kopię tego pliku razem z bazą danych. (Jeśli wolisz zarządzać nim samodzielnie, przypnij stały <code>ENCRYPTION_KEY</code> przełącznikiem zaawansowanym powyżej.)',
      nativeRecover: {
        head: 'Jeśli instalacja zawiedzie',
        port: '<code>port already in use</code> / <code>EADDRINUSE</code>: port {port} jest zajęty. Zmień pole Port powyżej i uruchom ponownie.',
        windows:
          '<strong>Windows</strong>: instalator działa tylko na Linuksie i macOS. Uruchom go w <strong>WSL2</strong> albo użyj Docker Desktop.',
        network:
          '<strong>Pobieranie lub klonowanie wisi</strong>: upewnij się, że maszyna ma dostęp do <code>github.com</code> i <code>bun.sh</code> po HTTPS (może je blokować proxy).',
      },
      proxyCaddy:
        "Caddy obsługuje HTTPS automatycznie (Let's Encrypt). Wstaw to do swojego <code>Caddyfile</code> i uruchom <code>caddy run</code>.",
      proxyNginx: 'Blok serwera nginx przekazujący ruch do Hivekeep, a potem certbot dla HTTPS.',
      proxyOwnNote:
        'Skieruj swój reverse proxy na <code>http://localhost:{port}</code>, upewnij się, że <code>PUBLIC_URL={url}</code> jest ustawione (powyżej już jest) i wyłącz buforowanie odpowiedzi na <code>/api/sse</code>, żeby zdarzenia server-sent płynęły strumieniem.',
      foot: 'Otwórz <code>{url}</code> w przeglądarce. Queenie przeprowadzi cię przez resztę (konto administratora, pierwszy dostawca AI, pierwsi agenci). Bez plików konfiguracyjnych do edycji.',
      envComments: {
        publicUrl: '# Publiczny URL: używany do linków zaproszeń, webhooków, callbacków OAuth, CORS.',
        key1: '# Klucz szyfrowania (AES-256-GCM, 64 znaki hex). Generowany automatycznie i przechowywany',
        key2: '# w wolumenie danych, jeśli zostawisz to puste. Ustawiając go samodzielnie, możesz',
        key3: '# zrobić mu kopię: jego utrata czyni każdy sekret w sejfie nie do odzyskania.',
      },
      nginxComments: {
        sse: '# SSE: strumieniuj zdarzenia bez buforowania',
        https: '# Potem dodaj HTTPS:  sudo certbot --nginx -d {host}',
      },
    },
  },

  pluginsPage: {
    kicker: 'Marketplace',
    heading: 'Wtyczki prosto z npm.',
    sub: 'Ta lista pochodzi automatycznie z npm: każdy pakiet z tagiem <code>hivekeep-plugin</code> pojawia się tutaj. Instaluj je jednym kliknięciem z wbudowanego marketplace\'u, bez terminala.',
    count: '{count} wtyczek, a lista rośnie',
    by: 'od {author}',
    downloads: '{count} pobrań/mies.',
    updated: 'zaktualizowano {date}',
    viewNpm: 'npm',
    viewGithub: 'GitHub',
    publishHeading: 'Opublikuj własną.',
    publishText: 'Wtyczka może dodać <b>dostawców, kanały, narzędzia i hooki</b>. Zbuduj ją (albo niech napisze ją agent), opublikuj na npm ze słowem kluczowym <code>hivekeep-plugin</code>, a pojawi się tutaj i we wbudowanym marketplace automatycznie.',
    publishCta: 'Przeczytaj przewodnik po wtyczkach',
  },

  components: {
    marquee: {
      kicker: 'Mini-aplikacje · budowane przez twoich agentów',
      heading: 'Poproś o aplikację. Dostań aplikację.',
      sub: 'Prawdziwe aplikacje webowe, które twoi agenci budują i hostują w Hivekeep: w motywie platformy, instalowalne i podpięte do twoich narzędzi oraz API, gdy tego potrzebujesz. Wszystko poniżej dostajesz za jedno zdanie.',
      note: 'Poglądowe podglądy. Agenci budują je, stylizują i ulepszają na życzenie: <b>„dodaj wykres”</b> to wiadomość, nie ticket.',
    },
    providers: {
      browseAll: 'Zobacz wszystkie wtyczki',
      kicker: 'Dostawcy i wtyczki',
      heading: 'Podłącz dowolnego dostawcę albo dodaj własnego.',
      intro: 'Ci dostawcy są wbudowani we wszystkie możliwości. Jedna konfiguracja na dostawcę, a możliwości wykrywają się same (klucz OpenAI odblokowuje naraz LLM, obrazy, embeddingi i głos). Potrzebujesz innego? Dodaj go wtyczką.',
      subCallout: '<b>Płacisz już za Claude lub ChatGPT?</b> Zaloguj się subskrypcją <b>Claude Pro/Max</b> lub <b>ChatGPT</b>: twoi agenci działają na niej, bez klucza API.',
      groupLlm: 'Modele językowe',
      groupImage: 'Generowanie obrazów',
      groupSearch: 'Wyszukiwanie w sieci',
      groupSpeech: 'Mowa (STT / TTS)',
      groupEmbeddings: 'Embeddingi',
      groupAccounts: 'Połączone konta',
      plugNote: 'Nie widzisz swojego? Zainstaluj wtyczkę z npm (wszystko z tagiem <code>hivekeep-plugin</code>) prosto z wbudowanego marketplace\'u, albo poproś agenta, żeby ją napisał. Wtyczka może dodać <b>dostawców, kanały, narzędzia i hooki</b>. Kilka prawdziwych:',
      tagChannel: 'kanał',
      tagLlm: 'dostawca LLM',
      tagImageLlm: 'dostawca obrazów / LLM',
      twilioDesc: 'Wysyłaj i odbieraj <b>SMS-y</b> przez API REST Twilio i webhooki. Prawdziwy adapter kanału.',
      mistralDesc: 'Dodaje <b>Mistral AI</b> jako dostawcę: modele czatu z wywoływaniem narzędzi, widzeniem i streamingiem.',
      replicateDesc: 'Wnosi <b>modele hostowane na Replicate</b>: obrazy (Flux), LLM (Llama 3, Mixtral) i embeddingi.',
      viewGithub: 'Zobacz na GitHubie',
    },
    agentDemo: {
      rosterTitle: '// twoi agenci',
      active: '{count} aktywnych',
      seeInAction: 'Zobacz {name} w akcji',
      demoTag: 'demo',
      close: 'Zamknij',
      replay: 'Odtwórz ponownie',
      placeholder: 'Napisz do {name}…',
      note: 'To podgląd według scenariusza. Prawdziwa wersja działa na twoim serwerze.',
      statusOnline: 'online',
      statusWorking: 'pracuje',
      statusIdle: 'bezczynny',
    },
    queenieDemo: {
      cap: 'Rys. 5 · Onboarding Queenie',
      liveDemo: 'demo na żywo',
      online: 'online',
      role: 'Twój przewodnik po konfiguracji · uruchamia ul',
      placeholder: 'Napisz do Queenie…',
    },
    domains: {
      Queenie: 'Konfiguracja i onboarding',
      Atlas: 'DevOps i infrastruktura',
      Forge: 'Programowanie i kod',
      Inbox: 'E-mail i kalendarz',
      Sentinel: 'Bezpieczeństwo i pentesty',
      Prism: 'Dane i BI',
      Ledger: 'Finanse i budżet',
      Quill: 'Pisanie i copywriting',
      Sage: 'Research i synteza',
      Pixel: 'Projektowanie UI/UX',
      Beacon: 'Newsy i radar technologiczny',
      Nest: 'Automatyka domowa',
      Compass: 'Planowanie podróży',
      Vitals: 'Zdrowie i fitness',
      Cuisine: 'Przepisy i posiłki',
      Tutor: 'Nauka i korepetycje',
      Sprout: 'Ogrodnictwo i rośliny',
      Lexicon: 'Tłumaczenia i lokalizacja',
      Archive: 'Dokumenty i organizacja',
      Pulse: 'Social i społeczność',
    },
  },
}

export default dict
