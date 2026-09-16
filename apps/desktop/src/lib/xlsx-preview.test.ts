import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { columnIndex, parseXlsxPreview } from './xlsx-preview'

const NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

function workbook(sheets: { name: string; xml: string }[], shared: string[] = []): Uint8Array {
  const parts: Record<string, Uint8Array> = {
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0"?><workbook ${NS}><sheets>${sheets
        .map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
        .join('')}</sheets></workbook>`
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map(
          (_sheet, index) => `<Relationship Id="rId${index + 1}" Type="x" Target="worksheets/sheet${index + 1}.xml"/>`
        )
        .join('')}</Relationships>`
    )
  }

  if (shared.length > 0) {
    parts['xl/sharedStrings.xml'] = strToU8(
      `<?xml version="1.0"?><sst ${NS}>${shared.map(text => `<si><t>${text}</t></si>`).join('')}</sst>`
    )
  }

  sheets.forEach((sheet, index) => {
    parts[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(
      `<?xml version="1.0"?><worksheet ${NS}>${sheet.xml}</worksheet>`
    )
  })

  return zipSync(parts)
}

describe('columnIndex', () => {
  it('maps cell references to zero-based columns', () => {
    expect(columnIndex('A1')).toBe(0)
    expect(columnIndex('Z9')).toBe(25)
    expect(columnIndex('AA1')).toBe(26)
    expect(columnIndex('AB12')).toBe(27)
  })
})

describe('parseXlsxPreview', () => {
  it('reads shared strings, inline strings, numbers, booleans and cached formula results', () => {
    const bytes = workbook(
      [
        {
          name: 'Doanh thu',
          xml:
            '<sheetData>' +
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
            '<row r="2"><c r="A2" t="inlineStr"><is><t>Q3</t></is></c><c r="B2"><v>1250.5</v></c>' +
            '<c r="C2" t="b"><v>1</v></c><c r="D2" t="str"><f>A2&amp;"!"</f><v>Q3!</v></c></row>' +
            '</sheetData>'
        }
      ],
      ['Quý', 'Doanh thu']
    )

    const preview = parseXlsxPreview(bytes)

    expect(preview.sheets).toHaveLength(1)
    expect(preview.sheets[0].name).toBe('Doanh thu')
    expect(preview.sheets[0].rows).toEqual([
      ['Quý', 'Doanh thu', '', ''],
      ['Q3', '1250.5', 'TRUE', 'Q3!']
    ])
    expect(preview.sheets[0].truncated).toBe(false)
    expect(preview.sheets[0].totalRows).toBe(2)
  })

  it('keeps sparse cells in their columns and pads rows to the widest', () => {
    const bytes = workbook([
      {
        name: 'S',
        xml: '<sheetData><row r="1"><c r="C1"><v>3</v></c></row><row r="2"><c r="A2"><v>1</v></c></row></sheetData>'
      }
    ])

    expect(parseXlsxPreview(bytes).sheets[0].rows).toEqual([
      ['', '', '3'],
      ['1', '', '']
    ])
  })

  it('honours the row and column caps and reports truncation', () => {
    const rows = Array.from(
      { length: 5 },
      (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c><c r="C${i + 1}"><v>x</v></c></row>`
    )

    const bytes = workbook([{ name: 'Big', xml: `<sheetData>${rows.join('')}</sheetData>` }])

    const sheet = parseXlsxPreview(bytes, { maxCols: 2, maxRows: 3 }).sheets[0]

    expect(sheet.rows).toEqual([['0'], ['1'], ['2']])
    expect(sheet.truncated).toBe(true)
    expect(sheet.totalRows).toBe(5)
  })

  it('lists every sheet, including an empty one', () => {
    const bytes = workbook([
      { name: 'First', xml: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' },
      { name: 'Empty', xml: '<sheetData/>' }
    ])

    const preview = parseXlsxPreview(bytes)

    expect(preview.sheets.map(sheet => sheet.name)).toEqual(['First', 'Empty'])
    expect(preview.sheets[1].rows).toEqual([])
  })

  it('reads rich-text shared strings as one string', async () => {
    const parts = workbook([{ name: 'R', xml: '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData>' }])

    // Rebuild with a rich shared string: two runs plus a phonetic hint to skip.
    const rich = zipSync({
      ...Object.fromEntries(
        Object.entries((await import('fflate')).unzipSync(parts)).map(([name, data]) => [name, data])
      ),
      'xl/sharedStrings.xml': strToU8(
        `<?xml version="1.0"?><sst ${NS}><si><r><t>Hà </t></r><r><t>Nội</t></r><rPh><t>skip</t></rPh></si></sst>`
      )
    })

    expect(parseXlsxPreview(rich).sheets[0].rows).toEqual([['Hà Nội']])
  })

  it('refuses a zip that is not a workbook', () => {
    expect(() => parseXlsxPreview(zipSync({ 'readme.txt': strToU8('hi') }))).toThrow(/Not a workbook/)
  })
})
