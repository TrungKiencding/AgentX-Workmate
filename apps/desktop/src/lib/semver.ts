// Version order the way the AgentX Skill Hub orders them (its `semver_key`):
// release numbers compare as numbers, a prerelease sorts below its release,
// build metadata is ignored. Enough to tell "the hub has a newer version" from
// "the version this machine runs was withdrawn" on a store card.

type PreId = readonly [0, number] | readonly [1, string]

function keyOf(version: string): { release: [number, number, number]; pre: PreId[] | null } {
  const core = version.split('+', 1)[0]
  const dash = core.indexOf('-')

  const release = (dash === -1 ? core : core.slice(0, dash))
    .split('.')
    .map(part => (/^\d+$/.test(part) ? Number(part) : 0))

  while (release.length < 3) {
    release.push(0)
  }

  const pre = dash === -1 ? '' : core.slice(dash + 1)

  return {
    release: [release[0], release[1], release[2]],
    pre: pre ? pre.split('.').map((id): PreId => (/^\d+$/.test(id) ? [0, Number(id)] : [1, id])) : null
  }
}

/** Negative when `a` comes before `b`, positive after, zero when the hub treats them as one version. */
export function compareSemver(a: string, b: string): number {
  const [x, y] = [keyOf(a), keyOf(b)]

  for (let i = 0; i < 3; i += 1) {
    if (x.release[i] !== y.release[i]) {
      return x.release[i] - y.release[i]
    }
  }

  if (x.pre === null || y.pre === null) {
    return x.pre === y.pre ? 0 : x.pre === null ? 1 : -1
  }

  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i += 1) {
    const [p, q] = [x.pre[i], y.pre[i]]

    if (p[0] !== q[0]) {
      return p[0] - q[0]
    }

    if (p[1] !== q[1]) {
      return p[1] < q[1] ? -1 : 1
    }
  }

  return x.pre.length - y.pre.length
}
