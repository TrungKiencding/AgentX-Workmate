import type { ComponentProps, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'

import { ArrowUpRight } from '@/lib/icons'

import { resolveBrandIcon } from './brand-icon'
import { isPrivateNetworkHost } from './private-network-host'
import { cn } from './utils'

const titleCache = new Map<string, string>()
const titleInflight = new Map<string, Promise<string>>()
const titleSubs = new Map<string, Set<(value: string) => void>>()

// A match may end in ")" or "]"; balancedUrl decides whether it is the URL's.
const URL_RE =
  /(?:https?:\/\/|www\.)[^\s<>"'`]+[^\s<>"'`.,;:!?]|[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}(?:\/[^\s<>"'`.,;:!?]*)?/gi

// Explicit-scheme / www. URLs only — no bare-domain matching. Used where the
// surrounding text is full of filename-shaped tokens (e.g. `agent.log`,
// `errors.log` in a /debug report) that the bare-domain branch of URL_RE would
// otherwise mistake for domains and linkify.
const EXPLICIT_URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`]+[^\s<>"'`.,;:!?]/gi

const DOMAIN_RE = /^(?:www\.)?[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s]*)?$/i
const SKIP_PROTO_RE = /^(?:file|data|mailto|javascript|blob|chrome|about|agentx):/i
const URL_HEAD_RE = /^(?:https?:\/\/|www\.)/i

const ERROR_TITLE_RE =
  /\b(?:access denied|attention required|captcha|error|forbidden|just a moment|not found|request blocked|too many requests)\b/i

export function normalizeExternalUrl(value: string): string {
  const trimmed = value.trim()

  if (!trimmed || /^https?:\/\//i.test(trimmed)) {
    return trimmed
  }

  return DOMAIN_RE.test(trimmed) ? `https://${trimmed}` : trimmed
}

function parseUrl(value: string): null | URL {
  try {
    return new URL(normalizeExternalUrl(value))
  } catch {
    return null
  }
}

function titleCacheKey(value: string): string {
  const url = parseUrl(value)

  if (!url) {
    return normalizeExternalUrl(value)
  }

  const host = url.hostname.replace(/^www\./i, '').toLowerCase()
  const pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '') || '/'

  return `${host}${pathname}${url.search || ''}`
}

export function shortHostLabel(value: string): string {
  return parseUrl(value)?.hostname.replace(/^www\./, '') ?? value
}

export function hostPathLabel(value: string): string {
  const url = parseUrl(value)

  if (!url) {
    return value
  }

  const host = url.hostname.replace(/^www\./, '')
  const path = url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : ''

  return `${host}${path}`
}

function cleanSlug(segment: string): string {
  try {
    return decodeURIComponent(segment)
      .replace(/\.a\d+\..*$/i, '')
      .replace(/\.(?:html?|php|aspx?)$/i, '')
      .replace(/(?:[-_.](?:[a-z]{1,3}\d{2,}|i\d{2,}))+$/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  } catch {
    return ''
  }
}

export function urlSlugTitleLabel(value: string): string {
  const url = parseUrl(value)

  for (const segment of url?.pathname.split('/').filter(Boolean).reverse() ?? []) {
    const cleaned = cleanSlug(segment)

    if (!cleaned || !/[a-z]/i.test(cleaned)) {
      continue
    }

    if (/^(?:[a-z]{1,3}\d+|\d+)$/i.test(cleaned.replace(/\s+/g, ''))) {
      continue
    }

    const titled = cleaned.replace(/\b[a-z]/g, c => c.toUpperCase())

    if (titled.length >= 4) {
      return titled
    }
  }

  return hostPathLabel(value)
}

// Reading a title loads the page (curl, then a hidden window), so a link in a
// reply or a tool error must not reach into this machine or its network.
export function isTitleFetchable(value: string): boolean {
  if (!value || SKIP_PROTO_RE.test(value)) {
    return false
  }

  const url = parseUrl(value)

  return Boolean(url && /^https?:$/.test(url.protocol) && !isPrivateNetworkHost(url.hostname))
}

export function fetchLinkTitle(url: string): Promise<string> {
  const normalizedUrl = normalizeExternalUrl(url)
  const key = titleCacheKey(normalizedUrl)

  if (!isTitleFetchable(normalizedUrl)) {
    return Promise.resolve('')
  }

  if (titleCache.has(key)) {
    return Promise.resolve(titleCache.get(key) ?? '')
  }

  const pending = titleInflight.get(key)

  if (pending) {
    return pending
  }

  const bridge = typeof window === 'undefined' ? undefined : window.agentxDesktop?.fetchLinkTitle

  if (!bridge) {
    titleCache.set(key, '')

    return Promise.resolve('')
  }

  const promise = bridge(normalizedUrl)
    .then(value => (value || '').replace(/\s+/g, ' ').trim())
    .then(clean => (clean && !ERROR_TITLE_RE.test(clean) ? clean : ''))
    .catch(() => '')
    .then(safe => {
      titleCache.set(key, safe)
      titleInflight.delete(key)
      titleSubs.get(key)?.forEach(sub => sub(safe))

      return safe
    })

  titleInflight.set(key, promise)

  return promise
}

export function useLinkTitle(url?: null | string): string {
  const normalizedUrl = useMemo(() => (url ? normalizeExternalUrl(url) : ''), [url])
  const key = useMemo(() => (normalizedUrl ? titleCacheKey(normalizedUrl) : ''), [normalizedUrl])
  const [title, setTitle] = useState(() => (key ? (titleCache.get(key) ?? '') : ''))

  useEffect(() => {
    setTitle(key ? (titleCache.get(key) ?? '') : '')

    if (!key || !isTitleFetchable(normalizedUrl)) {
      return
    }

    const subs = titleSubs.get(key) ?? new Set<(value: string) => void>()

    subs.add(setTitle)
    titleSubs.set(key, subs)
    void fetchLinkTitle(normalizedUrl)

    return () => {
      subs.delete(setTitle)

      if (!subs.size) {
        titleSubs.delete(key)
      }
    }
  }, [key, normalizedUrl])

  return title
}

export function openExternalLink(href: string): void {
  if (href) {
    void window.agentxDesktop?.openExternal?.(href)
  }
}

interface ExternalLinkProps extends Omit<ComponentProps<'a'>, 'href' | 'target'> {
  href: string
  children?: ReactNode
  showExternalIcon?: boolean
}

export function ExternalLinkIcon({ className }: { className?: string }) {
  return <ArrowUpRight aria-hidden className={cn('ml-1 inline size-[0.78em] align-[-0.08em] opacity-70', className)} />
}

// Brand mark for a known host, sized in `em` so it tracks the surrounding text
// at any font size. It paints in `currentColor` rather than the brand hex —
// several brand colors (GitHub's near-black, Unity's white) vanish against one
// theme or the other.
//
// `title=""` is load-bearing: Simple Icons always renders a <title> defaulting
// to the brand name, which lands in the anchor's textContent and accessible
// name — a PR link would read "GitHub#123".
export function LinkBrandIcon({ className, href }: { className?: string; href: string }) {
  const Icon = resolveBrandIcon(shortHostLabel(href))

  return Icon ? (
    <Icon aria-hidden className={cn('mr-1 inline size-[0.85em] align-[-0.12em] opacity-80', className)} title="" />
  ) : null
}

export function ExternalLink({
  children,
  className,
  href,
  onClick,
  showExternalIcon = false,
  ...rest
}: ExternalLinkProps) {
  const target = normalizeExternalUrl(href)

  return (
    <a
      className={cn('ref', className)}
      href={target}
      onClick={event => {
        event.stopPropagation()
        onClick?.(event)

        if (event.defaultPrevented) {
          return
        }

        event.preventDefault()
        openExternalLink(target)
      }}
      rel="noopener noreferrer"
      target="_blank"
      {...rest}
    >
      {children ?? urlSlugTitleLabel(target)}
      {showExternalIcon && <ExternalLinkIcon />}
    </a>
  )
}

interface PrettyLinkProps extends Omit<ComponentProps<'a'>, 'href' | 'target'> {
  href: string
  label?: string
  fallbackLabel?: string
}

// Title resolution is a fallback, not an override. Both props carry authored
// text — chat markdown passes `fallbackLabel` — so either one skips the fetch.
export function PrettyLink({ className, fallbackLabel, href, label, ...rest }: PrettyLinkProps) {
  const target = useMemo(() => normalizeExternalUrl(href), [href])
  const authoredLabel = label?.trim() || fallbackLabel?.trim()
  const fetched = useLinkTitle(authoredLabel ? null : target)
  const display = authoredLabel || fetched || urlSlugTitleLabel(target)

  return (
    <ExternalLink className={cn('wrap-break-word', className)} href={target} title={target} {...rest}>
      <LinkBrandIcon href={target} />
      {display}
    </ExternalLink>
  )
}

interface LinkifiedTextProps {
  className?: string
  text: string
  pretty?: boolean
  explicitOnly?: boolean
}

/**
 * A URL match up to its first ")" that closes no "(" in it, or "]" that closes
 * no "[" (the rule tool-row titles use for ")"). One that does close a bracket
 * is the URL's own, as in a GFM autolink: "…/wiki/Mercury_(planet)" and
 * "http://[::1]:8080/" stay whole, and "(see https://acme.dev)" stops before
 * the prose's ")". Empty when the cut leaves too little to link.
 */
function balancedUrl(match: string): string {
  let parens = 0
  let brackets = 0
  let end = match.length

  for (let index = 0; index < match.length; index += 1) {
    const char = match[index]

    if (char === '(') {
      parens += 1
    } else if (char === '[') {
      brackets += 1
    } else if ((char === ')' && !parens) || (char === ']' && !brackets)) {
      end = index

      break
    } else if (char === ')') {
      parens -= 1
    } else if (char === ']') {
      brackets -= 1
    }
  }

  if (end === match.length) {
    return match
  }

  // The punctuation the cut bares goes too: "(see https://acme.dev.)".
  while (end > 0 && '.,;:!?'.includes(match[end - 1])) {
    end -= 1
  }

  // The patterns ask for two characters past "https://" or "www.".
  return end - (URL_HEAD_RE.exec(match)?.[0].length ?? 0) < 2 ? '' : match.slice(0, end)
}

export function LinkifiedText({ className, explicitOnly = false, pretty = true, text }: LinkifiedTextProps) {
  const nodes: ReactNode[] = []
  // Its own lastIndex, so a scan goes on from where balancedUrl cut a URL:
  // "(https://a.dev)(https://b.dev)" links both.
  const pattern = new RegExp(explicitOnly ? EXPLICIT_URL_RE : URL_RE)
  let cursor = 0

  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const raw = balancedUrl(match[0])
    const index = match.index

    // Right after the URL, or the next character when none is left here.
    pattern.lastIndex = index + (raw.length || 1)

    if (!raw) {
      continue
    }

    const url = normalizeExternalUrl(raw)

    if (index > cursor) {
      nodes.push(text.slice(cursor, index))
    }

    nodes.push(
      pretty ? (
        <PrettyLink href={url} key={`${url}-${index}`} />
      ) : (
        <ExternalLink href={url} key={`${url}-${index}`}>
          {raw}
        </ExternalLink>
      )
    )

    cursor = index + raw.length
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor))
  }

  return <span className={className}>{nodes.length ? nodes : text}</span>
}

export function __resetLinkTitleCache(): void {
  titleCache.clear()
  titleInflight.clear()
  titleSubs.clear()
}
