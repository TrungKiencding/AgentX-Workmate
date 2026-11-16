import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import {
  ACCOUNT_SLUG_RE,
  accountSlugDigest,
  accountSlugForIdentity,
  accountSlugLabel,
  isAccountSlug,
  resolveAccountSlug,
  slugBelongsToSubject
} from './account-slug'

/**
 * The cross-language contract.
 *
 * The IDENTICAL table lives in `tests/hermes_cli/test_accounts.py` as
 * ACCOUNT_SLUG_VECTORS. The desktop derives the slug to pass `--account`, and
 * Python derives it again to decide which directory that names — so a
 * disagreement does not raise anywhere. It quietly gives one person two homes,
 * splitting their sessions and their provider key across both.
 *
 * If you change the algorithm, change both tables in the same commit.
 */
const ACCOUNT_SLUG_VECTORS: Array<[string, string, string, string]> = [
  // (subject, username, email, expected_slug)
  ['f81d4fae-7dec-11d0-a765-00a0c91e6bf6', 'Kien.Le', 'kien.le@astralx.vn', 'kien-le-30a5154b'],
  ['f81d4fae-7dec-11d0-a765-00a0c91e6bf6', '', 'kien.le@astralx.vn', 'kien-le-30a5154b'],
  ['00000000-0000-0000-0000-000000000001', '', '', 'u-7ac1b8d7'],
  ['subject-with-unicode', 'Nguyễn Văn A', 'nva@astralx.vn', 'nguy-n-v-n-a-ab1c1834'],
  ['longname', 'a-very-long-username-that-exceeds-the-label-budget-by-a-lot', '', 'a-very-long-username-tha-7dc98c29'],
  ['f81d4fae-7dec-11d0-a765-00a0c91e6bf6', '  ', '  KIEN.LE@Astralx.VN ', 'kien-le-30a5154b'],
  ['other-subject', 'Kien Le', 'kien.le@astralx.vn', 'kien-le-9fe36593']
]

describe('accountSlugForIdentity', () => {
  test('matches the Python vectors byte for byte', () => {
    for (const [subject, username, email, expected] of ACCOUNT_SLUG_VECTORS) {
      assert.equal(
        accountSlugForIdentity({ email, subject, username }),
        expected,
        `slug for subject=${subject} username=${username} email=${email}`
      )
    }
  })

  test('is stable for one subject and distinct across subjects', () => {
    const a1 = accountSlugForIdentity({ subject: 'sub-a', username: 'sam' })
    const a2 = accountSlugForIdentity({ subject: 'sub-a', username: 'sam' })
    const b = accountSlugForIdentity({ subject: 'sub-b', username: 'sam' })

    assert.equal(a1, a2)
    assert.notEqual(a1, b, 'two people whose usernames match must not share a home')
  })

  test('keys off the subject, not the display name', () => {
    // Renaming yourself in Keycloak changes the readable half but must not
    // move you to a new home and orphan your sessions behind the old one.
    const before = accountSlugForIdentity({ subject: 'stable-sub', username: 'old-name' })
    const after = accountSlugForIdentity({ subject: 'stable-sub', username: 'new-name' })

    assert.notEqual(before, after)
    assert.equal(before.split('-').pop(), after.split('-').pop(), 'the digest half is the identity')
  })

  test('always produces a value the profile/account resolvers accept', () => {
    const awkward = [
      { subject: 's1', username: '   ' },
      { subject: 's2', username: '...' },
      { subject: 's3', username: '-leading-and-trailing-' },
      { subject: 's4', email: '@nolocalpart.example' },
      { subject: 's5', username: '🙂🙂🙂' },
      { subject: 's6', username: '99problems' }
    ]

    for (const identity of awkward) {
      const slug = accountSlugForIdentity(identity)

      assert.ok(ACCOUNT_SLUG_RE.test(slug), `${JSON.stringify(identity)} -> ${slug}`)
    }
  })

  test('refuses to derive a slug without a subject', () => {
    // A shared fallback directory is the exact opposite of what accounts are
    // for, so this has to throw rather than pick something.
    assert.throws(() => accountSlugForIdentity({ subject: '' }), /subject claim/)
    assert.throws(() => accountSlugForIdentity({ subject: '   ' }), /subject claim/)
  })
})

describe('accountSlugLabel', () => {
  test('prefers the username and falls back to the email local part', () => {
    assert.equal(accountSlugLabel('sam', 'other@example.com'), 'sam')
    assert.equal(accountSlugLabel('', 'other@example.com'), 'other')
    assert.equal(accountSlugLabel('', ''), '')
  })

  test('never leaves a hyphen at either end', () => {
    for (const raw of ['.sam.', '---sam---', '!!!', ' sam ']) {
      const label = accountSlugLabel(raw)

      assert.ok(!label.startsWith('-') && !label.endsWith('-'), `${raw} -> ${label}`)
    }
  })
})

describe('isAccountSlug', () => {
  test('rejects anything that could escape a path or an argv slot', () => {
    for (const value of ['../evil', 'a/b', 'UPPER', '-leading', '', null, undefined, 42, {}]) {
      assert.equal(isAccountSlug(value), false, String(value))
    }

    assert.equal(isAccountSlug('kien-le-30a5154b'), true)
  })
})

describe('slugBelongsToSubject', () => {
  const subject = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6'

  test('recognises every slug the subject could have been given', () => {
    assert.equal(accountSlugDigest(subject), '30a5154b')
    assert.equal(slugBelongsToSubject('kien-le-30a5154b', subject), true)
    assert.equal(slugBelongsToSubject('l-trung-ki-n-30a5154b', subject), true)
    assert.equal(slugBelongsToSubject('u-30a5154b', subject), true)
  })

  test("never claims another person's home or a malformed one", () => {
    assert.equal(slugBelongsToSubject('kien-le-9fe36593', subject), false)
    assert.equal(slugBelongsToSubject('kien-le30a5154b', subject), false)
    assert.equal(slugBelongsToSubject('../x-30a5154b', subject), false)
    assert.equal(slugBelongsToSubject('kien-le-30a5154b', ''), false)
  })
})

describe('resolveAccountSlug', () => {
  const subject = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6'
  const renamed = accountSlugForIdentity({ subject, username: 'Lê Trung Kiên' })
  const original = accountSlugForIdentity({ subject, username: 'Kien.Le' })

  test('a renamed person stays in the home they have instead of starting an empty one', () => {
    // The bug: the SSO console renames "Kien.Le" to "Lê Trung Kiên", the next
    // sign-in derives a new slug, and every conversation is left behind.
    assert.notEqual(renamed, original)

    assert.equal(
      resolveAccountSlug({
        derived: renamed,
        homes: [{ lastUsedMs: 1, slug: original }],
        stored: original,
        subject
      }),
      original
    )
  })

  test('finds the home by its digest when this machine forgot which one it was', () => {
    // accounts.json lives in Electron's userData, which an uninstall of the
    // app alone removes; the homes under AGENTX_HOME are still there.
    assert.equal(
      resolveAccountSlug({ derived: renamed, homes: [{ lastUsedMs: 1, slug: original }], subject }),
      original
    )
  })

  test('prefers the most recently used home when a rename already split one person in two', () => {
    const homes = [
      { lastUsedMs: 100, slug: original },
      { lastUsedMs: 500, slug: 'kien-30a5154b' }
    ]

    assert.equal(resolveAccountSlug({ derived: renamed, homes, subject }), 'kien-30a5154b')
  })

  test('keeps the derived home when it exists, and creates it when nothing does', () => {
    assert.equal(
      resolveAccountSlug({
        derived: original,
        homes: [
          { lastUsedMs: 900, slug: 'kien-30a5154b' },
          { lastUsedMs: 1, slug: original }
        ],
        subject
      }),
      original
    )
    assert.equal(resolveAccountSlug({ derived: original, homes: [], subject }), original)
  })

  test("ignores a stored home that is gone, and other people's homes", () => {
    const stranger = accountSlugForIdentity({ subject: 'other-subject', username: 'Kien.Le' })

    assert.equal(
      resolveAccountSlug({
        derived: original,
        homes: [{ lastUsedMs: 999, slug: stranger }],
        stored: 'kien-30a5154b',
        subject
      }),
      original
    )
  })
})
