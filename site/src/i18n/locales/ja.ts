import en from './en'

const dict: typeof en = {
  meta: {
    plugins: {
      title: 'プラグイン',
      description: 'npm に公開されたすべての Hivekeep プラグインを一覧できます。プロバイダー、チャンネル、ツール、フックをアプリ内マーケットプレイスからワンクリックでインストール。',
    },
    home: {
      title: 'Hivekeep · あなたのAIチーム、自宅に。',
      description:
        '記憶し、協働し、自らツールを作り上げる、セルフホスト型のAIエージェントチーム。コンテナ1つ、外部インフラはゼロ。あなたのAIチームを、自宅に。',
    },
    install: {
      title: 'Hivekeepをインストール',
      description:
        'Hivekeepを好きな方法でインストール。お試しならDocker、エージェントに本当の住まいを与えるならネイティブインストール。あなたの環境にぴったりのコマンドを生成します。',
    },
  },

  nav: {
    plugins: 'プラグイン',
    features: '機能',
    household: 'ハウスホールド',
    why: 'Hivekeepの強み',
    docs: 'ドキュメント',
    github: 'GitHub ↗',
    getStarted: 'はじめる',
    configure: '設定する',
  },

  footer: {
    line: 'オープンソース · MIT · Bunで構築 · © 2026',
  },

  languages: {
    kicker: '多言語対応',
    heading: 'あなたの言語で話します。',
    p: 'インターフェースは10言語に対応。そしてエージェントはそれに縛られません。UIの言語とは関係なく、あなたが話す言語(40以上)で答えます。',
  },

  home: {
    hero: {
      meta: 'セルフホスト · MIT',
      kicker: '自律エージェントのハイブ',
      h1a: 'あなたのAIチーム。',
      h1b: '自宅に。',
      sub: '<b>記憶し</b>、<b>協働し</b>、<b>自らツールを作る</b>エージェントチームが、すべてあなたのサーバー上で動きます。チャットボットではありません。ハイブのように働くスペシャリストたちの住まいです。',
      colophon: {
        runsOnK: '動作環境',
        runsOnV: 'コンテナ1つ',
        infraK: '外部インフラ',
        infraV: 'なし',
        setupK: 'セットアップ',
        setupV: '会話だけ',
        channelsK: 'チャンネル',
        channelsV: '6種を内蔵',
      },
      ctaStart: '2分ではじめる',
      ctaDemo: 'デモを見る',
      everywhere: 'どこからでも:',
      webPwa: 'Web · PWA',
    },

    health: {
      kicker: 'GitHubからライブ',
      latestRelease: '最新リリース',
      ciPrefix: 'CI',
      ciPassing: '成功',
      ciFailing: '失敗',
      mainBranch: 'mainブランチ',
      stars: 'スター',
      openIssue: '未解決Issue',
      openIssues: '未解決Issue',
      lastCommit: '最終コミット',
      contributor: 'コントリビューター',
      contributors: 'コントリビューター',
    },

    video: {
      kicker: '実際の動きを見る',
      heading: 'コマンド1つで、ゼロから自分のチームへ。',
      sub: 'コンテナ1つ。あとはQueenieが引き継ぎます。プロバイダー、アバター、チーム一式を整え、エージェントたちがあなたのために動き始めます。',
    },

    s1memory: {
      stage: '永続記憶',
      heading: 'あなたを決して忘れません。',
      p1: '「新しい会話」はありません。1本の連続したセッションと、数か月かけて文脈を積み上げるハイブリッドメモリ。何も削除されません。古いやり取りは要約されるだけで、捨てられることはありません。',
      p2: 'エージェントは仕事を別のエージェントに引き継ぎ、あるいはサブエージェントの群れを生み出して作業を加速します。コロニーは1つの履歴と1つのアドレス帳を共有します。',
      tagSession: '連続セッション',
      tagHandoff: 'エージェント間ハンドオフ',
      figCap: '図1 · recall("grocery budget")',
      figTag: 'メモリ',
      card1: {
        cat: '決定',
        topic: '予算',
        text: '毎月の食費予算を600ドルに設定。無駄な支出を減らすことが目標。',
      },
      card2: {
        cat: '好み',
        topic: '買い物',
        text: 'プライベートブランドの定番品を好み、週末にまとめて作り置きする。',
      },
    },

    s2sovereign: {
      stage: 'データ主権',
      heading: 'コンテナ1つ。データはサーバーの外に出ません。',
      p1: 'PostgresもRedisもMongoもメッセージブローカーも不要。BunとSQLiteが1つのバイナリに収まります。あなたのデータ、あなたのキー、あなたのマシン。',
      p2: 'シークレットは暗号化されたVaultに保管。エージェントはVaultキーを参照してサービスにアクセスするだけで、<b>値そのものを読むことはなく</b>、だから<b>LLMに渡ることもありません</b>。',
      termComment: '# あとはブラウザを開くだけ。残りはQueenieが引き受けます。',
      specs: {
        footprintK: 'フットプリント',
        footprintV: 'プロセス1つ · SQLiteファイル1つ',
        infraK: '外部インフラ',
        infraV: 'なし',
        secretsK: 'シークレット',
        secretsV: 'AES-256-GCM Vault、参照のみ',
        dataK: 'データとキー',
        dataV: 'あなたのハードウェア上に、あなたのものとして',
      },
    },

    s3extensible: {
      stage: '自己進化',
      heading: 'エージェント自身がプラットフォームを拡張します。',
      shotAlt: '会話内にテーマ付きカードとして表示された天気ツール',
      p1: 'エージェントは好きな言語で、独自の依存関係を持つツールを書き、結果を<b>生のJSONではなくテーマ付きカード</b>として表示するレンダラーまで用意します。ダッシュボードやコントロールパネルといった本格的なミニアプリをHivekeepの中に直接構築し、NPMプラグインとして公開することもできます。',
      p2: '<b>ツールボックス</b>で各エージェントのスコープを絞れば、専任のエージェントは必要なツールだけを見ることになり、切れ味が保たれ、より軽いモデルでも仕事をこなせます。',
      tagCustomTools: 'カスタムツール',
      tagMiniApps: 'ミニアプリ',
      tagNpm: 'NPMプラグイン',
      tagMcp: 'MCP',
      tagToolboxes: 'ツールボックス',
    },

    s4channels: {
      stage: 'どこでも',
      heading: 'チーム全体に、受信箱は1つ。',
      p1: '使い慣れたメッセージアプリから、どのエージェントにも話しかけられます。担当外の依頼でも、応対中のエージェントが<b>適切なスペシャリストにリクエストを引き渡し</b>、答えを中継します。指名すれば、<b>チャンネルそのものをリアルタイムで引き継ぎます</b>。コマンドも、アプリの切り替えも不要です。',
      shotAlt: '担当違いのエージェントに送られたスマートホームの依頼が、担当のスペシャリストへ転送され、照明が消される様子',
    },

    s5pocket: {
      stage: 'モバイル',
      heading: 'ハイブまるごと、ポケットの中に。',
      p1: 'Hivekeepはスマートフォンでも本物のアプリ。<b>ブラウザから直接インストール</b>でき、アプリストアも、どこかのアカウント登録も、追加のデプロイも不要です。フルスクリーン表示、ホーム画面のアイコン、そしてきちんと動く<b>未読バッジ</b>。',
      p2: 'しかもデスクトップと<b>同じライブセッション</b>。デスクに届いた答えは、すでにスマートフォンにもあります。<b>音声</b>で返信し、写真を送り、ソファからエージェントのプランを承認できます。',
      tagPwa: 'インストール可能なPWA',
      tagDesktopMobile: 'デスクトップ + モバイル',
      tagBadges: '未読バッジ',
      tagVoice: '音声の入出力',
      phone: {
        aria: 'スマートフォンにインストールされたアプリとして動作するHivekeep',
        online: 'オンライン',
        userBubble: 'これから帰るよ、部屋を心地よくしておいて 🛋️',
        tool1Name: '暖房を設定',
        tool1Detail: ' · リビング → 21.5°',
        tool2Name: 'シーン',
        tool2Detail: ' · イブニング',
        agentBubble: '暖房を入れて、照明を<strong>イブニング</strong>にしました。道路状況だと18分です。オーブンの予熱もしておきますか?',
        inputPlaceholder: 'Nestにメッセージ…',
      },
      chipInstallB: 'ブラウザからインストール',
      chipInstallI: 'アプリストア不要',
      chipBadgesB: '未読バッジ',
      chipBadgesI: 'ホーム画面に',
      chipSyncB: 'デスクトップと同期',
      chipSyncI: '1つのライブセッション',
    },

    s6transparency: {
      stage: '透明性',
      heading: 'ブラックボックスなし。コストの不意打ちもなし。',
      p1: 'モデルに何が送られているかを正確に確認できます。システムプロンプトのブロック単位の内訳、<b>エージェント別・モデル別</b>のトークンコスト、そしてプロンプトキャッシュの読み取り/書き込み/新規の内訳とヒット率。Hivekeepは、何を送り、いくら使っているかについて、どのプロバイダーでも並外れて正直です。',
      tagCost: 'エージェント別トークンコスト',
      tagPreview: 'コンテキストプレビュー',
      figCap: '図4 · コンテキストビューア',
      figTag: 'トークン',
      barTools: 'ツール',
      barMemory: 'メモリ',
      barIdentity: 'アイデンティティ',
      barChannels: 'チャンネル',
      cacheTitle: 'プロンプトキャッシュ · ウォーム · 残り4:12',
      cacheHit: 'ヒット率72%',
      legendRead: '読み取り 9.1k',
      legendWrite: '書き込み 1.2k',
      legendFresh: '新規 2.4k',
    },

    s7setup: {
      stage: 'セットアップ',
      heading: 'セットアップはYAMLファイルではなく、会話です。',
      p1: 'セットアップ担当エージェントのQueenieが、あなたと会話しながらプロバイダーを接続し、シークレットを安全に保管し、最初のエージェントたちを作成します。その後もずっとそばにいて、エージェントの追加や新しいプロバイダーの接続をいつでも引き受けます。',
      tagSecure: 'セキュア入力 → Vault',
      tagGenerates: 'エージェントを自動生成',
    },

    s8household: {
      stage: '実例',
      heading: 'あなたの暮らしに合わせたハウスホールドを。',
      p1: 'Hivekeepに最初から入っているエージェントは1人だけ。セットアップ案内役の<b>Queenie</b>です。残りはあなたが作るか、Queenieに頼んで作ってもらいましょう。それぞれが固有の名前、専門領域、メモリ、ツール、そして生成されたアバターを持ちます。',
      p2: 'アバターはHivekeepの<b>デフォルトのアートスタイル</b>で生成されるので、作りたてのハイブにも最初から統一感があります。自分らしい見た目にしたいなら、<b>カスタムアバタースタイル</b>を一度設定するだけ。ピクセルアートでも、水彩でも、自分のブランドでも、すべてのエージェントがそのスタイルで再生成され、チーム全体のテーマが揃います。',
      examplesNote: 'みんなが作っているハウスホールドの例 →',
      builtIn: '内蔵',
      eg: '例:',
    },

    morefx: {
      kicker: '内部のしくみ',
      heading: 'さらに{count}個の機能。',
      sub: '以下はすべて標準搭載。アドオンも有料プランもありません。',
      categories: [
        {
          label: 'エージェントとコラボレーション',
          icon: 'users',
          cards: [
            {
              title: 'エージェント同士の対話',
              blurb: 'スペシャリストたちは<b>リクエスト/リプライ</b>パターンで互いにメッセージを交わします。1人に尋ねれば、自発的に別のエージェントへ相談しに行く様子が見られます。',
              icon: 'messages-square',
            },
            {
              title: 'サブエージェントへの委任',
              blurb: 'エージェントは重い仕事のために使い捨てのサブエージェントを生成します(<b>ブロッキングまたは並列</b>)。同時実行数の上限つきで、整理されたレポートが返ってきます。',
              icon: 'git-branch',
            },
            {
              title: 'スカウトモード',
              blurb: '読み取り専用のリサーチを<b>安くて速いモデル</b>に委任し、フラッグシップのトークンを燃やさずにダイジェストを受け取れます。',
              icon: 'binoculars',
            },
            {
              title: '内蔵CRM',
              blurb: 'エージェントはメモや好みを添えた連絡先帳を自動で育てます。<b>iCloudとCardDAV</b>からの読み取り専用同期にも対応。',
              icon: 'users',
            },
          ],
        },
        {
          label: '自動化',
          icon: 'workflow',
          cards: [
            {
              title: '学習するcron',
              blurb: 'スケジュールジョブはcronでエージェントを起動し、<b>実行ジャーナル</b>を残し、学んだことを保存して以降の実行を毎回改善します。',
              icon: 'calendar-clock',
            },
            {
              title: '受信Webhook',
              blurb: 'あらゆるHTTPイベントでエージェントを起こせます。<b>ペイロードフィルタリング</b>(ドットパスまたは正規表現)、レート制限、リクエストログつき。',
              icon: 'webhook',
            },
            {
              title: 'メールトリガー',
              blurb: 'ルールに一致した受信メールが、適切なエージェントを自動で起こします。普段の会話の中でも、<b>独立したタスク</b>としても。',
              icon: 'mail-check',
            },
            {
              title: 'ウェイクアップタイマー',
              blurb: 'エージェントは自分の将来の仕事を自分で予約します(<b>「2時間後に起こして」</b>)。フォローアップやリマインダーが確実に実行されます。',
              icon: 'alarm-clock',
            },
            {
              title: 'エージェントが回すカンバン',
              blurb: '仕事をプロジェクトとチケットに整理し、<b>チケットをエージェントに割り当て</b>。エージェントが実行し、コメントで報告します。',
              icon: 'kanban',
            },
          ],
        },
        {
          label: 'メモリとコンテキスト',
          icon: 'brain-circuit',
          cards: [
            {
              title: '終わらない1つの会話',
              blurb: '「新しいチャット」ボタンはありません。古いメッセージは<b>日付つきの要約</b>に圧縮され、原文はデータベースに安全に残ります。',
              icon: 'infinity',
            },
            {
              title: '自己整理するメモリ',
              blurb: '記憶は統合され、使用状況で再スコアリングされ、古びたものは刈り込まれます。想起は<b>溜め込まず、鋭いまま</b>。',
              icon: 'brain',
            },
            {
              title: 'ナレッジベース',
              blurb: 'ドキュメントは一度アップロードするだけ。話題に上がるたび、関連する抜粋が<b>自動でコンテキストに</b>浮かび上がります。',
              icon: 'book-open',
            },
            {
              title: 'プロジェクトナレッジ',
              blurb: '各プロジェクトは精選された事実、決定事項、落とし穴を保持します。<b>ピン留めされたエントリ</b>はエージェントの毎ターンに同行します。',
              icon: 'notebook-pen',
            },
            {
              title: '検索できる過去',
              blurb: 'エージェントは<b>セマンティック + 全文検索</b>のランク融合で全履歴を検索します。一度話したことが本当に失われることはありません。',
              icon: 'history',
            },
          ],
        },
        {
          label: 'つながる世界',
          icon: 'globe',
          cards: [
            {
              title: 'メールはおまかせ',
              blurb: '<b>Gmail、Outlook、iCloud、IMAP</b>をまたいで読み、検索し、送信。送信メールには承認モードも用意。',
              icon: 'mail',
            },
            {
              title: 'カレンダー操作',
              blurb: 'エージェントがあなたに代わって<b>Google、Outlook、CalDAV</b>のカレンダーで予定を作成、更新、検索します。',
              icon: 'calendar-days',
            },
            {
              title: '本物のブラウザ自動化',
              blurb: 'エージェントは<b>ステートフルなブラウザ</b>を操作し(ログイン、フォーム入力、クリック、スクリーンショット)、セッションを次回のために保存します。',
              icon: 'mouse-pointer-click',
            },
            {
              title: 'Web検索と閲覧',
              blurb: '差し替え可能な検索バックエンド(<b>Brave、Tavily、SerpAPI、Perplexity</b>)に加えて、ページ取得、リンク抽出、スクリーンショット。',
              icon: 'globe',
            },
            {
              title: '音声で話し、声で聞く',
              blurb: '設定済みの任意のプロバイダーで音声認識と<b>音声合成</b>。エージェントに話しかけ、声で答えを聞けます。',
              icon: 'mic',
            },
          ],
        },
        {
          label: 'コントロールと信頼',
          icon: 'shield',
          cards: [
            {
              title: '暗号化Vault',
              blurb: 'シークレットは<b>AES-256-GCM</b>で保管され、プロンプトに注入されることはありません。エージェントはスコープを絞ったツール経由でのみ取得します。',
              icon: 'key-round',
            },
            {
              title: 'シークレットはLLMを通らない',
              blurb: 'キーはモデルを完全にバイパスする<b>セキュアポップアップ</b>で入力します。漏れてしまった値も、後から墨消しできます。',
              icon: 'shield-check',
            },
            {
              title: 'ヒューマンインザループ',
              blurb: 'エージェントは行動の前に立ち止まって尋ねます。ブロッキングプロンプト、<b>承認ゲート</b>、さらには自動化の途中でのCAPTCHA引き継ぎまで。',
              icon: 'hand',
            },
            {
              title: '共有ハウスホールド',
              blurb: '家族やチームメイトを1つのインスタンスに招待。全員でエージェントを共有し、エージェントは<b>誰が話しているか</b>を把握します。',
              icon: 'users-round',
            },
            {
              title: '巻き戻しとエクスポート',
              blurb: 'メッセージを削除し、会話を任意の時点まで<b>巻き戻し</b>、すべてをMarkdownやJSONでエクスポート。履歴の扱いはあなた次第です。',
              icon: 'undo-2',
            },
          ],
        },
        {
          label: '体験',
          icon: 'sparkles',
          cards: [
            {
              title: '18のカラーパレット',
              blurb: 'AuroraからCitrusまで。ライト、ダーク、ソフトコントラストの各モードを備えた<b>18のパレット</b>がワンクリックで切り替わります。',
              icon: 'palette',
            },
            {
              title: 'どこにでもインストール',
              blurb: '本格的な<b>PWA</b>。デスクトップでもスマートフォンでもインストールでき、未読バッジが届き、デバイス間でリアルタイムに同期します。',
              icon: 'smartphone',
            },
            {
              title: 'クイックセッション',
              blurb: '<b>セッション単位のモデル上書き</b>ができる使い捨てのサイドチャット。自由に実験して、良い部分だけをメモリとして保存できます。',
              icon: 'zap',
            },
            {
              title: 'メッセージ単位のコントロール',
              blurb: 'モデルと<b>思考の深さ</b>を1つのメッセージだけ上書き。コンポーザーからそのまま操作できます。',
              icon: 'sliders-horizontal',
            },
            {
              title: 'ワークスペースのファイルブラウザ',
              blurb: 'エージェントが生み出すすべてのファイルを閲覧、編集、共有。<b>タブ、競合検出</b>、ドラッグ&ドロップ、チャット内のクリックできるパス。',
              icon: 'folder',
            },
            {
              title: '画像とアバター',
              blurb: 'エージェントはオンデマンドで<b>画像を生成・編集</b>します。チーム全員分の、一貫したスタイルのアバターも。',
              icon: 'image',
            },
          ],
        },
      ],
    },

    why: {
      kicker: 'Hivekeepの強み',
      heading: '近いプロジェクトと並べてみる。',
      intro:
        '<b>OpenClaw</b>や<b>Hermes</b>のようなセルフホスト型AIアシスタントは優れたプロダクトです。メモリ、オムニチャネル対応、セルフホスティングでは互角に強い。Hivekeepが一歩先を行くのは、<b>チーム</b>であること、<b>磨き込まれたプロダクトUI</b>、そして<b>透明性</b>です。',
      rows: [
        'セルフホスト、データは自分のもの',
        '永続メモリ',
        'ネイティブなオムニチャネル',
        '接続アカウント(メール、カレンダー)',
        'エージェントが自らツール/スキルを構築',
        'スケジュールタスク(cron)',
        '協働するエージェントチーム',
        '磨き込まれたWebアプリ(PWA)',
        'ツール呼び出しのUI表示(JSONではなく)',
        'ミニアプリとプロジェクト(カンバン)',
        '会話によるセットアップ(CLI不要)',
        'シークレットをLLMに送らない',
        'トークンとコンテキストの透明性',
      ],
      legend: '✓ ネイティブ対応 · ✕ 実質非対応 · 残りは部分対応または不明。評価は公開ドキュメントに基づくベストエフォートです。',
    },

    getstarted: {
      kicker: 'はじめる',
      heading: '2分で、あなたのチームが動き出す。',
      p: 'LinuxまたはmacOSマシンにコマンドを1つ貼り付けるだけ。すべてをインストールし、ブラウザが開いたら<b>Queenie</b>が残りを案内します。',
      recTag: 'いちばん簡単なインストール方法',
      needCustom: 'カスタムポート、独自ドメイン、Dockerが必要ですか?',
      seeAll: 'すべてのインストール方法を見る',
      installBtn: 'Hivekeepをインストール',
      starBtn: 'GitHubでスターする',
      copyAria: 'コマンドをコピー',
    },
  },

  install: {
    intro: {
      kicker: 'インストール',
      heading: 'Hivekeepを動かす。',
      p: 'コマンド1つですべて完了。起動したら<b>Queenie</b>が会話で残りをセットアップするので、編集すべき設定ファイルはありません。',
    },

    rec: {
      tag: '推奨 · いちばん簡単な方法',
      heading: '1行貼り付けるだけ。以上です。',
      p: 'LinuxまたはmacOSマシンのターミナルで実行してください。必要なものをすべてインストールします。',
      copyAria: 'インストールコマンドをコピー',
      copy: 'コピー',
      copied: 'コピーしました',
      then: '完了したら、表示されたリンクをブラウザで開いてください。<b>残りはQueenieにおまかせ。</b>',
    },

    configure: {
      kicker: 'オプション',
      heading: 'カスタムポート、ドメイン、Dockerが必要ですか?',
      p: '上のワンライナーで十分なら、ここは飛ばして構いません。必要なら、いくつかの質問に答えるだけで、あなたの環境にぴったりのコマンドを生成します。',
    },

    more: {
      label: '高度な設定とその他の選択肢',
      hint: '前提条件と、Docker / ネイティブ / ソースの比較',
    },

    prereqs: {
      kicker: 'はじめる前に',
      heading: 'ワンライナーに必要なもの。',
      sub: 'ほとんどのマシンにはすでにすべて揃っています。',
      items: [
        {
          icon: 'lucide:shield',
          title: 'sudoが使えること',
          desc: '不足しているシステムパッケージ(git、curl、unzip)のインストールに必要です。',
        },
        {
          icon: 'lucide:hard-drive',
          title: '約500 MBの空きディスク',
          desc: 'クローンとビルドのための領域です。1 GB以上あれば余裕です。',
        },
        {
          icon: 'lucide:cpu',
          title: '64ビットのマシン',
          desc: 'x86_64またはARM64。32ビット(古いRaspberry Pi)は非対応です。',
        },
        {
          icon: 'lucide:globe',
          title: '外向きのHTTPS',
          desc: 'github.comとbun.shからダウンロードするため、両方に到達できる必要があります。',
        },
        {
          icon: 'lucide:key-round',
          title: 'opensslがあること',
          desc: 'キーの生成に使います。ほぼすべてのLinuxとmacOSに同梱されています。',
        },
      ],
      windows:
        '<b>Windowsをお使いですか?</b> ネイティブインストーラーはWindows上では直接動きません。<b>WSL2</b>(Linuxディストリビューションの中でワンライナーを実行)か、<b>Docker Desktop</b>をお使いください。',
    },

    compare: {
      kicker: '比較',
      heading: 'ネイティブ、Docker、それともソースから?',
      sub: '3つとも動くアプリはまったく同じ。違いは、マシン上での住まい方です。',
    },

    methods: [
      {
        tag: '推奨',
        name: 'ネイティブ(install.sh)',
        pick: 'とにかく動いてほしい方はこちら。自分のLinuxまたはmacOSマシンで、コマンド1つ。',
        points: [
          ['y', 'コマンド1つでローカルにビルド、イメージの公開や取得は不要'],
          ['y', '暗号化キーを自動で保存、シークレットが永続化される'],
          ['y', 'サービスとして稼働(systemd / launchd)、ロールバックつき自動更新'],
          ['y', 'エージェントがマシンを使いこなす: ツールや依存関係のインストール、ハードウェアへの直接アクセス'],
          ['n', 'ホストシステムに変更を加える(設計どおりの挙動)'],
          ['n', 'LinuxとmacOSのみ(WindowsはWSL2経由)'],
        ],
      },
      {
        tag: 'コンテナ',
        name: 'Docker',
        pick: 'すでにDockerで暮らしていて、クリーンでサンドボックス化されたアプライアンスが欲しい方はこちら。',
        points: [
          ['y', '完全に隔離され、ホストをまったく汚さない'],
          ['y', 'Dockerが動く場所ならどこでも動く(Windowsを含む)'],
          ['n', '公開イメージはまだ利用できないため、当面はネイティブを推奨'],
          ['n', 'エージェントがインストールしたツールやバイナリは再起動で消える'],
          ['n', 'データボリュームを永続化しないとシークレットを失う'],
        ],
      },
      {
        tag: 'ソースから',
        name: '手動',
        pick: 'コードを読みたい、いじりたい、自分のやり方で動かしたい方はこちら。',
        points: [
          ['y', '完全なコントロール: 自分でクローンし、ビルドし、Bunで実行'],
          ['y', 'コントリビューターと開発作業に最適'],
          ['n', 'サービスも自動更新もなし、配線は自分で行う'],
          ['n', 'Bun、ビルド、マイグレーション、暗号化キーをすべて手動で管理'],
        ],
      },
    ],

    configurator: {
      step1: '1 · どう使いますか?',
      step2: '2 · 設定',
      step3: '3 · 実行',
      useCases: {
        try: { label: 'ちょっと試したい', hint: 'このマシンで、localhostのみで実行。設定はゼロ。' },
        permanent: {
          label: 'このマシンに常設する',
          hint: 'エージェントの長く続く住まいに。他のデバイスからのアクセスも任意で。',
        },
        server: { label: 'ドメインつきのサーバー', hint: '公開、HTTPS、独自ドメインでアクセス可能。' },
      },
      method: '方式',
      methodNative: 'ネイティブ(推奨)',
      methodDocker: 'Docker',
      port: 'ポート',
      lanAccess: 'ネットワーク内の他のデバイスからアクセスする',
      lanPlaceholder: 'このマシンのLAN IP(例: 192.168.1.50)',
      domain: 'あなたのドメイン',
      reverseProxy: 'リバースプロキシ(HTTPS)',
      proxyOwn: '自前で用意済み',
      fixedKey: '固定の暗号化キーを設定する(上級者向け: バックアップを忘れずに)',
      generate: '生成',
      copy: 'コピー',
      copied: 'コピーしました',
      copyAria: 'クリップボードにコピー',
      blockRun: '実行',
      blockStart: '起動',
      blockInstall: 'インストール',
      dockerWarn: {
        title: 'ご注意: 公開Dockerイメージはまだ利用できません。',
        beforeImage: 'これらのコマンドは ',
        afterImage: ' を取得しますが、現時点ではレジストリに公開されていないため、',
        or: ' または ',
        beforeLink: ' で失敗します。公開されるまでは、',
        link: 'ネイティブインストール',
        afterLink: '(ローカルでビルドするためイメージ不要)を使うか、リポジトリをクローンして自分でイメージをビルドしてください。',
      },
      dockerKeynote:
        '<strong>暗号化キーは必ず保管してください。</strong>キーは<code>hivekeep-data</code>ボリュームの中に保存されます。キーを残さないまま(または上の上級者向けトグルで固定の<code>ENCRYPTION_KEY</code>を設定しないまま)そのボリュームを削除・再作成すると、Vaultのすべてのシークレットが復元不能になります。',
      composeKeynote:
        '<strong>暗号化キーは必ず保管してください。</strong>キーは<code>hivekeep-data</code>ボリュームの中にあります。キーを残さず(または<code>.env</code>で固定の<code>ENCRYPTION_KEY</code>を設定せず)にボリュームを再作成すると、保存済みのすべてのシークレットが復元不能になります。',
      dockerRecover: {
        head: 'コマンドが失敗したら',
        port: '<code>port is already allocated</code>: ポート{port}が使用中です。上のポート欄を変更して、新しいコマンドをコピーしてください。',
        manifest: {
          before: '公開イメージはまだ利用できません。代わりに',
          link: 'ネイティブインストール',
          after: 'を使うか、ローカルでビルドしてください。',
        },
        daemon:
          '<code>Cannot connect to the Docker daemon</code>: Dockerが起動していません。Docker Desktopを起動するか、Linuxでは<code>sudo systemctl start docker</code>を実行してください。',
      },
      nativeKeynote:
        '<strong>暗号化キーは自動で面倒を見ます。</strong>インストーラーが自動生成して<code>$DATA_DIR/.encryption-key</code>に保存するため、再起動してもシークレットは失われません。そのファイルはデータベースと一緒にバックアップしてください。(自分で管理したい場合は、上の上級者向けトグルで固定の<code>ENCRYPTION_KEY</code>を設定できます。)',
      nativeRecover: {
        head: 'インストールが失敗したら',
        port: '<code>port already in use</code> / <code>EADDRINUSE</code>: ポート{port}が使用中です。上のポート欄を変更して、再実行してください。',
        windows:
          '<strong>Windows</strong>: インストーラーはLinuxとmacOS専用です。<strong>WSL2</strong>の中で実行するか、Docker Desktopをお使いください。',
        network:
          '<strong>ダウンロードやクローンが進まない場合</strong>: マシンがHTTPSで<code>github.com</code>と<code>bun.sh</code>に到達できることを確認してください(プロキシがブロックしている可能性があります)。',
      },
      proxyCaddy:
        "CaddyはHTTPSを自動で処理します(Let's Encrypt)。これを<code>Caddyfile</code>に書いて<code>caddy run</code>を実行してください。",
      proxyNginx: 'Hivekeepへプロキシするnginxのserverブロックを設定し、その後certbotでHTTPSを有効化します。',
      proxyOwnNote:
        'リバースプロキシの向き先を<code>http://localhost:{port}</code>にし、<code>PUBLIC_URL={url}</code>が設定されていることを確認してください(上のコマンドにはすでに含まれています)。さらに、Server-Sent Eventsがストリーミングされるよう、<code>/api/sse</code>のレスポンスバッファリングを無効にしてください。',
      foot: 'ブラウザで<code>{url}</code>を開いてください。あとはQueenieが案内します(管理者アカウント、最初のAIプロバイダー、最初のエージェント)。編集すべき設定ファイルはありません。',
      envComments: {
        publicUrl: '# 公開URL: 招待リンク、Webhook、OAuthコールバック、CORSに使用されます。',
        key1: '# 暗号化キー(AES-256-GCM、16進64文字)。未設定のままにすると自動生成され、',
        key2: '# データボリューム内に保存されます。自分で設定すればバックアップできます。',
        key3: '# キーを失うと、Vaultのすべてのシークレットが復元不能になります。',
      },
      nginxComments: {
        sse: '# SSE: バッファリングなしでイベントをストリーミング',
        https: '# 続いてHTTPSを追加:  sudo certbot --nginx -d {host}',
      },
    },
  },

  pluginsPage: {
    kicker: 'マーケットプレイス',
    heading: 'プラグインは npm から直接。',
    sub: 'このリストは npm から自動で取得されます。<code>hivekeep-plugin</code> タグの付いたパッケージはすべてここに表示されます。アプリ内マーケットプレイスからワンクリックでインストールでき、ターミナルは不要です。',
    count: '{count} 個のプラグイン、さらに増加中',
    by: '作者: {author}',
    downloads: '{count} ダウンロード/月',
    updated: '更新: {date}',
    viewNpm: 'npm',
    viewGithub: 'GitHub',
    publishHeading: 'あなたのプラグインを公開。',
    publishText: 'プラグインは<b>プロバイダー、チャンネル、ツール、フック</b>を追加できます。自分で作るか、エージェントに書かせて、<code>hivekeep-plugin</code> キーワード付きで npm に公開すれば、ここにもアプリ内マーケットプレイスにも自動で表示されます。',
    publishCta: 'プラグインガイドを読む',
  },

  components: {
    marquee: {
      kicker: 'ミニアプリ · あなたのエージェントが作る',
      heading: 'アプリを頼む。アプリが届く。',
      sub: 'エージェントが Hivekeep の中で作ってホストする本物のウェブアプリです。テーマが適用され、インストールでき、必要ならあなたのツールや API ともつながります。下にあるものはすべて、ひと言で手に入る類のものです。',
      note: 'イメージ用のプレビューです。エージェントはリクエストに応じて作成・装飾・改善します。<b>「グラフを追加して」</b>はメッセージひとつで済み、チケットは要りません。',
    },
    providers: {
      browseAll: 'すべてのプラグインを見る',
      kicker: 'プロバイダーとプラグイン',
      heading: 'どのプロバイダーでも。自作の追加も。',
      intro: 'これらのプロバイダーはすべての機能に組み込み済みです。プロバイダーごとに設定はひとつ、機能は自動検出されます（OpenAI のキーひとつで LLM・画像・埋め込み・音声が一度に使えます）。他のものが必要なら、プラグインで追加できます。',
      subCallout: '<b>すでに Claude や ChatGPT を契約していますか?</b> <b>Claude Pro/Max</b> や <b>ChatGPT</b> のサブスクリプションでサインインすれば、API キーなしでエージェントがその上で動きます。',
      groupLlm: '言語モデル',
      groupImage: '画像生成',
      groupSearch: 'ウェブ検索',
      groupSpeech: '音声 (STT / TTS)',
      groupEmbeddings: '埋め込み',
      groupAccounts: '連携アカウント',
      plugNote: 'お使いのものが見当たりませんか? npm のプラグイン（<code>hivekeep-plugin</code> タグ付きのもの）をアプリ内マーケットプレイスから直接インストールするか、エージェントに書かせることもできます。プラグインは<b>プロバイダー、チャンネル、ツール、フック</b>を追加できます。実例をいくつか:',
      tagChannel: 'チャンネル',
      tagLlm: 'LLM プロバイダー',
      tagImageLlm: '画像 / LLM プロバイダー',
      twilioDesc: 'Twilio の REST API とウェブフックで <b>SMS</b> を送受信。本物のチャンネルアダプターです。',
      mistralDesc: '<b>Mistral AI</b> をプロバイダーとして追加。ツール呼び出し・ビジョン・ストリーミング対応のチャットモデルです。',
      replicateDesc: '<b>Replicate ホストのモデル</b>を利用可能に。画像 (Flux)、LLM (Llama 3、Mixtral)、埋め込みに対応。',
      viewGithub: 'GitHub で見る',
    },
    agentDemo: {
      rosterTitle: '// あなたのエージェント',
      active: '{count} 体が稼働中',
      seeInAction: '{name} の実演を見る',
      demoTag: 'デモ',
      close: '閉じる',
      replay: 'もう一度再生',
      placeholder: '{name}にメッセージ…',
      note: 'これは台本どおりのプレビューです。本物はあなたのサーバーで動きます。',
      statusOnline: 'オンライン',
      statusWorking: '作業中',
      statusIdle: '待機中',
    },
    queenieDemo: {
      cap: '図5 · Queenie のオンボーディング',
      liveDemo: 'ライブデモ',
      online: 'オンライン',
      role: 'セットアップガイド · ハイブを立ち上げます',
      placeholder: 'Queenie にメッセージ…',
    },
    domains: {
      Queenie: 'セットアップとオンボーディング',
      Atlas: 'DevOps とインフラ',
      Forge: '開発とコード',
      Inbox: 'メールとカレンダー',
      Sentinel: 'セキュリティとペンテスト',
      Prism: 'データと BI',
      Ledger: '家計と予算',
      Quill: '文章とコピー',
      Sage: 'リサーチと整理',
      Pixel: 'UI/UX デザイン',
      Beacon: 'ニュースと技術ウォッチ',
      Nest: 'ホームオートメーション',
      Compass: '旅行プラン',
      Vitals: '健康とフィットネス',
      Cuisine: 'レシピと食事',
      Tutor: '学習と家庭教師',
      Sprout: 'ガーデニングと植物',
      Lexicon: '翻訳とローカライズ',
      Archive: '資料と整理整頓',
      Pulse: 'SNS とコミュニティ',
    },
  },
}

export default dict
