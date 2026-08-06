import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import {
  type AccountStoreIo,
  type AccountStoreState,
  bootAccountSlug,
  markProvisioned,
  parseAccountState,
  readAccountState,
  rehomeTarget,
  rememberSignIn,
  writeAccountState
} from './account-store'

function memoryIo(initial: string | null = null): AccountStoreIo & { text: string | null } {
  const io: any = {
    readText: () => io.text,
    text: initial,
    writeText: (value: string) => {
      io.text = value
    }
  }

  return io
}

const KIEN = {
  displayName: 'Kien Le',
  email: 'kien.le@astralx.vn',
  slug: 'kien-le-30a5154b',
  subject: 'sub-kien'
}

const GRACE = {
  displayName: 'Grace Hopper',
  email: 'grace@astralx.vn',
  slug: 'grace-9fe36593',
  subject: 'sub-grace'
}

describe('parseAccountState', () => {
  test('survives every shape a broken file can take', () => {
    // Boot reads this before anything else works. A throw here costs the user
    // their app; an empty state costs them one extra respawn after sign-in.
    for (const raw of [null, '', 'not json', '[]', '"string"', '{}', '{"accounts": 7}']) {
      const state = parseAccountState(raw)

      assert.deepEqual(state.accounts, {})
      assert.equal(state.activeSubject, '')
    }
  })

  test('drops records whose slug could escape a path or an argv slot', () => {
    const raw = JSON.stringify({
      accounts: {
        bad: { slug: '../../etc' },
        good: { slug: 'kien-le-30a5154b' },
        upper: { slug: 'NotALowercaseSlug' }
      },
      activeSubject: 'bad'
    })

    const state = parseAccountState(raw)

    assert.deepEqual(Object.keys(state.accounts), ['good'])
    // The pointer named a record that did not survive validation, so it must
    // not survive either — otherwise bootAccountSlug reads undefined.slug.
    assert.equal(state.activeSubject, '')
  })

  test('keeps an activeSubject that names a surviving record', () => {
    const raw = JSON.stringify({
      accounts: { 'sub-kien': { slug: KIEN.slug, email: KIEN.email } },
      activeSubject: 'sub-kien'
    })

    assert.equal(parseAccountState(raw).activeSubject, 'sub-kien')
  })
})

describe('bootAccountSlug', () => {
  test('is null until somebody signs in — the pre-account launch', () => {
    assert.equal(bootAccountSlug({ accounts: {}, activeSubject: '' }), null)
  })

  test('names the active account once one exists', () => {
    const { state } = rememberSignIn({ accounts: {}, activeSubject: '' }, KIEN)

    assert.equal(bootAccountSlug(state), KIEN.slug)
  })
})

describe('rememberSignIn', () => {
  test('records the account and reports the first sign-in as a switch', () => {
    const { state, switched } = rememberSignIn({ accounts: {}, activeSubject: '' }, KIEN)

    assert.equal(switched, true)
    assert.equal(state.activeSubject, KIEN.subject)
    assert.equal(state.accounts[KIEN.subject].slug, KIEN.slug)
  })

  test('signing in again as the same person is not a switch', () => {
    const first = rememberSignIn({ accounts: {}, activeSubject: '' }, KIEN).state
    const { switched } = rememberSignIn(first, KIEN)

    assert.equal(switched, false)
  })

  test('a different person IS a switch, and both records are kept', () => {
    const first = rememberSignIn({ accounts: {}, activeSubject: '' }, KIEN).state
    const { state, switched } = rememberSignIn(first, GRACE)

    assert.equal(switched, true)
    assert.equal(state.activeSubject, GRACE.subject)
    // Kien's mapping survives so signing back in as Kien boots straight into
    // his home instead of respawning to rediscover it.
    assert.equal(state.accounts[KIEN.subject].slug, KIEN.slug)
  })

  test('never un-remembers that an account has been provisioned', () => {
    const signedIn = rememberSignIn({ accounts: {}, activeSubject: '' }, KIEN).state
    const provisioned = markProvisioned(signedIn, KIEN.subject)

    // A later sign-in that could not reach LiteLLM carries provisioned:false;
    // letting it win would make the app re-await provisioning on every launch.
    const { state } = rememberSignIn(provisioned, { ...KIEN, provisioned: false })

    assert.equal(state.accounts[KIEN.subject].provisioned, true)
  })

  test('refuses a record with no subject or an illegal slug', () => {
    const base: AccountStoreState = { accounts: {}, activeSubject: '' }

    assert.equal(rememberSignIn(base, { ...KIEN, subject: '' }).state, base)
    assert.equal(rememberSignIn(base, { ...KIEN, slug: '../evil' }).state, base)
  })
})

describe('rehomeTarget', () => {
  test('null when the backend is already in the right home', () => {
    assert.equal(rehomeTarget(KIEN.slug, KIEN.slug), null)
  })

  test('names the account when the backend started in the shared home', () => {
    assert.equal(rehomeTarget(null, KIEN.slug), KIEN.slug)
  })

  test('names the account when somebody else signed in', () => {
    assert.equal(rehomeTarget(GRACE.slug, KIEN.slug), KIEN.slug)
  })

  test('never asks to re-home to an illegal slug', () => {
    assert.equal(rehomeTarget(null, '../evil'), null)
    assert.equal(rehomeTarget(null, ''), null)
  })
})

describe('round trip', () => {
  test('what boot writes is what the next boot reads', () => {
    const io = memoryIo()
    const { state } = rememberSignIn(readAccountState(io), KIEN)

    writeAccountState(state, io)

    assert.equal(bootAccountSlug(readAccountState(io)), KIEN.slug)
  })

  test('an unreadable store degrades to the shared home instead of throwing', () => {
    const io: AccountStoreIo = {
      readText: () => {
        throw new Error('EACCES')
      },
      writeText: () => undefined
    }

    assert.equal(bootAccountSlug(readAccountState(io)), null)
  })

  test('holds no token — only names, slugs, and flags', () => {
    const io = memoryIo()

    writeAccountState(rememberSignIn(readAccountState(io), KIEN).state, io)

    const written = JSON.parse(io.text || '{}')
    const serialized = JSON.stringify(written)

    for (const forbidden of ['accessToken', 'refreshToken', 'idToken', 'sk-']) {
      assert.ok(!serialized.includes(forbidden), `${forbidden} must not reach accounts.json`)
    }
  })
})
