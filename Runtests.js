import Groq from 'groq-sdk'
import { launchChromiumBrowser } from './playwright-launch.js'
import 'dotenv/config'
import db from './db.js'

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

async function fillAllFields(page) {
  for (const f of KNOWN_FIELDS) {
    try {
      if (f.type === 'select') {
        await page.locator(f.selector).selectOption(f.validValue)
      } else {
        await page.locator(f.selector).fill(f.validValue)
      }
    } catch { /* field may not exist on this form */ }
  }
}

async function clearField(page, field) {
  try {
    if (field.type === 'select') {
      await page.locator(field.selector).selectOption('')
    } else {
      await page.locator(field.selector).fill('')
    }
  } catch { /* ignore */ }
}

function matchFieldFromTestCase(tc) {
  const text = `${tc.name || ''} ${tc.what_to_test || ''} ${tc.expected_result || ''}`.toLowerCase()
  let best = null
  let bestScore = 0
  for (const f of KNOWN_FIELDS) {
    let score = 0
    for (const kw of f.keywords) {
      if (text.includes(kw)) score += kw.split(' ').length
    }
    if (score > bestScore) {
      bestScore = score
      best = f
    }
  }
  return bestScore > 0 ? best : null
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
    if (!(await el.count())) return false
    return await el.isVisible()
  } catch {
    return false
  }
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
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45000 })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(500)
    return true
  } catch {
    return false
  }
}

// ─── Main runner ──────────────────────────────────────────────────────────────

async function runTests(projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)
  const testCases = db.prepare('SELECT * FROM test_cases WHERE project_id = ?').all(projectId)

  if (!project) throw new Error('Project not found')
  if (testCases.length === 0) throw new Error('No test cases found')

  const browser = await launchChromiumBrowser()
  const page = await browser.newPage()
  const results = []

  for (const tc of testCases) {
    testLog('─────────────────────────────────────────')
    testLog(`Name: "${tc.name}"`)

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
          db.prepare("UPDATE test_cases SET status = ?, notes = ? WHERE id = ?")
            .run('Failed', note, tc.id)
          results.push({ id: tc.id, name: tc.name, passed: false, notes: note })
          continue
        }

        testType = validation.test_type
        testLog(`Type (from AI): ${testType}`)
      } else {
        testLog(`Type: ${testType}`)
      }

      // ── Navigate to form ───────────────────────────────────────────────────
      testLog('Step: navigating to form')
      const loaded = await goToForm(page, project.form_url)
      if (!loaded) {
        const note = 'Failed: page did not load'
        testLog('RESULT: ✗ Failed — page did not load')
        db.prepare("UPDATE test_cases SET status = ?, notes = ? WHERE id = ?")
          .run('Failed', note, tc.id)
        results.push({ id: tc.id, name: tc.name, passed: false, notes: note })
        continue
      }

      let passed = false
      let notes = ''

      // ══════════════════════════════════════════════════════════════════════
      // REQUIRED FIELD
      // What we check: leave ONE specific field empty, fill everything else.
      // Pass: that field's specific error appears AND form did not submit.
      // Fail: form submitted (field not required) OR no error appeared.
      // ══════════════════════════════════════════════════════════════════════
      if (testType === 'required_field') {

        const targetField = matchFieldFromTestCase(tc)

        if (!targetField) {
          const note = 'Failed: could not identify which field this test is about. Please mention the field name clearly in "What to test".'
          testLog('RESULT: ✗ Failed — no field matched')
          db.prepare("UPDATE test_cases SET status = ?, notes = ? WHERE id = ?")
            .run('Failed', note, tc.id)
          results.push({ id: tc.id, name: tc.name, passed: false, notes: note })
          continue
        }

        if (targetField.optional) {
          const note = `Failed: "${targetField.label}" is optional on this form — leaving it empty does not show a required error. Update the test case or mark a required field instead.`
          testLog('RESULT: ✗ Failed — field is optional on form')
          db.prepare("UPDATE test_cases SET status = ?, notes = ? WHERE id = ?")
            .run('Failed', note, tc.id)
          results.push({ id: tc.id, name: tc.name, passed: false, notes: note })
          continue
        }

        testLog(`Step: filling all fields except "${targetField.label}"`)
        await fillAllFields(page)
        await clearField(page, targetField)

        testLog('Step: clicking submit')
        await clickSubmit(page)
        await page.waitForTimeout(1000)

        testLog('Step: checking results')
        const fieldError = await isVisible(page, targetField.errorSelector)
        const success = await isVisible(page, '#successMsg')

        testLog(`"${targetField.label}" error visible: ${fieldError}`)
        testLog(`Success visible: ${success}`)

        // STRICT: pass only if the specific error appeared AND form did not submit
        passed = fieldError === true && success === false

        if (passed) {
          notes = `Passed: "${targetField.label}" correctly shows a required error when left empty.`
          testLog(`RESULT: ✓ Passed`)
        } else if (success === true) {
          notes = `Failed: form submitted successfully even though "${targetField.label}" was empty. This field is NOT required on the form — the test case does not match the form's actual behaviour.`
          testLog(`RESULT: ✗ Failed — form submitted with empty "${targetField.label}"`)
        } else {
          notes = `Failed: no required error appeared for "${targetField.label}". The form did not validate this field.`
          testLog(`RESULT: ✗ Failed — no error appeared for "${targetField.label}"`)
        }
      }

      // ══════════════════════════════════════════════════════════════════════
      // FORMAT VALIDATION
      // What we check: fill everything correctly, then put wrong format in one field.
      // Pass: format error appears AND form did not submit.
      // Fail: form submitted (no format check) OR no error appeared.
      // ══════════════════════════════════════════════════════════════════════
      else if (testType === 'format_validation') {

        const targetField = matchFieldFromTestCase(tc)

        if (!targetField) {
          const note = 'Failed: could not identify which field to test format validation on. Please mention the field name in "What to test".'
          testLog('RESULT: ✗ Failed — no field matched')
          db.prepare("UPDATE test_cases SET status = ?, notes = ? WHERE id = ?")
            .run('Failed', note, tc.id)
          results.push({ id: tc.id, name: tc.name, passed: false, notes: note })
          continue
        }

        if (targetField.optional) {
          const note = `Failed: "${targetField.label}" is optional on this form — it has no required/format error element to assert. Pick a required field for format tests.`
          testLog('RESULT: ✗ Failed — optional field')
          db.prepare("UPDATE test_cases SET status = ?, notes = ? WHERE id = ?")
            .run('Failed', note, tc.id)
          results.push({ id: tc.id, name: tc.name, passed: false, notes: note })
          continue
        }

        let invalidVal = targetField.invalidValue || '!!!invalid!!!'
        let formatErrorSelector = targetField.formatErrorSelector || targetField.errorSelector

        if (targetField.type === 'date') {
          const dobPlan = resolveDobFormatValidation(tc)
          if (dobPlan) {
            invalidVal = dobPlan.invalidVal
            formatErrorSelector = dobPlan.formatErrorSelector
          } else {
            const note =
              "Failed: Date of Birth automation needs wording like \"under 18\" or \"minor\" in the test. Plain date inputs cannot use fake text, so the runner must use a minor's date and assert the age error."
            testLog('RESULT: ✗ Failed — DOB format test not actionable without under-18/minor wording')
            db.prepare("UPDATE test_cases SET status = ?, notes = ? WHERE id = ?")
              .run('Failed', note, tc.id)
            results.push({ id: tc.id, name: tc.name, passed: false, notes: note })
            continue
          }
        }

        testLog(`Step: filling all fields, then setting invalid value for "${targetField.label}": "${invalidVal}"`)
        await fillAllFields(page)

        if (targetField.type === 'select') {
          await page.locator(targetField.selector).selectOption('').catch(() => {})
        } else {
          await page.locator(targetField.selector).fill(invalidVal).catch(() => {})
        }

        testLog('Step: clicking submit')
        await clickSubmit(page)
        await page.waitForTimeout(1000)

        testLog('Step: checking results')
        const formatError = await isVisible(page, formatErrorSelector)
        const success = await isVisible(page, '#successMsg')

        testLog(`Format error for "${targetField.label}" visible: ${formatError}`)
        testLog(`Success visible: ${success}`)

        // STRICT: pass only if format error appeared AND form did not submit
        passed = formatError === true && success === false

        if (passed) {
          notes =
            targetField.type === 'date' && formatErrorSelector === '#dobAgeError'
              ? `Passed: Date of Birth rejected a minor's date (${invalidVal}) — age restriction error shown.`
              : `Passed: "${targetField.label}" correctly rejected the invalid value "${invalidVal}".`
          testLog(`RESULT: ✓ Passed`)
        } else if (success === true) {
          notes = `Failed: form submitted successfully even though "${targetField.label}" had an invalid value "${invalidVal}". Format validation is NOT working on the form.`
          testLog(`RESULT: ✗ Failed — form accepted invalid value for "${targetField.label}"`)
        } else {
          notes = `Failed: no format error appeared for "${targetField.label}" with value "${invalidVal}". The form did not reject this invalid value.`
          testLog(`RESULT: ✗ Failed — no format error for "${targetField.label}"`)
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
        await fillAllFields(page)

        testLog('Step: clicking submit')
        await clickSubmit(page)
        await page.waitForTimeout(1500)

        testLog('Step: checking results')
        const success = await isVisible(page, '#successMsg')

        // Check if any field errors appeared
        let anyError = false
        for (const f of KNOWN_FIELDS) {
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
        db.prepare("UPDATE test_cases SET status = ?, notes = ? WHERE id = ?")
          .run('Failed', note, tc.id)
        results.push({ id: tc.id, name: tc.name, passed: false, notes: note })
        continue
      }

      // Save result
      db.prepare("UPDATE test_cases SET status = ?, notes = ? WHERE id = ?")
        .run(passed ? 'Passed' : 'Failed', notes, tc.id)
      results.push({ id: tc.id, name: tc.name, passed, notes })

    } catch (err) {
      const note = `Failed: runtime error — ${String(err?.message || 'Unknown error')}`
      testLog(`RESULT: ✗ Failed — ${note}`)
      db.prepare("UPDATE test_cases SET status = ?, notes = ? WHERE id = ?")
        .run('Failed', note, tc.id)
      results.push({ id: tc.id, name: tc.name, passed: false, notes: note })
    }

    testLog('─────────────────────────────────────────')
  }

  await browser.close()

  const allPassed = results.every(r => r.passed)
  const anyFailed = results.some(r => !r.passed)
  const newStatus = allPassed ? 'Passed' : anyFailed ? 'Failed' : 'In Progress'

  db.prepare(
    "UPDATE projects SET status = ?, last_tested = datetime('now') WHERE id = ?"
  ).run(newStatus, projectId)

  return results
}

export default runTests