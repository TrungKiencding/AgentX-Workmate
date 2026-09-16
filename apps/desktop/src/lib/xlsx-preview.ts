import { strFromU8, unzipSync } from 'fflate'

/**
 * A read-only look inside an .xlsx for the preview rail: sheet names and cell
 * text, nothing more. An .xlsx is a zip of XML parts; this reads the three
 * that matter (workbook, its relationships, shared strings) plus one part per
 * sheet, with the zip handled by `fflate` (already a dependency) and the XML
 * by the browser's own parser. No formulas are evaluated — a formula cell
 * shows the value the last save cached, exactly what Excel would show on open.
 *
 * Bounded on purpose: a preview answers "is this the right file, does it look
 * right", not "let me analyse 100k rows" — that is what opening it is for.
 */

export interface SheetPreview {
  name: string
  /** Rows of cell text, padded to the sheet's widest row within the column cap. */
  rows: string[][]
  totalRows: number
  truncated: boolean
}

export interface WorkbookPreview {
  sheets: SheetPreview[]
}

export const XLSX_PREVIEW_MAX_ROWS = 500
export const XLSX_PREVIEW_MAX_COLS = 64

interface ParseOptions {
  maxCols?: number
  maxRows?: number
}

const XML_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml')

  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Malformed workbook XML')
  }

  return doc
}

function partText(parts: Record<string, Uint8Array>, name: string): null | string {
  const data = parts[name] ?? parts[name.replace(/^\//, '')]

  return data ? strFromU8(data) : null
}

/** `A` → 0, `Z` → 25, `AA` → 26; the row digits are ignored. */
export function columnIndex(cellRef: string): number {
  let index = 0

  for (const char of cellRef) {
    if (char < 'A' || char > 'Z') {
      break
    }

    index = index * 26 + (char.charCodeAt(0) - 64)
  }

  return index - 1
}

function elementText(node: Element): string {
  // Rich text runs (`<r><t>…</t></r>`) and phonetic hints: keep the `<t>`
  // leaves in order, skip `<rPh>` (furigana) which would duplicate the text.
  const pieces: string[] = []

  const walk = (current: Element) => {
    for (const child of Array.from(current.children)) {
      if (child.localName === 'rPh') {
        continue
      }

      if (child.localName === 't') {
        pieces.push(child.textContent ?? '')
      } else {
        walk(child)
      }
    }
  }

  walk(node)

  return pieces.join('')
}

function sharedStrings(parts: Record<string, Uint8Array>): string[] {
  const text = partText(parts, 'xl/sharedStrings.xml')

  if (!text) {
    return []
  }

  const doc = parseXml(text)

  return Array.from(doc.getElementsByTagNameNS(XML_NS, 'si')).map(elementText)
}

function sheetParts(parts: Record<string, Uint8Array>): { name: string; part: string }[] {
  const workbookXml = partText(parts, 'xl/workbook.xml')

  if (!workbookXml) {
    throw new Error('Not a workbook: xl/workbook.xml is missing')
  }

  const relsXml = partText(parts, 'xl/_rels/workbook.xml.rels') ?? ''
  const targetById = new Map<string, string>()

  if (relsXml) {
    for (const rel of Array.from(parseXml(relsXml).getElementsByTagNameNS(RELS_NS, 'Relationship'))) {
      const id = rel.getAttribute('Id')
      const target = rel.getAttribute('Target')

      if (id && target) {
        targetById.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`)
      }
    }
  }

  const sheets: { name: string; part: string }[] = []

  Array.from(parseXml(workbookXml).getElementsByTagNameNS(XML_NS, 'sheet')).forEach((sheet, index) => {
    const relId = sheet.getAttributeNS(REL_NS, 'id') || sheet.getAttribute('r:id') || ''
    const part = targetById.get(relId) ?? `xl/worksheets/sheet${index + 1}.xml`

    sheets.push({ name: sheet.getAttribute('name') || `Sheet${index + 1}`, part })
  })

  return sheets
}

function cellText(cell: Element, strings: string[]): string {
  const type = cell.getAttribute('t') || 'n'

  if (type === 'inlineStr') {
    const inline = cell.getElementsByTagNameNS(XML_NS, 'is')[0]

    return inline ? elementText(inline) : ''
  }

  const value = cell.getElementsByTagNameNS(XML_NS, 'v')[0]?.textContent ?? ''

  if (type === 's') {
    return strings[Number(value)] ?? ''
  }

  if (type === 'b') {
    return value === '1' ? 'TRUE' : 'FALSE'
  }

  return value
}

function parseSheet(xml: string, strings: string[], maxRows: number, maxCols: number): Omit<SheetPreview, 'name'> {
  const doc = parseXml(xml)
  const rowNodes = Array.from(doc.getElementsByTagNameNS(XML_NS, 'row'))
  const rows: string[][] = []
  let width = 0

  for (const rowNode of rowNodes.slice(0, maxRows)) {
    const row: string[] = []

    for (const cell of Array.from(rowNode.getElementsByTagNameNS(XML_NS, 'c'))) {
      const ref = cell.getAttribute('r') || ''
      const column = ref ? columnIndex(ref) : row.length

      if (column < 0 || column >= maxCols) {
        continue
      }

      while (row.length < column) {
        row.push('')
      }

      row[column] = cellText(cell, strings)
    }

    width = Math.max(width, row.length)
    rows.push(row)
  }

  for (const row of rows) {
    while (row.length < width) {
      row.push('')
    }
  }

  return { rows, totalRows: rowNodes.length, truncated: rowNodes.length > maxRows }
}

export function parseXlsxPreview(bytes: Uint8Array, options: ParseOptions = {}): WorkbookPreview {
  const maxRows = options.maxRows ?? XLSX_PREVIEW_MAX_ROWS
  const maxCols = options.maxCols ?? XLSX_PREVIEW_MAX_COLS
  const parts = unzipSync(bytes)
  const strings = sharedStrings(parts)

  const sheets = sheetParts(parts).map(({ name, part }) => {
    const xml = partText(parts, part)

    if (!xml) {
      return { name, rows: [], totalRows: 0, truncated: false }
    }

    return { name, ...parseSheet(xml, strings, maxRows, maxCols) }
  })

  return { sheets }
}
