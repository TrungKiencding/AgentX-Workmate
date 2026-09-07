import {
  AppWindow,
  Brain,
  BrandSpotify,
  BrandX,
  Clock,
  Code,
  Eye,
  Files,
  Globe,
  Home,
  type IconComponent,
  ImageIcon,
  ListCheck,
  MessageQuestion,
  Mic,
  Monitor,
  Plug,
  Puzzle,
  Search,
  Terminal,
  Users,
  Video,
  Volume2,
  Wrench
} from '@/lib/icons'

// The Tiện ích tool cards' glyphs, keyed by the toolset's internal name — the
// same key `skills.toolsets` uses for the hand-written label and description,
// so a tool's picture, name and sentence come from one row of the table. A
// toolset the table does not know keeps the generic wrench.
const TOOLSET_ICONS: Record<string, IconComponent> = {
  a2a: Plug,
  bfl: Video,
  browser: AppWindow,
  clarify: MessageQuestion,
  code_execution: Code,
  computer_use: Monitor,
  cronjob: Clock,
  delegation: Users,
  file: Files,
  homeassistant: Home,
  image_gen: ImageIcon,
  memory: Brain,
  session_search: Search,
  skills: Puzzle,
  spotify: BrandSpotify,
  stt: Mic,
  terminal: Terminal,
  todo: ListCheck,
  tts: Volume2,
  video: Video,
  video_gen: Video,
  vision: Eye,
  web: Globe,
  x_search: BrandX
}

/** The card glyph for a toolset; unknown toolsets share the wrench. */
export const toolsetIcon = (name: string): IconComponent => TOOLSET_ICONS[name] ?? Wrench
