import {
  Box,
  BrandApple,
  BrandGithub,
  Briefcase,
  Code,
  Cpu,
  Home,
  type IconComponent,
  ImageIcon,
  Mail,
  NotebookTabs,
  Palette,
  Search,
  Users,
  Zap
} from '@/lib/icons'
import { normalize } from '@/lib/text'

// The Tiện ích page's skill groups. The backend reports a skill's category as
// a raw slug in whatever casing the catalog stored ("Autonomous-Ai-Agents",
// "software-development") — normalize once, then map to a Tabler glyph and a
// translation key so the list reads in the app's language, never as a slug.
// A category outside this table keeps its glyph fallback and a prettied name.
export const SKILL_CATEGORY_IDS = [
  'apple',
  'autonomous-ai-agents',
  'creative',
  'email',
  'general',
  'github',
  'media',
  'mlops',
  'note-taking',
  'productivity',
  'research',
  'smart-home',
  'social-media',
  'software-development'
] as const

export type SkillCategoryId = (typeof SKILL_CATEGORY_IDS)[number]

const CATEGORY_ICONS: Record<SkillCategoryId, IconComponent> = {
  apple: BrandApple,
  'autonomous-ai-agents': Zap,
  creative: Palette,
  email: Mail,
  general: Box,
  github: BrandGithub,
  media: ImageIcon,
  mlops: Cpu,
  'note-taking': NotebookTabs,
  productivity: Briefcase,
  research: Search,
  'smart-home': Home,
  'social-media': Users,
  'software-development': Code
}

/** Canonical lookup key for a raw backend category ("Autonomous-Ai-Agents" → "autonomous-ai-agents"). */
export const skillCategoryKey = (raw: string): string => normalize(raw).replace(/[\s_]+/g, '-') || 'general'

export const isKnownSkillCategory = (key: string): key is SkillCategoryId =>
  (SKILL_CATEGORY_IDS as readonly string[]).includes(key)

/** The group's Tabler glyph; unknown categories share the "general" box. */
export const skillCategoryIcon = (raw: string): IconComponent => {
  const key = skillCategoryKey(raw)

  return isKnownSkillCategory(key) ? CATEGORY_ICONS[key] : CATEGORY_ICONS.general
}

// Proper names a naive word-capitalizer would mangle. The backend exposes no
// SKILL.md frontmatter title, so the display name is derived from the slug —
// the raw slug stays available under "Chi tiết kỹ thuật".
const DISPLAY_WORDS: Record<string, string> = {
  agentx: 'AgentX',
  ai: 'AI',
  api: 'API',
  github: 'GitHub',
  mcp: 'MCP',
  pdf: 'PDF',
  seo: 'SEO',
  url: 'URL'
}

/** Human display name for a kebab/snake skill slug ("agentx-agent-skill-authoring" → "AgentX Agent Skill Authoring"). */
export const skillDisplayName = (slug: string): string =>
  slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => DISPLAY_WORDS[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ') || slug

