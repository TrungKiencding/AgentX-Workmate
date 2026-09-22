import { describe, expect, it } from 'vitest'

import {
  isMessagingSource,
  LOCAL_SESSION_SOURCE_IDS,
  MESSAGING_SESSION_SOURCE_IDS,
  sessionSourceLabel,
  sessionSourceSearchTerms
} from './session-source'

// Regression guard for #46761 / PR #47395: Photon (iMessage) must keep its own
// sidebar section. refreshMessagingSessions() filters rows through
// isMessagingSource(), so this entry is the sole condition that keeps Photon
// sessions out of generic recents. A silent removal would regress the feature
// with no test failure — these asserts pin the contract.
describe('photon messaging source registration', () => {
  it('treats photon as a messaging source (own sidebar section)', () => {
    expect(isMessagingSource('photon')).toBe(true)
  })

  it('is case/space insensitive on the source id', () => {
    expect(isMessagingSource('PHOTON')).toBe(true)
    expect(isMessagingSource('  photon ')).toBe(true)
  })

  it('exposes the iMessage/messages search aliases so Photon sessions are findable', () => {
    const terms = sessionSourceSearchTerms('photon')
    expect(terms).toContain('imessage')
    expect(terms).toContain('messages')
  })

  it('is registered in the messaging source id list', () => {
    expect(MESSAGING_SESSION_SOURCE_IDS).toContain('photon')
  })

  it('does not flag local/CLI-ish sources as messaging (guard sanity)', () => {
    expect(isMessagingSource('cli')).toBe(false)
    expect(isMessagingSource(null)).toBe(false)
    expect(isMessagingSource(undefined)).toBe(false)
  })
})

// Every connectable channel must be a messaging source, or its transcripts land
// in local recents as editable chats instead of a read-only platform section.
// The full list is pinned against gateway/config.py by
// tests/gateway/test_messaging_session_sources.py; these cover the channels
// that were once missing.
describe('messaging source coverage', () => {
  it.each([
    'whatsapp_cloud',
    'msgraph_webhook',
    'wecom_callback',
    'relay',
    'a2a',
    'buzz',
    'google_chat',
    'irc',
    'line',
    'ntfy',
    'raft',
    'simplex',
    'teams'
  ])('treats %s as a messaging source', id => {
    expect(isMessagingSource(id)).toBe(true)
  })

  it('has no duplicates and no overlap with local sources', () => {
    expect(new Set(MESSAGING_SESSION_SOURCE_IDS).size).toBe(MESSAGING_SESSION_SOURCE_IDS.length)
    expect(MESSAGING_SESSION_SOURCE_IDS.filter(id => LOCAL_SESSION_SOURCE_IDS.includes(id))).toEqual([])
  })

  it('gives sidebar sections brand names rather than title-cased ids', () => {
    expect(sessionSourceLabel('teams')).toBe('Microsoft Teams')
    expect(sessionSourceLabel('google_chat')).toBe('Google Chat')
    expect(sessionSourceLabel('irc')).toBe('IRC')
    expect(sessionSourceLabel('wecom_callback')).not.toBe(sessionSourceLabel('wecom'))
  })
})
