import { LINKS } from '../lib/links'
import type { Dictionary } from './types'

export const zhHans: Dictionary = {
  meta: {
    title: 'AgentX Workmate — 跑在你自己机器上的 AI 同事',
    description:
      '一个会自我改进的 AI 智能体，就跑在你自己的机器上：打开真正的终端、读写你的文件、每做完一件难事就写下新技能，还能从 Telegram、Discord 或 Slack 回复你。开源，MIT 许可。'
  },

  nav: {
    features: '能力',
    how: '快速上手',
    download: '下载',
    docs: '文档',
    openMenu: '打开菜单',
    closeMenu: '关闭菜单',
    language: '语言',
    skipToContent: '跳到正文'
  },

  hero: {
    headline: '跑在你自己机器上的 AI 同事。',
    lede: 'AgentX Workmate 会打开真正的终端，在你指定的目录里读写文件，然后把这次的做法写成技能留给下一次。离开工位时，在 Telegram 上接着跟它说。',
    primaryCta: '下载',
    secondaryCta: '查看源码',
    installLabel: 'macOS · Linux · WSL2',
    installNote: 'Windows 用 PowerShell — 命令在「下载」一节。',
    copy: '复制命令',
    copied: '已复制',
    markAlt: 'AgentX Workmate 标志'
  },

  facts: [
    { value: '18', label: '种语言', note: '智能体本身会说，不只是这个页面' },
    { value: '6', label: '个聊天渠道', note: 'Telegram、Discord、Slack、WhatsApp、Signal、CLI' },
    { value: '7', label: '种运行环境', note: '从你的笔记本到容器和远程主机' },
    { value: 'MIT', label: '许可', note: '每一行都公开在 GitHub 上' }
  ],

  comparison: {
    title: '自己拼装，还是从拼好的开始',
    lede: '下面每一行你都造得出来。问题只是你愿意把几周时间花在哪一行。',
    columnDiy: '自己攒一个智能体',
    columnProduct: 'AgentX Workmate',
    rows: [
      {
        subject: '接模型',
        diy: '每家供应商写一个适配层，还要自己处理某一家挂掉时的兜底',
        product: '在 agentx model 里挑 — Nous Portal、OpenRouter、OpenAI、Anthropic、Ollama、你自己的端点'
      },
      {
        subject: '执行命令',
        diy: '先搭沙箱，再决定哪些命令可以放行',
        product: '七种运行环境开箱即用：local、Docker、SSH、Singularity、Modal、Daytona、Vercel Sandbox'
      },
      {
        subject: '记忆',
        diy: '自己设计存储结构，还要设计怎么把东西找回来',
        product: '由智能体自己打理的记忆，能全文检索几个月前关掉的会话'
      },
      {
        subject: '技能',
        diy: '攒一个提示词库，然后指望自己在对的时刻想起它',
        product: '难活干完，智能体自己写成技能，用的过程中还会自己修'
      },
      {
        subject: '消息',
        diy: '每个平台一个机器人，每个都要自己看着',
        product: '一个网关进程管六个渠道，对话在渠道之间接得上'
      },
      {
        subject: '定时任务',
        diy: '接 cron、写脚本，结果送到哪里还得自己解决',
        product: '内置调度，用一句话描述，结果送到你指定的渠道'
      },
      {
        subject: '界面',
        diy: '终端里的一个聊天循环，做到哪算哪',
        product: '完整 TUI、macOS/Windows/Linux 桌面端，以及网页控制台'
      }
    ]
  },

  capabilities: {
    title: '它到底能做什么',
    lede: '不是加了几个按钮的聊天框。这些是你关掉窗口之后还在跑的东西。',
    tiles: [
      {
        key: 'terminal',
        title: '真正的终端，不是画出来的',
        body: '多行编辑、斜杠命令补全、工具输出实时流式显示，中途打断改方向也不丢上下文。会话历史就在旁边。',
        meta: 'TUI'
      },
      {
        key: 'memory',
        title: '刻意保留的记忆',
        body: '智能体会提醒自己把要紧的事记下来，之后能在几个月前关掉的会话里再找出来。'
      },
      {
        key: 'skills',
        title: '自己写出来的技能',
        body: '干完一件难事，它会把方法写成技能。下次遇到就直接拿来用 — 顺手再改一改。'
      },
      {
        key: 'browser',
        title: '操控浏览器',
        body: 'WebMate 随安装包一起装，不走扩展商店。智能体在自己的浏览器里读页面、填表单、点按钮。',
        meta: 'WebMate'
      },
      {
        key: 'cron',
        title: '按点干活',
        body: '周一早报、半夜备份、周末巡检 — 一句话说清楚，你不在电脑前它照跑。'
      },
      {
        key: 'subagents',
        title: '把活拆开',
        body: '开出子智能体在各自的上下文里并行跑，结果汇到一处。'
      },
      {
        key: 'voice',
        title: '能听也能说',
        body: '从手机发条语音，智能体转成文字就开工。你想要的话，它也能出声回你。'
      },
      {
        key: 'mcp',
        title: 'MCP 与插件',
        body: '接入 MCP 服务器、插件和你自己的工具集。技能遵循 agentskills.io 标准。'
      },
      {
        key: 'local',
        title: '留在你自己机器上',
        body: '不强制注册账号，不用排别人服务器的队。文件就在你选的目录里。'
      }
    ]
  },

  loop: {
    title: '用得越久，越不用重复交代',
    lede: '这正是 AgentX Workmate 跟一问一答式助手分道扬镳的地方：它把「做过的事」和「要做的事」接成了一个闭环。',
    diagramTitle: '智能体的学习闭环',
    steps: [
      { n: '1', title: '你交代一件事', body: '用你自己的话 — 在终端里、在桌面端里，或者一条消息。' },
      { n: '2', title: '它一边做一边记', body: '把走过的步骤和一路学到的东西留下来。' },
      { n: '3', title: '难活变成技能', body: '一件多步骤的长活做完，它把这套方法写成可复用的技能。' },
      { n: '4', title: '下一次更短', body: '再碰上类似的活，它拿出旧技能 — 顺手修掉当初不对的地方。' }
    ],
    aside:
      '记忆和跨会话检索跟这个闭环并行运转：智能体会慢慢建起一份关于你怎么工作的认识，而不是每天早上从零开始。'
  },

  everywhere: {
    title: '你在哪儿干活，它就在哪儿',
    lede: '一个网关进程，好几道门。终端里没做完的，手机上接着说。',
    channelsLabel: '聊天渠道',
    channels: ['Telegram', 'Discord', 'Slack', 'WhatsApp', 'Signal', 'CLI'],
    surfacesLabel: '界面',
    surfaces: ['桌面端', '终端 TUI', '网页控制台'],
    runtimesLabel: '运行环境',
    runtimes: ['Local', 'Docker', 'SSH', 'Singularity', 'Modal', 'Daytona', 'Vercel Sandbox'],
    modelsLabel: '模型供应商',
    models: ['Nous Portal', 'OpenRouter', 'OpenAI', 'Anthropic', 'GitHub Copilot', 'Ollama', 'vLLM'],
    modelsNote: '一条 agentx model 命令就能换。不改代码，也不绑死在谁身上。'
  },

  steps: {
    title: '从下载到交出第一件活',
    lede: '三步。Python、Node、ripgrep 和 ffmpeg 都由安装包搞定。',
    steps: [
      {
        n: '01',
        title: '安装',
        body: '下载对应系统的安装包，或者往终端里粘一行命令。'
      },
      {
        n: '02',
        title: '选模型',
        body: '登录你本来就在用的供应商，或者粘一个 API key。随时能换。',
        command: 'agentx model'
      },
      {
        n: '03',
        title: '交代一件事',
        body: '打开桌面端，或者在终端里敲 agentx。想离开电脑也能聊的话，之后再接上 Telegram。',
        command: 'agentx'
      }
    ]
  },

  download: {
    title: '下载',
    lede: '三个系统的桌面安装包；习惯终端的话，一行命令也行。',
    platforms: [
      { key: 'mac', name: 'macOS', detail: 'Apple Silicon · Intel — .dmg', cta: '下载 macOS 版' },
      { key: 'win', name: 'Windows', detail: '.exe 安装包 — 不需要 WSL', cta: '下载 Windows 版' },
      { key: 'linux', name: 'Linux', detail: 'AppImage · .deb · .rpm', cta: '下载 Linux 版' }
    ],
    releaseNote: '所有安装包都在 GitHub Releases 页面上，附带版本说明。',
    cliTitle: '或者用命令行安装',
    cliUnix: 'macOS · Linux · WSL2',
    cliWindows: 'Windows — PowerShell',
    cliAfter: '装完重开终端，敲 agentx。',
    requirements:
      '安装包自带 Python 3.11、Node.js、ripgrep 和 ffmpeg。Windows 上还附带一份独立的 Git Bash，完全不碰系统里的 Git。'
  },

  faq: {
    title: '常见问题',
    items: [
      {
        q: 'AgentX Workmate 是什么？',
        a: '一个跑在你自己机器上的 AI 智能体：打开终端、读写文件、调用工具，并把学到的东西跨会话保留下来。有桌面端、终端界面，以及通往 Telegram、Discord、Slack、WhatsApp、Signal 的网关。'
      },
      {
        q: '我的数据会离开我的机器吗？',
        a: '智能体、它的记忆和你的文件都留在你机器上。但你发给模型的内容会送到你选的那家模型供应商 — 所有用云端模型的助手都是这样。如果你希望什么都不出去，就把 AgentX 指向本地的 Ollama 或 vLLM。'
      },
      {
        q: '能用哪些模型？',
        a: 'Nous Portal、OpenRouter、OpenAI、Anthropic、GitHub Copilot、Ollama、vLLM 等等。用 agentx model 切换，不用改代码。'
      },
      {
        q: '要花钱吗？',
        a: '软件本身是 MIT 许可的开源项目 — 这里没有订阅。你付的是所选模型供应商的钱；跑本地模型的话，一分不用付。'
      },
      {
        q: 'Windows 上能跑吗？',
        a: '能，原生就能跑 — CLI、网关、TUI 和工具都有 Windows 构建，不需要 WSL。你偏好 WSL2 的话，Linux 那条安装命令在里面也能用。'
      },
      {
        q: '源码在哪？',
        a: '全都在 GitHub 上，MIT 许可。看得了、改得了、也能自己从头构建。'
      }
    ]
  },

  footer: {
    statement: '软件跑在你的机器上。记忆留在你这里。',
    license: 'MIT 许可',
    builtBy: 'AstralX Technology',
    links: [
      { label: 'GitHub', href: LINKS.github },
      { label: '文档', href: LINKS.docs },
      { label: '讨论区', href: LINKS.discussions },
      { label: 'Releases', href: LINKS.releases }
    ]
  }
}
