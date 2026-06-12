import en from './en'

const dict: typeof en = {
  meta: {
    plugins: {
      title: 'Plugins',
      description: 'Parcours tous les plugins Hivekeep publiés sur npm : providers, canaux, outils et hooks, installables en un clic depuis le marketplace intégré.',
    },
    home: {
      title: "Hivekeep · Ton équipe d'IA. À la maison.",
      description:
        "Une équipe auto-hébergée d'agents IA qui se souviennent, collaborent et fabriquent leurs propres outils. Un conteneur, zéro infra externe. Ton équipe d'IA, à la maison.",
    },
    install: {
      title: 'Installer Hivekeep',
      description:
        'Installe Hivekeep à ta façon : Docker pour essayer, ou une installation native pour offrir un vrai foyer à tes agents. Génère la commande exacte pour ta configuration.',
    },
  },

  nav: {
    plugins: 'Plugins',
    features: 'Fonctionnalités',
    household: 'La maisonnée',
    why: 'Pourquoi Hivekeep',
    docs: 'Docs',
    github: 'GitHub ↗',
    getStarted: 'Démarrer',
    configure: 'Configurer',
  },

  footer: {
    line: 'Open-source · MIT · Construit avec Bun · © 2026',
  },

  languages: {
    kicker: 'Multilingue',
    heading: 'Il parle ta langue.',
    p: "L'interface est traduite en 10 langues, et tes agents ne s'arrêtent pas là : ils répondent dans la langue que tu parles (plus de 40), indépendamment de la langue de l'interface.",
  },

  home: {
    hero: {
      meta: 'auto-hébergé · MIT',
      kicker: "Une ruche d'agents autonomes",
      h1a: "Ton équipe d'IA.",
      h1b: 'À la maison.',
      sub: "Une équipe d'agents qui <b>se souviennent</b>, <b>collaborent</b> et <b>fabriquent leurs propres outils</b>, le tout sur ton serveur. Pas un chatbot : une maisonnée de spécialistes qui fonctionne comme une ruche.",
      colophon: {
        runsOnK: 'Tourne sur',
        runsOnV: 'un conteneur',
        infraK: 'Infra externe',
        infraV: 'aucune',
        setupK: 'Configuré par',
        setupV: 'une conversation',
        channelsK: 'Canaux',
        channelsV: '6 intégrés',
      },
      ctaStart: 'Démarrer en 2 minutes',
      ctaDemo: 'Voir la démo',
      everywhere: 'partout :',
      webPwa: 'Web · PWA',
    },

    health: {
      kicker: 'en direct de GitHub',
      latestRelease: 'dernière release',
      ciPrefix: 'CI',
      ciPassing: 'au vert',
      ciFailing: 'en échec',
      mainBranch: 'branche main',
      stars: 'stars',
      openIssue: 'issue ouverte',
      openIssues: 'issues ouvertes',
      lastCommit: 'dernier commit',
      contributor: 'contributeur',
      contributors: 'contributeurs',
    },

    video: {
      kicker: 'En action',
      heading: 'De zéro à ta propre équipe en une commande.',
      sub: 'Un conteneur. Puis Queenie prend le relais : fournisseurs, avatars, toute une équipe, et tes agents se mettent à construire pour toi.',
    },

    s1memory: {
      stage: 'Persistant',
      heading: "Ils ne t'oublient jamais.",
      p1: "Pas de « nouvelle conversation ». Une seule session continue, et une mémoire hybride qui construit du contexte sur des mois. Rien n'est supprimé : les anciens échanges sont résumés, jamais jetés.",
      p2: "Un agent passe le relais à un autre, ou lance un essaim de sous-agents pour aller plus vite. La colonie partage un seul historique et un seul carnet d'adresses.",
      tagSession: 'session continue',
      tagHandoff: 'relais entre agents',
      figCap: 'Fig. 1 · recall("budget courses")',
      figTag: 'mémoire',
      card1: {
        cat: 'décision',
        topic: 'budget',
        text: 'Budget courses mensuel fixé à 600 €, avec pour objectif de réduire les dépenses superflues.',
      },
      card2: {
        cat: 'préférence',
        topic: 'courses',
        text: 'Préfère les marques distributeur pour les produits de base, et le batch cooking le week-end.',
      },
    },

    s2sovereign: {
      stage: 'Souverain',
      heading: 'Un conteneur. Rien ne quitte ton serveur.',
      p1: 'Pas de Postgres, Redis, Mongo ni de message broker. Bun et SQLite dans un seul binaire. Tes données, tes clés, ta machine.',
      p2: "Les secrets vivent dans un coffre chiffré. Les agents référencent une clé du coffre pour atteindre un service ; ils <b>ne lisent jamais la valeur</b>, qui <b>n'atteint donc jamais le LLM</b>.",
      termComment: '# puis ouvre ton navigateur. Queenie fait le reste.',
      specs: {
        footprintK: 'Empreinte',
        footprintV: '1 processus · 1 fichier SQLite',
        infraK: 'Infra externe',
        infraV: 'aucune',
        secretsK: 'Secrets',
        secretsV: 'coffre AES-256-GCM, par référence uniquement',
        dataK: 'Données & clés',
        dataV: 'à toi, sur ton matériel',
      },
    },

    s3extensible: {
      stage: 'Auto-évolutif',
      heading: 'Tes agents étendent la plateforme eux-mêmes.',
      shotAlt: 'Outil météo affiché comme une carte thématisée dans la conversation',
      p1: "Les agents écrivent des outils dans le langage de leur choix, avec leurs propres dépendances, plus un rendu qui affiche le résultat en <b>carte thématisée, pas en JSON brut</b>. Ils construisent de vraies mini-apps (tableaux de bord, panneaux de contrôle) directement dans Hivekeep, et peuvent publier des plugins NPM.",
      p2: "Cadre chaque agent avec des <b>toolboxes</b> : un agent focalisé ne voit que les outils dont il a besoin, ce qui le garde affûté et permet à des modèles plus légers de faire le travail.",
      tagCustomTools: 'outils sur mesure',
      tagMiniApps: 'mini-apps',
      tagNpm: 'plugins NPM',
      tagMcp: 'MCP',
      tagToolboxes: 'toolboxes',
    },

    s4channels: {
      stage: 'Partout',
      heading: 'Une seule boîte de réception pour toute ton équipe.',
      p1: "Parle à chaque agent depuis les messageries que tu utilises déjà. Hors de son domaine ? L'agent au bout du fil <b>transmet ta demande au bon spécialiste</b> et relaie la réponse, ou, si tu le demandes, <b>lui passe le canal</b> en temps réel. Pas de commandes, pas de changement d'app.",
      shotAlt: "Une demande domotique envoyée au mauvais agent, transférée au spécialiste responsable qui éteint les lumières",
    },

    s5pocket: {
      stage: 'Mobile',
      heading: 'Toute la ruche, dans ta poche.',
      p1: "Hivekeep est une vraie app sur ton téléphone : installe-la <b>directement depuis le navigateur</b> (pas d'app store, pas de compte chez qui que ce soit, rien de plus à déployer). Plein écran, une icône sur ton écran d'accueil, des <b>badges de non-lus</b> qui fonctionnent vraiment.",
      p2: "Et c'est la <b>même session en direct</b> que sur ton ordinateur : une réponse qui arrive à ton bureau est déjà sur ton téléphone. Réponds à la <b>voix</b>, envoie des photos, approuve le plan d'un agent depuis le canapé.",
      tagPwa: 'PWA installable',
      tagDesktopMobile: 'desktop + mobile',
      tagBadges: 'badges de non-lus',
      tagVoice: 'voix en entrée et en sortie',
      phone: {
        aria: 'Hivekeep en app installée sur un téléphone',
        online: 'en ligne',
        userBubble: "Je rentre, mets l'ambiance cosy 🛋️",
        tool1Name: 'Régler le chauffage',
        tool1Detail: ' · salon → 21,5°',
        tool2Name: 'Scène',
        tool2Detail: ' · Soirée',
        agentBubble: "Chauffage allumé, lumières en mode <strong>Soirée</strong>. 18 min de trajet selon le trafic. Je préchauffe aussi le four ?",
        inputPlaceholder: 'Écrire à Nest…',
      },
      chipInstallB: 'Installation depuis le navigateur',
      chipInstallI: "sans app store",
      chipBadgesB: 'Badges de non-lus',
      chipBadgesI: "sur ton écran d'accueil",
      chipSyncB: 'Synchronisé avec le desktop',
      chipSyncI: 'une seule session en direct',
    },

    s6transparency: {
      stage: 'Transparent',
      heading: 'Pas de boîte noire. Pas de surprise sur la facture.',
      p1: "Vois exactement ce qui part au modèle : le prompt système décomposé bloc par bloc, le coût en tokens <b>par agent et par modèle</b>, et la répartition du cache de prompt (lecture / écriture / frais) avec son taux de hit. Hivekeep est d'une honnêteté rare sur ce qu'il envoie et ce qu'il dépense, quel que soit le fournisseur.",
      tagCost: 'coût en tokens par agent',
      tagPreview: 'aperçu du contexte',
      figCap: 'Fig. 4 · visualiseur de contexte',
      figTag: 'tokens',
      barTools: 'Outils',
      barMemory: 'Mémoire',
      barIdentity: 'Identité',
      barChannels: 'Canaux',
      cacheTitle: 'cache de prompt · chaud · 4:12 restantes',
      cacheHit: '72 % de hits',
      legendRead: 'lecture 9,1k',
      legendWrite: 'écriture 1,2k',
      legendFresh: 'frais 2,4k',
    },

    s7setup: {
      stage: 'Configuration',
      heading: 'La configuration est une conversation, pas un fichier YAML.',
      p1: "Queenie, ton agent de configuration, connecte tes fournisseurs, met tes secrets à l'abri et crée tes premiers agents en discutant avec toi. Elle reste ensuite pour de bon, prête à ajouter un agent ou brancher un nouveau fournisseur à tout moment.",
      tagSecure: 'saisie sécurisée → coffre',
      tagGenerates: 'génère des agents pour toi',
    },

    s8household: {
      stage: 'Exemples',
      heading: "Construis une maisonnée à l'image de ta vie.",
      p1: "Hivekeep arrive avec un seul agent : <b>Queenie</b>, ton guide de configuration. Tu crées les autres, ou tu demandes simplement à Queenie de les construire pour toi. Chacun reçoit son nom, son domaine, sa mémoire, ses outils et un avatar généré.",
      p2: "Les avatars suivent le <b>style graphique par défaut</b> de Hivekeep : une ruche toute neuve a déjà l'air d'une collection assortie. Envie de ton propre look ? Définis une fois un <b>style d'avatar personnalisé</b> (pixel art, aquarelle, ta propre identité visuelle) et chaque agent est régénéré dans ce style : toute ton équipe reste raccord.",
      examplesNote: 'Quelques exemples de ce que les gens construisent →',
      builtIn: 'intégré',
      eg: 'ex.',
    },

    morefx: {
      kicker: 'Sous le capot',
      heading: 'Et {count} fonctionnalités de plus.',
      sub: "Tout ce qui suit est inclus dans la boîte : pas d'extensions à acheter, pas d'offre payante.",
      categories: [
        {
          label: 'Agents & collaboration',
          icon: 'users',
          cards: [
            {
              title: 'Des agents qui parlent aux agents',
              blurb: "Tes spécialistes s'échangent des messages en <b>requête/réponse</b> : pose une question à un agent et regarde-le consulter un autre de lui-même.",
              icon: 'messages-square',
            },
            {
              title: 'Délégation à des sous-agents',
              blurb: "Les agents lancent des sous-agents éphémères pour les gros travaux (<b>bloquants ou parallèles</b>), avec limites de concurrence et rapports propres à l'arrivée.",
              icon: 'git-branch',
            },
            {
              title: 'Mode éclaireur',
              blurb: "Délègue la recherche en lecture seule à un <b>modèle rapide et bon marché</b> et récupère un condensé, sans brûler les tokens de ton modèle phare.",
              icon: 'binoculars',
            },
            {
              title: 'CRM intégré',
              blurb: "Les agents tiennent un carnet de contacts auto-alimenté avec notes et préférences, plus une synchro en lecture seule depuis <b>iCloud et CardDAV</b>.",
              icon: 'users',
            },
          ],
        },
        {
          label: 'Automatisation',
          icon: 'workflow',
          cards: [
            {
              title: 'Des crons qui apprennent',
              blurb: "Les tâches planifiées lancent des agents sur un cron, tiennent un <b>journal d'exécution</b> et retiennent leurs apprentissages pour améliorer chaque passage suivant.",
              icon: 'calendar-clock',
            },
            {
              title: 'Webhooks entrants',
              blurb: "N'importe quel événement HTTP peut réveiller un agent, avec <b>filtrage du payload</b> (dot-path ou regex), limites de débit et journaux de requêtes.",
              icon: 'webhook',
            },
            {
              title: 'Déclencheurs e-mail',
              blurb: "Un mail entrant qui correspond à tes règles réveille automatiquement le bon agent, dans sa conversation ou dans une <b>tâche isolée</b>.",
              icon: 'mail-check',
            },
            {
              title: 'Réveils programmés',
              blurb: "Les agents planifient leur propre travail futur (<b>« réveille-moi dans 2 heures »</b>) : les relances et les rappels arrivent vraiment.",
              icon: 'alarm-clock',
            },
            {
              title: 'Kanban tenu par les agents',
              blurb: "Organise le travail en projets et tickets, puis <b>assigne des tickets aux agents</b> : ils les exécutent et rendent compte en commentaires.",
              icon: 'kanban',
            },
          ],
        },
        {
          label: 'Mémoire & contexte',
          icon: 'brain-circuit',
          cards: [
            {
              title: 'Une conversation sans fin',
              blurb: "Pas de bouton « nouveau chat » : les anciens messages sont compactés en <b>résumés datés</b> pendant que les originaux restent en sécurité dans la base.",
              icon: 'infinity',
            },
            {
              title: 'Une mémoire qui fait le ménage',
              blurb: "Les souvenirs sont consolidés, re-notés selon l'usage, et les obsolètes élagués : le rappel reste <b>affûté, pas entassé</b>.",
              icon: 'brain',
            },
            {
              title: 'Bases de connaissances',
              blurb: "Téléverse tes documents une fois ; les extraits pertinents <b>remontent automatiquement</b> dans le contexte dès que le sujet revient.",
              icon: 'book-open',
            },
            {
              title: 'Connaissances de projet',
              blurb: "Chaque projet garde ses faits, ses décisions et ses pièges : les <b>entrées épinglées</b> accompagnent chaque tour d'agent.",
              icon: 'notebook-pen',
            },
            {
              title: 'Un passé interrogeable',
              blurb: "Les agents fouillent tout leur historique en fusionnant recherche <b>sémantique + plein texte</b> : rien de ce qui a été dit n'est vraiment perdu.",
              icon: 'history',
            },
          ],
        },
        {
          label: 'Monde connecté',
          icon: 'globe',
          cards: [
            {
              title: "L'e-mail, géré",
              blurb: "Lecture, recherche et envoi sur <b>Gmail, Outlook, iCloud et IMAP</b>, avec un mode approbation sur le courrier sortant.",
              icon: 'mail',
            },
            {
              title: 'Contrôle du calendrier',
              blurb: "Les agents créent, modifient et recherchent des événements sur les calendriers <b>Google, Outlook et CalDAV</b> en ton nom.",
              icon: 'calendar-days',
            },
            {
              title: 'Vraie automatisation de navigateur',
              blurb: "Les agents pilotent un <b>navigateur avec état</b> (connexion, formulaires, clics, captures) et sauvegardent les sessions pour la prochaine fois.",
              icon: 'mouse-pointer-click',
            },
            {
              title: 'Recherche & lecture web',
              blurb: "Des moteurs de recherche au choix (<b>Brave, Tavily, SerpAPI, Perplexity</b>), plus récupération de pages, extraction de liens et captures d'écran.",
              icon: 'globe',
            },
            {
              title: 'Voix en entrée, voix en sortie',
              blurb: "Reconnaissance vocale et <b>synthèse vocale</b> via n'importe quel fournisseur configuré : parle à tes agents et écoute-les répondre.",
              icon: 'mic',
            },
          ],
        },
        {
          label: 'Contrôle & confiance',
          icon: 'shield',
          cards: [
            {
              title: 'Coffre chiffré',
              blurb: "Les secrets sont stockés en <b>AES-256-GCM</b>, jamais injectés dans les prompts : les agents n'y accèdent que par un outil à portée limitée.",
              icon: 'key-round',
            },
            {
              title: 'Les secrets évitent le LLM',
              blurb: "Les clés se saisissent dans des <b>popups sécurisées</b> qui contournent entièrement le modèle, et une valeur qui fuite peut être caviardée après coup.",
              icon: 'shield-check',
            },
            {
              title: "L'humain dans la boucle",
              blurb: "Les agents s'arrêtent et demandent avant d'agir : questions bloquantes, <b>portes d'approbation</b>, et même relais de captcha en pleine automatisation.",
              icon: 'hand',
            },
            {
              title: 'Maisonnée partagée',
              blurb: "Invite ta famille ou ton équipe sur une même instance : tout le monde partage les agents, et les agents <b>savent qui parle</b>.",
              icon: 'users-round',
            },
            {
              title: 'Rembobiner & exporter',
              blurb: "Supprime des messages, <b>rembobine</b> une conversation à n'importe quel point, ou exporte tout en Markdown ou JSON. Ton historique, ta décision.",
              icon: 'undo-2',
            },
          ],
        },
        {
          label: 'Expérience',
          icon: 'sparkles',
          cards: [
            {
              title: '18 palettes de couleurs',
              blurb: "D'Aurora à Citrus : <b>18 palettes</b> avec modes clair, sombre et contraste doux, à un clic.",
              icon: 'palette',
            },
            {
              title: 'Installable partout',
              blurb: "Une vraie <b>PWA</b> : installe-la sur ordinateur ou téléphone, reçois les badges de non-lus et reste synchronisé en temps réel sur tous tes appareils.",
              icon: 'smartphone',
            },
            {
              title: 'Sessions éclair',
              blurb: "Des conversations annexes éphémères avec <b>modèle au choix par session</b> : expérimente librement, puis garde le meilleur en mémoire.",
              icon: 'zap',
            },
            {
              title: 'Réglages par message',
              blurb: "Change le modèle et l'<b>effort de réflexion</b> pour un seul message, directement depuis le composeur.",
              icon: 'sliders-horizontal',
            },
            {
              title: 'Explorateur de fichiers du workspace',
              blurb: "Parcours, édite et partage chaque fichier produit par tes agents : <b>onglets, détection de conflits</b>, glisser-déposer et chemins cliquables dans le chat.",
              icon: 'folder',
            },
            {
              title: 'Images & avatars',
              blurb: "Les agents <b>génèrent et retouchent des images</b> à la demande, y compris des avatars stylés et cohérents pour toute ton équipe.",
              icon: 'image',
            },
          ],
        },
      ],
    },

    why: {
      kicker: 'Pourquoi Hivekeep',
      heading: 'Face aux projets les plus proches.',
      intro:
        "Les assistants IA auto-hébergés comme <b>OpenClaw</b> et <b>Hermes</b> sont excellents : eux aussi brillent sur la mémoire, l'omnicanal et l'auto-hébergement. Là où Hivekeep prend l'avantage, c'est <b>l'équipe</b>, <b>l'interface produit soignée</b> et la <b>transparence</b>.",
      rows: [
        'Auto-hébergé, tes données',
        'Mémoire persistante',
        'Omnicanal natif',
        'Comptes connectés (mail, calendrier)',
        'Des agents qui créent leurs propres outils / skills',
        'Tâches planifiées (cron)',
        "Une équipe d'agents qui collaborent",
        'Web app soignée (PWA)',
        "Appels d'outils rendus en UI (pas en JSON)",
        'Mini-apps & projets (Kanban)',
        'Configuration conversationnelle (pas de CLI)',
        'Secrets jamais envoyés au LLM',
        'Transparence tokens & contexte',
      ],
      legend: "✓ natif · ✕ pas vraiment · le reste est partiel ou flou. Évaluations de bonne foi d'après les docs publiques.",
    },

    getstarted: {
      kicker: 'Démarrer',
      heading: 'Lance ton équipe en deux minutes.',
      p: "Colle une commande sur ta machine Linux ou macOS. Elle installe tout, puis ouvre ton navigateur où <b>Queenie</b> te guide pour la suite.",
      recTag: "La façon la plus simple d'installer",
      needCustom: "Besoin d'un port spécifique, de ton propre domaine ou de Docker ?",
      seeAll: "Voir toutes les options d'installation",
      installBtn: 'Installer Hivekeep',
      starBtn: 'Star sur GitHub',
      copyAria: 'Copier la commande',
    },
  },

  install: {
    intro: {
      kicker: 'Installation',
      heading: 'Mets Hivekeep en route.',
      p: "Une commande fait tout. Une fois lancé, <b>Queenie</b> configure le reste en discutant avec toi : aucun fichier de config à éditer.",
    },

    rec: {
      tag: 'Recommandé · la façon la plus simple',
      heading: "Colle une ligne. C'est tout.",
      p: "Lance ceci dans un terminal sur ta machine Linux ou macOS. Tout s'installe pour toi.",
      copyAria: "Copier la commande d'installation",
      copy: 'Copier',
      copied: 'Copié',
      then: "Quand c'est terminé, ouvre dans ton navigateur le lien affiché. <b>Queenie fait le reste.</b>",
    },

    configure: {
      kicker: 'Optionnel',
      heading: "Envie d'un port spécifique, d'un domaine ou de Docker ?",
      p: "Passe cette étape si la ligne ci-dessus te suffit. Sinon, réponds à deux ou trois questions et on génère la commande exacte pour ta configuration.",
    },

    more: {
      label: 'Avancé & autres options',
      hint: 'Prérequis, et Docker vs natif vs sources',
    },

    prereqs: {
      kicker: 'Avant de commencer',
      heading: 'Ce dont la commande unique a besoin.',
      sub: 'La plupart des machines ont déjà tout ça.',
      items: [
        {
          icon: 'lucide:shield',
          title: 'Tu peux lancer sudo',
          desc: "L'installateur en a besoin pour ajouter les paquets système manquants (git, curl, unzip).",
        },
        {
          icon: 'lucide:hard-drive',
          title: 'Environ 500 Mo de disque libre',
          desc: "De quoi cloner et builder. 1 Go ou plus, c'est confortable.",
        },
        {
          icon: 'lucide:cpu',
          title: 'Une machine 64 bits',
          desc: "x86_64 ou ARM64. Le 32 bits (anciens Raspberry Pi) n'est pas supporté.",
        },
        {
          icon: 'lucide:globe',
          title: 'HTTPS sortant',
          desc: 'Le script télécharge depuis github.com et bun.sh : ces domaines doivent être joignables.',
        },
        {
          icon: 'lucide:key-round',
          title: 'openssl présent',
          desc: 'Utilisé pour générer les clés. Il est livré avec presque tous les Linux et macOS.',
        },
      ],
      windows:
        "<b>Sous Windows ?</b> L'installateur natif ne tourne pas directement sous Windows. Utilise <b>WSL2</b> (lance la commande dans ta distro Linux) ou <b>Docker Desktop</b>.",
    },

    compare: {
      kicker: 'Comparer',
      heading: 'Natif, Docker ou depuis les sources ?',
      sub: "Les trois font tourner exactement la même app. Ils diffèrent par la façon dont elle vit sur la machine.",
    },

    methods: [
      {
        tag: 'Recommandé',
        name: 'Natif (install.sh)',
        pick: "Choisis ça si tu veux juste que ça marche. Une commande, sur ta propre machine Linux ou macOS.",
        points: [
          ['y', 'Une commande, build local, aucune image à publier ni à télécharger'],
          ['y', 'Sauvegarde automatiquement ta clé de chiffrement, les secrets persistent'],
          ['y', 'Tourne en service (systemd / launchd), mise à jour auto avec rollback'],
          ['y', "Les agents sont chez eux : installation d'outils & dépendances, accès direct au matériel"],
          ['n', "Modifie le système hôte (c'est voulu)"],
          ['n', 'Linux & macOS uniquement (Windows via WSL2)'],
        ],
      },
      {
        tag: 'Conteneur',
        name: 'Docker',
        pick: "Choisis ça si tu vis déjà dans Docker et veux une appliance propre et isolée.",
        points: [
          ['y', "Totalement isolé, zéro pollution de l'hôte"],
          ['y', 'Tourne partout où Docker tourne, Windows compris'],
          ['n', "L'image publiée n'est pas encore disponible, préfère le natif pour l'instant"],
          ['n', "Les outils & binaires installés par les agents ne survivent pas à un redémarrage"],
          ['n', 'Il faut persister le volume de données, sinon tu perds tes secrets'],
        ],
      },
      {
        tag: 'Depuis les sources',
        name: 'Manuel',
        pick: "Choisis ça si tu veux lire le code, bidouiller, ou tout faire à ta façon.",
        points: [
          ['y', 'Contrôle total : clone, build et lancement avec Bun par toi-même'],
          ['y', 'Idéal pour les contributeurs et le développement'],
          ['n', "Pas de service, pas de mise à jour auto : à toi de les câbler"],
          ['n', 'Bun, build, migrations et clé de chiffrement sont à gérer à la main'],
        ],
      },
    ],

    configurator: {
      step1: '1 · Quel usage ?',
      step2: '2 · Réglages',
      step3: '3 · Lance-le',
      useCases: {
        try: { label: 'Juste pour essayer', hint: 'Tourne sur cette machine, localhost uniquement. Zéro config.' },
        permanent: {
          label: 'Permanent sur cette machine',
          hint: "Un foyer durable pour tes agents. Accès optionnel depuis d'autres appareils.",
        },
        server: { label: 'Serveur avec un domaine', hint: 'Public, HTTPS, joignable sur ton propre domaine.' },
      },
      method: 'Méthode',
      methodNative: 'Natif (recommandé)',
      methodDocker: 'Docker',
      port: 'Port',
      lanAccess: "Accès depuis d'autres appareils de mon réseau",
      lanPlaceholder: "l'IP LAN de cette machine, ex. 192.168.1.50",
      domain: 'Ton domaine',
      reverseProxy: 'Reverse proxy (HTTPS)',
      proxyOwn: "J'ai le mien",
      fixedKey: 'Définir une clé de chiffrement fixe (avancé : pense à la sauvegarder)',
      generate: 'Générer',
      copy: 'Copier',
      copied: 'Copié',
      copyAria: 'Copier dans le presse-papiers',
      blockRun: 'Lancer',
      blockStart: 'Démarrer',
      blockInstall: 'Installer',
      dockerWarn: {
        title: "Attention : l'image Docker publiée n'est pas encore disponible.",
        beforeImage: 'Ces commandes récupèrent ',
        afterImage: ", qui n'est pas publique sur le registre pour le moment ; elles échoueront donc avec ",
        or: ' ou ',
        beforeLink: ". En attendant sa publication, utilise l'",
        link: 'installation native',
        afterLink: " (build local, aucune image nécessaire), ou construis l'image toi-même depuis un clone du dépôt.",
      },
      dockerKeynote:
        "<strong>Garde ta clé de chiffrement.</strong> La clé est stockée dans le volume <code>hivekeep-data</code>. Si tu supprimes ou recrées ce volume sans avoir conservé la clé (ou fixé une <code>ENCRYPTION_KEY</code> avec l'option avancée ci-dessus), chaque secret du coffre devient irrécupérable.",
      composeKeynote:
        "<strong>Garde ta clé de chiffrement.</strong> Elle vit dans le volume <code>hivekeep-data</code>. Recréer le volume sans avoir conservé la clé (ou défini une <code>ENCRYPTION_KEY</code> fixe dans <code>.env</code>) rend chaque secret stocké irrécupérable.",
      dockerRecover: {
        head: 'Si une commande échoue',
        port: '<code>port is already allocated</code> : le port {port} est occupé. Change le champ Port ci-dessus et copie la nouvelle commande.',
        manifest: {
          before: "l'image publiée n'est pas encore disponible. Utilise plutôt l'",
          link: 'installation native',
          after: ", ou construis l'image localement.",
        },
        daemon:
          "<code>Cannot connect to the Docker daemon</code> : Docker ne tourne pas. Lance Docker Desktop, ou exécute <code>sudo systemctl start docker</code> sous Linux.",
      },
      nativeKeynote:
        "<strong>Ta clé de chiffrement est gérée pour toi.</strong> L'installateur la génère et l'enregistre automatiquement dans <code>$DATA_DIR/.encryption-key</code> : tes secrets survivent aux redémarrages. Sauvegarde ce fichier avec ta base de données. (Fixe une <code>ENCRYPTION_KEY</code> avec l'option avancée ci-dessus si tu préfères la gérer toi-même.)",
      nativeRecover: {
        head: "Si l'installation échoue",
        port: '<code>port already in use</code> / <code>EADDRINUSE</code> : le port {port} est pris. Change le champ Port ci-dessus et relance.',
        windows:
          "<strong>Windows</strong> : l'installateur est Linux et macOS uniquement. Lance-le dans <strong>WSL2</strong>, ou utilise Docker Desktop.",
        network:
          "<strong>Le téléchargement ou le clone bloque</strong> : vérifie que la machine peut joindre <code>github.com</code> et <code>bun.sh</code> en HTTPS (un proxy peut les bloquer).",
      },
      proxyCaddy:
        "Caddy gère le HTTPS automatiquement (Let's Encrypt). Mets ceci dans ton <code>Caddyfile</code> et lance <code>caddy run</code>.",
      proxyNginx: 'Un server block nginx en proxy vers Hivekeep, puis certbot pour le HTTPS.',
      proxyOwnNote:
        "Pointe ton reverse proxy vers <code>http://localhost:{port}</code>, vérifie que <code>PUBLIC_URL={url}</code> est bien défini (c'est déjà le cas ci-dessus), et désactive le buffering des réponses sur <code>/api/sse</code> pour que les événements SSE passent en streaming.",
      foot: "Ouvre <code>{url}</code> dans ton navigateur. Queenie te guide pour la suite (compte admin, ton premier fournisseur d'IA, tes premiers agents). Aucun fichier de config à éditer.",
      envComments: {
        publicUrl: "# URL publique : utilisée pour les liens d'invitation, webhooks, callbacks OAuth, CORS.",
        key1: '# Clé de chiffrement (AES-256-GCM, 64 caractères hexa). Générée et stockée',
        key2: '# automatiquement dans le volume de données si tu ne la définis pas. La définir',
        key3: '# toi-même permet de la sauvegarder : la perdre rend chaque secret du coffre irrécupérable.',
      },
      nginxComments: {
        sse: '# SSE : streamer les événements sans buffering',
        https: '# Puis ajoute le HTTPS :  sudo certbot --nginx -d {host}',
      },
    },
  },

  pluginsPage: {
    kicker: 'Marketplace',
    heading: 'Les plugins, directement depuis npm.',
    sub: 'Cette liste vient automatiquement de npm : chaque paquet tagué <code>hivekeep-plugin</code> apparaît ici. Installe-les en un clic depuis le marketplace intégré, sans terminal.',
    count: '{count} plugins, et ça continue',
    by: 'par {author}',
    downloads: '{count} téléchargements/mois',
    updated: 'mis à jour {date}',
    viewNpm: 'npm',
    viewGithub: 'GitHub',
    publishHeading: 'Publie le tien.',
    publishText: 'Un plugin peut ajouter <b>providers, canaux, outils et hooks</b>. Construis-en un (ou demande à un agent de l\'écrire), publie-le sur npm avec le mot-clé <code>hivekeep-plugin</code>, et il apparaît ici et dans le marketplace intégré automatiquement.',
    publishCta: 'Lire le guide des plugins',
  },

  components: {
    marquee: {
      kicker: 'Mini-apps · construites par tes agents',
      heading: 'Demande une app. Reçois une app.',
      sub: 'De vraies applis web que tes agents construisent et hébergent dans Hivekeep : thémées, installables, et reliées à tes outils et API quand il le faut. Tout ce qui suit s\'obtient en une phrase.',
      note: 'Aperçus illustratifs. Les agents les construisent, les habillent et les améliorent à la demande : <b>« ajoute un graphique »</b> est un message, pas un ticket.',
    },
    providers: {
      browseAll: 'Voir tous les plugins',
      kicker: 'Providers & plugins',
      heading: 'Branche n\'importe quel provider, ou ajoute le tien.',
      intro: 'Ces providers sont intégrés sur toutes les capacités. Une config par provider, et les capacités sont détectées automatiquement (une clé OpenAI active d\'un coup LLM, image, embeddings et voix). Il t\'en faut un autre ? Ajoute-le via un plugin.',
      subCallout: '<b>Tu paies déjà Claude ou ChatGPT ?</b> Connecte-toi avec ton abonnement <b>Claude Pro/Max</b> ou <b>ChatGPT</b> : tes agents tournent dessus, sans clé API.',
      groupLlm: 'Modèles de langage',
      groupImage: 'Génération d\'images',
      groupSearch: 'Recherche web',
      groupSpeech: 'Voix (STT / TTS)',
      groupEmbeddings: 'Embeddings',
      groupAccounts: 'Comptes connectés',
      plugNote: 'Le tien n\'y est pas ? Installe un plugin depuis npm (tout paquet tagué <code>hivekeep-plugin</code>) directement depuis le marketplace intégré, ou demande à un agent d\'en écrire un. Un plugin peut ajouter <b>providers, canaux, outils et hooks</b>. Quelques exemples réels :',
      tagChannel: 'canal',
      tagLlm: 'provider LLM',
      tagImageLlm: 'provider image / LLM',
      twilioDesc: 'Envoie et reçois des <b>SMS</b> via l\'API REST Twilio et ses webhooks. Un vrai adaptateur de canal.',
      mistralDesc: 'Ajoute <b>Mistral AI</b> comme provider : modèles de chat avec appels d\'outils, vision et streaming.',
      replicateDesc: 'Apporte les <b>modèles hébergés sur Replicate</b> : image (Flux), LLM (Llama 3, Mixtral) et embeddings.',
      viewGithub: 'Voir sur GitHub',
    },
    agentDemo: {
      rosterTitle: '// tes agents',
      active: '{count} actifs',
      seeInAction: 'Voir {name} en action',
      demoTag: 'démo',
      close: 'Fermer',
      replay: 'Rejouer',
      placeholder: 'Écris à {name}…',
      note: 'Ceci est un aperçu scripté. La vraie version tourne sur ton serveur.',
      statusOnline: 'en ligne',
      statusWorking: 'au travail',
      statusIdle: 'inactif',
    },
    queenieDemo: {
      cap: 'Fig. 5 · Onboarding Queenie',
      liveDemo: 'démo live',
      online: 'en ligne',
      role: 'Ton guide d\'installation · met la ruche en route',
      placeholder: 'Écris à Queenie…',
    },
    domains: {
      Queenie: 'Installation & onboarding',
      Atlas: 'DevOps & infra',
      Forge: 'Dev & code',
      Inbox: 'Email & agenda',
      Sentinel: 'Sécurité & pentest',
      Prism: 'Data & BI',
      Ledger: 'Finances & budget',
      Quill: 'Écriture & copywriting',
      Sage: 'Recherche & synthèse',
      Pixel: 'Design UI/UX',
      Beacon: 'Actu & veille tech',
      Nest: 'Domotique',
      Compass: 'Voyages',
      Vitals: 'Santé & forme',
      Cuisine: 'Recettes & repas',
      Tutor: 'Apprentissage & tutorat',
      Sprout: 'Jardinage & plantes',
      Lexicon: 'Traduction & localisation',
      Archive: 'Docs & organisation',
      Pulse: 'Réseaux & communauté',
    },
  },
}

export default dict
