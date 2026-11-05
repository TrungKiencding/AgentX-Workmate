/**
 * Picture picker: a big live preview beside the shape and colour choices,
 * plus "upload" and — when an image model is set up — "generate with AI".
 */

import { Button, cn, GlyphSpinner, host, icons, Tip, useQuery } from '@agentx/plugin-sdk'
import { useState } from 'react'

import { AVATAR_COLORS, AVATAR_SHAPES, type AvatarShape, BotFace } from './face'
import { useBots } from './i18n'
import { PLUGIN_ID } from './state'

const MAX_UPLOAD_BYTES = 15_000_000
const AVATAR_EDGE = 256

export interface AvatarValue {
  color: string
  image: string | null
  shape: AvatarShape
}

/** Centre-crop to a small square PNG so storage stays light. */
export function squareImage(dataUrl: string, edge = AVATAR_EDGE): Promise<string> {
  return new Promise(resolve => {
    const img = new Image()

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = edge
        canvas.height = edge
        const side = Math.min(img.width, img.height)
        canvas
          .getContext('2d')
          ?.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, edge, edge)
        resolve(canvas.toDataURL('image/png'))
      } catch {
        resolve(dataUrl)
      }
    }

    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

function pickFile(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp,image/gif'
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.click()
  })
}

function readAsDataUrl(file: File): Promise<string | null> {
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/** Is an image model configured? Cached briefly; re-probed on next mount. */
function useImageGeneration() {
  return useQuery({
    queryKey: [PLUGIN_ID, 'image-probe'],
    queryFn: async () =>
      Boolean((await host.request<{ available?: boolean }>('image.generate', { probe: true }))?.available),
    staleTime: 60_000,
    retry: false
  })
}

export function AvatarPicker({
  description,
  name,
  onChange,
  value
}: {
  description: string
  name: string
  onChange: (next: AvatarValue) => void
  value: AvatarValue
}) {
  const b = useBots()
  const imagen = useImageGeneration()
  const [busy, setBusy] = useState(false)

  const upload = async () => {
    const file = await pickFile()

    if (!file) {
      return
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      host.notify({ kind: 'error', message: b.imageTooLarge })

      return
    }

    const raw = await readAsDataUrl(file)

    if (raw) {
      onChange({ ...value, image: await squareImage(raw) })
    }
  }

  const generate = async () => {
    setBusy(true)

    try {
      const who = [name, description].filter(Boolean).join(' — ')

      const res = await host.request<{ error?: string; image?: string; image_data?: string; success?: boolean }>(
        'image.generate',
        {
          prompt: `Friendly minimal mascot avatar for an AI assistant named "${who}". Bold flat vector style, simple shapes, solid colour background, centered, no text.`,
          aspect_ratio: 'square'
        }
      )

      if (!res?.success) {
        throw new Error(res?.error || b.generateFailed)
      }

      const image = res.image_data || res.image

      if (image) {
        onChange({ ...value, image: await squareImage(image) })
      }
    } catch (error) {
      host.notifyError(error, b.generateFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-start gap-5">
      <div className="grid size-20 shrink-0 place-items-center rounded-(--radius-card) bg-(--bg-subtle)">
        <BotFace color={value.color} image={value.image} name={name} shape={value.shape} size={value.image ? 72 : 60} />
      </div>
      <div className="grid min-w-0 flex-1 gap-3">
        <div aria-label={b.shapesLabel} className="flex flex-wrap gap-1" role="radiogroup">
          {AVATAR_SHAPES.map(shape => {
            const active = !value.image && value.shape === shape

            return (
              <button
                aria-checked={active}
                aria-label={shape}
                className={cn(
                  'grid size-9 place-items-center rounded-(--radius-control) transition-colors duration-(--dur-micro) hover:bg-(--bg-hover)',
                  active && 'bg-(--bg-selected) ring-1 ring-(--border-strong)'
                )}
                key={shape}
                onClick={() => onChange({ ...value, image: null, shape })}
                role="radio"
                type="button"
              >
                <BotFace color={value.color} name={`${name}:${shape}`} shape={shape} size={26} />
              </button>
            )
          })}
        </div>
        <div aria-label={b.colorsLabel} className="flex flex-wrap items-center gap-2" role="radiogroup">
          {AVATAR_COLORS.map(color => {
            const active = value.color === color

            return (
              <button
                aria-checked={active}
                aria-label={color}
                className={cn(
                  'size-5 rounded-full transition-transform duration-(--dur-micro) hover:scale-110',
                  active && 'ring-2 ring-(--border-strong) ring-offset-2 ring-offset-(--bg-app)'
                )}
                key={color}
                onClick={() => onChange({ ...value, color, image: value.image })}
                role="radio"
                style={{ backgroundColor: color }}
                type="button"
              />
            )
          })}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button onClick={() => void upload()} size="sm" type="button" variant="ghost">
            <icons.Upload className="size-4" />
            {b.uploadImage}
          </Button>
          {imagen.data ? (
            <Button disabled={busy} onClick={() => void generate()} size="sm" type="button" variant="ghost">
              {busy ? <GlyphSpinner className="size-4" spinner="breathe" /> : <icons.ImageIcon className="size-4" />}
              {busy ? b.generating : b.generateImage}
            </Button>
          ) : imagen.data === false ? (
            <Tip label={b.generateUnavailable}>
              <span>
                <Button disabled size="sm" type="button" variant="ghost">
                  <icons.ImageIcon className="size-4" />
                  {b.generateImage}
                </Button>
              </span>
            </Tip>
          ) : null}
          {value.image ? (
            <Button onClick={() => onChange({ ...value, image: null })} size="sm" type="button" variant="text">
              {b.useShape}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
