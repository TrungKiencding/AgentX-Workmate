import { cn } from '@/lib/utils'

const assetPath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

// Brand badge: the AgentX mark (the geometric ring logo) on its own dark
// plate, identical in light/dark. Fills the tile (softly rounded); size via
// className (default size-14). For a line-art glyph in the flow of text or at
// the head of a reply, use BrandGlyph instead.
export function BrandMark({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn('inline-flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md', className)}
      {...props}
    >
      <img alt="" className="size-full object-contain" src={assetPath('brand-mark.png')} />
    </span>
  )
}
