import en from './en'

const dict: typeof en = {
  meta: {
    plugins: {
      title: 'Plugins',
      description: 'Explora todos los plugins de Hivekeep publicados en npm: proveedores, canales, herramientas y hooks, instalables con un clic desde el marketplace integrado.',
    },
    home: {
      title: 'Hivekeep · Tu equipo de IA. En casa.',
      description:
        'Un equipo autoalojado de agentes de IA que recuerdan, colaboran y crean sus propias herramientas. Un contenedor, cero infraestructura externa. Tu equipo de IA, en casa.',
    },
    install: {
      title: 'Instala Hivekeep',
      description:
        'Instala Hivekeep a tu manera: Docker para probarlo, o una instalación nativa para darles a tus agentes un hogar de verdad. Genera el comando exacto para tu configuración.',
    },
  },

  nav: {
    plugins: 'Plugins',
    features: 'Funciones',
    household: 'El hogar',
    why: 'Por qué Hivekeep',
    docs: 'Docs',
    github: 'GitHub ↗',
    getStarted: 'Empieza',
    configure: 'Configurar',
  },

  footer: {
    line: 'Open-source · MIT · Hecho con Bun · © 2026',
  },

  languages: {
    kicker: 'Multilingüe',
    heading: 'Habla tu idioma.',
    p: 'La interfaz viene en 10 idiomas, y tus agentes no se limitan a eso: te responden en el idioma que les hables (más de 40), independientemente del idioma de la interfaz.',
  },

  home: {
    hero: {
      meta: 'autoalojado · MIT',
      kicker: 'Una colmena de agentes autónomos',
      h1a: 'Tu equipo de IA.',
      h1b: 'En casa.',
      sub: 'Un equipo de agentes que <b>recuerdan</b>, <b>colaboran</b> y <b>crean sus propias herramientas</b>, funcionando por completo en tu servidor. No es un chatbot. Es un hogar de especialistas que trabaja como una colmena.',
      colophon: {
        runsOnK: 'Funciona en',
        runsOnV: 'un contenedor',
        infraK: 'Infra externa',
        infraV: 'ninguna',
        setupK: 'Se configura con',
        setupV: 'una conversación',
        channelsK: 'Canales',
        channelsV: '6 integrados',
      },
      ctaStart: 'Empieza en 2 minutos',
      ctaDemo: 'Mira la demo',
      everywhere: 'en todas partes:',
      webPwa: 'Web · PWA',
    },

    health: {
      kicker: 'en directo desde GitHub',
      latestRelease: 'última versión',
      ciPrefix: 'CI',
      ciPassing: 'en verde',
      ciFailing: 'fallando',
      mainBranch: 'rama main',
      stars: 'estrellas',
      openIssue: 'issue abierto',
      openIssues: 'issues abiertos',
      lastCommit: 'último commit',
      contributor: 'colaborador',
      contributors: 'colaboradores',
    },

    video: {
      kicker: 'Míralo en acción',
      heading: 'De cero a tu propio equipo con un solo comando.',
      sub: 'Un contenedor. Luego Queenie toma el relevo: proveedores, avatares, un equipo entero, y tus agentes empiezan a construir para ti.',
    },

    s1memory: {
      stage: 'Persistente',
      heading: 'Nunca te olvidan.',
      p1: 'Sin "nueva conversación". Una sesión continua y una memoria híbrida que construye contexto durante meses. Nada se borra: los mensajes antiguos se resumen, nunca se tiran.',
      p2: 'Un agente pasa el trabajo a otro, o lanza un enjambre de subagentes para avanzar más rápido. La colonia comparte un solo historial y una sola agenda de contactos.',
      tagSession: 'sesión continua',
      tagHandoff: 'relevo entre agentes',
      figCap: 'Fig. 1 · recall("presupuesto de la compra")',
      figTag: 'memoria',
      card1: {
        cat: 'decisión',
        topic: 'presupuesto',
        text: 'Presupuesto mensual de la compra fijado en 600 $, con el objetivo de recortar gastos innecesarios.',
      },
      card2: {
        cat: 'preferencia',
        topic: 'compras',
        text: 'Prefiere comprar productos básicos de marca blanca y cocinar por tandas los fines de semana.',
      },
    },

    s2sovereign: {
      stage: 'Soberano',
      heading: 'Un contenedor. Nada sale de tu servidor.',
      p1: 'Sin Postgres, Redis, Mongo ni broker de mensajes. Bun y SQLite en un solo binario. Tus datos, tus claves, tu máquina.',
      p2: 'Los secretos viven en un vault cifrado. Los agentes referencian una clave del vault para acceder a un servicio; <b>nunca leen el valor</b>, así que <b>nunca llega al LLM</b>.',
      termComment: '# luego abre tu navegador. Queenie hace el resto.',
      specs: {
        footprintK: 'Huella',
        footprintV: '1 proceso · 1 archivo SQLite',
        infraK: 'Infra externa',
        infraV: 'ninguna',
        secretsK: 'Secretos',
        secretsV: 'vault AES-256-GCM, solo por referencia',
        dataK: 'Datos y claves',
        dataV: 'tuyos, en tu hardware',
      },
    },

    s3extensible: {
      stage: 'Se mejora solo',
      heading: 'Tus agentes amplían la plataforma por sí mismos.',
      shotAlt: 'Herramienta del tiempo mostrada como una tarjeta con estilo dentro de la conversación',
      p1: 'Los agentes escriben herramientas en el lenguaje que quieran, con sus propias dependencias, más un renderizador que muestra el resultado como una <b>tarjeta con estilo, no JSON crudo</b>. Construyen mini-apps completas (dashboards, paneles de control) dentro del propio Hivekeep, y pueden publicar plugins de NPM.',
      p2: 'Acota cada agente con <b>cajas de herramientas</b> para que un agente enfocado solo vea las herramientas que necesita: se mantiene afilado y modelos más ligeros pueden hacer el trabajo.',
      tagCustomTools: 'herramientas a medida',
      tagMiniApps: 'mini-apps',
      tagNpm: 'plugins NPM',
      tagMcp: 'MCP',
      tagToolboxes: 'cajas de herramientas',
    },

    s4channels: {
      stage: 'En todas partes',
      heading: 'Una sola bandeja para todo tu equipo.',
      p1: 'Habla con cada agente desde las apps de mensajería que ya usas. ¿Fuera de su terreno? El agente al otro lado <b>pasa tu petición al especialista adecuado</b> y te transmite la respuesta, o, si se lo pides, <b>le cede el canal</b> en tiempo real. Sin comandos, sin cambiar de app.',
      shotAlt: 'Una petición domótica enviada al agente equivocado, reenviada al especialista responsable, que apaga las luces',
    },

    s5pocket: {
      stage: 'Móvil',
      heading: 'Toda la colmena, en tu bolsillo.',
      p1: 'Hivekeep es una app de verdad en tu teléfono: instálala <b>directamente desde el navegador</b> (sin app store, sin cuentas con nadie, sin nada extra que desplegar). Pantalla completa, un icono en tu pantalla de inicio y <b>globos de no leídos</b> que funcionan de verdad.',
      p2: 'Y es la <b>misma sesión en vivo</b> que en tu escritorio: una respuesta que llega a tu mesa ya está en tu teléfono. Responde por <b>voz</b>, envía fotos, aprueba el plan de un agente desde el sofá.',
      tagPwa: 'PWA instalable',
      tagDesktopMobile: 'escritorio + móvil',
      tagBadges: 'globos de no leídos',
      tagVoice: 'voz de entrada y salida',
      phone: {
        aria: 'Hivekeep funcionando como app instalada en un teléfono',
        online: 'en línea',
        userBubble: 'Voy de camino a casa, déjala acogedora 🛋️',
        tool1Name: 'Ajustar calefacción',
        tool1Detail: ' · salón → 21.5°',
        tool2Name: 'Escena',
        tool2Detail: ' · Noche',
        agentBubble: 'Calefacción encendida y luces en modo <strong>Noche</strong>. El tráfico dice 18 min. ¿Quieres que precaliente también el horno?',
        inputPlaceholder: 'Mensaje a Nest…',
      },
      chipInstallB: 'Instálala desde el navegador',
      chipInstallI: 'sin app store',
      chipBadgesB: 'Globos de no leídos',
      chipBadgesI: 'en tu pantalla de inicio',
      chipSyncB: 'Sincronizada con el escritorio',
      chipSyncI: 'una sola sesión en vivo',
    },

    s6transparency: {
      stage: 'Transparente',
      heading: 'Sin caja negra. Sin sustos en la factura.',
      p1: 'Mira exactamente qué llega al modelo: el prompt de sistema desglosado bloque a bloque, el coste en tokens <b>por agente y por modelo</b>, y el reparto lectura / escritura / nuevo del prompt cache con su tasa de aciertos. Hivekeep es inusualmente honesto sobre lo que envía y lo que gasta, con cualquier proveedor.',
      tagCost: 'coste en tokens por agente',
      tagPreview: 'vista previa del contexto',
      figCap: 'Fig. 4 · visor de contexto',
      figTag: 'tokens',
      barTools: 'Herramientas',
      barMemory: 'Memoria',
      barIdentity: 'Identidad',
      barChannels: 'Canales',
      cacheTitle: 'prompt cache · caliente · quedan 4:12',
      cacheHit: '72% de aciertos',
      legendRead: 'lectura 9.1k',
      legendWrite: 'escritura 1.2k',
      legendFresh: 'nuevo 2.4k',
    },

    s7setup: {
      stage: 'Configuración',
      heading: 'La configuración es una conversación, no un archivo YAML.',
      p1: 'Queenie, tu agente de configuración, conecta tus proveedores, protege tus secretos y crea tus primeros agentes charlando contigo. Y se queda para siempre, lista para añadir un agente o conectar un proveedor nuevo en cualquier momento.',
      tagSecure: 'entrada segura → vault',
      tagGenerates: 'genera agentes por ti',
    },

    s8household: {
      stage: 'Ejemplos',
      heading: 'Monta un hogar a la medida de tu vida.',
      p1: 'Hivekeep viene con un solo agente: <b>Queenie</b>, tu guía de configuración. El resto lo creas tú, o simplemente le pides a Queenie que los construya por ti. Cada uno recibe su propio nombre, dominio, memoria, herramientas y un avatar generado.',
      p2: 'Los avatares llegan con el <b>estilo artístico por defecto</b> de Hivekeep, así que una colmena recién creada ya parece un conjunto. ¿Quieres tu propio look? Define una vez un <b>estilo de avatar personalizado</b>, pixel art, acuarela, tu propia marca, y cada agente se regenera con él, para que todo tu equipo siga el mismo tema.',
      examplesNote: 'Algunos ejemplos de lo que la gente construye →',
      builtIn: 'integrado',
      eg: 'p. ej.',
    },

    morefx: {
      kicker: 'Bajo el capó',
      heading: 'Y {count} funciones más.',
      sub: 'Todo lo de abajo viene incluido de serie: sin complementos, sin planes de pago.',
      categories: [
        {
          label: 'Agentes y colaboración',
          icon: 'users',
          cards: [
            {
              title: 'Agentes que hablan con agentes',
              blurb: 'Tus especialistas se escriben entre sí con patrones de <b>petición/respuesta</b>: pregúntale a un agente y míralo consultar a otro por su cuenta.',
              icon: 'messages-square',
            },
            {
              title: 'Delegación en subagentes',
              blurb: 'Los agentes lanzan subagentes efímeros para el trabajo pesado (<b>bloqueante o en paralelo</b>), con límites de concurrencia e informes limpios al terminar.',
              icon: 'git-branch',
            },
            {
              title: 'Modo explorador',
              blurb: 'Delega la investigación de solo lectura en un <b>modelo barato y rápido</b> y recibe un resumen sin quemar tokens del modelo estrella.',
              icon: 'binoculars',
            },
            {
              title: 'CRM integrado',
              blurb: 'Los agentes mantienen una agenda de contactos autocompletada con notas y preferencias, más sincronización de solo lectura desde <b>iCloud y CardDAV</b>.',
              icon: 'users',
            },
          ],
        },
        {
          label: 'Automatización',
          icon: 'workflow',
          cards: [
            {
              title: 'Crons que aprenden',
              blurb: 'Las tareas programadas lanzan agentes según un cron, llevan un <b>diario de ejecuciones</b> y guardan aprendizajes para mejorar cada ejecución futura.',
              icon: 'calendar-clock',
            },
            {
              title: 'Webhooks entrantes',
              blurb: 'Cualquier evento HTTP puede despertar a un agente, con <b>filtrado del payload</b> (dot-path o regex), límites de frecuencia y registro de peticiones.',
              icon: 'webhook',
            },
            {
              title: 'Disparadores de correo',
              blurb: 'El correo entrante que cumple tus reglas despierta automáticamente al agente adecuado, en su conversación o en una <b>tarea aislada</b>.',
              icon: 'mail-check',
            },
            {
              title: 'Temporizadores de despertar',
              blurb: 'Los agentes programan su propio trabajo futuro (<b>«despiértame en 2 horas»</b>) para que los seguimientos y recordatorios ocurran de verdad.',
              icon: 'alarm-clock',
            },
            {
              title: 'Kanban llevado por agentes',
              blurb: 'Organiza el trabajo en proyectos y tickets, y luego <b>asigna tickets a agentes</b> que los ejecutan y reportan el resultado como comentarios.',
              icon: 'kanban',
            },
          ],
        },
        {
          label: 'Memoria y contexto',
          icon: 'brain-circuit',
          cards: [
            {
              title: 'Una conversación sin fin',
              blurb: 'Sin botón de «nuevo chat»: los mensajes antiguos se compactan en <b>resúmenes fechados</b> mientras los originales quedan a salvo en la base de datos.',
              icon: 'infinity',
            },
            {
              title: 'Memoria que se limpia sola',
              blurb: 'Los recuerdos se consolidan, se repuntúan según su uso y los obsoletos se podan, así la memoria se mantiene <b>afilada, no acumulada</b>.',
              icon: 'brain',
            },
            {
              title: 'Bases de conocimiento',
              blurb: 'Sube documentos una vez; los extractos relevantes <b>afloran solos</b> al contexto cada vez que el tema sale a relucir.',
              icon: 'book-open',
            },
            {
              title: 'Conocimiento de proyecto',
              blurb: 'Cada proyecto guarda hechos, decisiones y trampas curadas: las <b>entradas fijadas</b> acompañan cada turno del agente.',
              icon: 'notebook-pen',
            },
            {
              title: 'Un pasado en el que buscar',
              blurb: 'Los agentes buscan en todo su historial con fusión de ranking <b>semántica + texto completo</b>: nada de lo dicho se pierde de verdad.',
              icon: 'history',
            },
          ],
        },
        {
          label: 'Mundo conectado',
          icon: 'globe',
          cards: [
            {
              title: 'El correo, resuelto',
              blurb: 'Lee, busca y envía en <b>Gmail, Outlook, iCloud e IMAP</b>, con un modo de aprobación para el correo saliente.',
              icon: 'mail',
            },
            {
              title: 'Control del calendario',
              blurb: 'Los agentes crean, actualizan y buscan eventos en tu nombre en calendarios de <b>Google, Outlook y CalDAV</b>.',
              icon: 'calendar-days',
            },
            {
              title: 'Automatización con navegador real',
              blurb: 'Los agentes manejan un <b>navegador con estado</b> (inician sesión, rellenan formularios, hacen clic, capturan pantalla) y guardan sesiones para la próxima vez.',
              icon: 'mouse-pointer-click',
            },
            {
              title: 'Búsqueda y lectura web',
              blurb: 'Backends de búsqueda conectables (<b>Brave, Tavily, SerpAPI, Perplexity</b>) más descarga de páginas, extracción de enlaces y capturas.',
              icon: 'globe',
            },
            {
              title: 'Voz de entrada, voz de salida',
              blurb: 'Voz a texto y <b>texto a voz</b> con cualquier proveedor configurado: habla con tus agentes y escúchalos responder.',
              icon: 'mic',
            },
          ],
        },
        {
          label: 'Control y confianza',
          icon: 'shield',
          cards: [
            {
              title: 'Vault cifrado',
              blurb: 'Secretos guardados con <b>AES-256-GCM</b>, nunca inyectados en los prompts: los agentes los obtienen solo a través de una herramienta acotada.',
              icon: 'key-round',
            },
            {
              title: 'Los secretos esquivan al LLM',
              blurb: 'Las claves se escriben en <b>popups seguros</b> que se saltan el modelo por completo, y los valores filtrados pueden censurarse a posteriori.',
              icon: 'shield-check',
            },
            {
              title: 'Humano al mando',
              blurb: 'Los agentes se detienen y preguntan antes de actuar: avisos bloqueantes, <b>puertas de aprobación</b>, incluso relevos de captcha en plena automatización.',
              icon: 'hand',
            },
            {
              title: 'Hogar compartido',
              blurb: 'Invita a tu familia o a tu equipo a una misma instancia: todos comparten los agentes, y los agentes <b>saben quién habla</b>.',
              icon: 'users-round',
            },
            {
              title: 'Rebobinar y exportar',
              blurb: 'Borra mensajes, <b>rebobina</b> una conversación a cualquier punto o expórtalo todo como Markdown o JSON. Tu historial, tú decides.',
              icon: 'undo-2',
            },
          ],
        },
        {
          label: 'Experiencia',
          icon: 'sparkles',
          cards: [
            {
              title: '18 paletas de color',
              blurb: 'De Aurora a Citrus: <b>18 paletas</b> con modos claro, oscuro y de contraste suave, a un clic de distancia.',
              icon: 'palette',
            },
            {
              title: 'Instálalo donde quieras',
              blurb: 'Una <b>PWA</b> completa: instálala en el escritorio o el teléfono, recibe globos de no leídos y mantente sincronizado entre dispositivos en tiempo real.',
              icon: 'smartphone',
            },
            {
              title: 'Sesiones rápidas',
              blurb: 'Chats laterales efímeros con <b>modelo configurable por sesión</b>: experimenta con libertad y guarda lo bueno como recuerdos.',
              icon: 'zap',
            },
            {
              title: 'Controles por mensaje',
              blurb: 'Cambia el modelo y el <b>esfuerzo de razonamiento</b> para un solo mensaje, directamente desde el redactor.',
              icon: 'sliders-horizontal',
            },
            {
              title: 'Explorador de archivos del workspace',
              blurb: 'Navega, edita y comparte cada archivo que producen tus agentes: <b>pestañas, detección de conflictos</b>, arrastrar y soltar, y rutas clicables en el chat.',
              icon: 'folder',
            },
            {
              title: 'Imágenes y avatares',
              blurb: 'Los agentes <b>generan y editan imágenes</b> bajo demanda, incluidos avatares coherentes y con estilo para todo tu plantel.',
              icon: 'image',
            },
          ],
        },
      ],
    },

    why: {
      kicker: 'Por qué Hivekeep',
      heading: 'Frente a los proyectos más cercanos.',
      intro:
        'Los asistentes de IA autoalojados como <b>OpenClaw</b> y <b>Hermes</b> son excelentes: también ganan en memoria, alcance omnicanal y autoalojamiento. Donde Hivekeep se adelanta es en el <b>equipo</b>, la <b>interfaz pulida de producto</b> y la <b>transparencia</b>.',
      rows: [
        'Autoalojado, tus datos',
        'Memoria persistente',
        'Omnicanal nativo',
        'Cuentas conectadas (correo, calendario)',
        'Los agentes crean sus propias herramientas / habilidades',
        'Tareas programadas (cron)',
        'Un equipo de agentes que colaboran',
        'App web pulida (PWA)',
        'Llamadas a herramientas renderizadas (UI, no JSON)',
        'Mini-apps y proyectos (Kanban)',
        'Configuración conversacional (sin CLI)',
        'Secretos que nunca se envían al LLM',
        'Transparencia de tokens y contexto',
      ],
      legend: '✓ nativo · ✕ realmente no · el resto es parcial o poco claro. Las marcas son una estimación a partir de la documentación pública.',
    },

    getstarted: {
      kicker: 'Empieza',
      heading: 'Pon tu equipo en marcha en dos minutos.',
      p: 'Pega un comando en tu máquina Linux o macOS. Lo instala todo y luego se abre en tu navegador, donde <b>Queenie</b> te guía con el resto.',
      recTag: 'La forma más simple de instalar',
      needCustom: '¿Necesitas un puerto personalizado, tu propio dominio o Docker?',
      seeAll: 'Ver todas las opciones de instalación',
      installBtn: 'Instalar Hivekeep',
      starBtn: 'Dale una estrella en GitHub',
      copyAria: 'Copiar comando',
    },
  },

  install: {
    intro: {
      kicker: 'Instalación',
      heading: 'Pon Hivekeep en marcha.',
      p: 'Un solo comando lo hace todo. Una vez arrancado, <b>Queenie</b> configura el resto charlando contigo, así que no hay archivos de configuración que editar.',
    },

    rec: {
      tag: 'Recomendado · la forma más simple',
      heading: 'Pega una línea. Eso es todo.',
      p: 'Ejecuta esto en una terminal de tu máquina Linux o macOS. Lo instala todo por ti.',
      copyAria: 'Copiar comando de instalación',
      copy: 'Copiar',
      copied: 'Copiado',
      then: 'Cuando termine, abre en tu navegador el enlace que imprime. <b>Queenie hace el resto.</b>',
    },

    configure: {
      kicker: 'Opcional',
      heading: '¿Quieres un puerto personalizado, un dominio o Docker?',
      p: 'Sáltate esto si con la línea de arriba te basta. Si no, responde un par de preguntas y generaremos el comando exacto para tu configuración.',
    },

    more: {
      label: 'Avanzado y otras opciones',
      hint: 'Requisitos, y Docker frente a nativo frente a código fuente',
    },

    prereqs: {
      kicker: 'Antes de empezar',
      heading: 'Qué necesita el comando de una línea.',
      sub: 'La mayoría de las máquinas ya tienen todo esto.',
      items: [
        {
          icon: 'lucide:shield',
          title: 'Puedes ejecutar sudo',
          desc: 'El instalador lo necesita para instalar los paquetes del sistema que falten (git, curl, unzip).',
        },
        {
          icon: 'lucide:hard-drive',
          title: 'Unos 500 MB de disco libres',
          desc: 'Espacio para clonar y compilar. Con 1 GB o más vas sobrado.',
        },
        {
          icon: 'lucide:cpu',
          title: 'Una máquina de 64 bits',
          desc: 'x86_64 o ARM64. 32 bits (Raspberry Pi antiguas) no está soportado.',
        },
        {
          icon: 'lucide:globe',
          title: 'HTTPS de salida',
          desc: 'Descarga desde github.com y bun.sh, así que ambos deben ser accesibles.',
        },
        {
          icon: 'lucide:key-round',
          title: 'openssl presente',
          desc: 'Se usa para generar claves. Viene con casi cualquier Linux y macOS.',
        },
      ],
      windows:
        '<b>¿En Windows?</b> El instalador nativo no funciona directamente en Windows. Usa <b>WSL2</b> (ejecuta el comando de una línea dentro de tu distro Linux) o <b>Docker Desktop</b>.',
    },

    compare: {
      kicker: 'Compara',
      heading: '¿Nativo, Docker o desde el código fuente?',
      sub: 'Las tres opciones ejecutan exactamente la misma app. Se diferencian en cómo vive en la máquina.',
    },

    methods: [
      {
        tag: 'Recomendado',
        name: 'Nativo (install.sh)',
        pick: 'Elige esta opción si solo quieres que funcione. Un comando, en tu propia máquina Linux o macOS.',
        points: [
          ['y', 'Un comando, compila en local, sin imagen que publicar ni descargar'],
          ['y', 'Guarda tu clave de cifrado automáticamente, los secretos persisten'],
          ['y', 'Funciona como servicio (systemd / launchd), autoactualización con rollback'],
          ['y', 'Los agentes son dueños de la máquina: instalan herramientas y dependencias, acceso directo al hardware'],
          ['n', 'Modifica el sistema anfitrión (por diseño)'],
          ['n', 'Solo Linux y macOS (Windows vía WSL2)'],
        ],
      },
      {
        tag: 'Contenedor',
        name: 'Docker',
        pick: 'Elige esta opción si ya vives en Docker y quieres un appliance limpio y aislado.',
        points: [
          ['y', 'Totalmente aislado, cero contaminación del host'],
          ['y', 'Funciona donde funcione Docker, incluido Windows'],
          ['n', 'La imagen publicada aún no está disponible, por ahora prefiere el nativo'],
          ['n', 'Las herramientas y binarios que instalan los agentes no sobreviven a un reinicio'],
          ['n', 'Debes persistir el volumen de datos o perderás tus secretos'],
        ],
      },
      {
        tag: 'Desde el código',
        name: 'Manual',
        pick: 'Elige esta opción si quieres leer el código, trastear con él o ejecutarlo a tu manera.',
        points: [
          ['y', 'Control total: clona, compila y ejecuta con Bun tú mismo'],
          ['y', 'Lo mejor para contribuidores y desarrollo'],
          ['n', 'Sin servicio ni autoactualización, eso lo montas tú'],
          ['n', 'Bun, la build, las migraciones y la clave de cifrado corren de tu cuenta'],
        ],
      },
    ],

    configurator: {
      step1: '1 · ¿Cómo lo vas a usar?',
      step2: '2 · Ajustes',
      step3: '3 · Ejecútalo',
      useCases: {
        try: { label: 'Solo estoy probando', hint: 'Ejecútalo en esta máquina, solo localhost. Cero configuración.' },
        permanent: {
          label: 'Permanente en esta máquina',
          hint: 'Un hogar duradero para tus agentes. Acceso opcional desde otros dispositivos.',
        },
        server: { label: 'Servidor con dominio', hint: 'Público, con HTTPS, accesible en tu propio dominio.' },
      },
      method: 'Método',
      methodNative: 'Nativo (recomendado)',
      methodDocker: 'Docker',
      port: 'Puerto',
      lanAccess: 'Acceso desde otros dispositivos de mi red',
      lanPlaceholder: 'la IP LAN de esta máquina, p. ej. 192.168.1.50',
      domain: 'Tu dominio',
      reverseProxy: 'Proxy inverso (HTTPS)',
      proxyOwn: 'Tengo el mío',
      fixedKey: 'Fijar una clave de cifrado (avanzado: haz copia de seguridad)',
      generate: 'Generar',
      copy: 'Copiar',
      copied: 'Copiado',
      copyAria: 'Copiar al portapapeles',
      blockRun: 'Ejecutar',
      blockStart: 'Iniciar',
      blockInstall: 'Instalar',
      dockerWarn: {
        title: 'Atención: la imagen Docker publicada aún no está disponible.',
        beforeImage: 'Estos comandos descargan ',
        afterImage: ', que ahora mismo no es pública en el registro, así que fallarán con ',
        or: ' o ',
        beforeLink: '. Hasta que se publique, usa la ',
        link: 'instalación nativa',
        afterLink: ' (compila en local y no necesita imagen), o construye la imagen tú mismo desde un clon del repo.',
      },
      dockerKeynote:
        '<strong>Conserva tu clave de cifrado.</strong> La clave se guarda dentro del volumen <code>hivekeep-data</code>. Si borras o recreas ese volumen sin persistir la clave (o sin fijar una <code>ENCRYPTION_KEY</code> con el interruptor avanzado de arriba), todos los secretos del vault se vuelven irrecuperables.',
      composeKeynote:
        '<strong>Conserva tu clave de cifrado.</strong> Vive en el volumen <code>hivekeep-data</code>. Recrear el volumen sin persistir la clave (o sin fijar una <code>ENCRYPTION_KEY</code> en <code>.env</code>) vuelve irrecuperable cada secreto guardado.',
      dockerRecover: {
        head: 'Si un comando falla',
        port: '<code>port is already allocated</code>: el puerto {port} está en uso. Cambia el campo Puerto de arriba y copia el comando nuevo.',
        manifest: {
          before: 'la imagen publicada aún no está disponible. Usa la ',
          link: 'instalación nativa',
          after: ' en su lugar, o compila en local.',
        },
        daemon:
          '<code>Cannot connect to the Docker daemon</code>: Docker no está en marcha. Inicia Docker Desktop, o ejecuta <code>sudo systemctl start docker</code> en Linux.',
      },
      nativeKeynote:
        '<strong>Tu clave de cifrado se gestiona por ti.</strong> El instalador la genera y la guarda automáticamente en <code>$DATA_DIR/.encryption-key</code> para que tus secretos sobrevivan a los reinicios. Haz copia de seguridad de ese archivo junto con tu base de datos. (Fija una <code>ENCRYPTION_KEY</code> con el interruptor avanzado de arriba si prefieres gestionarla tú mismo.)',
      nativeRecover: {
        head: 'Si la instalación falla',
        port: '<code>port already in use</code> / <code>EADDRINUSE</code>: el puerto {port} está ocupado. Cambia el campo Puerto de arriba y vuelve a ejecutar.',
        windows:
          '<strong>Windows</strong>: el instalador es solo para Linux y macOS. Ejecútalo dentro de <strong>WSL2</strong>, o usa Docker Desktop.',
        network:
          '<strong>¿La descarga o el clon se quedan colgados?</strong> Asegúrate de que la máquina llega a <code>github.com</code> y <code>bun.sh</code> por HTTPS (puede que un proxy los esté bloqueando).',
      },
      proxyCaddy:
        "Caddy gestiona HTTPS automáticamente (Let's Encrypt). Pon esto en tu <code>Caddyfile</code> y ejecuta <code>caddy run</code>.",
      proxyNginx: 'Un server block de nginx haciendo proxy hacia Hivekeep, y luego certbot para el HTTPS.',
      proxyOwnNote:
        'Apunta tu proxy inverso a <code>http://localhost:{port}</code>, asegúrate de que <code>PUBLIC_URL={url}</code> está definido (arriba ya lo está) y desactiva el buffering de respuestas en <code>/api/sse</code> para que los eventos server-sent fluyan sin cortes.',
      foot: 'Abre <code>{url}</code> en tu navegador. Queenie te guía con el resto (cuenta de administrador, tu primer proveedor de IA, tus primeros agentes). Sin archivos de configuración que editar.',
      envComments: {
        publicUrl: '# URL pública: usada para enlaces de invitación, webhooks, callbacks OAuth, CORS.',
        key1: '# Clave de cifrado (AES-256-GCM, 64 caracteres hex). Se genera y guarda',
        key2: '# automáticamente dentro del volumen de datos si la dejas sin definir. Definirla tú',
        key3: '# te permite respaldarla: perderla vuelve irrecuperable cada secreto del vault.',
      },
      nginxComments: {
        sse: '# SSE: transmite eventos sin buffering',
        https: '# Luego añade HTTPS:  sudo certbot --nginx -d {host}',
      },
    },
  },

  pluginsPage: {
    kicker: 'Marketplace',
    heading: 'Plugins, directos desde npm.',
    sub: 'Esta lista se obtiene automáticamente de npm: todo paquete con la etiqueta <code>hivekeep-plugin</code> aparece aquí. Instálalos con un clic desde el marketplace integrado, sin terminal.',
    count: '{count} plugins y subiendo',
    by: 'por {author}',
    downloads: '{count} descargas/mes',
    updated: 'actualizado {date}',
    viewNpm: 'npm',
    viewGithub: 'GitHub',
    publishHeading: 'Publica el tuyo.',
    publishText: 'Un plugin puede añadir <b>proveedores, canales, herramientas y hooks</b>. Crea uno (o pide a un agente que lo escriba), publícalo en npm con la palabra clave <code>hivekeep-plugin</code> y aparecerá aquí y en el marketplace integrado automáticamente.',
    publishCta: 'Leer la guía de plugins',
  },

  components: {
    marquee: {
      kicker: 'Mini-apps · creadas por tus agentes',
      heading: 'Pide una app. Recibe una app.',
      sub: 'Aplicaciones web reales que tus agentes crean y alojan dentro de Hivekeep: con tema propio, instalables y conectadas a tus herramientas y API cuando lo necesitas. Todo lo de abajo se consigue con una frase.',
      note: 'Vistas ilustrativas. Los agentes las crean, las visten y las mejoran bajo demanda: <b>«añade un gráfico»</b> es un mensaje, no un ticket.',
    },
    providers: {
      browseAll: 'Ver todos los plugins',
      kicker: 'Proveedores y plugins',
      heading: 'Trae cualquier proveedor, o añade el tuyo.',
      intro: 'Estos proveedores vienen integrados en todas las capacidades. Una configuración por proveedor, y las capacidades se detectan solas (una clave de OpenAI activa a la vez LLM, imagen, embeddings y voz). ¿Necesitas otro? Añádelo con un plugin.',
      subCallout: '<b>¿Ya pagas Claude o ChatGPT?</b> Inicia sesión con tu suscripción <b>Claude Pro/Max</b> o <b>ChatGPT</b>: tus agentes funcionan con ella, sin clave API.',
      groupLlm: 'Modelos de lenguaje',
      groupImage: 'Generación de imágenes',
      groupSearch: 'Búsqueda web',
      groupSpeech: 'Voz (STT / TTS)',
      groupEmbeddings: 'Embeddings',
      groupAccounts: 'Cuentas conectadas',
      plugNote: '¿No ves el tuyo? Instala un plugin desde npm (cualquier paquete con la etiqueta <code>hivekeep-plugin</code>) directamente desde el marketplace integrado, o pide a un agente que escriba uno. Un plugin puede añadir <b>proveedores, canales, herramientas y hooks</b>. Algunos reales:',
      tagChannel: 'canal',
      tagLlm: 'proveedor LLM',
      tagImageLlm: 'proveedor imagen / LLM',
      twilioDesc: 'Envía y recibe <b>SMS</b> a través de la API REST de Twilio y sus webhooks. Un adaptador de canal de verdad.',
      mistralDesc: 'Añade <b>Mistral AI</b> como proveedor: modelos de chat con llamadas a herramientas, visión y streaming.',
      replicateDesc: 'Trae los <b>modelos alojados en Replicate</b>: imagen (Flux), LLM (Llama 3, Mixtral) y embeddings.',
      viewGithub: 'Ver en GitHub',
    },
    agentDemo: {
      rosterTitle: '// tus agentes',
      active: '{count} activos',
      seeInAction: 'Ver a {name} en acción',
      demoTag: 'demo',
      close: 'Cerrar',
      replay: 'Repetir',
      placeholder: 'Escribe a {name}…',
      note: 'Esto es una vista previa guionizada. La versión real corre en tu servidor.',
      statusOnline: 'en línea',
      statusWorking: 'trabajando',
      statusIdle: 'inactivo',
    },
    queenieDemo: {
      cap: 'Fig. 5 · Onboarding con Queenie',
      liveDemo: 'demo en vivo',
      online: 'en línea',
      role: 'Tu guía de configuración · pone la colmena en marcha',
      placeholder: 'Escribe a Queenie…',
    },
    domains: {
      Queenie: 'Configuración y onboarding',
      Atlas: 'DevOps e infra',
      Forge: 'Desarrollo y código',
      Inbox: 'Email y calendario',
      Sentinel: 'Seguridad y pentesting',
      Prism: 'Datos y BI',
      Ledger: 'Finanzas y presupuesto',
      Quill: 'Escritura y copywriting',
      Sage: 'Investigación y síntesis',
      Pixel: 'Diseño UI/UX',
      Beacon: 'Noticias y vigilancia tech',
      Nest: 'Domótica',
      Compass: 'Planificación de viajes',
      Vitals: 'Salud y fitness',
      Cuisine: 'Recetas y comidas',
      Tutor: 'Aprendizaje y tutoría',
      Sprout: 'Jardinería y plantas',
      Lexicon: 'Traducción y localización',
      Archive: 'Documentos y organización',
      Pulse: 'Social y comunidad',
    },
  },
}

export default dict
