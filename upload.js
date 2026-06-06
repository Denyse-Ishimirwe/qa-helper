import fs from 'fs/promises'
import path from 'path'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'

/**
 * Per-line cleanup matching the old pdfreader-based extractor:
 * join split letter-spaces, split camelCase tokens, collapse whitespace.
 */
function formatPdfLine(line) {
  return line
    .replace(/(?<=[a-zA-Z])\s(?=[a-zA-Z])/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatPdfPageText(raw) {
  return raw
    .split(/\r?\n/)
    .map(formatPdfLine)
    .filter(Boolean)
    .join('\n')
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.pdf') {
    const data = await fs.readFile(filePath)
    const parser = new PDFParse({ data: new Uint8Array(data) })
    try {
      // lineEnforce / cellSeparator approximate pdfreader's Y-row + horizontal gaps
      const result = await parser.getText({
        lineEnforce: true,
        lineThreshold: 4.5,
        cellSeparator: ' ',
        cellThreshold: 9,
        pageJoiner: ''
      })
      const pages = result.pages.map((p) => formatPdfPageText(p.text)).filter(Boolean)
      return pages.join('\n\n').trim()
    } finally {
      await parser.destroy()
    }
  }

  if (ext === '.doc' || ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath })
    return result.value
  }

  throw new Error('Unsupported file type')
}

export default extractText
