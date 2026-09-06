import { type CSSProperties } from 'react'

import { createParticleEmitter, ParticleField, type ParticleFieldConfig } from '@/components/particles/particle-field'
import { $petActive, flashPetActivity } from '@/store/pet'
import { $petOverlayActive, forwardPetReaction } from '@/store/pet-overlay'

/**
 * TikTok-style floating hearts — a thin skin over {@link ParticleField} (the
 * Tabler heart, filled, in pink). Placed two ways: rising from the composer when no pet is
 * out, or from the pet when one is. Fired by the core `reaction` event (affection
 * in a user message) via {@link burstVibeHearts}.
 */

// Light pink reads on both light and dark chat surfaces.
const HEART_COLORS = ['#ff9ec4'] as const

/** Composer placement: hearts rise the thread height (rise = % of the tall lane). */
export const COMPOSER_HEART_CONFIG: Partial<ParticleFieldConfig> = {
  count: 12,
  size: [6, 13],
  rise: [6.75, 15.75],
  duration: [320, 700]
}

/** Pet placement: a compact puff off the pet. The field box spans feet→head, so
 *  rise ≥100% carries hearts from the feet to ~10-20% above the pet before fading. */
const PET_HEART_CONFIG: Partial<ParticleFieldConfig> = {
  count: 10,
  spawnWindowMs: 450,
  size: [6, 12],
  rise: [98, 118],
  duration: [480, 880],
  swayAmp: [5, 14],
  bank: [6, 14]
}

// The Tabler heart (`IconHeart`'s path), filled so it still reads at 6–13px,
// in `currentColor` so the field's pink applies. A drawn heart, not a sprite:
// the pixel glyph that sat here was the last of the 8-bit register.
const HEART_GLYPH = (
  <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M19.5 12.572 12 20l-7.5-7.428A5 5 0 1 1 12 6.006a5 5 0 1 1 7.5 6.572Z" />
  </svg>
)

const emitter = createParticleEmitter()

/** Play hearts in THIS window (whichever HeartField is mounted). The overlay
 *  window calls this directly off the mirrored vibe signal. */
export const playVibeHearts = (count?: number) => emitter.burst(count)

/**
 * Fire a vibe burst (from the core `reaction` event). Routes to where the
 * affection should land:
 *  - pet popped out  → forward to the overlay window + celebrate (mirrored)
 *  - pet in-window   → play here (on the pet) + celebrate
 *  - no pet          → play here (composer)
 */
export const burstVibeHearts = (count?: number) => {
  const overlay = $petOverlayActive.get()

  if (overlay || $petActive.get()) {
    flashPetActivity({ celebrate: true })
  }

  if (overlay) {
    forwardPetReaction('vibe')
  } else {
    playVibeHearts(count)
  }
}

export interface HeartFieldProps {
  config?: Partial<ParticleFieldConfig>
  className?: string
  style?: CSSProperties
}

/** Heart-skinned particle field. Caller supplies placement + a config preset. */
export function HeartField({ config, className, style }: HeartFieldProps) {
  return (
    <ParticleField
      className={className}
      colors={HEART_COLORS}
      config={config}
      emitter={emitter}
      glyph={HEART_GLYPH}
      style={style}
    />
  )
}

/**
 * Pet-anchored hearts, feet→~10-20% above. One place owns the geometry so the
 * in-window pet and the popped-out overlay stay identical. `petW`/`petH` are the
 * rendered sprite dimensions (frame × scale).
 */
export function PetHeartField({ petW, petH }: { petW: number; petH: number }) {
  return (
    <HeartField
      config={PET_HEART_CONFIG}
      style={{
        bottom: 0,
        height: Math.max(96, petH),
        left: '50%',
        pointerEvents: 'none',
        position: 'absolute',
        transform: 'translateX(-50%)',
        width: Math.max(90, petW * 1.5),
        zIndex: 2
      }}
    />
  )
}
