import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function resolveUploadDir() {
  if (process.env.UPLOADS_DIR) {
    return path.resolve(process.env.UPLOADS_DIR)
  }
  const localDefault = path.join(__dirname, 'uploads')
  const dataRoot = '/data'
  if (process.env.NODE_ENV === 'production' && fs.existsSync(dataRoot)) {
    return path.join(dataRoot, 'uploads')
  }
  return localDefault
}

const uploadDir = resolveUploadDir()
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

// Tell multer where to save files and what to name them
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9)
    cb(null, unique + path.extname(file.originalname))
  }
})

const upload = multer({ storage })

export default upload