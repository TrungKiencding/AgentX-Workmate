/**
 * Desktop bundles ship precompiled renderer assets. Returning false here tells
 * electron-builder to skip the node_modules collector/install step, which
 * avoids workspace dependency graph explosions and keeps packaging
 * deterministic across environments. The native Python/Node/backend payload is staged by beforePack for
 * the actual target OS and architecture, independently of npm dependencies.
 */
export default async function beforeBuild() {
  return false
}
