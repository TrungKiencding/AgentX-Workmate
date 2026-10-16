import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import { type CurlTitleOptions, fetchTitleHtmlWithCurl, publicAddresses, requestStaysPublic } from './link-title-fetch'

interface Page {
  body?: string
  location?: string
  status: number
}

// Stands in for curl: answers each URL like a server, then fills in
// --write-out the way curl does. %{redirect_url} is absolute, and empty unless
// a 3xx carried a Location.
function fakeCurl(pages: Record<string, Page>, chunkSize = Infinity) {
  const runs: string[][] = []

  const spawn = (_command: string, args: string[]) => {
    runs.push(args)

    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() })
    const url = args.at(-1)
    const page = pages[url] ?? { status: 0 }
    const redirect = page.location && page.status >= 300 && page.status < 400 ? new URL(page.location, url).href : ''

    const writeOut = args[args.indexOf('--write-out') + 1]
      .replace('%{http_code}', String(page.status).padStart(3, '0'))
      .replace('%{redirect_url}', redirect)

    const output = Buffer.from(`${page.body ?? ''}${writeOut}`)

    setImmediate(() => {
      for (let at = 0; at < output.length; at += chunkSize) {
        child.stdout.emit('data', output.subarray(at, at + chunkSize))
      }

      child.emit('close', 0)
    })

    return child
  }

  return { runs, spawn, urls: () => runs.map(args => args.at(-1)) }
}

function resolver(answers: Record<string, string[]>) {
  const asked: string[] = []

  const resolve = async (hostname: string) => {
    asked.push(hostname)

    if (!(hostname in answers)) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })
    }

    return answers[hostname]
  }

  return { asked, resolve }
}

const PUBLIC_DNS = { 'public.example': ['93.184.216.34'], 'www.public.example': ['93.184.216.35'] }

function options(
  curl: Pick<ReturnType<typeof fakeCurl>, 'spawn'>,
  resolve = resolver(PUBLIC_DNS).resolve,
  overrides: Partial<CurlTitleOptions> = {}
): CurlTitleOptions {
  return {
    byteBudget: 96 * 1024,
    maxRedirects: 3,
    resolve,
    spawn: curl.spawn,
    timeoutMs: 5000,
    userAgent: 'test-agent',
    ...overrides
  }
}

function valueAfter(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag)

  return at < 0 ? undefined : args[at + 1]
}

describe('fetchTitleHtmlWithCurl', () => {
  it('follows a public redirect chain one hop at a time', async () => {
    const curl = fakeCurl({
      'http://public.example/': {
        body: '<title>301 Moved Permanently</title>',
        location: 'https://public.example/',
        status: 301
      },
      'https://public.example/': { location: '/home', status: 302 },
      'https://public.example/home': { location: 'https://www.public.example/home', status: 307 },
      'https://www.public.example/home': { body: '<html><title>Home</title></html>', status: 200 }
    })

    expect(await fetchTitleHtmlWithCurl('http://public.example/', options(curl))).toBe(
      '<html><title>Home</title></html>'
    )
    expect(curl.urls()).toEqual([
      'http://public.example/',
      'https://public.example/',
      'https://public.example/home',
      'https://www.public.example/home'
    ])
    expect(curl.runs.some(args => args.includes('--location') || args.includes('-L'))).toBe(false)
  })

  it('refuses a redirect into the private network, by address or by name', async () => {
    for (const location of [
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.1/cgi-bin/reboot',
      'http://[::1]:8080/',
      'http://2130706433/',
      'http://localhost../',
      'http://10.0.0.1.nip.io/',
      'http://unresolvable.example/',
      'file:///etc/passwd'
    ]) {
      const curl = fakeCurl({
        'https://public.example/': { body: '<title>Found</title>', location, status: 302 },
        [new URL(location).href]: { body: '<title>Private page</title>', status: 200 }
      })

      const dns = resolver({ ...PUBLIC_DNS, '10.0.0.1.nip.io': ['10.0.0.1'] })

      expect(await fetchTitleHtmlWithCurl('https://public.example/', options(curl, dns.resolve)), location).toBe('')
      expect(curl.urls(), location).toEqual(['https://public.example/'])
    }
  })

  it('never takes a title from a 3xx body', async () => {
    const noLocation = fakeCurl({ 'https://public.example/': { body: '<title>302 Found</title>', status: 302 } })

    expect(await fetchTitleHtmlWithCurl('https://public.example/', options(noLocation))).toBe('')

    const notModified = fakeCurl({ 'https://public.example/': { body: '<title>304</title>', status: 304 } })

    expect(await fetchTitleHtmlWithCurl('https://public.example/', options(notModified))).toBe('')

    // One redirect more than maxRedirects: the chain ends on a 3xx.
    const tooLong = fakeCurl(
      Object.fromEntries(
        [1, 2, 3, 4].map(step => [
          `https://public.example/${step}`,
          { body: '<title>301 Moved Permanently</title>', location: `/${step + 1}`, status: 301 }
        ])
      )
    )

    expect(await fetchTitleHtmlWithCurl('https://public.example/1', options(tooLong))).toBe('')
    expect(tooLong.urls()).toHaveLength(4)
  })

  it('refuses a name with any private DNS answer before curl runs', async () => {
    for (const answers of [
      ['93.184.216.34', '10.0.0.1'],
      ['127.0.0.1'],
      ['100.100.100.200'],
      ['fd00:ec2::254'],
      ['2606:4700:4700::1111', '::1'],
      ['fe80::1%en0'],
      ['::ffff:169.254.169.254'],
      []
    ]) {
      const curl = fakeCurl({ 'https://rebind.example/': { body: '<title>Rebound</title>', status: 200 } })
      const dns = resolver({ 'rebind.example': answers })

      expect(await fetchTitleHtmlWithCurl('https://rebind.example/', options(curl, dns.resolve)), String(answers)).toBe(
        ''
      )
      expect(curl.runs, String(answers)).toEqual([])
    }

    // A failed lookup refuses too.
    const gone = fakeCurl({ 'https://gone.example/': { body: '<title>Gone</title>', status: 200 } })

    expect(await fetchTitleHtmlWithCurl('https://gone.example/', options(gone))).toBe('')
    expect(gone.runs).toEqual([])
  })

  it('pins curl to the address it checked', async () => {
    const curl = fakeCurl({ 'https://public.example:8443/a': { body: '<title>A</title>', status: 200 } })
    const dns = resolver({ 'public.example': ['2606:2800:21f:cb07:6820:80da:af6b:8b2c', '93.184.216.34'] })

    expect(await fetchTitleHtmlWithCurl('https://public.example:8443/a', options(curl, dns.resolve))).toBe(
      '<title>A</title>'
    )

    const [args] = curl.runs

    // -q only works first; it keeps ~/.curlrc (and a `location` in it) out.
    expect(args[0]).toBe('-q')
    expect(args).toContain('--globoff')
    expect(valueAfter(args, '--proto')).toBe('=http,https')
    // IPv4 first: a single pinned address has no fallback to the other family.
    expect(valueAfter(args, '--resolve')).toBe('public.example:8443:93.184.216.34')
    expect(valueAfter(args, '--user-agent')).toBe('test-agent')

    // IPv6 goes in unbracketed, the form curl 7.55 parses too.
    const v6 = fakeCurl({ 'http://public.example/': { body: '<title>v6</title>', status: 200 } })

    await fetchTitleHtmlWithCurl(
      'http://public.example/',
      options(v6, resolver({ 'public.example': ['2606:4700:4700::1111'] }).resolve)
    )
    expect(valueAfter(v6.runs[0], '--resolve')).toBe('public.example:80:2606:4700:4700::1111')

    // A trailing dot comes off, so the pin matches the host curl looks up.
    const dotted = fakeCurl({ 'https://public.example/b': { body: '<title>B</title>', status: 200 } })

    expect(await fetchTitleHtmlWithCurl('https://public.example./b', options(dotted))).toBe('<title>B</title>')
    expect(valueAfter(dotted.runs[0], '--resolve')).toBe('public.example:443:93.184.216.34')

    // An IP literal has nothing to resolve or pin.
    const literal = fakeCurl({ 'https://8.8.8.8/': { body: '<title>Literal</title>', status: 200 } })
    const unused = resolver({})

    expect(await fetchTitleHtmlWithCurl('https://8.8.8.8/', options(literal, unused.resolve))).toBe(
      '<title>Literal</title>'
    )
    expect(literal.runs[0]).not.toContain('--resolve')
    expect(unused.asked).toEqual([])
  })

  it('reads the write-out past the body budget', async () => {
    const body = `<title>Big</title>${'x'.repeat(50_000)}`
    const big = fakeCurl({ 'https://public.example/': { body, status: 200 } }, 4096)

    expect(await fetchTitleHtmlWithCurl('https://public.example/', options(big, undefined, { byteBudget: 1024 }))).toBe(
      body.slice(0, 1024)
    )

    // A short body comes back whole, write-out split across chunks or not.
    const short = fakeCurl({ 'https://public.example/': { body: '<title>Short</title>', status: 200 } }, 7)

    expect(await fetchTitleHtmlWithCurl('https://public.example/', options(short))).toBe('<title>Short</title>')

    // A large 3xx body can't hide the redirect.
    const longRedirect = fakeCurl(
      {
        'https://public.example/': { body: 'x'.repeat(200_000), location: '/next', status: 302 },
        'https://public.example/next': { body: '<title>Next</title>', status: 200 }
      },
      65_536
    )

    expect(await fetchTitleHtmlWithCurl('https://public.example/', options(longRedirect))).toBe('<title>Next</title>')

    // The marker is random, so a page can't end its body with a status line of its own.
    const forged = '<title>Real</title>agentx-hop-0123456789abcdef:302 http://10.0.0.1/'
    const forger = fakeCurl({ 'https://public.example/': { body: forged, status: 200 } })

    expect(await fetchTitleHtmlWithCurl('https://public.example/', options(forger))).toBe(forged)
    expect(forger.urls()).toEqual(['https://public.example/'])
  })

  it('fails closed when curl prints no write-out or does not start', async () => {
    const killed = {
      spawn: () => {
        const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() })

        setImmediate(() => {
          child.stdout.emit('data', Buffer.from('<title>Half a page</title>'))
          child.emit('close', null)
        })

        return child
      }
    }

    expect(await fetchTitleHtmlWithCurl('https://public.example/', options(killed))).toBe('')

    const missing = {
      spawn: () => {
        const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() })

        setImmediate(() => child.emit('error', Object.assign(new Error('spawn curl ENOENT'), { code: 'ENOENT' })))

        return child
      }
    }

    expect(await fetchTitleHtmlWithCurl('https://public.example/', options(missing))).toBe('')
  })

  it('gives up when the lookup outlasts the time budget', async () => {
    const curl = fakeCurl({ 'https://public.example/': { body: '<title>Late</title>', status: 200 } })
    const hanging = () => new Promise<string[]>(() => {})

    expect(await fetchTitleHtmlWithCurl('https://public.example/', options(curl, hanging, { timeoutMs: 20 }))).toBe('')
    expect(curl.runs).toEqual([])
  })
})

describe('publicAddresses', () => {
  it('returns every answer when all are public, and none when one is not', async () => {
    const dns = resolver({
      'mixed.example': ['8.8.8.8', '192.168.0.10'],
      'public.example': ['8.8.8.8', '2001:4860:4860::8888']
    })

    expect(await publicAddresses('public.example', dns.resolve)).toEqual(['8.8.8.8', '2001:4860:4860::8888'])
    expect(await publicAddresses('mixed.example', dns.resolve)).toEqual([])
    expect(await publicAddresses('missing.example', dns.resolve)).toEqual([])
  })
})

describe('requestStaysPublic', () => {
  it('blocks a request whose host is private by name or by DNS answer', async () => {
    const dns = resolver({
      'cdn.example': ['151.101.1.1'],
      'nip.example': ['10.0.0.1'],
      'v6.example': ['fd00::1']
    })

    expect(await requestStaysPublic('https://cdn.example/app.js', dns.resolve)).toBe(true)
    expect(await requestStaysPublic('https://nip.example/hop', dns.resolve)).toBe(false)
    expect(await requestStaysPublic('wss://v6.example/socket', dns.resolve)).toBe(false)
    expect(await requestStaysPublic('https://missing.example/', dns.resolve)).toBe(false)
    expect(dns.asked).toEqual(['cdn.example', 'nip.example', 'v6.example', 'missing.example'])
  })

  it('judges literals and non-network schemes without a lookup', async () => {
    const dns = resolver({})

    expect(await requestStaysPublic('http://192.168.1.1/', dns.resolve)).toBe(false)
    expect(await requestStaysPublic('ws://localhost:9222/devtools/browser', dns.resolve)).toBe(false)
    expect(await requestStaysPublic('https://8.8.8.8/', dns.resolve)).toBe(true)
    expect(await requestStaysPublic('https://[2606:4700:4700::1111]/', dns.resolve)).toBe(true)
    expect(await requestStaysPublic('data:image/png;base64,AAAA', dns.resolve)).toBe(true)
    expect(await requestStaysPublic('blob:https://example.com/0b6c', dns.resolve)).toBe(true)
    expect(await requestStaysPublic('about:blank', dns.resolve)).toBe(true)
    expect(dns.asked).toEqual([])
  })
})
