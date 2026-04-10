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
app.use(express.json())

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
    const name = req.body?.name
    const form_url = req.body?.form_url

    if (!name || !form_url) {
      return res.status(400).json({ error: 'Name and URL are required' })
    }

    if (!req.file) {
      return res.status(400).json({ error: 'SRD document is required' })
    }

    const srdText = await extractText(req.file.path)
    console.log('Extracted text:', srdText)

    const result = await db.run(
      'INSERT INTO projects (user_id, name, form_url, srd_text) VALUES (?, ?, ?, ?)',
      req.user.id,
      name,
      form_url,
      srdText
    )

    res.json({ success: true, id: result.lastInsertRowid })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Edit a project (name, form_url, and optionally a new SRD)
app.put('/api/projects/:id', requireAuth, upload.single('srd'), async (req, res) => {
  try {
    const ownedProject = await ensureProjectOwner(req, res)
    if (!ownedProject) return

    const { name, form_url } = req.body

    if (!name || !form_url) {
      return res.status(400).json({ error: 'Name and URL are required' })
    }

    // If a new SRD file was uploaded, extract its text, clear old test cases and reset status
    if (req.file) {
      const srdText = await extractText(req.file.path)
      await db.run('DELETE FROM test_cases WHERE project_id = ?', req.params.id)
      await db.run(
        "UPDATE projects SET name = ?, form_url = ?, srd_text = ?, form_structure = NULL, status = 'Not Tested', last_tested = 'Never' WHERE id = ?",
        name,
        form_url,
        srdText,
        req.params.id
      )
    } else {
      await db.run(
        'UPDATE projects SET name = ?, form_url = ?, form_structure = NULL WHERE id = ?',
        name,
        form_url,
        req.params.id
      )
    }

    res.json({ success: true })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
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
    console.error('Failed to delete project:', err)
    res.status(500).json({ error: err.message || 'Failed to delete project' })
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
      const testType = ['required_field', 'format_validation', 'successful_submit'].includes(tc.test_type)
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
    if (String(err?.message || '').includes('AI service is temporarily unavailable')) {
      return res.status(503).json({ error: err.message })
    }
    res.status(500).json({ error: err.message })
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

    const safeTestType = ['required_field', 'format_validation', 'successful_submit'].includes(test_type)
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
    const runStartedAt = new Date().toISOString()

    // 1) Run Playwright tests (existing function)
    const results = await runTests(projectId)

    const runFinishedAt = new Date().toISOString()
    const allPassed = results.every(r => r.passed)
    const projectStatus = allPassed ? 'Passed' : 'Failed'

    // 2) Save one run row
    const runInsert = await db.run(
      'INSERT INTO test_runs (project_id, run_started_at, run_finished_at, project_status) VALUES (?, ?, ?, ?)',
      projectId,
      runStartedAt,
      runFinishedAt,
      projectStatus
    )

    const runId = runInsert.lastInsertRowid

    // 3) Load current test cases for snapshots
    const cases = await db.all(
      'SELECT id, name, what_to_test, expected_result, test_type FROM test_cases WHERE project_id = ?',
      projectId
    )

    const byId = new Map(cases.map(tc => [tc.id, tc]))

    // 4) Save one result row per executed test case
    for (const r of results) {
      const tc = byId.get(r.id)
      if (!tc) continue

      await db.run(
        `
      INSERT INTO test_run_results
      (run_id, test_case_id, status, notes, snapshot_name, snapshot_what_to_test, snapshot_expected_result, snapshot_test_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
        runId,
        r.id,
        r.passed ? 'Passed' : 'Failed',
        r.notes || '',
        tc.name,
        tc.what_to_test,
        tc.expected_result,
        tc.test_type || 'required_field'
      )
    }

    // 5) Return old + new data
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

    const safeTestType = ['required_field', 'format_validation', 'successful_submit'].includes(test_type)
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