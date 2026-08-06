/**
 * Writes apps/desktop/build/deployment.json — the credentials this build
 * carries to machines that have never been configured.
 *
 * Everything a fresh install needs is public and lives in the repository
 * (`hermes_cli/config_defaults.py`: realm, client id, proxy URL, default
 * model) except one thing. `accounts.litellm.mode: direct` means each laptop
 * mints its own per-user LiteLLM key, and minting needs the LiteLLM ADMIN
 * key. That is a real secret and this repository is public, so it cannot be
 * committed — it is picked up from the build machine here and baked into the
 * packaged app instead.
 *
 * Which is to say: the key ends up inside the shipped .app / .exe, readable
 * by anyone who unpacks it. That trade is made deliberately (there is no
 * broker deployed yet, and a laptop that cannot mint has no model at all);
 * `hermes_cli/litellm_broker.py` is the way out of it.
 *
 * Schema:
 *   {
 *     "schemaVersion": 1,
 *     "litellmAdminKey": "<secret>" | "",
 *     "builtAt": "<ISO 8601 UTC>"
 *   }
 *
 * Source preference for the key:
 *   1. $AGENTX_LITELLM_ADMIN_KEY — how CI should pass it (a repo secret).
 *   2. The build machine's own <AGENTX_HOME>/.env, so a local `npm run
 *      dist:mac` on a configured machine needs no extra ceremony.
 *   3. Nothing. The build still succeeds and the app still runs; users just
 *      have to be given a key another way. A packaged build says so loudly.
 *
 * The output is git-ignored (apps/desktop/build/) and never logged in full.
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join, resolve } from "path"

import { isMain } from "./utils.mjs"

const SCHEMA_VERSION = 1

const DESKTOP_ROOT = resolve(import.meta.dirname, "..")
const OUT_DIR = join(DESKTOP_ROOT, "build")
const OUT_FILE = join(OUT_DIR, "deployment.json")

export const ADMIN_KEY_ENV_VAR = "AGENTX_LITELLM_ADMIN_KEY"

/**
 * The build machine's AgentX home, matching hermes_constants' platform rules.
 */
export function resolveAgentxHome(env = process.env, platform = process.platform, home = homedir()) {
  if (env.AGENTX_HOME) {
    return env.AGENTX_HOME
  }

  if (platform === "win32" && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, "agentx")
  }

  return join(home, ".agentx")
}

/**
 * Pull one value out of a .env, honouring the same shapes `load_env()` reads:
 * `KEY=v`, `export KEY=v`, and single- or double-quoted values.
 */
export function readEnvValue(text, key) {
  if (!text) {
    return ""
  }

  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()

    if (!line || line.startsWith("#")) {
      continue
    }

    if (line.startsWith("export ")) {
      line = line.slice(7).trimStart()
    }

    if (!line.startsWith(`${key}=`)) {
      continue
    }

    let value = line.slice(key.length + 1).trim()

    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
    }

    return value
  }

  return ""
}

/**
 * Resolve the admin key and say where it came from, so the build log can be
 * specific about a missing one without printing the key itself.
 */
export function resolveAdminKey({ env = process.env, readFile = tryReadFile, agentxHome = null } = {}) {
  const fromEnv = (env[ADMIN_KEY_ENV_VAR] || "").trim()

  if (fromEnv) {
    return { key: fromEnv, source: "env" }
  }

  const home = agentxHome || resolveAgentxHome(env)
  const envPath = join(home, ".env")
  const fromDotenv = readEnvValue(readFile(envPath), ADMIN_KEY_ENV_VAR).trim()

  if (fromDotenv) {
    return { key: fromDotenv, source: envPath }
  }

  return { key: "", source: null }
}

function tryReadFile(path) {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

export function buildDeploymentConfig(key, builtAt) {
  return {
    schemaVersion: SCHEMA_VERSION,
    litellmAdminKey: key || "",
    builtAt
  }
}

/** Mask for logs: enough to recognise which key it is, not enough to use. */
export function maskKey(key) {
  if (!key) {
    return "(none)"
  }

  return key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)} (${key.length} chars)`
}

function main() {
  const { key, source } = resolveAdminKey()

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT_FILE, `${JSON.stringify(buildDeploymentConfig(key, new Date().toISOString()), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  })

  if (key) {
    console.log(`[deployment] baked ${ADMIN_KEY_ENV_VAR} ${maskKey(key)} from ${source}`)
  } else {
    console.warn(
      `[deployment] WARNING: no ${ADMIN_KEY_ENV_VAR} found (checked $${ADMIN_KEY_ENV_VAR} and ` +
        `${join(resolveAgentxHome(), ".env")}).\n` +
        `[deployment] This build will install without model access: signing in works, but no per-user\n` +
        `[deployment] LiteLLM key can be minted. Set the variable and rebuild to ship one.`
    )
  }

  console.log(`[deployment] wrote ${OUT_FILE}`)
}

if (isMain(import.meta.url)) {
  main()
}
