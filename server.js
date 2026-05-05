import express from 'express'
import cors from 'cors'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'
import db, { dbReady } from './db.js'
import upload from './multer.js'
import extractText from './upload.js'
import generateTestCases, { analyzeFormStructure } from './ai.js'
import runTests from './Runtests.js'
import XLSX from 'xlsx'
import ExcelJS from 'exceljs'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { launchChromiumBrowser } from './playwright-launch.js'


const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
const PORT = Number(process.env.PORT) || 3000
const jwtSecret = process.env.JWT_SECRET
const DEFAULT_DEMO_PASSWORD = 'Try@123'
const DEMO_EMAILS = new Set([
  'qa_review_1@ymail.com',
  'qa_review_2@ymail.com',
  'qa_review_3@ymail.com'
])
const ALLOWED_TEST_TYPES = [
  'required_field',
  'format_validation',
  'successful_submit',
  'conditional_field',
  'conditional_required',
  'conditional_display',
  'widget_auto_fill',
  'attachment',
  'label_check'
]
const extensionScanJobs = new Map()

if (!jwtSecret) {
  throw new Error('JWT_SECRET is required. Add it to your .env file before starting the server.')
}

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1)
}

function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || ''
    const [scheme, token] = authHeader.split(' ')

    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' })
    }

    const decoded = jwt.verify(
      token,
      jwtSecret
    )

    req.user = {
      id: decoded.userId,
      email: decoded.email
    }

    next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

const corsOrigin = process.env.CORS_ORIGIN?.trim()
if (corsOrigin) {
  const origins = corsOrigin.split(',').map(s => s.trim()).filter(Boolean)
  app.use(
    cors({
      origin: origins.length > 1 ? origins : origins[0],
      credentials: true
    })
  )
} else {
  app.use(cors())
}
app.use(express.json({ limit: '25mb' }))

app.get('/api/health', (req, res) => {
  res.status(200).json({ ok: true, time: new Date().toISOString() })
})

async function resolveBestFormContext(page) {
  const candidates = [page.mainFrame(), ...page.frames()]
  let best = page.mainFrame()
  let bestScore = -1

  for (const frame of candidates) {
    try {
      const score = await frame.locator('input, select, textarea, button').count()
      if (score > bestScore) {
        bestScore = score
        best = frame
      }
    } catch {
      // Ignore frames that are not accessible/ready yet.
    }
  }

  return best
}

async function waitForPortalFormReady(page) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const context = await resolveBestFormContext(page)
    const controls = await context.locator('input, select, textarea, button').count()
    if (controls > 0) return context
    await page.waitForTimeout(500)
  }
  return resolveBestFormContext(page)
}

function extractNotionPageId(input) {
  const raw = String(input || '').trim()
  if (!raw) return null

  const toDashedUuid = (hex32) => {
    const compact = String(hex32 || '').replace(/-/g, '').toLowerCase()
    if (!/^[a-f0-9]{32}$/.test(compact)) return null
    return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`
  }

  // 1) Common Notion URL shape:
  //    /Page-Title-34315c104265800886c2cfa7693363b6
  //    or /34315c10-4265-8008-86c2-cfa7693363b6
  let candidates = []
  try {
    const parsed = new URL(raw)
    const parts = parsed.pathname.split('/').filter(Boolean)
    const lastPart = parts.length ? decodeURIComponent(parts[parts.length - 1]) : ''
    if (lastPart) candidates.push(lastPart)
    candidates.push(parsed.pathname)
  } catch {
    candidates.push(raw)
  }

  // 2) Also scan the whole raw input as a fallback.
  candidates.push(raw)

  for (const candidate of candidates) {
    const normalized = String(candidate || '')
    const dashed = normalized.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i)
    if (dashed?.[0]) return toDashedUuid(dashed[0])

    // Use the LAST 32-hex match to avoid grabbing unrelated IDs in prefixes.
    const compactMatches = normalized.match(/[a-f0-9]{32}/ig)
    if (compactMatches?.length) {
      return toDashedUuid(compactMatches[compactMatches.length - 1])
    }
  }

  return null
}

async function fetchNotionSrdText(notionUrl) {
  const token = String(process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || '').trim()
  if (!token) {
    throw new Error('NOTION_API_KEY (or NOTION_TOKEN) is required for Notion SRD import')
  }
  const pageId = extractNotionPageId(notionUrl)
  if (!pageId) throw new Error('Invalid Notion page URL')

  const headers = {
    Authorization: `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json'
  }

  const richTextToString = (richText) => (
    Array.isArray(richText)
      ? richText.map(t => String(t?.plain_text || '').trim()).filter(Boolean).join(' ')
      : ''
  )

  async function fetchBlockChildren(blockId) {
    const children = []
    let cursor = null
    for (let i = 0; i < 20; i += 1) {
      const url = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`)
      if (cursor) url.searchParams.set('start_cursor', cursor)
      const res = await fetch(url, { headers })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Notion API error (${res.status}): ${body || 'Unable to fetch page content'}`)
      }
      const data = await res.json()
      children.push(...(Array.isArray(data.results) ? data.results : []))
      if (!data.has_more || !data.next_cursor) break
      cursor = data.next_cursor
    }
    return children
  }

  function extractBlockText(block) {
    const type = String(block?.type || '')
    if (!type) return []

    const simpleRichTextTypes = new Set([
      'paragraph',
      'bulleted_list_item',
      'numbered_list_item',
      'toggle',
      'heading_1',
      'heading_2',
      'heading_3',
      'callout',
      'quote'
    ])

    if (simpleRichTextTypes.has(type)) {
      const content = block?.[type]
      const line = richTextToString(content?.rich_text)
      return line ? [line] : []
    }

    if (type === 'table_row') {
      const cells = Array.isArray(block?.table_row?.cells) ? block.table_row.cells : []
      const rowText = cells
        .map(cell => richTextToString(cell))
        .filter(Boolean)
      return rowText.length ? [rowText.join(' | ')] : []
    }

    return []
  }

  async function walkBlocks(blockId) {
    const blocks = await fetchBlockChildren(blockId)
    const lines = []

    for (const block of blocks) {
      lines.push(...extractBlockText(block))

      // Toggle and table content lives in child blocks.
      if (block?.has_children) {
        const nested = await walkBlocks(block.id)
        lines.push(...nested)
      }
    }

    return lines
  }

  const lines = await walkBlocks(pageId)
  const text = lines
    .map(line => String(line || '').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  console.log('[notion] Extracted SRD text:\n', text)

  if (!text) throw new Error('No readable text found in Notion page')
  return text
}

function isSkippedRunResultRow(r) {
  return Boolean(r?.skipped) || /^skipped:/i.test(String(r?.notes || '').trim())
}

async function persistRunResults(projectId, results) {
  const runStartedAt = new Date().toISOString()
  const runFinishedAt = new Date().toISOString()
  const anyRealFailure = results.some(r => !isSkippedRunResultRow(r) && !r.passed)
  const projectStatus = anyRealFailure ? 'Failed' : 'Passed'

  const runInsert = await db.run(
    'INSERT INTO test_runs (project_id, run_started_at, run_finished_at, project_status) VALUES (?, ?, ?, ?)',
    projectId,
    runStartedAt,
    runFinishedAt,
    projectStatus
  )
  const runId = runInsert.lastInsertRowid

  const cases = await db.all(
    'SELECT id, name, what_to_test, expected_result, generation_reason, test_type, expected_outcome FROM test_cases WHERE project_id = ?',
    projectId
  )
  const byId = new Map(cases.map(tc => [tc.id, tc]))

  for (const r of results) {
    const tc = byId.get(r.id)
    if (!tc) continue
    await db.run(
      `
      INSERT INTO test_run_results
      (run_id, test_case_id, status, notes, screenshot_path, snapshot_name, snapshot_what_to_test, snapshot_expected_result, snapshot_generation_reason, snapshot_expected_outcome, snapshot_test_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      runId,
      r.id,
      isSkippedRunResultRow(r) ? 'Skipped' : r.passed ? 'Passed' : 'Failed',
      r.notes || '',
      r.screenshotPath || null,
      tc.name,
      tc.what_to_test,
      tc.expected_result,
      tc.generation_reason || '',
      tc.expected_outcome || 'should_pass',
      tc.test_type || 'required_field'
    )
  }

  return { runId, projectStatus }
}

function ensureUploadsBaseDir() {
  const base = process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.join(process.cwd(), 'uploads')
  fs.mkdirSync(base, { recursive: true })
  return base
}

function saveExtensionScreenshot(runId, testCaseId, dataUrl) {
  const m = String(dataUrl || '').match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i)
  if (!m) return null
  const ext = String(m[1] || 'png').toLowerCase() === 'png' ? 'png' : 'jpg'
  const baseDir = ensureUploadsBaseDir()
  const dir = path.join(baseDir, 'screenshots', 'extension', `run-${runId}`)
  fs.mkdirSync(dir, { recursive: true })
  const fileName = `tc-${testCaseId}-${Date.now()}.${ext}`
  const fullPath = path.join(dir, fileName)
  fs.writeFileSync(fullPath, Buffer.from(m[2], 'base64'))
  return `/uploads/screenshots/extension/run-${runId}/${fileName}`
}

async function applyExtensionScreenshotsToRun(runId, screenshots = []) {
  let saved = 0
  for (const item of screenshots) {
    const testCaseId = Number(item?.testCaseId || 0)
    const dataUrl = String(item?.imageDataUrl || '')
    if (!testCaseId || !dataUrl) continue

    const screenshotPath = saveExtensionScreenshot(runId, testCaseId, dataUrl)
    if (!screenshotPath) continue

    const row = await db.get(
      'SELECT notes FROM test_run_results WHERE run_id = ? AND test_case_id = ?',
      runId,
      testCaseId
    )
    if (!row) continue

    const cleanNotes = String(row.notes || '').replace(/\n?Screenshot:\s*\/uploads\/[^\s]+/g, '').trim()
    const nextNotes = `${cleanNotes}${cleanNotes ? '\n' : ''}Screenshot: ${screenshotPath}`

    await db.run(
      'UPDATE test_run_results SET screenshot_path = ?, notes = ? WHERE run_id = ? AND test_case_id = ?',
      screenshotPath,
      nextNotes,
      runId,
      testCaseId
    )
    await db.run(
      'UPDATE test_cases SET notes = ? WHERE id = ?',
      nextNotes,
      testCaseId
    )
    saved += 1
  }
  return saved
}

async function ensureProjectOwner(req, res) {
  const project = await db.get('SELECT id, user_id FROM projects WHERE id = ?', req.params.id)

  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return null
  }

  if (project.user_id !== req.user.id) {
    res.status(403).json({ error: 'Forbidden' })
    return null
  }

  return project
}

async function ensureTestCaseOwner(req, res) {
  const row = await db.get(
    `
    SELECT tc.id AS test_case_id, p.user_id
    FROM test_cases tc
    JOIN projects p ON p.id = tc.project_id
    WHERE tc.id = ?
  `,
    req.params.id
  )

  if (!row) {
    res.status(404).json({ error: 'Test case not found' })
    return null
  }

  if (row.user_id !== req.user.id) {
    res.status(403).json({ error: 'Forbidden' })
    return null
  }

  return row
}

app.post('/api/auth/login', async (req, res) => {
  try {
    const rawEmail = String(req.body?.email || '').trim()
    const password = String(req.body?.password || '')
    const normalizedEmail = rawEmail.toLowerCase()

    if (!rawEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    let user = await db.get(
      'SELECT id, email, password_hash FROM users WHERE lower(email) = lower(?)',
      rawEmail
    )

    if (!user && DEMO_EMAILS.has(normalizedEmail)) {
      const hash = await bcrypt.hash(DEFAULT_DEMO_PASSWORD, 10)
      try {
        await db.run('INSERT INTO users (email, password_hash) VALUES (?, ?)', normalizedEmail, hash)
      } catch {
        // Another request may create the same row; read below covers that race.
      }
      user = await db.get(
        'SELECT id, email, password_hash FROM users WHERE lower(email) = lower(?)',
        rawEmail
      )
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    let passwordOk = await bcrypt.compare(password, user.password_hash).catch(() => false)

    // Backward compatibility: old seed rows stored plain text values in password_hash.
    // Allow one successful login and then upgrade the stored value to bcrypt.
    const isLegacyPlain = user.password_hash === password
    if (!passwordOk && isLegacyPlain) {
      passwordOk = true
      const upgradedHash = await bcrypt.hash(password, 10)
      await db.run('UPDATE users SET password_hash = ? WHERE id = ?', upgradedHash, user.id)
    }

    if (!passwordOk) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      jwtSecret,
      { expiresIn: '7d' }
    )

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email
      }
    })
  } catch (err) {
    console.error('Login error:', err)
    return res.status(500).json({ error: 'Login failed' })
  }
})

app.get('/api', (req, res) => {
  res.json({ ok: true, message: 'QA Helper API is running' })
})

app.post('/api/extension-scan', requireAuth, async (req, res) => {
  try {
    const { url, fields, projectId, sessionCookies } = req.body || {}
    const extensionUrl = String(url || '').trim()
    const safeFields = Array.isArray(fields) ? fields : []
    if (!projectId) {
      return res.status(400).json({ ok: false, error: 'projectId is required' })
    }
    if (!extensionUrl) {
      return res.status(400).json({ ok: false, error: 'Current page URL is required from extension scan' })
    }
    const project = await db.get(
      'SELECT id, user_id, form_url, form_structure, srd_text FROM projects WHERE id = ?',
      projectId
    )
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found' })
    if (project.user_id !== req.user.id) return res.status(403).json({ ok: false, error: 'Forbidden' })

    if (!safeFields.length) {
      return res.status(400).json({ ok: false, error: 'No fields were detected on current page' })
    }

    console.log('[extension-scan] URL:', extensionUrl || 'unknown')
    console.log('[extension-scan] projectId:', projectId)
    console.log('[extension-scan] Fields:', safeFields)
    // #region agent log
    fetch('http://127.0.0.1:7811/ingest/193ceff3-13cc-4a5d-8fcb-570fabc3b13e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'64e698'},body:JSON.stringify({sessionId:'64e698',runId:'pre-fix-auth',hypothesisId:'H2',location:'server.js:/api/extension-scan',message:'Received extension scan payload',data:{projectId:Number(projectId),fieldsCount:safeFields.length,sessionCookiesCount:Array.isArray(sessionCookies)?sessionCookies.length:0,sessionCookieDomains:Array.from(new Set((Array.isArray(sessionCookies)?sessionCookies:[]).map(c=>String(c?.domain||'').toLowerCase()).filter(Boolean))).slice(0,20)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    extensionScanJobs.set(jobId, {
      id: jobId,
      userId: req.user.id,
      projectId: Number(projectId),
      status: 'running',
      phase: 'running_tests',
      message: 'Running tests...',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      progress: { total: 0, completed: 0 },
      events: [],
      pendingScreenshots: [],
      nextEventSeq: 1,
      result: null,
      error: null
    })

    // Run in background so popup can poll live progress.
    ;(async () => {
      try {
    // Extension must use the app's existing test cases only.
        const existingCountRow = await db.get(
          'SELECT COUNT(*) AS total FROM test_cases WHERE project_id = ?',
          projectId
        )
        const existingCount = Number(existingCountRow?.total || 0)
        if (existingCount === 0) {
      throw new Error('No test cases found. Generate test cases in the app first.')
        }

        const results = await runTests(projectId, {
          overrideUrl: extensionUrl,
          scannedFields: safeFields,
          sessionCookies: Array.isArray(sessionCookies) ? sessionCookies : [],
          source: 'extension',
          screenshotSource: 'extension',
          onProgress: (p) => {
            const job = extensionScanJobs.get(jobId)
            if (!job) return
            const phase = String(p?.phase || '').trim() || job.phase
            const message = String(p?.message || '').trim() || job.message
            const total = Number.isFinite(Number(p?.total)) ? Number(p.total) : job.progress.total
            const completed = Number.isFinite(Number(p?.completed)) ? Number(p.completed) : job.progress.completed
            const events = Array.isArray(job.events) ? [...job.events] : []
            if ((p?.phase === 'case_done' || p?.phase === 'capture_failure') && p?.caseResult) {
              events.push({
                seq: job.nextEventSeq || 1,
                phase: p.phase,
                caseResult: p.caseResult
              })
            }
            extensionScanJobs.set(jobId, {
              ...job,
              phase,
              message,
              progress: { total, completed },
              events: events.slice(-80),
              nextEventSeq: (job.nextEventSeq || 1) + (((p?.phase === 'case_done' || p?.phase === 'capture_failure') && p?.caseResult) ? 1 : 0),
              updatedAt: Date.now()
            })
          }
        })

        const jobAlmostDone = extensionScanJobs.get(jobId)
        if (jobAlmostDone) {
          extensionScanJobs.set(jobId, {
            ...jobAlmostDone,
            phase: 'finishing',
            message: 'Almost done...',
            updatedAt: Date.now()
          })
        }

        const { runId } = await persistRunResults(projectId, results)
        const jobForScreens = extensionScanJobs.get(jobId)
        if (jobForScreens?.pendingScreenshots?.length) {
          await applyExtensionScreenshotsToRun(runId, jobForScreens.pendingScreenshots)
        }
        const skippedN = results.filter(r => isSkippedRunResultRow(r)).length
        const passedN = results.filter(r => r.passed && !isSkippedRunResultRow(r)).length
        const failedN = results.filter(r => !r.passed && !isSkippedRunResultRow(r)).length
        const summary = `Done - ${passedN} passed, ${failedN} failed${skippedN ? `, ${skippedN} skipped` : ''}`

        const jobDone = extensionScanJobs.get(jobId)
        if (jobDone) {
          extensionScanJobs.set(jobId, {
            ...jobDone,
            status: 'done',
            phase: 'done',
            message: summary,
            updatedAt: Date.now(),
            result: {
              ok: true,
              projectId: Number(projectId),
              runId,
              summary,
              passed: passedN,
              failed: failedN,
              checks: results.map(r => ({
                id: r.id,
                name: r.name,
                passed: Boolean(r.passed),
                notes: r.notes || '',
                generation_reason: r.generationReason || ''
              }))
            }
          })
        }
      } catch (err) {
        const jobFailed = extensionScanJobs.get(jobId)
        if (jobFailed) {
          extensionScanJobs.set(jobId, {
            ...jobFailed,
            status: 'error',
            phase: 'error',
            message: String(err?.message || 'Extension scan failed'),
            updatedAt: Date.now(),
            error: String(err?.message || 'Extension scan failed')
          })
        }
        console.error('extension-scan error:', err)
      }
    })()

    return res.json({
      ok: true,
      jobId,
      status: 'running',
      message: 'Running tests...'
    })
  } catch (err) {
    console.error('extension-scan error:', err)
    return res.status(500).json({ ok: false, error: err.message || 'Failed to run extension scan' })
  }
})

app.get('/api/extension-scan/status/:jobId', requireAuth, async (req, res) => {
  const jobId = String(req.params?.jobId || '').trim()
  const job = extensionScanJobs.get(jobId)
  if (!job) {
    return res.status(404).json({ ok: false, error: 'Scan job not found' })
  }
  if (job.userId !== req.user.id) {
    return res.status(403).json({ ok: false, error: 'Forbidden' })
  }

  // Auto-clean stale completed jobs after 15 minutes.
  if ((job.status === 'done' || job.status === 'error') && Date.now() - job.updatedAt > 15 * 60 * 1000) {
    extensionScanJobs.delete(jobId)
  }

  return res.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    phase: job.phase,
    message: job.message,
    progress: job.progress,
    events: job.events || [],
    result: job.result,
    error: job.error
  })
})

app.post('/api/extension-scan/:jobId/screenshot', requireAuth, async (req, res) => {
  try {
    const jobId = String(req.params?.jobId || '').trim()
    const job = extensionScanJobs.get(jobId)
    if (!job) return res.status(404).json({ ok: false, error: 'Scan job not found' })
    if (job.userId !== req.user.id) return res.status(403).json({ ok: false, error: 'Forbidden' })

    const testCaseId = Number(req.body?.testCaseId || 0)
    const imageDataUrl = String(req.body?.imageDataUrl || '')
    if (!testCaseId || !imageDataUrl) {
      return res.status(400).json({ ok: false, error: 'testCaseId and imageDataUrl are required' })
    }

    const pending = Array.isArray(job.pendingScreenshots) ? [...job.pendingScreenshots] : []
    pending.push({ testCaseId, imageDataUrl })
    extensionScanJobs.set(jobId, {
      ...job,
      pendingScreenshots: pending.slice(-80),
      updatedAt: Date.now()
    })

    return res.json({ ok: true })
  } catch (err) {
    console.error('extension screenshot queue error:', err)
    return res.status(500).json({ ok: false, error: err.message || 'Failed to queue extension screenshot' })
  }
})

app.post('/api/runs/:runId/extension-screenshots', requireAuth, async (req, res) => {
  try {
    const runId = Number(req.params?.runId || 0)
    const screenshots = Array.isArray(req.body?.screenshots) ? req.body.screenshots : []
    if (!runId || screenshots.length === 0) {
      return res.status(400).json({ ok: false, error: 'runId and screenshots are required' })
    }

    const owned = await db.get(
      `
      SELECT tr.id
      FROM test_runs tr
      JOIN projects p ON p.id = tr.project_id
      WHERE tr.id = ? AND p.user_id = ?
      `,
      runId,
      req.user.id
    )
    if (!owned) return res.status(403).json({ ok: false, error: 'Forbidden' })

    const saved = await applyExtensionScreenshotsToRun(runId, screenshots)

    return res.json({ ok: true, saved })
  } catch (err) {
    console.error('extension screenshot upload error:', err)
    return res.status(500).json({ ok: false, error: err.message || 'Failed to save extension screenshots' })
  }
})

app.get('/api/projects', requireAuth, async (req, res) => {
  const projects = await db.all(
    `
    SELECT id, user_id, name, form_url, form_structure, srd_text, status, last_tested, created_at
    FROM projects
    WHERE user_id = ?
    ORDER BY id DESC
  `,
    req.user.id
  )
  res.json(projects)
})

app.post('/api/projects', requireAuth, upload.single('srd'), async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim()
    const form_url = String(req.body?.form_url || '').trim()
    const notion_url = String(req.body?.notion_url || '').trim()
    const srdFile = req.file || null

    if (!name) {
      return res.status(400).json({ error: 'Project name is required' })
    }

    if (!srdFile && !notion_url) {
      return res.status(400).json({ error: 'Upload an SRD file or provide a Notion URL' })
    }

    let srdText = ''
    if (srdFile) {
      srdText = await extractText(srdFile.path)
    } else {
      srdText = await fetchNotionSrdText(notion_url)
    }

    const result = await db.run(
      'INSERT INTO projects (user_id, name, form_url, srd_text) VALUES (?, ?, ?, ?)',
      req.user.id,
      name,
      form_url || '',
      srdText
    )

    res.json({ success: true, id: result.lastInsertRowid })

  } catch (err) {
    const msg = String(err?.message || 'Failed to create project')
    console.error('Create project error:', msg)
    // Notion errors are usually user-actionable (wrong URL / not shared / permissions).
    if (msg.startsWith('Notion API error (') || msg.toLowerCase().includes('notion')) {
      return res.status(400).json({ error: msg })
    }
    res.status(500).json({ error: msg })
  }
})

// Edit a project (name, form_url, and optionally a new SRD)
app.put('/api/projects/:id', requireAuth, upload.single('srd'), async (req, res) => {
  try {
    const ownedProject = await ensureProjectOwner(req, res)
    if (!ownedProject) return

    const name = String(req.body?.name || '').trim()
    const form_url = String(req.body?.form_url || '').trim()
    const notion_url = String(req.body?.notion_url || '').trim()

    if (!name) {
      return res.status(400).json({ error: 'Project name is required' })
    }

    // If a new SRD source was provided, extract its text, clear old test cases and reset status
    if (req.file || notion_url) {
      const nextSrd = req.file
        ? await extractText(req.file.path)
        : await fetchNotionSrdText(notion_url)
      await db.run('DELETE FROM test_cases WHERE project_id = ?', req.params.id)
      await db.run(
        "UPDATE projects SET name = ?, form_url = ?, srd_text = ?, form_structure = NULL, status = 'Not Tested', last_tested = 'Never' WHERE id = ?",
        name,
        form_url || '',
        nextSrd,
        req.params.id
      )
    } else {
      await db.run(
        'UPDATE projects SET name = ?, form_url = ?, form_structure = NULL WHERE id = ?',
        name,
        form_url || '',
        req.params.id
      )
    }

    res.json({ success: true })

  } catch (err) {
    const msg = String(err?.message || 'Failed to update project')
    console.error('Update project error:', msg)
    if (msg.startsWith('Notion API error (') || msg.toLowerCase().includes('notion')) {
      return res.status(400).json({ error: msg })
    }
    res.status(500).json({ error: msg })
  }
})

app.delete('/api/projects/:id', requireAuth, async (req, res) => {
  try {
    const ownedProject = await ensureProjectOwner(req, res)
    if (!ownedProject) return

    const runs = await db.all('SELECT id FROM test_runs WHERE project_id = ?', req.params.id)
    for (const run of runs) {
      await db.run('DELETE FROM test_run_results WHERE run_id = ?', run.id)
    }
    await db.run('DELETE FROM test_runs WHERE project_id = ?', req.params.id)
    await db.run('DELETE FROM test_cases WHERE project_id = ?', req.params.id)
    await db.run('DELETE FROM projects WHERE id = ?', req.params.id)
    res.json({ success: true })
  } catch (err) {
    const msg = String(err?.message || 'Failed to delete project')
    console.error('Failed to delete project:', msg)
    // Surface FK constraint errors clearly.
    if (msg.toLowerCase().includes('foreign key') || msg.toLowerCase().includes('constraint')) {
      return res.status(409).json({ error: msg })
    }
    res.status(500).json({ error: msg })
  }
})

app.post('/api/projects/:id/generate', requireAuth, async (req, res) => {
  try {
    const ownedProject = await ensureProjectOwner(req, res)
    if (!ownedProject) return

    const project = await db.get(
      `
      SELECT id, user_id, name, form_url, form_structure, srd_text, status, last_tested, created_at
      FROM projects
      WHERE id = ?
    `,
      req.params.id
    )

    if (!project) {
      return res.status(404).json({ error: 'Project not found' })
    }
    if (!project.srd_text) {
      return res.status(400).json({ error: 'No SRD text found for this project' })
    }

    // Fix 2: Delete old test cases before inserting new ones
    await db.run('DELETE FROM test_cases WHERE project_id = ?', req.params.id)

    let formStructure = null
    if (project.form_structure) {
      try {
        formStructure = JSON.parse(project.form_structure)
      } catch {
        // Keep null form structure when saved JSON is malformed.
      }
    }

    const testCases = await generateTestCases(project.srd_text, formStructure)

    for (const tc of testCases) {
      const testType = ALLOWED_TEST_TYPES.includes(tc.test_type)
        ? tc.test_type
        : 'required_field'
      await db.run(
        'INSERT INTO test_cases (project_id, name, what_to_test, expected_result, test_type) VALUES (?, ?, ?, ?, ?)',
        req.params.id,
        tc.name,
        tc.what_to_test,
        tc.expected_result,
        testType
      )
    }

    // Fix 1: Update project status to In Progress
    await db.run(
      "UPDATE projects SET status = 'In Progress', last_tested = datetime('now') WHERE id = ?",
      req.params.id
    )

    res.json({ success: true, testCases })

  } catch (err) {
    console.error(err)
    const em = String(err?.message || '')
    if (em.includes('AI service is temporarily unavailable')) {
      return res.status(503).json({ error: em })
    }
    if (/Groq rate limit|daily tokens for this model/i.test(em)) {
      return res.status(429).json({ error: em })
    }
    res.status(500).json({ error: em })
  }
})

app.post('/api/projects/:id/analyse', requireAuth, async (req, res) => {
  let browser
  try {
    const ownedProject = await ensureProjectOwner(req, res)
    if (!ownedProject) return

    const project = await db.get(
      `
      SELECT id, user_id, name, form_url, form_structure, srd_text, status, last_tested, created_at
      FROM projects
      WHERE id = ?
    `,
      req.params.id
    )
    if (!project) {
      return res.status(404).json({ error: 'Project not found' })
    }

    browser = await launchChromiumBrowser()
    const page = await browser.newPage()

    await page.goto(project.form_url, { waitUntil: 'domcontentloaded' })
    const context = await waitForPortalFormReady(page)

    const extracted = await context.evaluate(() => {
      const getLabelText = (el) => {
        const id = el.id
        if (id) {
          const byFor = document.querySelector(`label[for="${id}"]`)
          if (byFor?.textContent?.trim()) return byFor.textContent.trim()
        }
        const wrappedLabel = el.closest('label')
        if (wrappedLabel?.textContent?.trim()) return wrappedLabel.textContent.trim()
        const aria = el.getAttribute('aria-label')
        if (aria) return aria.trim()
        return ''
      }

      const elements = Array.from(document.querySelectorAll('input, select, textarea, button'))
      const fields = []
      let submitButton = null

      for (const el of elements) {
        const tag = el.tagName.toLowerCase()
        const inputType = String(el.getAttribute('type') || '').toLowerCase()
        const isSubmit = (tag === 'button' && (inputType === '' || inputType === 'submit')) || inputType === 'submit'

        const id = el.id || ''
        const name = el.getAttribute('name') || ''
        const placeholder = el.getAttribute('placeholder') || ''
        const label = getLabelText(el)
        const required = el.hasAttribute('required') || el.getAttribute('aria-required') === 'true'
        const selector = id
          ? `#${id}`
          : name
            ? `${tag}[name="${name.replace(/"/g, '\\"')}"]`
            : ''

        if (isSubmit && !submitButton) {
          submitButton = { id, selector: selector || `${tag}[type="submit"]` }
          continue
        }

        const interactive =
          tag === 'textarea' ||
          tag === 'select' ||
          (tag === 'input' && !['hidden', 'submit', 'button', 'image', 'reset'].includes(inputType)) ||
          (tag === 'button' && !isSubmit)

        if (!interactive) continue

        fields.push({
          element: tag,
          type: inputType || (tag === 'select' ? 'select' : tag),
          id,
          name,
          placeholder,
          label,
          required,
          selector
        })
      }

      return { fields, submitButton }
    })

    const aiStructure = await analyzeFormStructure([
      ...extracted.fields,
      ...(extracted.submitButton ? [{ ...extracted.submitButton, type: 'submit' }] : [])
    ])

    const formStructure = {
      fields: Array.isArray(aiStructure?.fields) ? aiStructure.fields : extracted.fields,
      submitButton: aiStructure?.submitButton?.selector || aiStructure?.submitButton?.id
        ? aiStructure.submitButton
        : (extracted.submitButton || null)
    }

    await db.run(
      'UPDATE projects SET form_structure = ? WHERE id = ?',
      JSON.stringify(formStructure),
      req.params.id
    )

    return res.json({
      success: true,
      form_structure: formStructure,
      summary: `Found ${formStructure.fields.length} fields${formStructure.submitButton ? ' and a submit button' : ''}`
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: err.message || 'Failed to analyse form' })
  } finally {
    if (browser) await browser.close()
  }
})

app.get('/api/projects/:id/test_cases', requireAuth, async (req, res) => {
  const ownedProject = await ensureProjectOwner(req, res)
  if (!ownedProject) return

  const testCases = await db.all('SELECT * FROM test_cases WHERE project_id = ?', req.params.id)
  res.json(testCases)
})

/**
 * Derive field label from test name for any project — no per-form field lists.
 * Strips standard suffixes (… required test, … format validation test) and trailing context
 * (e.g. National ID / NIN) so "ID Number National ID format …" resolves to "ID Number".
 */
function inferFromTestNameAndType(name, testType) {
  const n = String(name || '').trim()
  if (!n || n.length > 220) return null
  if (/^(successful submit|widget auto-fill)\b/i.test(n)) return null
  if (/^attachment\b/i.test(n)) return null

  let head = n
  head = head.replace(/^test\s+(required\s+field|format\s+validation|optional\s+field|conditional\s+(required|display)|widget\s+auto\s+fill|attachment|disabled\s+field)\s*:\s*/i, '').trim()
  head = head.replace(/^(required|format|optional|conditional|widget|attachment|disabled)\s+(field|validation|display|required|auto\s+fill)\s*:\s*/i, '').trim()
  const tt = String(testType || '').toLowerCase()
  if (/\bformat_validation\b/.test(tt) || /\s+format\s+/i.test(head)) {
    const parts = head.split(/\s+format\s+/i)
    head = parts[0].trim()
  }
  head = head.replace(/\s+(age|format)\s+validation\s+test\s*$/i, '').trim()
  head = head.replace(/\s+when\s+.+/i, '').trim()
  head = head.replace(/\s+for\s+processing\s+office\s*$/i, '').trim()
  head = head.replace(/\s+required\s+field\s+test(\s+for\s+[^\s.]+)?\s*$/i, '').trim()
  head = head.replace(/\s+optional\s+field\s+test(\s+for\s+[^\s.]+)?\s*$/i, '').trim()
  head = head.replace(/\s+required\s+test\s*$/i, '').trim()
  head = head.replace(/\s+optional\s+test\s*$/i, '').trim()
  head = head.replace(/\s+wrong\s+format\s+test\s*$/i, '').trim()
  head = head.replace(/\s+size\s+test\s*$/i, '').trim()
  head = head.replace(/\s+display\s+test\s*$/i, '').trim()
  head = head.replace(/\s+for\s+(national id|nin|citizen application number)\s*$/i, '').trim()
  head = head.replace(/\s+(national id|nin|citizen application number)\s*$/i, '').trim()
  head = head.replace(/\s+field\s+test\s*$/i, '').trim()
  head = head.replace(/\s+test\s*$/i, '').trim()
  head = head.replace(/\s+required\s+field\s*$/i, '').trim()
  head = head.replace(/\s+optional\s+field\s*$/i, '').trim()

  head = head
    .replace(/\s+(required|invalid|missing|more\s+than|too\s+long|less\s+than|invalid\s+email|invalid\s+phone|invalid\s+format)\b.*$/i, '')
    .trim()
  head = head.replace(/\s+error\s*$/i, '').trim()
  head = trimLeadingArticles(head)

  if (head.length < 2 || head.length > 120) return null
  return {
    field_label: head,
    field_name: head.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_]/g, '')
  }
}

/** Strip a trailing word "field" from "ID Type field" → "ID Type". */
function trimFieldWordSuffix(label) {
  return String(label || '')
    .trim()
    .replace(/\s+field\s*$/i, '')
    .trim()
}

/** "the First Name" / "a National ID" → "First Name" / "National ID" for DOM matching. */
function trimLeadingArticles(label) {
  return String(label || '')
    .trim()
    .replace(/^(the|a|an)\s+/i, '')
    .trim()
}

function cleanInferredLabel(label) {
  return trimLeadingArticles(trimFieldWordSuffix(String(label || '').trim()))
}

function inferFromWhatToTest(what) {
  const w = String(what || '').trim()
  if (!w) return null
  const mLeaveEmpty = w.match(/\bleave\s+(.+?)\s+field\s+empty\b/i)
  if (mLeaveEmpty?.[1]) {
    const label = cleanInferredLabel(mLeaveEmpty[1])
    if (label.length > 0 && label.length < 120) {
      return {
        field_label: label,
        field_name: label.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_]/g, '')
      }
    }
  }
  const mEnterInField = w.match(/\b(?:enter|put)\s+.+?\s+in\s+(?:the|a|an)\s+(.+?)\s+field\b/i)
  if (mEnterInField?.[1]) {
    const label = cleanInferredLabel(mEnterInField[1])
    if (label.length > 0 && label.length < 120) {
      return {
        field_label: label,
        field_name: label.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_]/g, '')
      }
    }
  }
  const mFieldWith = w.match(/^(.+?)\s+field\s+with\b/i)
  if (mFieldWith?.[1]) {
    const label = cleanInferredLabel(String(mFieldWith[1]).trim())
    if (label.length > 0 && label.length < 120) {
      return {
        field_label: label,
        field_name: label.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_]/g, '')
      }
    }
  }
  const mFieldReq = w.match(/^(.+?)\s+field\s+is\s+required\b/i)
  if (mFieldReq?.[1]) {
    const label = cleanInferredLabel(mFieldReq[1])
    if (label.length > 0 && label.length < 120) {
      return {
        field_label: label,
        field_name: label.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_]/g, '')
      }
    }
  }
  const mFieldOpt = w.match(/^(.+?)\s+field\s+is\s+optional\b/i)
  if (mFieldOpt?.[1]) {
    const label = cleanInferredLabel(mFieldOpt[1])
    if (label.length > 0 && label.length < 120) {
      return {
        field_label: label,
        field_name: label.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_]/g, '')
      }
    }
  }
  return null
}

function inferFieldLabelAndName(testCase) {
  const what = String(testCase?.what_to_test || '')
  const name = String(testCase?.name || '')
  const expected = String(testCase?.expected_result || '')
  const joined = `${name} ${what} ${expected}`

  const quoted = joined.match(/"([^"]+)"/)
  if (quoted?.[1]) {
    const label = cleanInferredLabel(String(quoted[1]).trim())
    return {
      field_label: label,
      field_name: label.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_]/g, '')
    }
  }

  const fromWhatPhrase = inferFromWhatToTest(what)
  if (fromWhatPhrase) return fromWhatPhrase

  const fromGenericName = inferFromTestNameAndType(name, testCase?.test_type)
  if (fromGenericName?.field_label) return fromGenericName

  const subject = name.match(/^(.+?)\s+(required|optional|format|validation|test)/i)
  if (subject?.[1]) {
    const label = cleanInferredLabel(String(subject[1]).trim())
    return {
      field_label: label,
      field_name: label.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_]/g, '')
    }
  }

  const fromWhat = what.match(/(?:leave|enter|set|fill|clear)\s+(.+?)\s+(?:empty|with|to|and)/i)
  if (fromWhat?.[1]) {
    const label = cleanInferredLabel(String(fromWhat[1]).trim())
    return {
      field_label: label,
      field_name: label.replace(/\s+/g, '').replace(/[^a-zA-Z0-9_]/g, '')
    }
  }

  return { field_label: '', field_name: '' }
}

app.get('/api/projects/:id/extension-test-cases', requireAuth, async (req, res) => {
  try {
    const ownedProject = await ensureProjectOwner(req, res)
    if (!ownedProject) return

    const rows = await db.all(
      `
      SELECT id, name, test_type, what_to_test, expected_result
      FROM test_cases
      WHERE project_id = ?
      ORDER BY id ASC
      `,
      req.params.id
    )

    const formatted = rows.map(tc => {
      const inferred = inferFieldLabelAndName(tc)
      return {
        id: tc.id,
        name: tc.name,
        test_type: tc.test_type || 'required_field',
        what_to_test: tc.what_to_test || '',
        expected_result: tc.expected_result || '',
        field_label: inferred.field_label,
        field_name: inferred.field_name
      }
    })

    return res.json(formatted)
  } catch (err) {
    console.error('extension-test-cases error:', err)
    return res.status(500).json({ error: err.message || 'Failed to fetch extension test cases' })
  }
})

app.post('/api/projects/:id/extension-run', requireAuth, async (req, res) => {
  try {
    const ownedProject = await ensureProjectOwner(req, res)
    if (!ownedProject) return

    const rawResults = Array.isArray(req.body?.results) ? req.body.results : []
    if (rawResults.length === 0) {
      return res.status(400).json({ error: 'results array is required' })
    }

    const testCases = await db.all(
      'SELECT id FROM test_cases WHERE project_id = ?',
      req.params.id
    )
    const caseIds = new Set(testCases.map(tc => Number(tc.id)))

    const normalized = rawResults
      .map(item => ({
        id: Number(item?.id || 0),
        name: String(item?.name || ''),
        passed: Boolean(item?.passed),
        notes: String(item?.notes || ''),
        screenshotDataUrl: String(item?.screenshotDataUrl || '')
      }))
      .filter(item => caseIds.has(item.id))

    if (normalized.length === 0) {
      return res.status(400).json({ error: 'No valid project test case results found in payload' })
    }

    const persistPayload = normalized.map(r => ({
      id: r.id,
      name: r.name,
      passed: r.passed,
      notes: r.notes,
      screenshotPath: null
    }))

    const { runId } = await persistRunResults(req.params.id, persistPayload)

    for (const result of normalized) {
      let notes = result.notes
      let screenshotPath = null
      if (result.screenshotDataUrl) {
        screenshotPath = saveExtensionScreenshot(runId, result.id, result.screenshotDataUrl)
        if (screenshotPath) {
          notes = `${notes}${notes ? '\n' : ''}Screenshot: ${screenshotPath}`
        }
      }

      const status = result.passed ? 'Passed' : (String(result.notes || '').toLowerCase().startsWith('skipped:') ? 'Skipped' : 'Failed')
      await db.run(
        'UPDATE test_cases SET status = ?, notes = ? WHERE id = ?',
        status,
        notes,
        result.id
      )
      await db.run(
        'UPDATE test_run_results SET status = ?, notes = ?, screenshot_path = ? WHERE run_id = ? AND test_case_id = ?',
        status,
        notes,
        screenshotPath,
        runId,
        result.id
      )
    }

    return res.json({ ok: true, runId: Number(runId) })
  } catch (err) {
    console.error('extension-run error:', err)
    return res.status(500).json({ error: err.message || 'Failed to save extension run results' })
  }
})

app.get('/api/projects/:id/export/testcases', requireAuth, async (req, res) => {
  try {
    const ownedProject = await ensureProjectOwner(req, res)
    if (!ownedProject) return

    const projectId = req.params.id
    const project = await db.get('SELECT id, name FROM projects WHERE id = ?', projectId)

    if (!project) {
      return res.status(404).json({ error: 'Project not found' })
    }

    const testCases = await db.all(
      `
      SELECT name, what_to_test, expected_result, test_type, status
      FROM test_cases
      WHERE project_id = ?
      ORDER BY id ASC
    `,
      projectId
    )
    const runsCountRow = await db.get(
      'SELECT COUNT(*) AS total_runs FROM test_runs WHERE project_id = ?',
      projectId
    )
    const totalRuns = Number(runsCountRow?.total_runs || 0)
    const passedCount = testCases.filter(tc => tc.status === 'Passed').length
    const failedCount = testCases.filter(tc => tc.status === 'Failed').length

    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Test Cases')

    worksheet.mergeCells('A1:F1')
    const titleCell = worksheet.getCell('A1')
    titleCell.value = `${project.name || 'Project'} - Test Cases Report`
    titleCell.font = {
      name: 'Arial',
      size: 16,
      bold: true,
      color: { argb: 'FF00448E' }
    }
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' }

    worksheet.mergeCells('A2:F2')
    const statsCell = worksheet.getCell('A2')
    statsCell.value = `Runs: ${totalRuns} | Passed: ${passedCount} | Failed: ${failedCount}`
    statsCell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF1F2937' } }
    statsCell.alignment = { horizontal: 'left', vertical: 'middle' }

    const headerRow = worksheet.getRow(3)
    headerRow.values = ['#', 'Test Case Name', 'What to Test', 'Expected Result', 'Type', 'Status']
    headerRow.height = 22
    headerRow.eachCell((cell) => {
      cell.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00448E' } }
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      }
    })

    const toPlainType = (type) => {
      if (type === 'required_field') return 'Required Field'
      if (type === 'format_validation') return 'Format Validation'
      if (type === 'successful_submit') return 'Successful Submit'
      if (type === 'conditional_field') return 'Conditional Field'
      if (type === 'conditional_required') return 'Conditional Required'
      if (type === 'conditional_display') return 'Conditional Display'
      if (type === 'widget_auto_fill') return 'Widget Auto Fill'
      if (type === 'attachment') return 'Attachment'
      if (type === 'label_check') return 'Label Check'
      return 'Required Field'
    }

    for (let i = 0; i < testCases.length; i += 1) {
      const tc = testCases[i]
      const row = worksheet.addRow([
        i + 1,
        tc.name || '',
        tc.what_to_test || '',
        tc.expected_result || '',
        toPlainType(tc.test_type),
        tc.status || 'Not Run'
      ])

      row.eachCell((cell) => {
        cell.font = { name: 'Arial', size: 11 }
        cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true }
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        }
      })

      const normalizedStatus = String(tc.status || '').toLowerCase()
      if (normalizedStatus === 'passed') {
        row.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } }
        })
      } else if (normalizedStatus === 'failed') {
        row.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEBEE' } }
        })
      }
    }

    worksheet.columns = [
      { width: 6 },
      { width: 32 },
      { width: 42 },
      { width: 42 },
      { width: 22 },
      { width: 14 }
    ]

    const safeProjectName = String(project.name || 'Project')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .trim() || 'Project'
    const fileName = `${safeProjectName} Test Cases.xlsx`

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)

    await workbook.xlsx.write(res)
    res.end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to export test cases' })
  }
})

// Edit a test case
app.put('/api/test_cases/:id', requireAuth, async (req, res) => {
  try {
    const ownedTestCase = await ensureTestCaseOwner(req, res)
    if (!ownedTestCase) return

    const { name, what_to_test, expected_result, test_type } = req.body

    if (!name || !what_to_test || !expected_result) {
      return res.status(400).json({ error: 'All fields are required' })
    }

    const safeTestType = ALLOWED_TEST_TYPES.includes(test_type)
      ? test_type
      : 'required_field'
    await db.run(
      'UPDATE test_cases SET name = ?, what_to_test = ?, expected_result = ?, test_type = ? WHERE id = ?',
      name,
      what_to_test,
      expected_result,
      safeTestType,
      req.params.id
    )

    res.json({ success: true, message: 'Test case updated' })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Delete a test case
app.delete('/api/test_cases/:id', requireAuth, async (req, res) => {
  try {
    const ownedTestCase = await ensureTestCaseOwner(req, res)
    if (!ownedTestCase) return

    await db.run('DELETE FROM test_cases WHERE id = ?', req.params.id)
    res.json({ success: true, message: 'Test case deleted' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Run tests with Playwright
app.post('/api/projects/:id/run', requireAuth, async (req, res) => {
  try {
    const ownedProject = await ensureProjectOwner(req, res)
    if (!ownedProject) return

    const projectId = req.params.id
    const results = await runTests(projectId)
    const { runId } = await persistRunResults(projectId, results)
    res.json({ success: true, runId, results })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/projects/:id/runs/latest-comparison', requireAuth, async (req, res) => {
  try {
    const ownedProject = await ensureProjectOwner(req, res)
    if (!ownedProject) return

    const projectId = req.params.id

    const runs = await db.all(
      'SELECT * FROM test_runs WHERE project_id = ? ORDER BY id DESC LIMIT 2',
      projectId
    )

    const emptyCounts = {
      fixed: 0,
      still_failing: 0,
      newly_broken: 0,
      still_passing: 0,
      new_test_case: 0
    }

    const emptyGroups = {
      fixed: [],
      still_failing: [],
      newly_broken: [],
      still_passing: [],
      new_test_case: []
    }

    if (runs.length === 0) {
      return res.json({
        current_run: null,
        previous_run: null,
        counts: emptyCounts,
        groups: emptyGroups,
        summary_text: 'No runs yet.'
      })
    }

    if (runs.length === 1) {
      return res.json({
        current_run: runs[0],
        previous_run: null,
        counts: emptyCounts,
        groups: emptyGroups,
        summary_text: 'Only one run exists. No comparison yet.'
      })
    }

    const currentRun = runs[0]
    const previousRun = runs[1]

    const currentResults = await db.all('SELECT * FROM test_run_results WHERE run_id = ?', currentRun.id)
    const previousResults = await db.all('SELECT * FROM test_run_results WHERE run_id = ?', previousRun.id)

    const prevByCase = new Map(previousResults.map(r => [r.test_case_id, r]))

    const groups = {
      fixed: [],
      still_failing: [],
      newly_broken: [],
      still_passing: [],
      new_test_case: [],
      removed_test_case: []
    }

    const currentCaseIds = new Set(currentResults.map(r => r.test_case_id))

    for (const cur of currentResults) {
      const prev = prevByCase.get(cur.test_case_id)
      if (!prev) groups.new_test_case.push(cur)
      else if (prev.status === 'Failed' && cur.status === 'Passed') groups.fixed.push(cur)
      else if (prev.status === 'Failed' && cur.status === 'Failed') groups.still_failing.push(cur)
      else if (prev.status === 'Passed' && cur.status === 'Failed') groups.newly_broken.push(cur)
      else groups.still_passing.push(cur)
    }

    for (const prev of previousResults) {
      if (!currentCaseIds.has(prev.test_case_id)) {
        groups.removed_test_case.push(prev)
      }
    }

    const counts = {
      fixed: groups.fixed.length,
      still_failing: groups.still_failing.length,
      newly_broken: groups.newly_broken.length,
      still_passing: groups.still_passing.length,
      new_test_case: groups.new_test_case.length,
      removed_test_case: groups.removed_test_case.length
    }

    const summary_text = `Compared to previous run: ${counts.fixed} fixed, ${counts.still_failing} still failing, ${counts.newly_broken} newly broken, ${counts.removed_test_case} removed.`

    res.json({
      current_run: currentRun,
      previous_run: previousRun,
      counts,
      groups,
      summary_text
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/projects/:id/runs/:runId/export.xlsx', requireAuth, async (req, res) => {
  try {
    const ownedProject = await ensureProjectOwner(req, res)
    if (!ownedProject) return

    const { id: projectId, runId } = req.params
    const run = await db.get('SELECT * FROM test_runs WHERE id = ? AND project_id = ?', runId, projectId)

    if (!run) {
      return res.status(404).json({ error: 'Run not found for this project' })
    }

    const results = await db.all(
      'SELECT * FROM test_run_results WHERE run_id = ? ORDER BY id ASC',
      runId
    )

    const latestTwo = await db.all(
      'SELECT * FROM test_runs WHERE project_id = ? ORDER BY id DESC LIMIT 2',
      projectId
    )

    let comparisonSummary = 'No previous run to compare.'
    if (latestTwo.length >= 2 && Number(latestTwo[0].id) === Number(runId)) {
      const currentResults = results
      const previousResults = await db.all(
        'SELECT * FROM test_run_results WHERE run_id = ?',
        latestTwo[1].id
      )
      const prevByCase = new Map(previousResults.map(r => [r.test_case_id, r]))
      const currentCaseIds = new Set(currentResults.map(r => r.test_case_id))

      let fixed = 0
      let stillFailing = 0
      let newlyBroken = 0
      let stillPassing = 0
      let newCase = 0
      let removedCase = 0

      for (const cur of currentResults) {
        const prev = prevByCase.get(cur.test_case_id)
        if (!prev) newCase += 1
        else if (prev.status === 'Failed' && cur.status === 'Passed') fixed += 1
        else if (prev.status === 'Failed' && cur.status === 'Failed') stillFailing += 1
        else if (prev.status === 'Passed' && cur.status === 'Failed') newlyBroken += 1
        else stillPassing += 1
      }

      for (const prev of previousResults) {
        if (!currentCaseIds.has(prev.test_case_id)) removedCase += 1
      }

      comparisonSummary =
        `fixed=${fixed}, still_failing=${stillFailing}, newly_broken=${newlyBroken}, ` +
        `still_passing=${stillPassing}, new_test_case=${newCase}, removed_test_case=${removedCase}`
    }

    const runSummarySheet = [
      { key: 'project_id', value: run.project_id },
      { key: 'run_id', value: run.id },
      { key: 'run_started_at', value: run.run_started_at },
      { key: 'run_finished_at', value: run.run_finished_at },
      { key: 'project_status', value: run.project_status },
      { key: 'comparison_summary', value: comparisonSummary }
    ]

    const resultSheet = results.map(r => ({
      run_id: r.run_id,
      test_case_id: r.test_case_id,
      status: r.status,
      notes: r.notes,
      name: r.snapshot_name,
      what_to_test: r.snapshot_what_to_test,
      expected_result: r.snapshot_expected_result,
      expected_outcome: r.snapshot_expected_outcome || 'should_pass',
      test_type: r.snapshot_test_type,
      created_at: r.created_at
    }))

    const workbook = XLSX.utils.book_new()
    const summaryWorksheet = XLSX.utils.json_to_sheet(runSummarySheet)
    const resultsWorksheet = XLSX.utils.json_to_sheet(resultSheet)
    XLSX.utils.book_append_sheet(workbook, summaryWorksheet, 'Run Summary')
    XLSX.utils.book_append_sheet(workbook, resultsWorksheet, 'Test Results')

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
    const fileName = `project-${projectId}-run-${runId}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
    res.send(buffer)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Add a test case manually
app.post('/api/projects/:id/test_cases', requireAuth, async (req, res) => {
  try {
    const ownedProject = await ensureProjectOwner(req, res)
    if (!ownedProject) return

    const { name, what_to_test, expected_result, test_type } = req.body
    const project_id = req.params.id

    if (!name || !what_to_test || !expected_result) {
      return res.status(400).json({ error: 'All fields are required' })
    }

    const safeTestType = ALLOWED_TEST_TYPES.includes(test_type)
      ? test_type
      : 'required_field'
    const result = await db.run(
      'INSERT INTO test_cases (project_id, name, what_to_test, expected_result, test_type) VALUES (?, ?, ?, ?, ?)',
      project_id,
      name,
      what_to_test,
      expected_result,
      safeTestType
    )

    res.json({ success: true, id: result.lastInsertRowid })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

const distDir = path.join(__dirname, 'dist')
const distIndex = path.join(distDir, 'index.html')
const testFormPath = path.join(__dirname, 'testform.html')
const uploadsPublicDir = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, 'uploads')

if (fs.existsSync(uploadsPublicDir)) {
  app.use('/uploads', express.static(uploadsPublicDir))
}

if (fs.existsSync(distIndex)) {
  app.use(express.static(distDir))
  app.get('/testform.html', (req, res) => {
    res.sendFile(testFormPath)
  })
  // Express 5 / path-to-regexp: bare '*' is invalid; use middleware SPA fallback instead of app.get('*')
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (req.path.startsWith('/api')) return next()
    const ext = path.extname(req.path)
    if (ext !== '' && ext !== '.html') return next()
    res.sendFile(distIndex, err => {
      if (err) next(err)
    })
  })
} else {
  app.use(express.static('.'))
  console.warn('No dist/index.html — run `npm run build` to serve the React app from this server (dev UI: npm run dev).')
}

await dbReady

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
server.on('error', err => {
  console.error('Server failed to start:', err.message)
  process.exit(1)
})