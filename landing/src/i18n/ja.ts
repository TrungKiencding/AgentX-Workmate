import { LINKS } from '../lib/links'
import type { Dictionary } from './types'

export const ja: Dictionary = {
  meta: {
    title: 'AgentX Workmate — 自分のマシンで動く AI の同僚',
    description:
      '自分で学習していく AI エージェントが、あなたのマシンの上で動きます。本物のターミナルを開き、ファイルを読み書きし、難しい仕事を終えるたびに新しいスキルを書き残し、Telegram や Discord、Slack から返事をします。MIT ライセンスのオープンソース。'
  },

  nav: {
    features: 'できること',
    how: 'はじめかた',
    download: 'ダウンロード',
    docs: 'ドキュメント',
    openMenu: 'メニューを開く',
    closeMenu: 'メニューを閉じる',
    language: '言語',
    skipToContent: '本文へ移動'
  },

  hero: {
    headline: '自分のマシンで動く、AI の同僚。',
    lede: 'AgentX Workmate は本物のターミナルを開き、指定したフォルダのファイルを読み書きし、そのやり方をスキルとして次回のために書き残します。席を離れたら Telegram から続きを話しかけてください。',
    primaryCta: 'ダウンロード',
    secondaryCta: 'ソースを見る',
    installLabel: 'macOS · Linux · WSL2',
    installNote: 'Windows は PowerShell — コマンドはダウンロードの節にあります。',
    copy: 'コマンドをコピー',
    copied: 'コピーしました',
    markAlt: 'AgentX Workmate のマーク'
  },

  facts: [
    { value: '18', label: '言語', note: 'このページだけでなく、エージェント自身が話します' },
    { value: '6', label: 'チャット経路', note: 'Telegram、Discord、Slack、WhatsApp、Signal、CLI' },
    { value: '7', label: '実行環境', note: '手元のノート PC からコンテナ、リモートホストまで' },
    { value: 'MIT', label: 'ライセンス', note: '一行残らず GitHub で公開しています' }
  ],

  comparison: {
    title: '自分で組み上げるか、組み上がったところから始めるか',
    lede: '下の行はどれも自分で作れます。問題は、どの行に何週間かけるかです。',
    columnDiy: '自前でエージェントを組む',
    columnProduct: 'AgentX Workmate',
    rows: [
      {
        subject: 'モデル接続',
        diy: 'プロバイダごとにアダプタを書き、片方が落ちたときの退避も自分で用意する',
        product: 'agentx model から選ぶだけ — Nous Portal、OpenRouter、OpenAI、Anthropic、Ollama、自前のエンドポイント'
      },
      {
        subject: 'コマンド実行',
        diy: 'まずサンドボックスを作り、どのコマンドを許すか自分で決める',
        product: '実行環境が七つ最初から: local、Docker、SSH、Singularity、Modal、Daytona、Vercel Sandbox'
      },
      {
        subject: '記憶',
        diy: '保存の形も、あとで見つけ出す仕組みも自分で設計する',
        product: 'エージェント自身が手入れする記憶と、何か月も前に閉じたセッションまで届く全文検索'
      },
      {
        subject: 'スキル',
        diy: 'プロンプト集を貯め、必要な瞬間にそれを思い出せることを祈る',
        product: '難しい仕事のあとにエージェントがスキルを書き、使いながら自分で直していく'
      },
      {
        subject: 'メッセージ',
        diy: 'プラットフォームごとにボットを一つずつ、それぞれ面倒を見る',
        product: '六つの経路をひとつのゲートウェイが担当し、会話はその間で途切れません'
      },
      {
        subject: '定期実行',
        diy: 'cron を仕込み、スクリプトを書き、結果の届け先も自分で解決する',
        product: '組み込みのスケジューラ。ふつうの言葉で書けば、指定した経路に結果が届きます'
      },
      {
        subject: '操作画面',
        diy: 'ターミナルのチャットループを、作ったところまで',
        product: '本格的な TUI、macOS・Windows・Linux のデスクトップアプリ、そして Web ダッシュボード'
      }
    ]
  },

  capabilities: {
    title: '実際に何をするのか',
    lede: 'ボタンを足したチャット欄ではありません。ウィンドウを閉じたあとも動き続けるものです。',
    tiles: [
      {
        key: 'terminal',
        title: '絵ではなく、本物のターミナル',
        body: '複数行の編集、スラッシュコマンドの補完、流れてくるツール出力、そして文脈を保ったまま途中で割り込んで方向を変えられること。セッション履歴もすぐ横にあります。',
        meta: 'TUI'
      },
      {
        key: 'memory',
        title: '意図して残す記憶',
        body: '大事なことは書き留めるよう、エージェントが自分を促します。ずっと前に閉じたセッションからでも探し出せます。'
      },
      {
        key: 'skills',
        title: '自分で書くスキル',
        body: '難しい仕事を終えると、そのやり方をスキルとして書き残します。次からはそれを取り出し、必要なら直します。'
      },
      {
        key: 'browser',
        title: 'ブラウザ操作',
        body: 'WebMate はインストーラに同梱で、拡張機能ストアを経由しません。エージェントは自分専用のブラウザでページを読み、フォームを埋め、ボタンを押します。',
        meta: 'WebMate'
      },
      {
        key: 'cron',
        title: '決まった時刻の仕事',
        body: '月曜朝のレポート、深夜のバックアップ、週末の点検 — 一文で伝えれば、席にいない間に動きます。'
      },
      {
        key: 'subagents',
        title: '仕事を分ける',
        body: 'それぞれの文脈で並行して動くサブエージェントを立て、結果を一か所に集めます。'
      },
      {
        key: 'voice',
        title: '聞くことも、話すことも',
        body: 'スマートフォンから音声メモを送れば、エージェントが文字に起こして取りかかります。望むなら声で返します。'
      },
      {
        key: 'mcp',
        title: 'MCP とプラグイン',
        body: 'MCP サーバー、プラグイン、自作のツールセットを追加できます。スキルは agentskills.io の標準に沿っています。'
      },
      {
        key: 'local',
        title: '手元のマシンに留まります',
        body: 'アカウント登録も、誰かのサーバーの順番待ちもありません。ファイルはあなたが選んだフォルダのままです。'
      }
    ]
  },

  loop: {
    title: '使うほど、言い直す回数が減っていく',
    lede: 'ここが AgentX Workmate と一問一答のアシスタントの分かれ目です。やった仕事とこれからの仕事が、輪になってつながります。',
    diagramTitle: 'エージェントの学習の輪',
    steps: [
      { n: '1', title: '仕事を渡す', body: 'ふつうの言葉で — ターミナルでも、デスクトップアプリでも、一通のメッセージでも。' },
      { n: '2', title: '働きながら書き留める', body: '踏んだ手順と、その途中で分かったことを残していきます。' },
      { n: '3', title: '難しい仕事がスキルになる', body: '手数の多い仕事を終えると、その手順を再利用できる形に書き起こします。' },
      { n: '4', title: '次はもっと短く', body: '似た仕事では古いスキルを取り出し、間違っていたところを直します。' }
    ],
    aside:
      '記憶とセッション横断の検索が、この輪と並んで動きます。毎朝ゼロから始めるのではなく、あなたの仕事の進め方が少しずつ形になっていきます。'
  },

  everywhere: {
    title: '働く場所が、そのまま届く場所',
    lede: 'ゲートウェイはひとつ、入口はいくつも。ターミナルで途中まで、続きはスマートフォンで。',
    channelsLabel: 'チャット経路',
    channels: ['Telegram', 'Discord', 'Slack', 'WhatsApp', 'Signal', 'CLI'],
    surfacesLabel: '操作画面',
    surfaces: ['デスクトップアプリ', 'ターミナル TUI', 'Web ダッシュボード'],
    runtimesLabel: '実行環境',
    runtimes: ['Local', 'Docker', 'SSH', 'Singularity', 'Modal', 'Daytona', 'Vercel Sandbox'],
    modelsLabel: 'モデルプロバイダ',
    models: ['Nous Portal', 'OpenRouter', 'OpenAI', 'Anthropic', 'GitHub Copilot', 'Ollama', 'vLLM'],
    modelsNote: 'agentx model の一言で切り替わります。コードの書き換えも、囲い込みもありません。'
  },

  steps: {
    title: 'ダウンロードから最初の仕事まで',
    lede: '三段階。Python、Node、ripgrep、ffmpeg はインストーラが面倒を見ます。',
    steps: [
      {
        n: '01',
        title: 'インストール',
        body: 'お使いの OS 向けのインストーラを取るか、ターミナルに一行貼るだけです。'
      },
      {
        n: '02',
        title: 'モデルを選ぶ',
        body: 'すでに使っているプロバイダにサインインするか、API キーを貼ります。あとから変えられます。',
        command: 'agentx model'
      },
      {
        n: '03',
        title: '仕事を渡す',
        body: 'アプリを開くか、ターミナルで agentx と打ちます。席を離れて話したくなったら、あとから Telegram をつなげます。',
        command: 'agentx'
      }
    ]
  },

  download: {
    title: 'ダウンロード',
    lede: '三つの OS 向けのデスクトップインストーラ。ターミナル派なら一行で済みます。',
    platforms: [
      { key: 'mac', name: 'macOS', detail: 'Apple Silicon · Intel — .dmg', cta: 'macOS 版を入手' },
      { key: 'win', name: 'Windows', detail: '.exe インストーラ — WSL 不要', cta: 'Windows 版を入手' },
      { key: 'linux', name: 'Linux', detail: 'AppImage · .deb · .rpm', cta: 'Linux 版を入手' }
    ],
    releaseNote: 'インストーラはすべて GitHub の Releases ページに、リリースノートと一緒に置いてあります。',
    cliTitle: 'コマンドラインから入れる',
    cliUnix: 'macOS · Linux · WSL2',
    cliWindows: 'Windows — PowerShell',
    cliAfter: '終わったらターミナルを開き直して agentx と打ちます。',
    requirements:
      'インストーラが Python 3.11、Node.js、ripgrep、ffmpeg を用意します。Windows では独立した Git Bash も同梱され、システムの Git には一切触れません。'
  },

  faq: {
    title: 'よくある質問',
    items: [
      {
        q: 'AgentX Workmate とは何ですか。',
        a: '自分のマシンで動く AI エージェントです。ターミナルを開き、ファイルを読み書きし、ツールを呼び、学んだことをセッションをまたいで持ち続けます。デスクトップアプリ、ターミナル画面、そして Telegram・Discord・Slack・WhatsApp・Signal へのゲートウェイがあります。'
      },
      {
        q: 'データはマシンの外に出ますか。',
        a: 'エージェントも、その記憶も、あなたのファイルもマシンに留まります。ただしモデルに送る内容は、選んだモデルプロバイダに届きます — クラウドのモデルを使うアシスタントはすべてそうです。何も外に出したくない場合は、ローカルの Ollama や vLLM を指定してください。'
      },
      {
        q: 'どのモデルが使えますか。',
        a: 'Nous Portal、OpenRouter、OpenAI、Anthropic、GitHub Copilot、Ollama、vLLM ほか多数。コードを書き換えるのではなく agentx model で切り替えます。'
      },
      {
        q: '費用はかかりますか。',
        a: 'ソフトウェアは MIT ライセンスのオープンソースで、ここに購読料はありません。費用は選んだモデルプロバイダに支払います。ローカルでモデルを動かすなら、それも要りません。'
      },
      {
        q: 'Windows で動きますか。',
        a: '動きます。CLI、ゲートウェイ、TUI、ツールのすべてに Windows ビルドがあり、WSL は不要です。WSL2 を好むなら、Linux 用のインストールコマンドもそのまま使えます。'
      },
      {
        q: 'ソースはどこですか。',
        a: 'すべて GitHub に、MIT ライセンスで。読めますし、変えられますし、一から自分でビルドできます。'
      }
    ]
  },

  footer: {
    statement: 'ソフトウェアはあなたのマシンで動く。記憶はあなたのもとに残る。',
    license: 'MIT ライセンス',
    builtBy: 'AstralX Technology',
    links: [
      { label: 'GitHub', href: LINKS.github },
      { label: 'ドキュメント', href: LINKS.docs },
      { label: 'ディスカッション', href: LINKS.discussions },
      { label: 'Releases', href: LINKS.releases }
    ]
  }
}
