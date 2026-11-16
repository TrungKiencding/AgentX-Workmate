import { normalize } from '@/lib/text'

/** AgentX' reasoning levels, in ascending order — mirrors the backend's
 *  VALID_REASONING_EFFORTS (hermes_constants.py). `none` is not a level: it's
 *  thinking disabled, owned by the Thinking toggle rather than the scale. */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/** The scale plus the off state — the full set a config value may hold. */
export const REASONING_EFFORT_VALUES = ['none', ...REASONING_EFFORTS] as const

/** AgentX' built-in level when neither the surface nor the profile config
 *  specifies one (mirrors the backend's own fallback). */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium'

/** Locale-free compact labels, for code that has no translations at hand (and
 *  the plugin SDK's fallback). App chrome uses the translated
 *  `shell.modelOptions.effortShort` strings instead. */
const SHORT_LABELS: Record<string, string> = {
  none: 'Off',
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra'
}

export function reasoningEffortLabel(effort: string): string {
  const key = normalize(effort)

  return key ? (SHORT_LABELS[key] ?? effort) : ''
}

export const isReasoningEffort = (value: string): value is ReasoningEffort =>
  REASONING_EFFORTS.includes(normalize(value) as ReasoningEffort)

/** Any value a config may hold: a level, or `none` (thinking off). */
export type ReasoningEffortValue = (typeof REASONING_EFFORT_VALUES)[number]

// Spellings the backend's parse_reasoning_effort also reads as "thinking off"
// (YAML `false` reaches us stringified).
const OFF_ALIASES = new Set(['none', 'false', 'disabled', 'off'])

/** The level a surface is actually running at. Empty means "inherit", so it
 *  resolves through `fallback`; the off aliases collapse to `none`; anything
 *  unrecognized clamps to AgentX' default rather than showing a phantom level. */
export function effectiveReasoningEffort(
  effort: string,
  fallback: string = DEFAULT_REASONING_EFFORT
): ReasoningEffortValue {
  const value = normalize(effort || fallback || DEFAULT_REASONING_EFFORT)

  if (OFF_ALIASES.has(value)) {
    return 'none'
  }

  return isReasoningEffort(value) ? value : DEFAULT_REASONING_EFFORT
}

/** The stops a thinking-level control offers by default — the levels real
 *  provider wires distinguish. `minimal` (OpenAI-only, clamps to `low`
 *  elsewhere) and `ultra` (AgentX-internal, clamps to `max` everywhere) stay
 *  reachable from config/CLI and Settings, but would only crowd the dial. */
export const THINKING_STOPS = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const satisfies readonly ReasoningEffortValue[]

/** The stops to render for `selected`: the default set, plus `selected` in its
 *  ladder position when it is one of the off-dial levels — a session running
 *  at `ultra` must show `ultra`, never a nearby stop it isn't actually at. */
export function thinkingStops(selected: string): ReasoningEffortValue[] {
  const stops: ReasoningEffortValue[] = [...THINKING_STOPS]
  const value = normalize(selected) as ReasoningEffortValue

  if (!REASONING_EFFORT_VALUES.includes(value) || stops.includes(value)) {
    return stops
  }

  return REASONING_EFFORT_VALUES.filter(level => level === value || stops.includes(level))
}
