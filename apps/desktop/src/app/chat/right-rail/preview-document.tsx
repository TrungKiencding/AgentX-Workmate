import { useEffect, useMemo, useState } from 'react'

import { useDeliverableActions } from '@/components/chat/deliverable-menu'
import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { deliverableKind, fileExtension } from '@/lib/deliverables'
import { readDesktopFileDataUrl } from '@/lib/desktop-fs'
import { renderDocxPreview } from '@/lib/docx-preview'
import { cn } from '@/lib/utils'
import { parseXlsxPreview, type WorkbookPreview } from '@/lib/xlsx-preview'
import type { PreviewTarget } from '@/store/preview'

import { PreviewEmptyState } from './preview-file'

/**
 * The rail's viewer for office documents. A .docx renders as sanitised HTML
 * in a fully sandboxed frame (no scripts, no navigation, no same-origin —
 * a document is foreign content); an .xlsx / .xlsm as one table per sheet
 * with a sheet strip; anything else in the family (.pptx, .odt, .pages …)
 * has no in-app renderer yet and offers the ways out instead: Quick Look,
 * the OS app, a saved copy.
 *
 * Bytes travel as a data URL through the same bridge images use, so a
 * gateway-side document previews exactly like a local one.
 */

type DocumentState =
  | { kind: 'docx'; html: string; warnings: string[] }
  | { kind: 'error'; message: string }
  | { kind: 'loading' }
  | { kind: 'xlsx'; workbook: WorkbookPreview }

async function bytesFromDataUrl(dataUrl: string): Promise<Uint8Array> {
  const response = await fetch(dataUrl)

  return new Uint8Array(await response.arrayBuffer())
}

function filePathForTarget(target: PreviewTarget): string {
  if (target.path) {
    return target.path
  }

  try {
    const url = new URL(target.url)

    return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : target.url
  } catch {
    return target.url
  }
}

/** Which in-app renderer handles the extension, if any. */
export function documentRenderer(path: string): 'docx' | 'xlsx' | null {
  const ext = fileExtension(path)

  if (ext === 'docx') {
    return 'docx'
  }

  if (ext === 'xlsx' || ext === 'xlsm') {
    return 'xlsx'
  }

  return null
}

const DOCX_FRAME_STYLE = `
  :root { color-scheme: light; }
  body { margin: 0; padding: 32px 40px; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 14px;
         line-height: 1.6; color: #1f2328; background: #fff; max-width: 52rem; }
  h1, h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 0.5em; }
  p { margin: 0 0 0.8em; }
  table { border-collapse: collapse; margin: 1em 0; max-width: 100%; }
  td, th { border: 1px solid #d0d7de; padding: 4px 8px; vertical-align: top; }
  img { max-width: 100%; height: auto; }
  a { color: #0969da; }
`

function composeDocxDocument(html: string): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${DOCX_FRAME_STYLE}</style></head><body>`,
    html,
    '</body></html>'
  ].join('\n')
}

function SheetTable({ rows }: { rows: string[][] }) {
  const { t } = useI18n()

  if (rows.length === 0) {
    return <div className="px-4 py-6 text-center text-xs text-muted-foreground">{t.preview.sheetEmpty}</div>
  }

  return (
    <table className="min-w-full border-collapse font-mono text-2xs leading-relaxed">
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr className="border-b border-(--ui-stroke-tertiary) last:border-0" key={rowIndex}>
            <td className="w-9 select-none border-r border-(--ui-stroke-tertiary) bg-muted/35 px-2 text-right tabular-nums text-muted-foreground/70">
              {rowIndex + 1}
            </td>
            {row.map((cell, cellIndex) => (
              <td
                className="max-w-80 truncate border-r border-(--ui-stroke-tertiary) px-2 py-0.5 last:border-0"
                key={cellIndex}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function WorkbookView({ workbook }: { workbook: WorkbookPreview }) {
  const { t } = useI18n()
  const [active, setActive] = useState(0)
  const sheet = workbook.sheets[Math.min(active, workbook.sheets.length - 1)]

  if (!sheet) {
    return <PreviewEmptyState title={t.preview.sheetEmpty} />
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {workbook.sheets.length > 1 && (
        <div
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-(--ui-stroke-tertiary) px-2 py-1"
          role="tablist"
        >
          {workbook.sheets.map((entry, index) => (
            <button
              aria-selected={index === active}
              className={cn(
                'shrink-0 rounded-(--radius-control) px-2 py-0.5 text-xs transition-colors duration-(--dur-short)',
                index === active
                  ? 'bg-(--ui-bg-quaternary) text-foreground'
                  : 'text-muted-foreground hover:bg-(--chrome-action-hover) hover:text-foreground'
              )}
              key={`${entry.name}-${index}`}
              onClick={() => setActive(index)}
              role="tab"
              type="button"
            >
              {entry.name}
            </button>
          ))}
        </div>
      )}
      {sheet.truncated && (
        <div className="shrink-0 border-b border-(--ui-stroke-tertiary) bg-muted/35 px-3 py-1.5 text-2xs text-muted-foreground">
          {t.preview.sheetTruncated(sheet.rows.length)}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto" data-selectable-text="true">
        <SheetTable rows={sheet.rows} />
      </div>
    </div>
  )
}

/** The "no renderer for this one" state, with every way out on the control ramp. */
export function UnsupportedDocument({ onPreviewAnyway, path }: { onPreviewAnyway?: () => void; path: string }) {
  const { t } = useI18n()
  const actions = useDeliverableActions(path)

  return (
    <PreviewEmptyState
      body={
        <div className="mt-3 flex flex-wrap justify-center gap-1.5">
          {actions.quickLookAvailable && (
            <Button onClick={actions.quickLook} size="sm" variant="secondary">
              {t.fileCard.quickLook}
            </Button>
          )}
          {actions.local && (
            <Button onClick={actions.openExternally} size="sm" variant="secondary">
              {t.fileCard.openWith}
            </Button>
          )}
          <Button onClick={actions.download} size="sm" variant="secondary">
            {t.fileCard.download}
          </Button>
        </div>
      }
      secondaryAction={onPreviewAnyway ? { label: t.preview.previewAnyway, onClick: onPreviewAnyway } : undefined}
      title={t.preview.documentUnsupportedTitle}
    />
  )
}

export function DocumentPreview({ reloadKey, target }: { reloadKey: number; target: PreviewTarget }) {
  const { t } = useI18n()
  const filePath = filePathForTarget(target)
  const renderer = documentRenderer(filePath)
  const [state, setState] = useState<DocumentState>({ kind: 'loading' })

  useEffect(() => {
    if (!renderer) {
      return
    }

    let active = true
    setState({ kind: 'loading' })

    void (async () => {
      try {
        const bytes = await bytesFromDataUrl(await readDesktopFileDataUrl(filePath))

        if (renderer === 'docx') {
          const rendered = await renderDocxPreview(bytes.buffer as ArrayBuffer)

          if (active) {
            setState({ kind: 'docx', ...rendered })
          }
        } else if (active) {
          setState({ kind: 'xlsx', workbook: parseXlsxPreview(bytes) })
        }
      } catch (error) {
        if (active) {
          setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      }
    })()

    return () => {
      active = false
    }
  }, [filePath, reloadKey, renderer])

  const docxDocument = useMemo(() => (state.kind === 'docx' ? composeDocxDocument(state.html) : ''), [state])

  if (!renderer) {
    return <UnsupportedDocument path={filePath} />
  }

  if (state.kind === 'loading') {
    return <PageLoader label={t.preview.documentLoading} />
  }

  if (state.kind === 'error') {
    return (
      <PreviewEmptyState body={t.preview.documentFailedBody(state.message)} title={t.preview.documentFailedTitle} />
    )
  }

  if (state.kind === 'xlsx') {
    return <WorkbookView workbook={state.workbook} />
  }

  // sandbox="" — no scripts, no forms, no navigation, no same-origin: the
  // frame can only paint. The document is white on purpose (a page), and a
  // light colour scheme keeps generated content from inheriting dark tokens
  // it cannot see.
  return (
    <iframe
      className="block size-full border-0 bg-white"
      sandbox=""
      srcDoc={docxDocument}
      style={{ colorScheme: 'light' }}
      title={target.label}
    />
  )
}

export { deliverableKind as documentKind }
