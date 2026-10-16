import { describe, expect, it } from 'vitest'

import { isPrivateNetworkHost } from './private-network-host'

// The classifier reads `URL.hostname`, so every case goes through the URL
// parser first, as it does in the app.
const isPrivate = (url: string) => isPrivateNetworkHost(new URL(url).hostname)

const PRIVATE_URLS: Record<string, string[]> = {
  'RFC 1918': [
    'http://10.0.0.1/admin',
    'http://10.255.255.255/',
    'http://172.16.0.1/',
    'http://172.31.255.254/',
    'http://192.168.1.1/'
  ],
  'loopback and "this network"': ['http://127.0.0.1:8080/', 'http://127.4.5.6/', 'http://0.0.0.0:3000/', 'http://0/'],
  'link-local and cloud metadata': [
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.170.2/v2/credentials',
    'http://169.254.1.1/',
    'http://100.100.100.200/latest/meta-data/'
  ],
  'carrier-grade NAT and Tailscale': ['http://100.64.0.1/', 'http://100.101.102.103:8080/', 'http://100.127.255.254/'],
  'documentation, benchmarking and IETF ranges': [
    'http://192.0.0.1/',
    'http://192.0.2.10/',
    'http://198.18.0.1/',
    'http://198.19.255.254/',
    'http://198.51.100.7/',
    'http://203.0.113.9/'
  ],
  'multicast, reserved and broadcast': [
    'http://224.0.0.1/',
    'http://239.255.255.250:1900/',
    'http://240.0.0.1/',
    'http://255.255.255.255/'
  ],
  'IPv4 written in decimal, hex, octal or short form': [
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://0x7f.1/',
    'http://127.1/',
    'http://3232235777/',
    'http://0xa9fea9fe/',
    'http://0xA9.0xFE.0xA9.0xFE/',
    'http://2852039166/',
    'http://%31%32%37.0.0.1/',
    'http://127。0。0。1/'
  ],
  'IPv6 loopback, unspecified, unique local, link-local and multicast': [
    'http://[::1]:8080/',
    'http://[0:0:0:0:0:0:0:1]/',
    'http://[::]/',
    'http://[fc00::1]/',
    'http://[fd12:3456:789a::1]/',
    'http://[fd00:ec2::254]/',
    'http://[fe80::1]/',
    'http://[fec0::1]/',
    'http://[ff02::1]/'
  ],
  'IPv6 wrapping a private IPv4 address': [
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:c0a8:101]/',
    'http://[::127.0.0.1]/',
    'http://[64:ff9b::10.0.0.1]/',
    'http://[2002:a00:1::]/'
  ],
  'IPv6 documentation, discard and IETF ranges': [
    'http://[2001:db8::1]/',
    'http://[3fff::1]/',
    'http://[100::1]/',
    'http://[2001::1]/',
    'http://[2001:1ff:ffff::1]/'
  ],
  'localhost aliases': [
    'http://localhost:5174/',
    'http://LOCALHOST/',
    'http://localhost./',
    'http://app.localhost/',
    'http://api.dev.localhost:3000/'
  ],
  'names that resolve only inside a network': [
    'http://nas.local/',
    'http://printer.local:631/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata.goog/',
    'http://router.lan/',
    'http://grafana.home.arpa/',
    'http://files.home/',
    'http://wiki.corp/',
    'http://jira.intranet/',
    'http://vault.private/',
    'http://myapp.test/'
  ],
  'single-label hosts': ['http://intranet/wiki', 'http://router/', 'http://nas:5000/', 'http://intranet./']
}

const PUBLIC_URLS = [
  'https://www.expedia.com/things-to-do/foo',
  'https://github.com/NousResearch/hermes-agent/pull/123',
  'https://example.com./',
  'https://例え.jp/',
  'https://local.example.com/',
  'https://localhost.example.com/',
  'https://internal.company.com/',
  'https://test.com/',
  'http://8.8.8.8/',
  'http://1.1.1.1/',
  'http://134744072/',
  'http://11.0.0.1/',
  'http://100.63.255.255/',
  'http://100.128.0.1/',
  'http://169.253.255.255/',
  'http://169.255.0.1/',
  'http://172.15.255.255/',
  'http://172.32.0.1/',
  'http://192.167.255.255/',
  'http://192.169.0.1/',
  'http://198.17.255.255/',
  'http://198.20.0.1/',
  'http://223.255.255.255/',
  'https://[2606:4700:4700::1111]/',
  'https://[2001:4860:4860::8888]/',
  'http://[2001:200::1]/',
  'http://[::ffff:8.8.8.8]/'
]

describe('isPrivateNetworkHost', () => {
  it.each(Object.entries(PRIVATE_URLS))('refuses %s', (_group, urls) => {
    for (const url of urls) {
      expect(isPrivate(url), url).toBe(true)
    }
  })

  it('still lets public hosts through, right up to the edge of each range', () => {
    for (const url of PUBLIC_URLS) {
      expect(isPrivate(url), url).toBe(false)
    }
  })

  it('refuses a host it cannot read rather than fetching it', () => {
    expect(isPrivateNetworkHost('')).toBe(true)
    expect(isPrivateNetworkHost('[::ffff:127.0.0.1]')).toBe(true)
    expect(isPrivateNetworkHost('[1:2:3:4:5:6:7:8:9]')).toBe(true)
    expect(isPrivateNetworkHost('[2001:db8::1::1]')).toBe(true)
  })

  // electron/private-network-host.ts keeps a copy of this classifier for the
  // main process, whose tsconfig can't import from src/. Both must give every
  // case the same verdict. The path is a variable so tsc doesn't pull the file
  // into this project.
  it('agrees with the main-process copy', async () => {
    const mainCopy = '../../electron/private-network-host'

    const main = (await import(/* @vite-ignore */ mainCopy)) as {
      isPrivateNetworkHost: typeof isPrivateNetworkHost
    }

    const hosts = [...Object.values(PRIVATE_URLS).flat(), ...PUBLIC_URLS].map(url => new URL(url).hostname)

    for (const host of [...hosts, '', '[1:2:3:4:5:6:7:8:9]']) {
      expect(main.isPrivateNetworkHost(host), host).toBe(isPrivateNetworkHost(host))
    }
  })
})
