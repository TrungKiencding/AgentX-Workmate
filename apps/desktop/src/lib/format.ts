// THE compact-number formatter — every user-facing count/token figure goes
// through here. 999 → "999", 1000 → "1k", 1230 → "1.2k", 10000 → "10k",
// 1_500_000 → "1.5M". Do not hand-roll `/ 1000` display math elsewhere.
export function compactNumber(value: null | number | undefined): string {
  const num = Number(value ?? 0)

  if (!Number.isFinite(num) || num <= 0) {
    return '0'
  }

  const scaled = (v: number, suffix: string) => `${v.toFixed(1).replace(/\.0$/, '')}${suffix}`

  // Thresholds sit just under the unit boundary so rounding can't produce
  // "1000k" or "1000" — those promote to the next unit instead.
  if (num >= 999_950) {
    return scaled(num / 1_000_000, 'M')
  }

  if (num >= 999.5) {
    return scaled(num / 1_000, 'k')
  }

  return `${Math.round(num)}`
}

// THE byte-size formatter for anything the user reads as a file size — the
// preview rail's "this file is large" notice, a file card's meta line. Binary
// units, one decimal under 10, none above: 512 → "512 B", 1536 → "1.5 KB",
// 10_485_760 → "10 MB". `unknownLabel` is what a missing size reads as.
export function formatByteSize(bytes: null | number | undefined, unknownLabel = ''): string {
  const size = Number(bytes ?? 0)

  if (!Number.isFinite(size) || size <= 0) {
    return unknownLabel
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = size
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}
