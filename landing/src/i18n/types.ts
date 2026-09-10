/**
 * The shape every locale must fill.
 *
 * `vi` is the source of truth — it is the desktop app's default locale, so the
 * page ships in the same language the product opens in. The other three are
 * translations of it. Because `Dictionary` is exact, adding a key to `vi.ts`
 * breaks the build until `en`, `zh-Hans` and `ja` carry it too; that is the
 * point. There is no runtime key-missing fallback to hide a gap behind.
 */

export type Locale = 'vi' | 'en' | 'zh-Hans' | 'ja'

/** Order is the order of the language menu. */
export const LOCALES: readonly Locale[] = ['vi', 'en', 'zh-Hans', 'ja']

export const DEFAULT_LOCALE: Locale = 'vi'

/** Endonyms — a language menu names each language in its own language. */
export const LOCALE_LABELS: Record<Locale, string> = {
  vi: 'Tiếng Việt',
  en: 'English',
  'zh-Hans': '简体中文',
  ja: '日本語'
}

/** `lang` attribute values, which are not always the locale key. */
export const LOCALE_HTML_LANG: Record<Locale, string> = {
  vi: 'vi',
  en: 'en',
  'zh-Hans': 'zh-Hans',
  ja: 'ja'
}

type NavCopy = {
  features: string
  how: string
  download: string
  docs: string
  openMenu: string
  closeMenu: string
  language: string
  skipToContent: string
}

type HeroCopy = {
  headline: string
  lede: string
  primaryCta: string
  secondaryCta: string
  installLabel: string
  installNote: string
  copy: string
  copied: string
  markAlt: string
}

type FactCopy = { value: string; label: string; note: string }

type ComparisonCopy = {
  title: string
  lede: string
  columnDiy: string
  columnProduct: string
  rows: readonly { subject: string; diy: string; product: string }[]
}

type CapabilityCopy = {
  title: string
  lede: string
  tiles: readonly { key: string; title: string; body: string; meta?: string }[]
}

type LoopCopy = {
  title: string
  lede: string
  steps: readonly { n: string; title: string; body: string }[]
  aside: string
  diagramTitle: string
}

type EverywhereCopy = {
  title: string
  lede: string
  channelsLabel: string
  channels: readonly string[]
  surfacesLabel: string
  surfaces: readonly string[]
  runtimesLabel: string
  runtimes: readonly string[]
  modelsLabel: string
  models: readonly string[]
  modelsNote: string
}

type StepsCopy = {
  title: string
  lede: string
  steps: readonly { n: string; title: string; body: string; command?: string }[]
}

type DownloadCopy = {
  title: string
  lede: string
  platforms: readonly { key: string; name: string; detail: string; cta: string }[]
  releaseNote: string
  cliTitle: string
  cliUnix: string
  cliWindows: string
  cliAfter: string
  requirements: string
}

type FaqCopy = {
  title: string
  items: readonly { q: string; a: string }[]
}

type FooterCopy = {
  statement: string
  license: string
  builtBy: string
  links: readonly { label: string; href: string }[]
}

export type Dictionary = {
  meta: { title: string; description: string }
  nav: NavCopy
  hero: HeroCopy
  facts: readonly FactCopy[]
  comparison: ComparisonCopy
  capabilities: CapabilityCopy
  loop: LoopCopy
  everywhere: EverywhereCopy
  steps: StepsCopy
  download: DownloadCopy
  faq: FaqCopy
  footer: FooterCopy
}
