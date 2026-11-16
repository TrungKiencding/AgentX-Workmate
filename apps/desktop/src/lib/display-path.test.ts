import { describe, expect, it } from 'vitest'

import { displayPath, normalizeDisplayPath, pathLeaf, tailPath } from './display-path'

describe('displayPath', () => {
  it('collapses a macOS home prefix to ~', () => {
    expect(displayPath('/Users/brooklyn/www/agentx-agent')).toBe('~/www/agentx-agent')
    expect(displayPath('/Users/brooklyn')).toBe('~')
  })

  it('collapses a Linux home prefix to ~', () => {
    expect(displayPath('/home/alice/src/app')).toBe('~/src/app')
  })

  it('collapses a Windows user profile to ~', () => {
    expect(displayPath('C:\\Users\\brooklyn\\src')).toBe('~/src')
    expect(displayPath('C:/Users/brooklyn')).toBe('~')
  })

  it('honours an explicit home override', () => {
    expect(displayPath('/opt/work/repo', { home: '/opt/work' })).toBe('~/repo')
    expect(displayPath('/elsewhere/repo', { home: '/opt/work' })).toBe('/elsewhere/repo')
  })

  it('leaves non-home absolute paths alone', () => {
    expect(displayPath('/var/log/system.log')).toBe('/var/log/system.log')
    expect(displayPath('/Users')).toBe('/Users')
  })

  it('normalizes separators and trailing slashes', () => {
    expect(normalizeDisplayPath('C:\\Users\\me\\src\\')).toBe('C:/Users/me/src')
    expect(displayPath('/Users/me/src/')).toBe('~/src')
  })

  it('keeps an already-tildified path', () => {
    expect(displayPath('~/www/app')).toBe('~/www/app')
    expect(displayPath('~')).toBe('~')
  })
})

describe('pathLeaf', () => {
  it('returns the last segment', () => {
    expect(pathLeaf('/Users/me/www/agentx-agent')).toBe('agentx-agent')
    expect(pathLeaf('~/www/agentx-agent')).toBe('agentx-agent')
    expect(pathLeaf('/')).toBe('/')
  })
})

describe('tailPath', () => {
  it('keeps a path that fits', () => {
    expect(tailPath('/Users/me/work/acme', 40)).toBe('~/work/acme')
  })

  it('keeps the end — the part that tells long paths apart', () => {
    expect(tailPath('/srv/shared/clients/2026/quarterly/acme-corp', 24)).toBe('…/quarterly/acme-corp')
  })

  it('never cuts inside a segment, even when one leaf is longer than the limit', () => {
    expect(tailPath('/data/an-extremely-long-folder-name-for-reports', 10)).toBe(
      '…/an-extremely-long-folder-name-for-reports'
    )
  })

  it('works with Windows paths', () => {
    expect(tailPath('D:\\Projects\\Clients\\Acme\\Reports', 16)).toBe('…/Acme/Reports')
  })
})
