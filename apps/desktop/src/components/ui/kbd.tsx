import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { comboTokens } from '@/lib/keybinds/combo'
import { cn } from '@/lib/utils'

const COMPACT_KEY = /^[\p{L}\p{N}⌘⌥⇧⌃↵⇥⌫↑↓←→@/?]$/u

// Spec §5.20: caption text in the UI face, --bg-subtle under a --border-default
// edge, 6px corners, 18px tall. Flat — no key-cap shadow.
const kbdSurface = ['border-(--border-default)', 'bg-(--bg-subtle)', 'text-(--text-secondary)']

const kbdVariants = cva(
  'inline-flex shrink-0 items-center justify-center border [font-family:var(--dt-font-kbd)] font-normal leading-none select-none',
  {
    variants: {
      variant: {
        default: kbdSurface,
        ghost: ['border-(--border-subtle)', 'bg-transparent', 'text-(--text-tertiary)'],
        // Recording a new combo: the one signal state, in the accent.
        capturing: ['border-(--accent)', 'bg-(--bg-app)', 'text-(--accent)'],
        // On an inverse surface (a tooltip): currentColor at reduced strength.
        inverted: [
          'border-[color-mix(in_srgb,currentColor_24%,transparent)]',
          'bg-[color-mix(in_srgb,currentColor_10%,transparent)]',
          'text-[color-mix(in_srgb,currentColor_80%,transparent)]'
        ]
      },
      size: {
        sm: 'rounded-sm text-xs',
        md: 'rounded-sm text-xs'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'md'
    }
  }
)

// Every key is the spec's 18px cap (`sm` and `md` share it — `md` remains so
// call sites that ask for the roomier look keep compiling). A single glyph is
// a square; a word gets 4px of padding each side.
function kbdShapeClass(label: string): string {
  return COMPACT_KEY.test(label) ? 'size-4.5 px-0' : 'h-4.5 min-w-4.5 px-1'
}

interface KbdProps extends React.ComponentProps<'kbd'>, VariantProps<typeof kbdVariants> {}

function Kbd({ children, className, size, variant, ...props }: KbdProps) {
  const label = typeof children === 'string' ? children : ''

  return (
    <kbd className={cn(kbdVariants({ size, variant }), kbdShapeClass(label), className)} data-slot="kbd" {...props}>
      {children}
    </kbd>
  )
}

interface KbdGroupProps extends Omit<React.ComponentProps<'span'>, 'children'>, VariantProps<typeof kbdVariants> {
  keys: string[]
}

function KbdGroup({ className, keys, size, variant, ...props }: KbdGroupProps) {
  return (
    <span
      aria-label={keys.join(' ')}
      className={cn('inline-flex shrink-0 items-center gap-1', className)}
      data-slot="kbd-group"
      {...props}
    >
      {keys.map((key, index) => (
        <Kbd key={`${key}-${index}`} size={size} variant={variant}>
          {key}
        </Kbd>
      ))}
    </span>
  )
}

interface KbdComboProps extends Omit<KbdGroupProps, 'keys'> {
  combo: string
}

function KbdCombo({ combo, ...props }: KbdComboProps) {
  return <KbdGroup keys={comboTokens(combo)} {...props} />
}

export { Kbd, KbdCombo, KbdGroup, kbdVariants }
