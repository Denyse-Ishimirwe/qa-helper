import express from 'express'
import cors from 'cors'
import db from './db.js'
import upload from './multer.js'
import extractText from './upload.js'
import generateTestCases from './ai.js'
import runTests from './Runtests.js'

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
      'INSERT INTO test_cases (project_id, name, what_to_test, expected_result) VALUES (?, ?, ?, ?)'
    )

    for (const tc of testCases) {
      insertTestCase.run(req.params.id, tc.name, tc.what_to_test, tc.expected_result)
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
    const { name, what_to_test, expected_result } = req.body

    if (!name || !what_to_test || !expected_result) {
      return res.status(400).json({ error: 'All fields are required' })
    }

    db.prepare(
      'UPDATE test_cases SET name = ?, what_to_test = ?, expected_result = ? WHERE id = ?'
    ).run(name, what_to_test, expected_result, req.params.id)

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
    const results = await runTests(req.params.id)
    res.json({ success: true, results })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// Add a test case manually
app.post('/api/projects/:id/test_cases', (req, res) => {
  try {
    const { name, what_to_test, expected_result } = req.body
    const project_id = req.params.id

    if (!name || !what_to_test || !expected_result) {
      return res.status(400).json({ error: 'All fields are required' })
    }

    const result = db.prepare(
      'INSERT INTO test_cases (project_id, name, what_to_test, expected_result) VALUES (?, ?, ?, ?)'
    ).run(project_id, name, what_to_test, expected_result)

    res.json({ success: true, id: result.lastInsertRowid })

  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})