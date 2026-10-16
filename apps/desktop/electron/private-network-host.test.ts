import { describe, expect, it } from 'vitest'

import { isPrivateNetworkHost, linkTitleTarget, reachesPrivateNetwork } from './private-network-host'

// The classifier's full table lives in src/lib/private-network-host.test.ts,
// which also checks this copy against the renderer's.

describe('isPrivateNetworkHost', () => {
  it('refuses this machine and its network, and lets public hosts through', () => {
    for (const host of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '[::1]',
      '[fd00:ec2::254]',
      'nas.local',
      'intranet'
    ]) {
      expect(isPrivateNetworkHost(host), host).toBe(true)
    }

    for (const host of ['example.com', '8.8.8.8', '[2606:4700:4700::1111]']) {
      expect(isPrivateNetworkHost(host), host).toBe(false)
    }
  })
})

describe('linkTitleTarget', () => {
  it('passes a public http(s) page on, re-serialized', () => {
    expect(linkTitleTarget('https://www.expedia.com/things-to-do/foo')).toBe('https://www.expedia.com/things-to-do/foo')
    expect(linkTitleTarget('  HTTP://Example.COM  ')).toBe('http://example.com/')
    expect(linkTitleTarget('https://例え.jp/パス')).toBe('https://xn--r8jz45g.jp/%E3%83%91%E3%82%B9')
  })

  it('refuses the private network however the host is spelled', () => {
    for (const url of [
      'http://10.0.0.1/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://2130706433/',
      'http://0x7f.1/',
      'http://[::ffff:7f00:1]/',
      'http://[fe80::1]/',
      'http://nas.local/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://intranet/',
      'http://localhost:5174/'
    ]) {
      expect(linkTitleTarget(url), url).toBe('')
    }
  })

  it('refuses anything that is not an http(s) URL', () => {
    for (const raw of [
      'file:///etc/passwd',
      'ftp://example.com/',
      'data:text/html,<title>x</title>',
      'javascript:alert(1)',
      'example.com',
      '',
      null,
      undefined,
      42,
      { href: 'https://example.com/' }
    ]) {
      expect(linkTitleTarget(raw), String(raw)).toBe('')
    }
  })
})

describe('reachesPrivateNetwork', () => {
  it('flags a redirect hop or request into the private network', () => {
    expect(reachesPrivateNetwork('http://192.168.1.1/cgi-bin/reboot')).toBe(true)
    expect(reachesPrivateNetwork('https://[::1]:8443/')).toBe(true)
    expect(reachesPrivateNetwork('ws://localhost:9222/devtools/browser')).toBe(true)
    expect(reachesPrivateNetwork('wss://printer.local/')).toBe(true)
  })

  it('lets public requests and schemes without a network host through', () => {
    expect(reachesPrivateNetwork('https://cdn.example.com/app.js')).toBe(false)
    expect(reachesPrivateNetwork('data:image/png;base64,AAAA')).toBe(false)
    expect(reachesPrivateNetwork('blob:https://example.com/0b6c')).toBe(false)
    expect(reachesPrivateNetwork('about:blank')).toBe(false)
    expect(reachesPrivateNetwork('not a url')).toBe(false)
  })
})
