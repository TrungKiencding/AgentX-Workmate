import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  __resetLinkTitleCache,
  ExternalLink,
  fetchLinkTitle,
  hostPathLabel,
  isTitleFetchable,
  LinkifiedText,
  PrettyLink,
  urlSlugTitleLabel
} from './external-link'

const desktopWindow = window as unknown as { agentxDesktop?: Window['agentxDesktop'] }
const initialAgentxDesktop = desktopWindow.agentxDesktop

function installDesktopBridge(partial: Partial<Window['agentxDesktop']> = {}) {
  desktopWindow.agentxDesktop = {
    fetchLinkTitle: vi.fn().mockResolvedValue(''),
    openExternal: vi.fn().mockResolvedValue(undefined),
    ...partial
  } as unknown as Window['agentxDesktop']
}

const FORGEJO_URL = 'https://forgejo.home.example/homelab/homelab-ops/issues/101'

function installTitleBridge(title: string) {
  const bridge = vi.fn().mockResolvedValue(title)

  installDesktopBridge({ fetchLinkTitle: bridge as unknown as Window['agentxDesktop']['fetchLinkTitle'] })

  return bridge
}

afterEach(() => {
  __resetLinkTitleCache()
  vi.restoreAllMocks()
  cleanup()

  if (initialAgentxDesktop) {
    desktopWindow.agentxDesktop = initialAgentxDesktop
  } else {
    delete desktopWindow.agentxDesktop
  }
})

describe('external link helpers', () => {
  it('formats URL fallbacks as host + path', () => {
    expect(
      hostPathLabel(
        'https://www.getyourguide.com/culebra-island-l145468/from-fajardo-full-day-cordillera-islands-catamaran-tour-t19894/'
      )
    ).toBe('getyourguide.com/culebra-island-l145468/from-fajardo-full-day-cordillera-islands-catamaran-tour-t19894')
  })

  it('derives readable title fallbacks from URL slugs', () => {
    expect(
      urlSlugTitleLabel(
        'https://www.getyourguide.com/fajardo-l882/from-fajardo-icacos-island-full-day-catamaran-trip-t19891/'
      )
    ).toBe('From Fajardo Icacos Island Full Day Catamaran Trip')
  })

  it('filters out local/non-http targets for title fetches', () => {
    expect(isTitleFetchable('https://www.expedia.com/things-to-do/foo')).toBe(true)
    expect(isTitleFetchable('http://localhost:5174')).toBe(false)
    expect(isTitleFetchable('file:///tmp/demo.html')).toBe(false)
    expect(isTitleFetchable('mailto:hello@example.com')).toBe(false)
  })

  it('never looks up the title of a page on this machine or its network', async () => {
    const bridge = installTitleBridge('Router Admin')

    // A web_extract the backend refused names the URL in the row's red lead.
    render(<LinkifiedText text="http://10.0.0.1/admin — Blocked: private address" />)

    expect(screen.getByTitle('http://10.0.0.1/admin').textContent).toBe('Admin')
    expect(isTitleFetchable('http://192.168.1.1/')).toBe(false)
    expect(isTitleFetchable('http://2852039166/latest/meta-data/')).toBe(false)
    expect(isTitleFetchable('nas.local/photos')).toBe(false)
    await expect(fetchLinkTitle('http://169.254.169.254/latest/meta-data/')).resolves.toBe('')
    expect(bridge).not.toHaveBeenCalled()
  })

  it('deduplicates in-flight title fetches and caches results', async () => {
    const bridge = vi.fn().mockResolvedValue('El Yunque Tour Water Slide, Rope Swing & Pickup')
    installDesktopBridge({ fetchLinkTitle: bridge as unknown as Window['agentxDesktop']['fetchLinkTitle'] })

    const url =
      'https://www.expedia.com/things-to-do/puerto-rico-el-yunque-rainforest-adventure-with-transport.a46272756.activity-details'

    const [first, second] = await Promise.all([fetchLinkTitle(url), fetchLinkTitle(url)])

    expect(first).toBe('El Yunque Tour Water Slide, Rope Swing & Pickup')
    expect(second).toBe('El Yunque Tour Water Slide, Rope Swing & Pickup')
    expect(bridge).toHaveBeenCalledTimes(1)

    const third = await fetchLinkTitle(url)

    expect(third).toBe('El Yunque Tour Water Slide, Rope Swing & Pickup')
    expect(bridge).toHaveBeenCalledTimes(1)
  })

  it('shares cache across protocol/www URL variants', async () => {
    const bridge = vi.fn().mockResolvedValue('Shared Canonical Title')
    installDesktopBridge({ fetchLinkTitle: bridge as unknown as Window['agentxDesktop']['fetchLinkTitle'] })

    const first = 'https://www.getyourguide.com/san-juan-puerto-rico-l355/sunset-tours-tc306/'
    const second = 'http://getyourguide.com/san-juan-puerto-rico-l355/sunset-tours-tc306/'

    const [a, b] = await Promise.all([fetchLinkTitle(first), fetchLinkTitle(second)])

    expect(a).toBe('Shared Canonical Title')
    expect(b).toBe('Shared Canonical Title')
    expect(bridge).toHaveBeenCalledTimes(1)
  })

  it('opens links via the desktop bridge', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    installDesktopBridge({ openExternal: openExternal as unknown as Window['agentxDesktop']['openExternal'] })

    render(<ExternalLink href="https://example.com/path/to/resource">Example link</ExternalLink>)

    fireEvent.click(screen.getByRole('link', { name: 'Example link' }))
    expect(openExternal).toHaveBeenCalledWith('https://example.com/path/to/resource')
  })

  it('hides the trailing external-link icon by default', () => {
    installDesktopBridge()

    render(<ExternalLink href="https://example.com/path/to/resource">Example link</ExternalLink>)

    const link = screen.getByRole('link', { name: 'Example link' })
    expect(link.querySelector('svg')).toBeNull()
  })

  it('shows a trailing external-link icon when opted in', () => {
    installDesktopBridge()

    render(
      <ExternalLink href="https://example.com/path/to/resource" showExternalIcon>
        Example link
      </ExternalLink>
    )

    const link = screen.getByRole('link', { name: 'Example link' })
    expect(link.querySelector('svg')).toBeTruthy()
  })

  it('renders pretty links with fetched titles and no host suffix', async () => {
    const bridge = vi.fn().mockResolvedValue('From Fajardo: Full-Day Culebra Islands Catamaran Tour')
    installDesktopBridge({ fetchLinkTitle: bridge as unknown as Window['agentxDesktop']['fetchLinkTitle'] })

    const url =
      'https://www.getyourguide.com/culebra-island-l145468/from-fajardo-full-day-cordillera-islands-catamaran-tour-t19894/'

    render(<LinkifiedText text={`Read ${url}`} />)

    const link = screen.getByTitle(url)
    expect(link.textContent).toContain('From Fajardo Full Day Cordillera Islands Catamaran Tour')

    await waitFor(() => {
      expect(link.textContent).toContain('From Fajardo: Full-Day Culebra Islands Catamaran Tour')
    })
    expect(link.textContent).not.toContain('getyourguide.com')
  })

  it('shows host/path fallback when title is unavailable', () => {
    installDesktopBridge()
    const url = 'https://www.expedia.com/things-to-do/puerto-rico-el-yunque'

    render(<PrettyLink href={url} />)

    const link = screen.getByTitle(url)

    expect(link.textContent).toBe('Puerto Rico El Yunque')
  })

  it('ignores error-like fetched titles and falls back to slug label', async () => {
    const bridge = vi.fn().mockResolvedValue('GetYourGuide – Error')
    installDesktopBridge({ fetchLinkTitle: bridge as unknown as Window['agentxDesktop']['fetchLinkTitle'] })

    const url =
      'https://www.getyourguide.com/culebra-island-l145468/from-fajardo-full-day-cordillera-islands-catamaran-tour-t19894/'

    render(<PrettyLink href={url} />)

    const link = screen.getByTitle(url)
    await waitFor(() => {
      expect(link.textContent).toBe('From Fajardo Full Day Cordillera Islands Catamaran Tour')
    })
  })

  it('treats not-found fetched titles as unusable', async () => {
    const bridge = installTitleBridge('Page not found - Forgejo')

    await expect(fetchLinkTitle(FORGEJO_URL)).resolves.toBe('')
    expect(bridge).toHaveBeenCalledTimes(1)
  })

  it('keeps an authored fallbackLabel ahead of a fetched title, and skips the fetch', async () => {
    const bridge = installTitleBridge('Kinkolino Forgejo')

    // Chat markdown passes authored link text as `fallbackLabel`, not `label`.
    render(<PrettyLink fallbackLabel="FJ #101" href={FORGEJO_URL} />)

    const link = screen.getByTitle(FORGEJO_URL)

    await waitFor(() => {
      expect(link.textContent).toContain('FJ #101')
    })
    expect(link.textContent).not.toContain('Kinkolino Forgejo')
    expect(bridge).not.toHaveBeenCalled()
  })

  it('still resolves a title when no label was authored', async () => {
    const bridge = installTitleBridge('Homelab Ops Issue 101')

    render(<PrettyLink href={FORGEJO_URL} />)

    await waitFor(() => {
      expect(screen.getByTitle(FORGEJO_URL).textContent).toContain('Homelab Ops Issue 101')
    })
    expect(bridge).toHaveBeenCalledTimes(1)
  })

  it('normalizes scheme-less links before opening', () => {
    installDesktopBridge()

    render(<LinkifiedText text="Source expedia.com/things-to-do/puerto-rico-el-yunque-rainforest-adventure" />)

    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe(
      'https://expedia.com/things-to-do/puerto-rico-el-yunque-rainforest-adventure'
    )
  })

  it('explicitOnly skips bare filename/domain tokens and only links explicit URLs', () => {
    installDesktopBridge()

    render(
      <LinkifiedText
        explicitOnly
        pretty={false}
        text={'Report  https://paste.rs/abc\nagent.log  https://paste.rs/def\nerrors.log'}
      />
    )

    const links = screen.getAllByRole('link')
    expect(links.map(a => a.getAttribute('href'))).toEqual(['https://paste.rs/abc', 'https://paste.rs/def'])
    // Bare filename-shaped tokens stay as plain text, not links.
    expect(screen.queryByText(content => content.includes('agent.log'))).toBeTruthy()
    expect(links.some(a => (a.textContent ?? '').includes('.log'))).toBe(false)
  })

  it('without explicitOnly, bare filename tokens are still linkified (default behavior)', () => {
    installDesktopBridge()

    render(<LinkifiedText pretty={false} text="open agent.log please" />)

    const link = screen.getByRole('link', { name: 'agent.log' })
    expect(link.getAttribute('href')).toBe('https://agent.log')
  })

  it('prefixes a pretty link to a known host with its brand glyph', () => {
    installDesktopBridge()

    const url = 'https://github.com/NousResearch/hermes-agent/pull/123'

    render(<PrettyLink fallbackLabel="#123" href={url} />)

    const link = screen.getByTitle(url)

    expect(link.querySelector('svg')).toBeTruthy()
    // The glyph is decorative — it must not pollute the link's accessible name.
    expect(link.textContent).toBe('#123')
  })

  it('renders no brand glyph for an unknown host', () => {
    installDesktopBridge()

    const url = 'https://example.com/some/page'

    render(<PrettyLink fallbackLabel="Some Page" href={url} />)

    expect(screen.getByTitle(url).querySelector('svg')).toBeNull()
  })
})

const MERCURY = 'https://en.wikipedia.org/wiki/Mercury_(planet)'

// The text of each link LinkifiedText makes, explicitOnly as a tool row and a
// system message use it unless `explicitOnly` is false.
function links(text: string, explicitOnly = true): string[] {
  const { container } = render(<LinkifiedText explicitOnly={explicitOnly} pretty={false} text={text} />)

  // Linking never adds, drops or moves a character.
  expect(container.textContent).toBe(text)

  return Array.from(container.querySelectorAll('a'), link => link.textContent ?? '')
}

describe('LinkifiedText URLs with parentheses and brackets', () => {
  it('links a URL whole when its ")" closes a "(" in it', () => {
    expect(links(`${MERCURY} — Blocked: private address`)).toEqual([MERCURY])
    expect(links(`Opened ${MERCURY}`, false)).toEqual([MERCURY])
  })

  it('names and looks up the whole page', async () => {
    const bridge = installTitleBridge('Mercury (planet) - Wikipedia')

    render(<LinkifiedText explicitOnly text={`${MERCURY} — Blocked: private address`} />)

    const link = screen.getByTitle(MERCURY)

    expect(link.getAttribute('href')).toBe(MERCURY)
    expect(link.textContent).toBe('Mercury (Planet)')
    await waitFor(() => {
      expect(link.textContent).toBe('Mercury (planet) - Wikipedia')
    })
    expect(bridge).toHaveBeenCalledWith(MERCURY)
  })

  it('stops at a ")" that closes nothing in the URL', () => {
    expect(links('(see https://acme.dev)')).toEqual(['https://acme.dev'])
    expect(links('(see https://acme.dev).')).toEqual(['https://acme.dev'])
    expect(links('(see https://acme.dev.)')).toEqual(['https://acme.dev'])
    expect(links('[docs](https://acme.dev/docs), then')).toEqual(['https://acme.dev/docs'])
    expect(links(`(see ${MERCURY})`)).toEqual([MERCURY])
  })

  it('keeps nested parens that the URL closes', () => {
    expect(links('https://acme.dev/a_(b_(c))')).toEqual(['https://acme.dev/a_(b_(c))'])
    expect(links('(https://acme.dev/a_(b_(c)))')).toEqual(['https://acme.dev/a_(b_(c))'])
    expect(links('https://acme.dev/a((b)')).toEqual(['https://acme.dev/a((b)'])
  })

  it('still drops punctuation after a ")" the URL keeps', () => {
    expect(links(`Opened ${MERCURY}.`)).toEqual([MERCURY])
    expect(links(`${MERCURY}, ${MERCURY}!`)).toEqual([MERCURY, MERCURY])
    expect(links(`(${MERCURY}).`)).toEqual([MERCURY])
    // Inside the parens it is the URL's.
    expect(links('https://acme.dev/(a.)')).toEqual(['https://acme.dev/(a.)'])
  })

  it('stops at a "]" that closes no "[", and keeps one that does', () => {
    expect(links('[see https://acme.dev]')).toEqual(['https://acme.dev'])
    expect(links('[see https://acme.dev/x].')).toEqual(['https://acme.dev/x'])
    expect(links('[https://acme.dev](https://acme.dev)')).toEqual(['https://acme.dev', 'https://acme.dev'])
    expect(links('http://[::1]:8080/x')).toEqual(['http://[::1]:8080/x'])
    expect(links('https://acme.dev/?a[]=1&b[0]=2')).toEqual(['https://acme.dev/?a[]=1&b[0]=2'])
    // A ")" closes only a "(", and a "]" only a "[".
    expect(links('https://acme.dev/(x]')).toEqual(['https://acme.dev/(x'])
    expect(links('https://acme.dev/[x)')).toEqual(['https://acme.dev/[x'])
  })

  it('stops at a ")" that closes nothing even mid-URL, as tool-row titles do', () => {
    expect(links('(https://acme.dev)—x')).toEqual(['https://acme.dev'])
    expect(links('https://a.b/x)y')).toEqual(['https://a.b/x'])
    // What the cut leaves is read again, and a cut that leaves no host links nothing.
    expect(links('(https://a.dev/x)(https://b.dev/y)')).toEqual(['https://a.dev/x', 'https://b.dev/y'])
    expect(links('https://)x')).toEqual([])
  })

  it('reads a bare domain the same way, which explicitOnly never links', () => {
    const { container } = render(<LinkifiedText pretty={false} text="see en.wikipedia.org/wiki/Mercury_(planet)." />)

    expect(container.querySelector('a')?.getAttribute('href')).toBe(MERCURY)
    expect(links('see en.wikipedia.org/wiki/Mercury_(planet).', false)).toEqual([
      'en.wikipedia.org/wiki/Mercury_(planet)'
    ])
    expect(links('(see acme.dev/docs)', false)).toEqual(['acme.dev/docs'])
    expect(links('[see acme.dev/docs]', false)).toEqual(['acme.dev/docs'])
    expect(links('see en.wikipedia.org/wiki/Mercury_(planet).')).toEqual([])
  })
})
