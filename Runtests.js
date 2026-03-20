import { chromium } from 'playwright'
import db from './db.js'

async function runTests(projectId) {
  // Get project and its test cases
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)
  const testCases = db.prepare('SELECT * FROM test_cases WHERE project_id = ?').all(projectId)

  if (!project) throw new Error('Project not found')
  if (testCases.length === 0) throw new Error('No test cases found')

  const browser = await chromium.launch({ headless: false }) // headless: false so you can watch it
  const page = await browser.newPage()

  const results = []

  for (const tc of testCases) {
    try {
      await page.goto(project.form_url)
      await page.waitForLoadState('domcontentloaded')

      let passed = false
      let notes = ''

      const testTypeRaw = tc.test_type || 'required_field'
      const testType = ['required_field', 'format_validation', 'successful_submit'].includes(testTypeRaw)
        ? testTypeRaw
        : 'required_field'

      // --- required_field tests ---
      if (testType === 'required_field') {
        // Click submit without filling anything
        await page.click('#submitBtn')
        await page.waitForTimeout(500)

        // Check if any error message is visible
        const errorVisible = await page.locator('.error-msg.visible').count()
        passed = errorVisible > 0
        notes = passed ? 'Error messages appeared correctly' : 'No error messages appeared'
      }

      // --- format_validation tests ---
      else if (testType === 'format_validation') {
        await page.fill('#firstName', 'John')
        await page.fill('#lastName', 'Doe')
        await page.fill('#dob', '1990-01-01')
        await page.selectOption('#gender', 'male')
        await page.fill('#nationality', 'Rwandan')
        await page.fill('#idNumber', '9999999999999999') // invalid - doesn't start with 1
        await page.click('#submitBtn')
        await page.waitForTimeout(500)

        const formatErrorVisible = await page.locator('#idNumberFormatError.visible').count()
        passed = formatErrorVisible > 0
        notes = passed ? 'ID format error appeared correctly' : 'ID format error did not appear'
      }

      // --- successful_submit tests ---
      else if (testType === 'successful_submit') {
        await page.fill('#firstName', 'John')
        await page.fill('#lastName', 'Doe')
        await page.fill('#dob', '1990-01-01')
        await page.selectOption('#gender', 'male')
        await page.fill('#nationality', 'Rwandan')
        await page.fill('#idNumber', '1199880012345678')
        await page.click('#submitBtn')
        await page.waitForTimeout(500)

        const successVisible = await page.locator('#successMsg.visible').count()
        passed = successVisible > 0
        notes = passed ? 'Form submitted successfully' : 'Success message did not appear'
      }

      else {
        // Shouldn't happen due to validation above, but keep a safe fallback.
        await page.click('#submitBtn')
        await page.waitForTimeout(500)
        const errorVisible = await page.locator('.error-msg.visible').count()
        passed = errorVisible > 0
        notes = passed ? 'Validation triggered' : 'Unknown test type - please review manually'
      }

      // Save result to database
      db.prepare(
        "UPDATE test_cases SET status = ? WHERE id = ?"
      ).run(passed ? 'Passed' : 'Failed', tc.id)

      results.push({ id: tc.id, name: tc.name, passed, notes })

    } catch (err) {
      db.prepare("UPDATE test_cases SET status = 'Failed' WHERE id = ?").run(tc.id)
      results.push({ id: tc.id, name: tc.name, passed: false, notes: err.message })
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