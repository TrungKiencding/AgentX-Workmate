import { type ReactNode, useState } from 'react'

import { DisclosureRow } from '@/components/ui/disclosure-row'
import { useI18n } from '@/i18n'

// The folded technical tail every detail dialog carries: raw ids, provenance,
// mono chips — everything a curious admin needs and nobody else has to read.
export function TechnicalDetails({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  return (
    <div>
      <DisclosureRow onToggle={() => setOpen(value => !value)} open={open}>
        {t.skills.technicalDetails}
      </DisclosureRow>
      {open && <div className="mt-1.5 grid gap-2 pl-5">{children}</div>}
    </div>
  )
}

export function TechnicalDetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
      <span className="text-(--ui-text-tertiary)">{label}</span>
      <span className="min-w-0 text-foreground/85">{value}</span>
    </div>
  )
}
