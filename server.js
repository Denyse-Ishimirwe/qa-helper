import express from 'express'
import cors from 'cors'
import db from './db.js'
import upload from './multer.js'
import extractText from './upload.js'
import generateTestCases from './ai.js'
import runTests from './Runtests.js'
import XLSX from 'xlsx'

const app = express()

app.use(cors())
app.use(express.json())
app.use(express.static('.'))

app.get('/', (req, res) => {
  res.send('QA Helper API is running')
})

app.get('/api/projects', (req, res) => {
  const projects = db.prepare('SELECT * FROM projects').all()
  res.json(projects)
})

app.post('/api/projects', upload.single('srd'), async (req, res) => {
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

    const result = db.prepare(
      'INSERT INTO projects (name, form_url, srd_text) VALUES (?, ?, ?)'
    ).run(name, form_url, srdText)

    res.json({ success: true, id: result.lastInsertRowid })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Edit a project (name, form_url, and optionally a new SRD)
app.put('/api/projects/:id', upload.single('srd'), async (req, res) => {
  try {
    const { name, form_url } = req.body

    if (!name || !form_url) {
      return res.status(400).json({ error: 'Name and URL are required' })
    }

    // If a new SRD file was uploaded, extract its text, clear old test cases and reset status
    if (req.file) {
      const srdText = await extractText(req.file.path)
      db.prepare('DELETE FROM test_cases WHERE project_id = ?').run(req.params.id)
      db.prepare(
        "UPDATE projects SET name = ?, form_url = ?, srd_text = ?, status = 'Not Tested', last_tested = 'Never' WHERE id = ?"
      ).run(name, form_url, srdText, req.params.id)
    } else {
      db.prepare(
        'UPDATE projects SET name = ?, form_url = ? WHERE id = ?'
      ).run(name, form_url, req.params.id)
    }

    res.json({ success: true })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/projects/:id', (req, res) => {
  db.prepare('DELETE FROM test_cases WHERE project_id = ?').run(req.params.id)
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

app.listen(3000, () => {
  console.log('Server running on port 3000')
})

app.post('/api/projects/:id/generate', async (req, res) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id)

    if (!project) {
      return res.status(404).json({ error: 'Project not found' })
    }

    if (!project.srd_text) {
      return res.status(400).json({ error: 'No SRD text found for this project' })
    }

    // Fix 2: Delete old test cases before inserting new ones
    db.prepare('DELETE FROM test_cases WHERE project_id = ?').run(req.params.id)

    const testCases = await generateTestCases(project.srd_text)

    const insertTestCase = db.prepare(
      'INSERT INTO test_cases (project_id, name, what_to_test, expected_result, test_type) VALUES (?, ?, ?, ?, ?)'
    )

    for (const tc of testCases) {
      const testType = ['required_field', 'format_validation', 'successful_submit'].includes(tc.test_type)
        ? tc.test_type
        : 'required_field'

      insertTestCase.run(req.params.id, tc.name, tc.what_to_test, tc.expected_result, testType)
    }

    // Fix 1: Update project status to In Progress
    db.prepare(
      "UPDATE projects SET status = 'In Progress', last_tested = datetime('now') WHERE id = ?"
    ).run(req.params.id)

    res.json({ success: true, testCases })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/projects/:id/test_cases', (req, res) => {
  const testCases = db.prepare(
    'SELECT * FROM test_cases WHERE project_id = ?'
  ).all(req.params.id)
  res.json(testCases)
})

// Edit a test case
app.put('/api/test_cases/:id', (req, res) => {
  try {
    const { name, what_to_test, expected_result, test_type } = req.body

    if (!name || !what_to_test || !expected_result) {
      return res.status(400).json({ error: 'All fields are required' })
    }

    const safeTestType = ['required_field', 'format_validation', 'successful_submit'].includes(test_type)
      ? test_type
      : 'required_field'

    db.prepare(
      'UPDATE test_cases SET name = ?, what_to_test = ?, expected_result = ?, test_type = ? WHERE id = ?'
    ).run(name, what_to_test, expected_result, safeTestType, req.params.id)

    res.json({ success: true, message: 'Test case updated' })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Delete a test case
app.delete('/api/test_cases/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM test_cases WHERE id = ?').run(req.params.id)
    res.json({ success: true, message: 'Test case deleted' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Run tests with Playwright
app.post('/api/projects/:id/run', async (req, res) => {
  try {
    const projectId = req.params.id
    const runStartedAt = new Date().toISOString()

    // 1) Run Playwright tests (existing function)
    const results = await runTests(projectId)

    const runFinishedAt = new Date().toISOString()
    const allPassed = results.every(r => r.passed)
    const projectStatus = allPassed ? 'Passed' : 'Failed'

    // 2) Save one run row
    const runInsert = db.prepare(
      'INSERT INTO test_runs (project_id, run_started_at, run_finished_at, project_status) VALUES (?, ?, ?, ?)'
    ).run(projectId, runStartedAt, runFinishedAt, projectStatus)

    const runId = runInsert.lastInsertRowid

    // 3) Load current test cases for snapshots
    const cases = db.prepare(
      'SELECT id, name, what_to_test, expected_result, test_type FROM test_cases WHERE project_id = ?'
    ).all(projectId)

    const byId = new Map(cases.map(tc => [tc.id, tc]))

    // 4) Save one result row per executed test case
    const insertRunResult = db.prepare(`
      INSERT INTO test_run_results
      (run_id, test_case_id, status, notes, snapshot_name, snapshot_what_to_test, snapshot_expected_result, snapshot_test_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    for (const r of results) {
      const tc = byId.get(r.id)
      if (!tc) continue

      insertRunResult.run(
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

app.get('/api/projects/:id/runs/latest-comparison', (req, res) => {
  try {
    const projectId = req.params.id

    const runs = db.prepare(
      'SELECT * FROM test_runs WHERE project_id = ? ORDER BY id DESC LIMIT 2'
    ).all(projectId)

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

    const currentResults = db.prepare(
      'SELECT * FROM test_run_results WHERE run_id = ?'
    ).all(currentRun.id)
    const previousResults = db.prepare(
      'SELECT * FROM test_run_results WHERE run_id = ?'
    ).all(previousRun.id)

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

app.get('/api/projects/:id/runs/:runId/export.xlsx', (req, res) => {
  try {
    const { id: projectId, runId } = req.params
    const run = db.prepare(
      'SELECT * FROM test_runs WHERE id = ? AND project_id = ?'
    ).get(runId, projectId)

    if (!run) {
      return res.status(404).json({ error: 'Run not found for this project' })
    }

    const results = db.prepare(
      'SELECT * FROM test_run_results WHERE run_id = ? ORDER BY id ASC'
    ).all(runId)

    const latestTwo = db.prepare(
      'SELECT * FROM test_runs WHERE project_id = ? ORDER BY id DESC LIMIT 2'
    ).all(projectId)

    let comparisonSummary = 'No previous run to compare.'
    if (latestTwo.length >= 2 && Number(latestTwo[0].id) === Number(runId)) {
      const currentResults = results
      const previousResults = db.prepare(
        'SELECT * FROM test_run_results WHERE run_id = ?'
      ).all(latestTwo[1].id)
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
app.post('/api/projects/:id/test_cases', (req, res) => {
  try {
    const { name, what_to_test, expected_result, test_type } = req.body
    const project_id = req.params.id

    if (!name || !what_to_test || !expected_result) {
      return res.status(400).json({ error: 'All fields are required' })
    }

    const safeTestType = ['required_field', 'format_validation', 'successful_submit'].includes(test_type)
      ? test_type
      : 'required_field'

    const result = db.prepare(
      'INSERT INTO test_cases (project_id, name, what_to_test, expected_result, test_type) VALUES (?, ?, ?, ?, ?)'
    ).run(project_id, name, what_to_test, expected_result, safeTestType)

    res.json({ success: true, id: result.lastInsertRowid })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})