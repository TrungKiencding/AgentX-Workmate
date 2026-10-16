// Tier 1 of link-title resolution (curl), one hop at a time, and the DNS check
// both tiers share. private-network-host.ts judges a host by how it is written,
// but a public-looking link can still reach the private network: through a
// redirect (a 302 to 169.254.169.254) or through a name that resolves there
// (10.0.0.1.nip.io, localtest.me, a split-horizon intranet name). So curl never
// follows a redirect itself. Each hop is checked here, its name is resolved,
// and curl is pinned to an address that passed.

import { randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { isPrivateNetworkHost, linkTitleTarget, reachesPrivateNetwork } from './private-network-host'

// Room for curl's --write-out at the end of stdout (status and next hop), kept
// apart from the body budget so a long body can't push it out.
const WRITE_OUT_BUDGET = 16 * 1024

export type ResolveAddresses = (hostname: string) => Promise<string[]>

// The part of a ChildProcess a hop reads.
export interface CurlChild {
  on(event: 'close' | 'error', listener: () => void): unknown
  stdout: null | { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown }
}

export interface CurlTitleOptions {
  byteBudget: number
  maxRedirects: number
  resolve: ResolveAddresses
  spawn: (command: string, args: string[]) => CurlChild
  timeoutMs: number
  userAgent: string
}

interface Hop {
  body: Buffer
  redirect: string
  status: number
}

// The system resolver: the answers curl would have looked up for itself.
export const lookupAddresses: ResolveAddresses = async hostname =>
  (await lookup(hostname, { all: true })).map(answer => answer.address)

function isIpHost(hostname: string): boolean {
  return hostname.startsWith('[') || isIP(hostname) === 4
}

// Every address `hostname` resolves to, when all of them are public. [] when
// any is private, when there are none, or when the lookup fails: one private
// answer is enough for a connection to land there.
export async function publicAddresses(hostname: string, resolve: ResolveAddresses): Promise<string[]> {
  try {
    const addresses = await resolve(hostname)

    // The classifier reads URL.hostname, which brackets IPv6.
    const isPublic = (address: string) =>
      isIP(address) !== 0 && !isPrivateNetworkHost(address.includes(':') ? `[${address}]` : address)

    return addresses.length && addresses.every(isPublic) ? addresses : []
  } catch {
    return []
  }
}

// Whether the hidden title window may send a request: not to a private host,
// whether the URL names it or the name's DNS answers do. Schemes with no
// network host (data:, blob:, about:) pass.
export async function requestStaysPublic(raw: string, resolve: ResolveAddresses): Promise<boolean> {
  if (reachesPrivateNetwork(raw)) {
    return false
  }

  let url: URL

  try {
    url = new URL(raw)
  } catch {
    return false
  }

  if (!/^(?:https?|wss?):$/.test(url.protocol) || isIpHost(url.hostname)) {
    return true
  }

  return (await publicAddresses(url.hostname, resolve)).length > 0
}

// The URL curl may fetch next: linkTitleTarget's, minus trailing dots on the
// host. curl matches --resolve against the host as written, and some versions
// drop the dot first, so a pin only holds for a dotless host. Checked again
// after: "10.0.0.1.." is an IPv4 address once its dots go.
function hopTarget(raw: string): null | URL {
  const target = linkTitleTarget(raw)

  if (!target) {
    return null
  }

  const url = new URL(target)

  url.hostname = url.hostname.replace(/\.+$/, '')

  return !url.hostname.endsWith('.') && linkTitleTarget(url.href) ? url : null
}

function beforeDeadline<T>(pending: Promise<T>, deadline: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), Math.max(0, deadline - Date.now()))

    const settle = (value: T) => {
      clearTimeout(timer)
      resolve(value)
    }

    pending.then(settle, () => settle(fallback))
  })
}

// One request, with no redirect followed. The status and the next hop come from
// --write-out, behind a random marker at the end of stdout. Not %{stderr}:
// Windows' bundled curl can be 7.55, which predates it.
function curlHop(url: URL, address: string, deadline: number, options: CurlTitleOptions): Promise<Hop | null> {
  const remainingMs = deadline - Date.now()

  if (remainingMs <= 0) {
    return Promise.resolve(null)
  }

  const marker = `agentx-hop-${randomBytes(8).toString('hex')}:`
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')

  const args = [
    // First, or curl reads ~/.curlrc, where a `location` line would follow
    // redirects past every check here.
    '-q',
    '--silent',
    '--show-error',
    // `[` and `{` stay in the URL instead of turning it into more requests.
    '--globoff',
    '--proto',
    '=http,https',
    '--max-time',
    String(Math.max(1, Math.ceil(remainingMs / 1000))),
    '--connect-timeout',
    '4',
    '--user-agent',
    options.userAgent,
    '--header',
    'Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
    '--header',
    'Accept-Language: en-US,en;q=0.7',
    '--header',
    'Accept-Encoding: identity',
    '--raw',
    ...(address ? ['--resolve', `${url.hostname}:${port}:${address}`] : []),
    '--write-out',
    `${marker}%{http_code} %{redirect_url}`,
    url.href
  ]

  return new Promise(resolve => {
    let child: CurlChild

    try {
      child = options.spawn('curl', args)
    } catch {
      return resolve(null)
    }

    const head: Buffer[] = []
    let headBytes = 0
    let tail: Buffer = Buffer.alloc(0)
    let total = 0

    child.stdout?.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)

      total += buffer.length

      if (headBytes < options.byteBudget) {
        const next = buffer.subarray(0, options.byteBudget - headBytes)

        head.push(next)
        headBytes += next.length
      }

      tail = (buffer.length >= WRITE_OUT_BUDGET ? buffer : Buffer.concat([tail, buffer])).subarray(-WRITE_OUT_BUDGET)
    })

    child.on('error', () => resolve(null))
    child.on('close', () => {
      const at = tail.lastIndexOf(marker)
      const meta = at < 0 ? null : /^(\d{3}) (.*)$/s.exec(tail.subarray(at + marker.length).toString('utf8'))

      if (!meta) {
        return resolve(null)
      }

      // Everything before the write-out is body, and the budget may have cut it.
      const bodyBytes = total - (tail.length - at)

      resolve({ body: Buffer.concat(head).subarray(0, bodyBytes), redirect: meta[2], status: Number(meta[1]) })
    })
  })
}

// The HTML (up to the byte budget) of the page a link ends at, read by curl.
// '' when a hop leaves the public network, when the chain runs past
// maxRedirects, or when the last response is a redirect: a 3xx body ("301
// Moved Permanently") is never a title.
export async function fetchTitleHtmlWithCurl(raw: string, options: CurlTitleOptions): Promise<string> {
  const deadline = Date.now() + options.timeoutMs
  let next = raw

  for (let redirects = 0; redirects <= options.maxRedirects; redirects += 1) {
    const url = hopTarget(next)

    if (!url) {
      return ''
    }

    let address = ''

    if (!isIpHost(url.hostname)) {
      const addresses = await beforeDeadline(publicAddresses(url.hostname, options.resolve), deadline, [])

      // IPv4 first: a pinned address has no fallback to the other family, and
      // IPv4 is the one nearly every network still routes.
      address = addresses.find(candidate => !candidate.includes(':')) ?? addresses[0]

      if (!address) {
        return ''
      }
    }

    const hop = await curlHop(url, address, deadline, options)

    if (!hop) {
      return ''
    }

    if (hop.status < 300 || hop.status > 399) {
      return hop.body.toString('utf8')
    }

    if (!hop.redirect) {
      return ''
    }

    next = hop.redirect
  }

  return ''
}
