import { LINKS } from '../lib/links'
import type { Dictionary } from './types'

export const en: Dictionary = {
  meta: {
    title: 'AgentX Workmate — an AI coworker that runs on your machine',
    description:
      'A self-improving AI agent that runs on your own machine: it opens a real terminal, edits your files, writes new skills after every hard task, and answers you from Telegram, Discord or Slack. Open source, MIT licensed.'
  },

  nav: {
    features: 'Capabilities',
    how: 'Get started',
    download: 'Download',
    docs: 'Docs',
    openMenu: 'Open menu',
    closeMenu: 'Close menu',
    language: 'Language',
    skipToContent: 'Skip to main content'
  },

  hero: {
    headline: 'An AI coworker on your own machine.',
    lede: 'AgentX Workmate opens a real terminal, reads and edits the files in the folder you point it at, then writes down how it did the work as a skill for next time. Step away from the desk and message it on Telegram.',
    primaryCta: 'Download',
    secondaryCta: 'Read the source',
    installLabel: 'macOS · Linux · WSL2',
    installNote: 'Windows uses PowerShell — that command is in Download.',
    copy: 'Copy command',
    copied: 'Copied',
    markAlt: 'AgentX Workmate mark'
  },

  facts: [
    { value: '18', label: 'languages', note: 'The agent speaks them, not just this page' },
    { value: '6', label: 'chat channels', note: 'Telegram, Discord, Slack, WhatsApp, Signal, CLI' },
    { value: '7', label: 'runtimes', note: 'From your laptop to containers and remote hosts' },
    { value: 'MIT', label: 'licence', note: 'Every line of it public on GitHub' }
  ],

  comparison: {
    title: 'Assemble it yourself, or start from assembled',
    lede: 'Every row below is something you could build. The question is which weeks you want to spend.',
    columnDiy: 'Rolling your own agent',
    columnProduct: 'AgentX Workmate',
    rows: [
      {
        subject: 'Model access',
        diy: 'An adapter per provider, plus your own fallback when one goes down',
        product: 'Pick one in agentx model — Nous Portal, OpenRouter, OpenAI, Anthropic, Ollama, your own endpoint'
      },
      {
        subject: 'Running commands',
        diy: 'Build the sandbox, then decide which commands are allowed',
        product: 'Seven runtimes ready: local, Docker, SSH, Singularity, Modal, Daytona, Vercel Sandbox'
      },
      {
        subject: 'Memory',
        diy: 'Design the storage schema and the way anything gets found again',
        product: 'Agent-curated memory, with full-text search across sessions you closed months ago'
      },
      {
        subject: 'Skills',
        diy: 'Collect a prompt library, then remember it exists at the right moment',
        product: 'The agent writes skills after hard tasks and repairs them while using them'
      },
      {
        subject: 'Messaging',
        diy: 'One bot per platform, each with its own lifecycle to babysit',
        product: 'One gateway process for all six channels, with the conversation carried between them'
      },
      {
        subject: 'Scheduled work',
        diy: 'Wire up cron, write the scripts, then solve delivery yourself',
        product: 'A built-in scheduler you describe in plain language, delivering to the channel you name'
      },
      {
        subject: 'Interface',
        diy: 'A chat loop in a terminal, extended as far as you got',
        product: 'A full TUI, desktop apps for macOS, Windows and Linux, and a web dashboard'
      }
    ]
  },

  capabilities: {
    title: 'What it actually does',
    lede: 'Not a chat box with extra buttons. This is what keeps running after you close the window.',
    tiles: [
      {
        key: 'terminal',
        title: 'A real terminal, not a drawing of one',
        body: 'Multiline editing, slash-command autocomplete, tool output streaming as it happens, and interrupt-and-redirect that keeps the thread. Session history sits right there.',
        meta: 'TUI'
      },
      {
        key: 'memory',
        title: 'Memory it keeps on purpose',
        body: 'The agent nudges itself to write down what matters, then finds it again in sessions closed long ago.'
      },
      {
        key: 'skills',
        title: 'Skills it writes itself',
        body: 'Finish something hard and the agent turns the method into a skill. Next time it reaches for it — and edits it.'
      },
      {
        key: 'browser',
        title: 'Browser control',
        body: 'WebMate ships inside the installer, not through an extension store. The agent reads pages, fills forms and clicks — in a browser of its own.',
        meta: 'WebMate'
      },
      {
        key: 'cron',
        title: 'Work on a schedule',
        body: 'Monday reports, midnight backups, weekend audits — described in a sentence, run while you are away from the keyboard.'
      },
      {
        key: 'subagents',
        title: 'Split the work',
        body: 'Spawn subagents that run in parallel in their own context, then collect the results in one place.'
      },
      {
        key: 'voice',
        title: 'Listening and speaking',
        body: 'Send a voice memo from your phone, the agent transcribes it and gets to work. It answers out loud if you want.'
      },
      {
        key: 'mcp',
        title: 'MCP and plugins',
        body: 'Add MCP servers, plugins and your own toolsets. Skills follow the agentskills.io standard.'
      },
      {
        key: 'local',
        title: 'It stays on your machine',
        body: 'No account required, no queue on someone else’s server. The files stay in the folder you chose.'
      }
    ]
  },

  loop: {
    title: 'The more you use it, the less you repeat yourself',
    lede: 'This is where AgentX Workmate parts ways with a question-and-answer assistant: it closes the loop between the work it did and the work it is about to do.',
    diagramTitle: 'The agent’s learning loop',
    steps: [
      { n: '1', title: 'You hand over a task', body: 'In your own words — in the terminal, the desktop app, or a message.' },
      { n: '2', title: 'It works and takes notes', body: 'It keeps the steps it took and what it learned along the way.' },
      { n: '3', title: 'Hard work becomes a skill', body: 'After a long multi-step task, it writes that method down as something reusable.' },
      { n: '4', title: 'Next time is shorter', body: 'It reaches for the old skill on a similar job — and fixes whatever was wrong with it.' }
    ],
    aside:
      'Memory and cross-session search run alongside this loop: the agent builds up a model of how you work instead of starting from nothing every morning.'
  },

  everywhere: {
    title: 'Wherever you work, it is there',
    lede: 'One gateway process, several doors in. Leave off in the terminal, pick up on your phone.',
    channelsLabel: 'Chat channels',
    channels: ['Telegram', 'Discord', 'Slack', 'WhatsApp', 'Signal', 'CLI'],
    surfacesLabel: 'Interfaces',
    surfaces: ['Desktop app', 'Terminal TUI', 'Web dashboard'],
    runtimesLabel: 'Runtimes',
    runtimes: ['Local', 'Docker', 'SSH', 'Singularity', 'Modal', 'Daytona', 'Vercel Sandbox'],
    modelsLabel: 'Model providers',
    models: ['Nous Portal', 'OpenRouter', 'OpenAI', 'Anthropic', 'GitHub Copilot', 'Ollama', 'vLLM'],
    modelsNote: 'Switch with one agentx model command. No code changes, no lock-in.'
  },

  steps: {
    title: 'From download to first task',
    lede: 'Three steps. The installer handles Python, Node, ripgrep and ffmpeg.',
    steps: [
      {
        n: '01',
        title: 'Install',
        body: 'Grab the installer for your operating system, or paste a single line into a terminal.'
      },
      {
        n: '02',
        title: 'Pick a model',
        body: 'Sign in to a provider you already pay for, or paste an API key. Change it whenever.',
        command: 'agentx model'
      },
      {
        n: '03',
        title: 'Hand over a task',
        body: 'Open the app, or type agentx in a terminal. Connect Telegram later if you want to talk away from the desk.',
        command: 'agentx'
      }
    ]
  },

  download: {
    title: 'Download',
    lede: 'Desktop installers for three operating systems, or one line if you live in a terminal.',
    platforms: [
      { key: 'mac', name: 'macOS', detail: 'Apple Silicon · Intel — .dmg', cta: 'Get for macOS' },
      { key: 'win', name: 'Windows', detail: '.exe installer — no WSL needed', cta: 'Get for Windows' },
      { key: 'linux', name: 'Linux', detail: 'AppImage · .deb · .rpm', cta: 'Get for Linux' }
    ],
    releaseNote: 'Every installer lives on the GitHub Releases page, with its release notes.',
    cliTitle: 'Or install from the command line',
    cliUnix: 'macOS · Linux · WSL2',
    cliWindows: 'Windows — PowerShell',
    cliAfter: 'Reopen your terminal afterwards and type agentx.',
    requirements:
      'The installer brings Python 3.11, Node.js, ripgrep and ffmpeg. On Windows it also ships a portable Git Bash that never touches a system Git install.'
  },

  faq: {
    title: 'Questions people ask',
    items: [
      {
        q: 'What is AgentX Workmate?',
        a: 'An AI agent that runs on your machine: it opens a terminal, reads and edits files, calls tools, and keeps what it learns between sessions. There is a desktop app, a terminal interface, and a gateway to Telegram, Discord, Slack, WhatsApp and Signal.'
      },
      {
        q: 'Does my data leave my machine?',
        a: 'The agent, its memory and your files stay on your machine. What you send to a model does go to the model provider you chose — that is how every assistant on a cloud model works. If you want nothing to leave at all, point AgentX at a local Ollama or vLLM.'
      },
      {
        q: 'Which models can I use?',
        a: 'Nous Portal, OpenRouter, OpenAI, Anthropic, GitHub Copilot, Ollama, vLLM and many others. Switch with agentx model rather than by editing code.'
      },
      {
        q: 'What does it cost?',
        a: 'The software is open source under the MIT licence — there is no subscription here. You pay whichever model provider you pick, or nothing at all if you run a model locally.'
      },
      {
        q: 'Does it run on Windows?',
        a: 'Yes, natively — CLI, gateway, TUI and tools all have Windows builds, no WSL required. If you prefer WSL2, the Linux install command works there too.'
      },
      {
        q: 'Where is the source?',
        a: 'All of it on GitHub under the MIT licence. Readable, forkable, buildable from scratch.'
      }
    ]
  },

  footer: {
    statement: 'The software runs on your machine. The memory stays with you.',
    license: 'MIT licence',
    builtBy: 'AstralX Technology',
    links: [
      { label: 'GitHub', href: LINKS.github },
      { label: 'Docs', href: LINKS.docs },
      { label: 'Discussions', href: LINKS.discussions },
      { label: 'Releases', href: LINKS.releases }
    ]
  }
}
