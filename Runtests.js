import { chromium } from 'playwright'
import db from './db.js'
import { validateManualTestCase } from './ai.js'

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function inferFieldCategory(field) {
  const text = `${field?.label || ''} ${field?.name || ''} ${field?.id || ''} ${field?.type || ''}`.toLowerCase()
  if (text.includes('email')) return 'email'
  if (text.includes('phone') || text.includes('tel')) return 'phone'
  if (text.includes('date') || field?.type === 'date') return 'date'
  if (text.includes('id')) return 'id'
  if (text.includes('name')) return 'name'
  return 'text'
}

function validValueFor(field) {
  const category = inferFieldCategory(field)
  if (category === 'email') return 'qa@example.com'
  if (category === 'phone') return '0781234567'
  if (category === 'date') return '1995-05-15'
  if (category === 'id') return '1199880012345678'
  if (category === 'name') return 'John'
  return 'Sample Value'
}

function invalidValueFor(field) {
  const category = inferFieldCategory(field)
  if (category === 'email') return 'not-an-email'
  if (category === 'phone') return 'abc'
  if (category === 'date') return 'invalid-date'
  if (category === 'id') return '9999999999999999'
  return '!!!'
}

async function openAndPrepareForm(page, project) {
  await page.goto(project.form_url, { waitUntil: 'domcontentloaded' })
  return waitForPortalFormReady(page)
}

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
    } catch {}
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

async function fillField(context, field, value) {
  const selector = String(field?.selector || '').trim()
  if (!selector || selector.startsWith('field_')) return false
  const locator = context.locator(selector).first()
  if (!(await locator.count())) return false

  const type = String(field?.type || '').toLowerCase()
  if (type === 'checkbox') {
    if (value === true) await locator.check().catch(() => {})
    return true
  }
  if (type === 'radio') {
    await locator.check().catch(() => {})
    return true
  }
  if (type === 'select' || type === 'select-one') {
    const options = locator.locator('option')
    const optionCount = await options.count()
    if (optionCount > 1) {
      const target = await options.nth(1).getAttribute('value')
      if (target) await locator.selectOption(target).catch(() => {})
    }
    return true
  }

  await locator.fill(String(value)).catch(() => {})
  return true
}

async function clickSubmit(page, submitButton) {
  const selector = String(submitButton?.selector || '').trim()
  if (selector) {
    const button = page.locator(selector).first()
    if (await button.count()) {
      await button.click()
      return
    }
  }

  const fallback = page.locator('#submitBtn, button[type="submit"], input[type="submit"], button:has-text("Submit")').first()
  if (await fallback.count()) {
    await fallback.click()
    return
  }

  throw new Error('Submit button not found')
}

async function hasErrorEvidence(context) {
  const selectors = [
    '[aria-invalid="true"]',
    '[role="alert"]',
    '.error',
    '.error-msg',
    '[class*="error"]'
  ]

  for (const s of selectors) {
    const count = await context.locator(s).count()
    if (count > 0) return true
  }

  const redTextCount = await context.locator('*').evaluateAll((nodes) =>
    nodes.filter((n) => {
      const style = window.getComputedStyle(n)
      const text = (n.textContent || '').trim()
      return text && (style.color.includes('rgb(255') || style.color.includes('red'))
    }).length
  )
  return redTextCount > 0
}

async function hasSuccessEvidence(context, beforeUrl) {
  const successCount = await context.locator(
    '#successMsg, .success, [class*="success"], [role="status"], text=/success|submitted|completed/i'
  ).count()
  if (successCount > 0) return true
  if (context.url() !== beforeUrl) return true
  const formCount = await context.locator('form').count()
  return formCount === 0
}

async function runTests(projectId) {
  // Get project and its test cases
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)
  const testCases = db.prepare('SELECT * FROM test_cases WHERE project_id = ?').all(projectId)

  if (!project) throw new Error('Project not found')
  if (testCases.length === 0) throw new Error('No test cases found')

  const browser = await chromium.launch({ headless: false }) // headless: false so you can watch it
  const page = await browser.newPage()
  const formStructure = safeJsonParse(project.form_structure, { fields: [], submitButton: null })
  const fields = Array.isArray(formStructure?.fields) ? formStructure.fields : []
  const requiredFields = fields.filter(f => Boolean(f?.required))
  const formatFields = fields.filter(f => ['email', 'tel', 'number', 'date'].includes(String(f?.type || '').toLowerCase()) || inferFieldCategory(f) !== 'text')

  const results = []

  for (const tc of testCases) {
    try {
      let testTypeRaw = tc.test_type
      const shouldValidateWithAi = !tc.test_type || tc.test_type === 'required_field'

      if (shouldValidateWithAi) {
        const validation = await validateManualTestCase({
          name: tc.name,
          what_to_test: tc.what_to_test,
          expected_result: tc.expected_result,
          srd_text: project.srd_text
        })

        if (!validation.valid) {
          const invalidNote = `Failed: invalid test case (${validation.reason})`
          db.prepare("UPDATE test_cases SET status = ?, notes = ? WHERE id = ?")
            .run('Failed', invalidNote, tc.id)
          results.push({ id: tc.id, name: tc.name, passed: false, notes: invalidNote })
          continue
        }

        testTypeRaw = validation.test_type
      }

      const context = await openAndPrepareForm(page, project)

      let passed = false
      let notes = ''

      const testType = ['required_field', 'format_validation', 'successful_submit'].includes(testTypeRaw)
        ? testTypeRaw
        : 'required_field'

      // --- required_field tests ---
      if (testType === 'required_field') {
        for (const f of fields) {
          if (!requiredFields.some(rf => rf.selector === f.selector)) {
            await fillField(context, f, validValueFor(f))
          }
        }

        await clickSubmit(context, formStructure?.submitButton)
        await page.waitForTimeout(500)

        const errorVisible = await hasErrorEvidence(context)
        passed = requiredFields.length > 0 ? errorVisible : errorVisible
        notes = passed
          ? 'Passed: required fields were validated and error messages appeared.'
          : 'Failed: expected required-field errors after submit, but none appeared.'
      }

      // --- format_validation tests ---
      else if (testType === 'format_validation') {
        for (const f of fields) {
          await fillField(context, f, validValueFor(f))
        }

        const target = formatFields[0] || fields.find(f => inferFieldCategory(f) !== 'text')
        if (target) {
          await fillField(context, target, invalidValueFor(target))
        }

        await clickSubmit(context, formStructure?.submitButton)
        await page.waitForTimeout(500)

        const formatErrorVisible = await hasErrorEvidence(context)
        passed = formatErrorVisible
        notes = passed
          ? 'Passed: invalid format was rejected and an error appeared.'
          : 'Failed: expected a format validation error, but none appeared.'
      }

      // --- successful_submit tests ---
      else if (testType === 'successful_submit') {
        for (const f of fields) {
          await fillField(context, f, validValueFor(f))
        }
        const beforeUrl = context.url()
        await clickSubmit(context, formStructure?.submitButton)
        await page.waitForTimeout(500)

        const successVisible = await hasSuccessEvidence(context, beforeUrl)
        passed = successVisible
        notes = passed
          ? 'Passed: form submitted successfully with valid inputs.'
          : 'Failed: expected success message after valid submit, but it did not appear.'
      }

      else {
        // Shouldn't happen due to validation above, but keep a safe fallback.
        await clickSubmit(context, formStructure?.submitButton)
        await page.waitForTimeout(500)
        const errorVisible = await hasErrorEvidence(context)
        passed = errorVisible
        notes = passed
          ? 'Passed: fallback validation triggered.'
          : 'Failed: unsupported test type and no validation evidence was found.'
      }

      // Save result to database
      db.prepare(
        "UPDATE test_cases SET status = ?, notes = ? WHERE id = ?"
      ).run(passed ? 'Passed' : 'Failed', notes, tc.id)

      results.push({ id: tc.id, name: tc.name, passed, notes })

    } catch (err) {
      const errorNote = `Failed: runtime error while executing test (${err.message})`
      db.prepare("UPDATE test_cases SET status = ?, notes = ? WHERE id = ?")
        .run('Failed', errorNote, tc.id)
      results.push({ id: tc.id, name: tc.name, passed: false, notes: errorNote })
    }
  }

  await browser.close()

  // Update project status based on results
  const allPassed = results.every(r => r.passed)
  const anyFailed = results.some(r => !r.passed)
  const newStatus = allPassed ? 'Passed' : anyFailed ? 'Failed' : 'In Progress'

  db.prepare(
    "UPDATE projects SET status = ?, last_tested = datetime('now') WHERE id = ?"
  ).run(newStatus, projectId)

  return results
}

export default runTests