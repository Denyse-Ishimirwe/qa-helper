import Groq from 'groq-sdk'
import { launchChromiumBrowser } from './playwright-launch.js'
import 'dotenv/config'
import db from './db.js'
import fs from 'node:fs'
import path from 'node:path'

// ─── Logging ─────────────────────────────────────────────────────────────────

function testLog(line) {
  console.log(`[TEST] ${line}`)
}

// ─── AI validation — ONLY for manually added test cases ──────────────────────
// AI-generated test cases already have a test_type — skip validation for them

async function validateManualTestCase({ name, what_to_test, expected_result }) {
  const key = process.env.GROQ_API_KEY
  if (!key) return { valid: false, test_type: 'required_field', reason: 'GROQ_API_KEY not set' }

  const groq = new Groq({ apiKey: key })
  const content = `
You are a strict QA validator. A tester manually wrote this test case for a registration form:
Name: ${name}
What to test: ${what_to_test}
Expected result: ${expected_result}

Return JSON only — no other text:
{ "valid": true, "test_type": "required_field", "reason": "explanation" }

Rules:
- Return valid: false if the test case is vague, nonsensical, contradicts itself, or cannot be automated by filling a form and clicking submit
- Return valid: true if it clearly describes a specific automatable form test
- test_type must be exactly one of: required_field, format_validation, successful_submit
- required_field: tests that an error appears when a required field is left empty
- format_validation: tests that an error appears when a field has wrong format (e.g. wrong ID number)
- successful_submit: tests that the form submits successfully when all fields are correct
`.trim()

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content }]
    })
    const response = completion.choices?.[0]?.message?.content || '{}'
    const cleaned = response.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(cleaned)
    const valid = Boolean(parsed?.valid)
    const rawType = String(parsed?.test_type || '')
    const test_type = ['required_field', 'format_validation', 'successful_submit'].includes(rawType)
      ? rawType : 'required_field'
    const reason = String(parsed?.reason || '').trim() || (valid ? 'Valid test case' : 'Invalid test case')
    return { valid, test_type, reason }
  } catch {
    // If AI validation fails, allow the test to run rather than blocking it
    return { valid: true, test_type: 'required_field', reason: 'AI validation unavailable — running as required_field' }
  }
}

// ─── Known form fields ────────────────────────────────────────────────────────

const KNOWN_FIELDS = [
  {
    selector: '#firstName',
    optional: true,
    type: 'text',
    label: 'First Name',
    keywords: ['first name', 'firstname'],
    validValue: 'John'
  },
  {
    selector: '#lastName',
    errorSelector: '#lastNameError',
    type: 'text',
    label: 'Last Name',
    keywords: ['last name', 'lastname'],
    validValue: 'Doe'
  },
  {
    selector: '#dob',
    errorSelector: '#dobError',
    formatErrorSelector: '#dobAgeError',
    type: 'date',
    label: 'Date of Birth',
    keywords: ['date of birth', 'dob', 'birth date', 'birth'],
    validValue: '1990-01-01'
  },
  {
    selector: '#gender',
    errorSelector: '#genderError',
    type: 'select',
    label: 'Gender',
    keywords: ['gender'],
    validValue: 'male'
  },
  {
    selector: '#nationality',
    errorSelector: '#nationalityError',
    type: 'text',
    label: 'Nationality',
    keywords: ['nationality'],
    validValue: 'Rwandan'
  },
  {
    selector: '#idNumber',
    errorSelector: '#idNumberError',
    formatErrorSelector: '#idNumberFormatError',
    type: 'text',
    label: 'ID Number',
    keywords: ['id number', 'national id', 'id no', 'id'],
    validValue: '1199880012345678',
    invalidValue: '9999999999999999'
  }
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeType(rawType) {
  const t = String(rawType || '').toLowerCase()
  return t || 'text'
}

function toNormalizedText(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-./]+/g, ' ')
    .replace(/[0-9]+/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function toTokenSet(value) {
  const base = toNormalizedText(value)
  if (!base) return []
  const parts = base.split(' ').filter(Boolean)
  const compact = base.replace(/\s+/g, '')
  return Array.from(new Set([...parts, compact]))
}

function guessValidValue(field) {
  if (field.validValue) return field.validValue
  const type = normalizeType(field.type)
  const labelText = `${field.label || ''} ${field.name || ''}`.toLowerCase()
  if (type === 'email' || labelText.includes('email')) return 'qa.tester@example.com'
  if (type === 'tel' || labelText.includes('phone') || labelText.includes('mobile')) return '0788123456'
  if (type === 'date' || labelText.includes('birth')) return '1990-01-01'
  if (type === 'number') return '10'
  if (type === 'select') return field.validValue || ''
  return 'SampleValue'
}

function guessInvalidValue(field) {
  if (field.invalidValue) return field.invalidValue
  const type = normalizeType(field.type)
  const labelText = `${field.label || ''} ${field.name || ''}`.toLowerCase()
  if (type === 'email' || labelText.includes('email')) return 'invalid-email'
  if (type === 'tel' || labelText.includes('phone') || labelText.includes('mobile')) return 'abc'
  if (type === 'number') return 'abc'
  if (type === 'date' || labelText.includes('birth')) return null
  return '!!!invalid!!!'
}

function deriveInvalidValueForTestCase(tc, field, fallbackValue) {
  const text = `${tc?.name || ''} ${tc?.what_to_test || ''} ${tc?.expected_result || ''}`.toLowerCase()
  const labelText = `${field?.label || ''} ${field?.name || ''}`.toLowerCase()
  const isIdLike = labelText.includes('id') || labelText.includes('identifier')

  if (text.includes('non-numeric') || text.includes('letters') || text.includes('alphabet')) {
    return 'ABCXYZ'
  }
  if (text.includes('special') || text.includes('symbol')) {
    return '@@@###'
  }
  if (text.includes('length') || text.includes('too short')) {
    return isIdLike ? '12345' : 'x'
  }
  if (text.includes('too long')) {
    return isIdLike ? '1234567890123456789012345' : 'xxxxxxxxxxxxxxxxxxxxxxxx'
  }
  if (isIdLike && String(fallbackValue || '').replace(/\D/g, '').length >= 10) {
    // Prefer clearly invalid alpha input for id-like fields unless test explicitly asks length.
    return 'ABC123XYZ'
  }
  return fallbackValue
}

async function fillAllFields(page, fields = KNOWN_FIELDS, options = {}) {
  const exclude = new Set(Array.isArray(options?.excludeSelectors) ? options.excludeSelectors : [])
  for (const f of fields) {
    if (exclude.has(f.selector)) continue
    try {
      const loc = page.locator(f.selector).first()
      const type = normalizeType(f.type)
      if (type === 'select') {
        const val = guessValidValue(f)
        if (val) {
          await loc.selectOption(val, { timeout: 700 })
        } else {
          // Pick first non-empty option for generic dropdowns.
          await loc.selectOption({ index: 1 }, { timeout: 700 }).catch(() => {})
        }
      } else if (type === 'radio' || type === 'checkbox') {
        await loc.check({ timeout: 700 }).catch(() => {})
      } else {
        await loc.fill(guessValidValue(f), { timeout: 700 })
      }
    } catch { /* field may not exist on this form */ }
  }
}

async function clearField(page, field) {
  try {
    const loc = page.locator(field.selector).first()
    const type = normalizeType(field.type)
    if (type === 'select') {
      await loc.selectOption('', { timeout: 700 })
    } else if (type === 'checkbox') {
      await loc.uncheck({ timeout: 700 }).catch(() => {})
    } else if (type === 'radio') {
      // Radios cannot always be programmatically "unchecked"; for required tests we
      // skip selecting this target radio in fillAllFields instead.
      return
    } else {
      await loc.fill('', { timeout: 700 })
    }
  } catch { /* ignore */ }
}

function matchFieldFromTestCaseInSet(tc, fields) {
  const text = toNormalizedText(`${tc.name || ''} ${tc.what_to_test || ''} ${tc.expected_result || ''}`)
  const tokens = new Set(toTokenSet(text))
  const quotedRaw = `${tc.name || ''} ${tc.what_to_test || ''} ${tc.expected_result || ''}`
  const quotedParts = Array.from(quotedRaw.matchAll(/"([^"]{2,80})"/g))
    .map(m => toNormalizedText(m[1]))
    .filter(Boolean)
  let best = null
  let bestScore = 0
  let bestLabel = ''
  for (const f of fields) {
    let score = 0
    const label = toNormalizedText(f.label || '')
    const name = toNormalizedText(f.name || '')
    const selector = toNormalizedText(f.selector || '')

    // Strong signal: quoted field names in test case text.
    for (const qp of quotedParts) {
      if (!qp) continue
      if (label && (qp === label || label.includes(qp) || qp.includes(label))) score += 12
      if (name && (qp === name || name.includes(qp) || qp.includes(name))) score += 10
      if (selector && selector.includes(qp)) score += 8
    }

    for (const kw of (f.keywords || [])) {
      const nk = toNormalizedText(kw)
      if (!nk) continue
      const kwTokens = toTokenSet(nk)
      for (const t of kwTokens) {
        if (tokens.has(t)) score += 2
      }
      if (text.includes(nk)) score += Math.max(1, nk.split(' ').length)
    }
    if (label && text.includes(label)) score += Math.max(2, label.split(' ').length)
    if (name && text.includes(name)) score += Math.max(1, name.split(' ').length)
    if (score > bestScore) {
      bestScore = score
      best = f
      bestLabel = f.label || f.name || f.selector || ''
    }
  }
  const confidence = bestScore >= 6 ? 'high' : bestScore >= 3 ? 'medium' : 'low'
  return {
    field: bestScore > 0 ? best : null,
    score: bestScore,
    confidence,
    matchedLabel: bestLabel
  }
}

async function discoverLiveFields(page) {
  const readOnce = async () => page.evaluate(() => {
    const normalizeText = (value) =>
      String(value || '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_\-./]+/g, ' ')
        .replace(/[0-9]+/g, ' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()

    const tokenSet = (value) => {
      const base = normalizeText(value)
      if (!base) return []
      const parts = base.split(' ').filter(Boolean)
      const compact = base.replace(/\s+/g, '')
      return Array.from(new Set([...parts, compact]))
    }

    const getLabel = (el) => {
      const id = el.id
      if (id) {
        const byFor = document.querySelector(`label[for="${id}"]`)
        if (byFor?.textContent?.trim()) return byFor.textContent.trim()
      }
      const wrapped = el.closest('label')
      if (wrapped?.textContent?.trim()) return wrapped.textContent.trim()
      return (el.getAttribute('aria-label') || '').trim()
    }

    const fields = []
    const nodes = Array.from(document.querySelectorAll('input, select, textarea'))
    for (const el of nodes) {
      const tag = el.tagName.toLowerCase()
      const inputType = String(el.getAttribute('type') || '').toLowerCase()
      if (tag === 'input' && ['hidden', 'submit', 'button', 'image', 'reset'].includes(inputType)) continue

      const id = el.id || ''
      const name = el.getAttribute('name') || ''
      const placeholder = el.getAttribute('placeholder') || ''
      const label = getLabel(el)
      const required = el.hasAttribute('required') || el.getAttribute('aria-required') === 'true'
      const selector = id
        ? `#${id}`
        : name
          ? `${tag}[name="${name.replace(/"/g, '\\"')}"]`
          : ''
      if (!selector) continue

      fields.push({
        selector,
        type: inputType || tag,
        label: label || name || id || tag,
        name,
        optional: !required,
        keywords: [label, name, id, placeholder]
          .flatMap(v => tokenSet(v))
      })
    }
    return fields
  })

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await readOnce()
      return Array.isArray(raw) ? raw : []
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase()
      const contextDestroyed =
        msg.includes('execution context was destroyed') ||
        msg.includes('cannot find context with specified id')
      if (!contextDestroyed || attempt === 2) {
        throw err
      }
      // The page navigated while evaluating; wait for next document and retry.
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
      await page.waitForTimeout(250)
    }
  }

  return []
}

function mergeFields(known, live) {
  const map = new Map()
  for (const f of [...known, ...live]) {
    if (!f?.selector) continue
    if (!map.has(f.selector)) map.set(f.selector, f)
    else map.set(f.selector, { ...map.get(f.selector), ...f })
  }
  return Array.from(map.values())
}

/** `<input type="date">` only accepts yyyy-mm-dd; "invalid" strings become empty → wrong errors. */
function resolveDobFormatValidation(tc) {
  const text = `${tc.name || ''} ${tc.what_to_test || ''} ${tc.expected_result || ''}`.toLowerCase()
  const mentionsUnderage =
    /under\s*18|under eighteen|minor|less than 18|below 18|too young|younger than 18|person is under/i.test(
      text
    )
  if (!mentionsUnderage) return null
  const d = new Date()
  d.setFullYear(d.getFullYear() - 10)
  return { invalidVal: d.toISOString().slice(0, 10), formatErrorSelector: '#dobAgeError' }
}

async function isVisible(page, selector) {
  try {
    const el = page.locator(selector).first()
    return await el.isVisible({ timeout: 200 })
  } catch {
    return false
  }
}

async function waitForPostSubmitSignals(page, selectors = [], timeoutMs = 1200) {
  const deadline = Date.now() + timeoutMs
  const unique = Array.from(new Set((selectors || []).filter(Boolean)))
  while (Date.now() < deadline) {
    for (const sel of unique) {
      if (await isVisible(page, sel)) return { selector: sel, seen: true }
    }
    await page.waitForTimeout(50)
  }
  return { selector: null, seen: false }
}

async function clickSubmit(page) {
  const candidates = [
    '#submitBtn',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Submit")'
  ]
  for (const sel of candidates) {
    const el = page.locator(sel).first()
    if (await el.count()) {
      await el.click()
      return
    }
  }
  throw new Error('Submit button not found')
}

async function goToForm(page, url) {
  if (!url) return false
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForTimeout(120)
    return true
  } catch {
    try {
      // Fallback for complex portals that keep long-running network requests.
      await page.goto(url, { waitUntil: 'commit', timeout: 10000 })
      await page.waitForTimeout(120)
      return true
    } catch {
      return false
    }
  }
}

async function resetFormPage(page, url, hasLoadedOnce) {
  if (!hasLoadedOnce) {
    return goToForm(page, url)
  }
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 8000 })
    await page.waitForTimeout(120)
    return true
  } catch {
    return goToForm(page, url)
  }
}

function mapScannedFieldsToRuntime(scannedFields = []) {
  return scannedFields
    .map((f, idx) => {
      const type = normalizeType(f?.type)
      const id = String(f?.id || '').trim()
      const name = String(f?.name || '').trim()
      const placeholder = String(f?.placeholder || '').trim()
      const element = String(f?.element || '').trim().toLowerCase()
      const label = String(f?.label || f?.name || f?.id || `field-${idx + 1}`).trim()
      const selectorTag =
        element === 'textarea'
          ? 'textarea'
          : (type === 'select-one' || type === 'select' || element === 'select')
            ? 'select'
            : 'input'
      const selector = id
        ? `#${id}`
        : name
          ? `${selectorTag}[name="${name.replace(/"/g, '\\"')}"]`
          : ''
      if (!selector) return null
      return {
        selector,
        type: (type === 'select-one' || type === 'select') ? 'select' : type,
        label,
        name,
        optional: !f?.required,
        keywords: [label, name, id, placeholder].flatMap(v => toTokenSet(v))
      }
    })
    .filter(Boolean)
}

function ensureScreenshotDir(projectId) {
  const base = process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.join(process.cwd(), 'uploads')
  const dir = path.join(base, 'screenshots', `project-${projectId}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function captureFailureScreenshot(page, projectId, testCaseId) {
  try {
    const dir = ensureScreenshotDir(projectId)
    const fileName = `tc-${testCaseId}-${Date.now()}.png`
    const fullPath = path.join(dir, fileName)
    await page.screenshot({ path: fullPath, fullPage: true })
    return `/uploads/screenshots/project-${projectId}/${fileName}`
  } catch (err) {
    testLog(`Screenshot capture failed for test case ${testCaseId}: ${String(err?.message || err)}`)
    return null
  }
}

// ─── Main runner ──────────────────────────────────────────────────────────────

async function runTests(projectId, options = {}) {
  const project = await db.get('SELECT * FROM projects WHERE id = ?', projectId)
  const testCases = await db.all('SELECT * FROM test_cases WHERE project_id = ?', projectId)

  if (!project) throw new Error('Project not found')
  if (testCases.length === 0) throw new Error('No test cases found')

  const browser = await launchChromiumBrowser()

  // If the tester saved their session from the extension, load it here so
  // Playwright starts already logged in and opens the real form directly
  // instead of bouncing to the portal login page.
  const authStatePath = process.env.AUTH_STATE_PATH
    ? path.resolve(process.env.AUTH_STATE_PATH)
    : path.join(process.cwd(), 'auth-state.json')
  let contextOptions = {}
  if (fs.existsSync(authStatePath)) {
    try {
      contextOptions = { storageState: authStatePath }
      testLog(`Using saved session from ${authStatePath}`)
    } catch (err) {
      testLog(`Could not load saved session (${String(err?.message || err)}). Continuing without it.`)
    }
  }
  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()
  const results = []
  let hasLoadedOnce = false
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  const captureAtFailure = async (testCaseId, selectorHints = []) => {
    const hints = Array.isArray(selectorHints) ? selectorHints.filter(Boolean) : []
    for (const sel of hints) {
      try {
        // Wait for UI feedback (error/result) before capturing failure state.
        await page.waitForSelector(sel, { state: 'visible', timeout: 1200 })
        break
      } catch {
        // If this selector does not appear, try the next hint and still capture.
      }
    }
    return captureFailureScreenshot(page, projectId, testCaseId)
  }
  const emitProgress = (payload) => {
    if (!onProgress) return
    try {
      onProgress(payload)
    } catch {
      // Ignore progress callback failures to keep test run stable.
    }
  }

  emitProgress({
    phase: 'running_tests',
    message: 'Running tests...',
    total: testCases.length,
    completed: 0
  })

  for (let index = 0; index < testCases.length; index += 1) {
    const tc = testCases[index]
    testLog('─────────────────────────────────────────')
    testLog(`Name: "${tc.name}"`)
    emitProgress({
      phase: 'checking_field',
      message: `Checking field: ${tc.name}...`,
      total: testCases.length,
      completed: index
    })

    try {

      // ── Determine test type ────────────────────────────────────────────────
      // If the test case already has a test_type (AI-generated), use it directly.
      // Only run AI validation for manually added ones (no test_type set).
      let testType = tc.test_type

      const isManualTestCase = !tc.test_type ||
        !['required_field', 'format_validation', 'successful_submit'].includes(tc.test_type)

      if (isManualTestCase) {
        testLog('Type: manually added — validating with AI...')
        const validation = await validateManualTestCase({
          name: tc.name,
          what_to_test: tc.what_to_test,
          expected_result: tc.expected_result
        })

        if (!validation.valid) {
          const note = `Failed: invalid test case — ${validation.reason}`
          testLog(`RESULT: ✗ Failed — ${validation.reason}`)
          const screenshotPath = await captureAtFailure(tc.id)
          await saveCaseResult(false, note, screenshotPath)
          continue
        }

        testType = validation.test_type
        testLog(`Type (from AI): ${testType}`)
      } else {
        testLog(`Type: ${testType}`)
      }

      // ── Navigate to form ───────────────────────────────────────────────────
      testLog('Step: navigating to form')
      const targetUrl = String(options.overrideUrl || project.form_url || '').trim()
      const loaded = await resetFormPage(page, targetUrl, hasLoadedOnce)
      if (!loaded) {
        const note = 'Failed: page did not load'
        testLog('RESULT: ✗ Failed — page did not load')
        const screenshotPath = await captureAtFailure(tc.id)
        await saveCaseResult(false, note, screenshotPath)
        continue
      }
      hasLoadedOnce = true

      const scannedRuntimeFields = mapScannedFieldsToRuntime(options.scannedFields || [])
      const liveFields = scannedRuntimeFields.length > 0 ? [] : await discoverLiveFields(page)
      const runtimeFields = mergeFields(KNOWN_FIELDS, [...liveFields, ...scannedRuntimeFields])
      const expectedOutcome = String(tc.expected_outcome || 'should_pass')
      const shouldFailExpected = expectedOutcome === 'should_fail'

      function finalizeByExpected(assertionPassed, baseNotes) {
        const finalPassed = shouldFailExpected ? !assertionPassed : assertionPassed
        let finalNotes = baseNotes
        if (shouldFailExpected) {
          finalNotes += finalPassed
            ? '\nExpected outcome: should_fail (captured as expected).'
            : '\nExpected outcome: should_fail, but form behaved like should_pass.'
        }
        return { finalPassed, finalNotes }
      }

      async function saveCaseResult(assertionPassed, baseNotes, screenshotOverride = null) {
        const { finalPassed, finalNotes } = finalizeByExpected(assertionPassed, baseNotes)
        let notesToSave = finalNotes
        const screenshotPath = screenshotOverride
        if (!finalPassed && screenshotPath) {
          notesToSave = `${notesToSave}\nScreenshot: ${screenshotPath}`
        }
        await db.run(
          "UPDATE test_cases SET status = ?, notes = ? WHERE id = ?",
          finalPassed ? 'Passed' : 'Failed',
          notesToSave,
          tc.id
        )
        results.push({
          id: tc.id,
          name: tc.name,
          passed: finalPassed,
          notes: notesToSave,
          screenshotPath,
          generationReason: tc.generation_reason || ''
        })
        emitProgress({
          phase: 'case_done',
          message: `Finished: ${tc.name}`,
          total: testCases.length,
          completed: index + 1,
          caseResult: { id: tc.id, name: tc.name, passed: finalPassed }
        })
      }

      let passed = false
      let notes = ''
      let failureWaitSelectors = []

      // ══════════════════════════════════════════════════════════════════════
      // REQUIRED FIELD
      // What we check: leave ONE specific field empty, fill everything else.
      // Pass: that field's specific error appears AND form did not submit.
      // Fail: form submitted (field not required) OR no error appeared.
      // ══════════════════════════════════════════════════════════════════════
      if (testType === 'required_field') {

        const match = matchFieldFromTestCaseInSet(tc, runtimeFields)
        const targetField = match.field

        if (!targetField) {
          testLog('Step: field mapping failed, running form submit for evidence')
          await fillAllFields(page, runtimeFields)
          await clickSubmit(page).catch(() => {})
          await page.waitForTimeout(300)
          const success = await isVisible(page, '#successMsg')
          const note =
            `Failed: the field named in this test could not be found on the live form, so this check could not be executed reliably. Form submission success was: ${success}.`
          testLog('RESULT: ✗ Failed — field not found on form')
          const screenshotPath = await captureAtFailure(tc.id)
          await saveCaseResult(false, note, screenshotPath)
          continue
        }
        if (match.confidence === 'low') {
          const note =
            `Failed: the runner could not confidently match this test case to one field on the live form. Best guess was "${match.matchedLabel || 'unknown'}", which is too uncertain. Please make the field name clearer in "What to test".`
          testLog('RESULT: ✗ Failed — low-confidence field mapping')
          const screenshotPath = await captureAtFailure(tc.id)
          await saveCaseResult(false, note, screenshotPath)
          continue
        }

        testLog(`Step: filling all fields except "${targetField.label}"`)
        await fillAllFields(page, runtimeFields, { excludeSelectors: [targetField.selector] })
        await clearField(page, targetField)

        testLog('Step: clicking submit')
        await clickSubmit(page)
        await waitForPostSubmitSignals(page, ['#successMsg', targetField.errorSelector], 1200)

        testLog('Step: checking results')
        const [fieldError, success] = await Promise.all([
          targetField.errorSelector ? isVisible(page, targetField.errorSelector) : Promise.resolve(false),
          isVisible(page, '#successMsg')
        ])

        testLog(`"${targetField.label}" error visible: ${fieldError}`)
        testLog(`Success visible: ${success}`)

        // STRICT: if no known error selector, fallback to "did not submit".
        passed = targetField.errorSelector ? (fieldError === true && success === false) : (success === false)

        if (passed) {
          notes = `Passed: when "${targetField.label}" was left empty, the form showed the expected required message and did not submit.`
          testLog(`RESULT: ✓ Passed`)
        } else if (success === true) {
          notes = `Failed: "${targetField.label}" was left empty, but the form still submitted. This means required validation did not block submission as expected.`
          testLog(`RESULT: ✗ Failed — form submitted with empty "${targetField.label}"`)
          failureWaitSelectors = [targetField.errorSelector, targetField.selector, '#successMsg']
        } else {
          notes = `Failed: "${targetField.label}" was left empty and the form did not submit, but no clear required message appeared for that field.`
          testLog(`RESULT: ✗ Failed — no error appeared for "${targetField.label}"`)
          failureWaitSelectors = [targetField.errorSelector, targetField.selector]
        }
      }

      // ══════════════════════════════════════════════════════════════════════
      // FORMAT VALIDATION
      // What we check: fill everything correctly, then put wrong format in one field.
      // Pass: format error appears AND form did not submit.
      // Fail: form submitted (no format check) OR no error appeared.
      // ══════════════════════════════════════════════════════════════════════
      else if (testType === 'format_validation') {

        const match = matchFieldFromTestCaseInSet(tc, runtimeFields)
        const targetField = match.field

        if (!targetField) {
          testLog('Step: field mapping failed, running form submit for evidence')
          await fillAllFields(page, runtimeFields)
          await clickSubmit(page).catch(() => {})
          await page.waitForTimeout(300)
          const success = await isVisible(page, '#successMsg')
          const note =
            `Failed: the field named in this test could not be found on the live form, so this format check could not be executed reliably. Form submission success was: ${success}.`
          testLog('RESULT: ✗ Failed — field not found on form')
          const screenshotPath = await captureAtFailure(tc.id)
          await saveCaseResult(false, note, screenshotPath)
          continue
        }
        if (match.confidence === 'low') {
          const note =
            `Failed: the runner could not confidently match this format test to one field on the live form. Best guess was "${match.matchedLabel || 'unknown'}", which is too uncertain. Please make the field name clearer in "What to test".`
          testLog('RESULT: ✗ Failed — low-confidence field mapping')
          const screenshotPath = await captureAtFailure(tc.id)
          await saveCaseResult(false, note, screenshotPath)
          continue
        }

        let invalidVal = guessInvalidValue(targetField)
        invalidVal = deriveInvalidValueForTestCase(tc, targetField, invalidVal)
        let formatErrorSelector = targetField.formatErrorSelector || targetField.errorSelector

        if (targetField.type === 'date') {
          const dobPlan = resolveDobFormatValidation(tc)
          if (dobPlan) {
            invalidVal = dobPlan.invalidVal
            formatErrorSelector = dobPlan.formatErrorSelector
          } else {
            const note =
              "Failed: Date format-validation case is not executable from this wording. Use explicit age/date-range wording (for example under-18, minimum date, or maximum date) so the runner can verify a real rule."
            testLog('RESULT: ✗ Failed — DOB format case not executable from current wording')
            const screenshotPath = await captureAtFailure(tc.id, [formatErrorSelector, targetField.selector])
            await saveCaseResult(false, note, screenshotPath)
            continue
          }
        }

        testLog(`Step: filling all fields, then setting invalid value for "${targetField.label}": "${invalidVal}"`)
        await fillAllFields(page, runtimeFields)

        if (targetField.type === 'select' || targetField.type === 'radio' || targetField.type === 'checkbox') {
          const note = `Failed: format_validation test type is not executable for option field "${targetField.label}". Use required_field or conditional behavior tests for this field.`
          testLog('RESULT: ✗ Failed — format_validation not executable for option field')
          const screenshotPath = await captureAtFailure(tc.id, [targetField.selector])
          await saveCaseResult(false, note, screenshotPath)
          continue
        } else {
          await page.locator(targetField.selector).first().fill(invalidVal, { timeout: 700 }).catch(() => {})
        }

        testLog('Step: clicking submit')
        await clickSubmit(page)
        await waitForPostSubmitSignals(page, ['#successMsg', formatErrorSelector, targetField.errorSelector], 1200)

        testLog('Step: checking results')
        const [formatError, success] = await Promise.all([
          formatErrorSelector ? isVisible(page, formatErrorSelector) : Promise.resolve(false),
          isVisible(page, '#successMsg')
        ])

        testLog(`Format error for "${targetField.label}" visible: ${formatError}`)
        testLog(`Success visible: ${success}`)

        // If there is no known format error selector, fallback to "did not submit".
        passed = formatErrorSelector ? (formatError === true && success === false) : (success === false)

        if (passed) {
          notes =
            targetField.type === 'date' && formatErrorSelector === '#dobAgeError'
              ? `Passed: Date of Birth rejected the minor date "${invalidVal}" and showed the age restriction message.`
              : `Passed: "${targetField.label}" rejected invalid input "${invalidVal}" and prevented successful submission.`
          testLog(`RESULT: ✓ Passed`)
        } else if (success === true) {
          notes = `Failed: "${targetField.label}" accepted invalid input "${invalidVal}" and the form submitted successfully.`
          testLog(`RESULT: ✗ Failed — form accepted invalid value for "${targetField.label}"`)
          failureWaitSelectors = [formatErrorSelector, targetField.errorSelector, targetField.selector, '#successMsg']
        } else {
          notes = `Failed: "${targetField.label}" used invalid input "${invalidVal}", but no clear validation message appeared for that field.`
          testLog(`RESULT: ✗ Failed — no format error for "${targetField.label}"`)
          failureWaitSelectors = [formatErrorSelector, targetField.errorSelector, targetField.selector]
        }
      }

      // ══════════════════════════════════════════════════════════════════════
      // SUCCESSFUL SUBMIT
      // What we check: fill everything correctly and submit.
      // Pass: success message appears AND no errors appear.
      // Fail: any error appears OR success does not appear.
      // ══════════════════════════════════════════════════════════════════════
      else if (testType === 'successful_submit') {

        testLog('Step: filling all fields with valid values')
        await fillAllFields(page, runtimeFields)

        testLog('Step: clicking submit')
        await clickSubmit(page)
        const checkSelectors = ['#successMsg', ...runtimeFields.map(f => f?.errorSelector).filter(Boolean)]
        await waitForPostSubmitSignals(page, checkSelectors, 1400)

        testLog('Step: checking results')
        const success = await isVisible(page, '#successMsg')

        // Check if any field errors appeared
        let anyError = false
        for (const f of runtimeFields) {
          if (f.optional || !f.errorSelector) continue
          if (await isVisible(page, f.errorSelector)) {
            anyError = true
            testLog(`Error visible: ${f.errorSelector}`)
            break
          }
        }

        testLog(`Success visible: ${success}`)
        testLog(`Any error visible: ${anyError}`)

        // STRICT: pass only if success appeared AND no errors appeared
        passed = success === true && anyError === false

        if (passed) {
          notes = 'Passed: form submitted successfully with all valid values and no errors appeared.'
          testLog('RESULT: ✓ Passed')
        } else if (anyError) {
          notes = 'Failed: errors appeared even though all fields were filled correctly. The form has a validation problem.'
          testLog('RESULT: ✗ Failed — errors appeared after valid submission')
        } else {
          notes = 'Failed: success message did not appear after submitting valid data. The form may not be submitting correctly.'
          testLog('RESULT: ✗ Failed — no success message appeared')
        }
      }

      else {
        const note = `Failed: unknown test type "${testType}".`
        testLog(`RESULT: ✗ Failed — ${note}`)
        const screenshotPath = await captureAtFailure(tc.id)
        await saveCaseResult(false, note, screenshotPath)
        continue
      }

      // Save result
      let failureScreenshotPath = null
      if (!passed) {
        // Capture exactly at failure state before next test navigates away.
        failureScreenshotPath = await captureAtFailure(tc.id, failureWaitSelectors)
      }
      await saveCaseResult(passed, notes, failureScreenshotPath)
      emitProgress({
        phase: 'running_tests',
        message: 'Running tests...',
        total: testCases.length,
        completed: index + 1
      })

    } catch (err) {
      const note = `Failed: runtime error — ${String(err?.message || 'Unknown error')}`
      testLog(`RESULT: ✗ Failed — ${note}`)
      const screenshotPath = await captureAtFailure(tc.id)
      const noteWithShot = screenshotPath ? `${note}\nScreenshot: ${screenshotPath}` : note
      await db.run("UPDATE test_cases SET status = ?, notes = ? WHERE id = ?", 'Failed', noteWithShot, tc.id)
      results.push({
        id: tc.id,
        name: tc.name,
        passed: false,
        notes: noteWithShot,
        screenshotPath,
        generationReason: tc.generation_reason || ''
      })
      emitProgress({
        phase: 'case_done',
        message: `Finished: ${tc.name}`,
        total: testCases.length,
        completed: index + 1,
        caseResult: { id: tc.id, name: tc.name, passed: false }
      })
      emitProgress({
        phase: 'running_tests',
        message: 'Running tests...',
        total: testCases.length,
        completed: index + 1
      })
    }

    testLog('─────────────────────────────────────────')
  }

  try { await context.close() } catch { /* ignore */ }
  await browser.close()

  const allPassed = results.every(r => r.passed)
  const anyFailed = results.some(r => !r.passed)
  const newStatus = allPassed ? 'Passed' : anyFailed ? 'Failed' : 'In Progress'

  await db.run("UPDATE projects SET status = ?, last_tested = datetime('now') WHERE id = ?", newStatus, projectId)

  return results
}

export default runTests