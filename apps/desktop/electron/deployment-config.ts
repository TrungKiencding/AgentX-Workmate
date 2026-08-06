/**
 * deployment-config.ts
 *
 * Carries the one credential that cannot live in the repository.
 *
 * Everything else a fresh install needs — the Keycloak realm, the LiteLLM
 * proxy, the default model — is public and ships in `config_defaults.py`.
 * The LiteLLM *admin* key is not public: it mints and revokes keys for the
 * whole estate, and this repository is. So it is injected into the packaged
 * app at build time (`scripts/write-deployment-config.mjs` → `deployment.json`
 * in resources, git-ignored on both ends) and seeded into the user's
 * `<AGENTX_HOME>/.env` the first time the app runs.
 *
 * Be clear-eyed about what that means: the key travels inside the installer,
 * so anyone who unpacks the .app or .exe can read it. That is the accepted
 * cost of `accounts.litellm.mode: direct`, and the reason `mode: broker`
 * exists — see the comment on that setting in `hermes_cli/config_defaults.py`.
 * This module keeps the blast radius as small as it can: it writes the value
 * exactly once, never overwrites a key the machine already has, and never
 * logs it.
 *
 * The .env format here mirrors `hermes_cli.config.save_env_value` — same
 * `export`-aware key matching, same quoting rule — because that is the file
 * Python reads back. `deployment-config.test.ts` covers the shapes, and
 * `tests/hermes_cli/test_deployment_defaults.py` round-trips those exact
 * bytes through the real `load_env()` so the two writers cannot drift apart.
 *
 * KNOWN LIMIT — rotation. Seeding is append-only, so shipping a build with a
 * rotated admin key does NOT update machines that already have the old one:
 * their provisioning starts failing (visibly, in Settings → Account) until
 * someone edits that machine's .env. Overwriting instead would mean a build
 * could silently clobber a key an operator set deliberately, which is worse.
 * If rotation becomes routine, the fix is to record which value we seeded and
 * only replace our own — not to start overwriting blind.
 */

export const DEPLOYMENT_CONFIG_SCHEMA_VERSION = 1

/** The credential `account_provisioning._admin_key()` looks for. */
export const LITELLM_ADMIN_KEY_ENV_VAR = 'AGENTX_LITELLM_ADMIN_KEY'

export interface DeploymentConfig {
  /** Empty when the build had no key to bake in — a normal dev build. */
  litellmAdminKey: string
}

export interface DeploymentSeedIo {
  readText(filePath: string): string | null
  writeText(filePath: string, text: string): void
  rememberLog?(message: string): void
}

export type SeedOutcome =
  /** The key was absent and has now been written. */
  | 'seeded'
  /** The machine already assigns this key; left untouched. */
  | 'already-set'
  /** This build carries no key (dev build, or a release built without one). */
  | 'no-secret'
  /** The write failed. Provisioning will report the missing key itself. */
  | 'failed'

/**
 * Parse `deployment.json`, or return null for anything that isn't one.
 *
 * A malformed or future-schema file is not an error worth stopping a launch
 * over: the app still runs, sign-in still works, and provisioning reports the
 * missing key in the one place the user can act on it.
 */
export function parseDeploymentConfig(raw: string | null | undefined): DeploymentConfig | null {
  if (!raw) {
    return null
  }

  let parsed: any

  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') {
    return null
  }

  if (parsed.schemaVersion !== DEPLOYMENT_CONFIG_SCHEMA_VERSION) {
    return null
  }

  const key = typeof parsed.litellmAdminKey === 'string' ? parsed.litellmAdminKey.trim() : ''

  return { litellmAdminKey: key }
}

/**
 * True when a .env line assigns `key`, plain or `export`-prefixed.
 *
 * Mirrors `hermes_cli.config._env_line_defines_key`. The `export` form matters:
 * `load_env()` reads it, so a hand-added `export AGENTX_LITELLM_ADMIN_KEY=…`
 * is live config. Missing it here would append a second assignment and leave
 * which one wins up to line order.
 */
export function envLineDefinesKey(line: string, key: string): boolean {
  let stripped = line.trim()

  if (stripped.startsWith('export ')) {
    stripped = stripped.slice(7).trimStart()
  }

  return stripped.startsWith(`${key}=`)
}

/**
 * Quote a value the way the Python writer does, so both produce one format.
 *
 * Mirrors `hermes_cli.config._quote_env_value`.
 */
export function quoteEnvValue(value: string): string {
  if (value === '') {
    return value
  }

  const needsQuoting =
    value.includes('#') ||
    value.includes('"') ||
    value.includes("'") ||
    value !== value.trim() ||
    /\s/.test(value)

  if (!needsQuoting) {
    return value
  }

  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Add `key=value` to a .env, or return null when the key is already assigned.
 *
 * Deliberately append-only. A machine that already has this key — a developer
 * box, a second install, an operator who rotated it by hand — has said what it
 * wants, and a build-time default has no business overruling it.
 */
export function upsertEnvAssignment(existing: string | null, key: string, value: string): string | null {
  const text = existing || ''

  if (text.split('\n').some(line => envLineDefinesKey(line, key))) {
    return null
  }

  const prefix = text === '' || text.endsWith('\n') ? text : `${text}\n`

  return `${prefix}${key}=${quoteEnvValue(value)}\n`
}

/**
 * Seed this build's baked credentials into `envPath`, once.
 *
 * Runs on every launch and is a no-op on all but the first — the cost is one
 * small read, and making it conditional on "have we ever run before?" would
 * mean a user who deleted their .env never gets it back.
 */
export function seedDeploymentSecrets(args: {
  config: DeploymentConfig | null
  envPath: string
  io: DeploymentSeedIo
}): SeedOutcome {
  const secret = args.config?.litellmAdminKey || ''

  if (!secret) {
    return 'no-secret'
  }

  try {
    const existing = args.io.readText(args.envPath)
    const next = upsertEnvAssignment(existing, LITELLM_ADMIN_KEY_ENV_VAR, secret)

    if (next === null) {
      return 'already-set'
    }

    args.io.writeText(args.envPath, next)
    args.io.rememberLog?.(`[deployment] seeded ${LITELLM_ADMIN_KEY_ENV_VAR} into ${args.envPath}`)

    return 'seeded'
  } catch (error) {
    // Never surface the value, only the failure.
    args.io.rememberLog?.(
      `[deployment] could not seed ${LITELLM_ADMIN_KEY_ENV_VAR}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )

    return 'failed'
  }
}
