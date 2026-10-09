#!/usr/bin/env node
/**
 * Writes release/AgentXWorkmate-<version>-win-build.json beside the Windows
 * installers: the install stamp they were packed with, and each installer's
 * sha256 and size. release-desktop.yml attaches it to the GitHub Release.
 *
 * An NSIS installer's payload is compressed, so nothing on the release machine
 * can read which commit a CI-built .exe pins. `npm run release:feed -- build
 * --from-github <tag>` reads it here instead: the exe it downloads must hash to
 * what this file records, and the stamp recorded with it must be the tagged
 * commit. The stamp comes from the unpacked builds electron-builder packed the
 * installers from — the file `release:feed build` checks for a local build.
 *
 *   node scripts/write-win-build-manifest.mjs   # after `npm run builder -- --win nsis`
 */

import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isMain } from './utils.mjs'

const DESKTOP_ROOT = resolve(import.meta.dirname, '..')
const UNPACKED_DIR = /^win(-[a-z0-9]+)?-unpacked$/

/** The release asset's name; release-feed.ts looks it up by this. */
export function winBuildManifestName(version) {
  return `AgentXWorkmate-${version}-win-build.json`
}

async function describeFile(file) {
  const hash = createHash('sha256')

  for await (const chunk of createReadStream(file)) {
    hash.update(chunk)
  }

  return { sha256: hash.digest('hex'), bytes: statSync(file).size }
}

/**
 * The stamp the unpacked Windows builds in `releaseDir` carry (every one must
 * carry the same), and the sha256 and size of each installer for `version`.
 */
export async function readWinBuild(releaseDir, version) {
  const names = readdirSync(releaseDir).sort()
  const unpacked = names.filter(name => UNPACKED_DIR.test(name))

  if (unpacked.length === 0) {
    throw new Error(`no win*-unpacked build in ${releaseDir}`)
  }

  const stamps = unpacked.map(dir => readFileSync(join(releaseDir, dir, 'resources', 'install-stamp.json'), 'utf8'))

  if (new Set(stamps).size !== 1) {
    throw new Error(`${unpacked.join(' and ')} carry different install stamps`)
  }

  const prefix = `AgentXWorkmate-${version}-win`
  const installers = {}

  for (const name of names.filter(name => name.startsWith(prefix) && /\.(exe|msi)$/.test(name))) {
    installers[name] = await describeFile(join(releaseDir, name))
  }

  if (Object.keys(installers).length === 0) {
    throw new Error(`no ${prefix}*.exe in ${releaseDir}`)
  }

  return { stamp: JSON.parse(stamps[0]), installers }
}

/** The manifest, naming the CI run that built it when there is one. */
export function winBuildManifest({ version, stamp, installers, env = process.env }) {
  const run = env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT || '1'}`
    : null

  return { schema: 1, product: 'agentx-workmate', version, stamp, installers, run }
}

async function main() {
  const version = JSON.parse(readFileSync(join(DESKTOP_ROOT, 'package.json'), 'utf8')).version
  const releaseDir = join(DESKTOP_ROOT, 'release')
  const { stamp, installers } = await readWinBuild(releaseDir, version)
  const file = join(releaseDir, winBuildManifestName(version))

  writeFileSync(file, `${JSON.stringify(winBuildManifest({ version, stamp, installers }), null, 2)}\n`)
  console.log(
    `[win-build-manifest] wrote ${file} -> ${String(stamp.commit).slice(0, 12)} for ${Object.keys(installers).join(', ')}`
  )
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(`[win-build-manifest] ERROR: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
