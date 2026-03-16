import fs from 'fs'
import path from 'path'
import mammoth from 'mammoth'
import { PdfReader } from 'pdfreader'

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.pdf') {
    return new Promise((resolve, reject) => {
      let rows = {}

      new PdfReader().parseFileItems(filePath, (err, item) => {
        if (err) {
          reject(new Error(err))
        } else if (!item) {
          const text = Object.keys(rows)
  .sort((a, b) => a - b)
  .map(y => {
    const line = rows[y].join(' ')
   return line.replace(/(?<=[a-zA-Z])\s(?=[a-zA-Z])/g, '')
           .replace(/([a-z])([A-Z])/g, '$1 $2')
           .replace(/\s+/g, ' ')
           .trim()
  })
  .join('\n')
resolve(text)
          
        } else if (item.text) {
          const row = item.y
          if (!rows[row]) rows[row] = []
          rows[row].push(item.text.trim())
        }
      })
    })
  }

  if (ext === '.doc' || ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath })
    return result.value
  }

  throw new Error('Unsupported file type')
}

export default extractText