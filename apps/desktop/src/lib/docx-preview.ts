import DOMPurify from 'dompurify'
import type * as MammothTypes from 'mammoth'

/**
 * A .docx rendered to HTML for the preview rail. `mammoth` does the
 * conversion (semantic HTML: headings, lists, tables, images as data URIs)
 * and is loaded on first use so a transcript that never opens a document
 * never pays for it. The result is sanitised before it reaches the sandboxed
 * frame that shows it: a document is foreign content, and a preview must not
 * be a way to run it.
 */

export interface DocxPreview {
  html: string
  /** Conversion notes (unsupported styles, dropped elements). */
  warnings: string[]
}

type MammothModule = typeof MammothTypes
let mammothCache: MammothModule | null = null

async function loadMammoth(): Promise<MammothModule> {
  if (!mammothCache) {
    mammothCache = await import('mammoth')
  }

  return mammothCache
}

export function sanitizeDocumentHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:data:image\/|#)/i,
    FORBID_TAGS: ['form', 'input', 'button', 'iframe', 'object', 'embed', 'link', 'meta', 'style'],
    USE_PROFILES: { html: true }
  })
}

export async function renderDocxPreview(bytes: ArrayBuffer): Promise<DocxPreview> {
  const mammoth = await loadMammoth()
  const result = await mammoth.convertToHtml({ arrayBuffer: bytes })

  return {
    html: sanitizeDocumentHtml(result.value),
    warnings: result.messages.map(message => message.message)
  }
}
