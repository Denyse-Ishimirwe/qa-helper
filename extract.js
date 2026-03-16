import fs from 'fs'
import path from 'path'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.pdf') {
    const buffer = fs.readFileSync(filePath)
    const parser = new PDFParse()
    const result = await parser.parse(buffer)
    return result.text
  }

  if (ext === '.doc' || ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath })
    return result.value
  }

  throw new Error('Unsupported file type')
}

export default extractText