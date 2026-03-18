import './TestPanel.css'
import { useState, useEffect, useCallback } from 'react'

function TestPanel({ project, onClose }) {
  const [testCases, setTestCases] = useState([])
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState({ name: '', what_to_test: '', expected_result: '' })
  const [showAddForm, setShowAddForm] = useState(false)
  const [newCase, setNewCase] = useState({ name: '', what_to_test: '', expected_result: '' })
  const [addError, setAddError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(null)

  const fetchTestCases = useCallback(async () => {
    try {
      const res = await fetch(`http://localhost:3000/api/projects/${project.id}/test_cases`)
      const data = await res.json()
      setTestCases(Array.isArray(data) ? data : [])
    } catch (err) {
      console.error('Failed to fetch test cases:', err)
      setTestCases([])
    }
  }, [project.id])

  useEffect(() => {
    fetchTestCases()
  }, [fetchTestCases])

  async function handleGenerate() {
    setLoading(true)
    try {
      const res = await fetch(`http://localhost:3000/api/projects/${project.id}/generate`, {
        method: 'POST'
      })
      const data = await res.json()
      if (!res.ok) {
        alert(data.error || 'Failed to generate test cases')
        return
      }
      await fetchTestCases()
    } catch {
      alert('Failed to generate test cases')
    } finally {
      setLoading(false)
    }
  }

  async function handleRun() {
    setRunning(true)
    try {
      const res = await fetch(`http://localhost:3000/api/projects/${project.id}/run`, {
        method: 'POST'
      })
      const data = await res.json()
      if (!res.ok) {
        alert(data.error || 'Failed to run tests')
        return
      }
      await fetchTestCases()
    } catch {
      alert('Failed to run tests')
    } finally {
      setRunning(false)
    }
  }

  function startEdit(tc) {
    setEditingId(tc.id)
    setEditForm({ name: tc.name, what_to_test: tc.what_to_test, expected_result: tc.expected_result })
  }

  async function handleSaveEdit(id) {
    try {
      const res = await fetch(`http://localhost:3000/api/test_cases/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm)
      })
      if (res.ok) {
        setEditingId(null)
        await fetchTestCases()
      }
    } catch (err) {
      console.error('Failed to update:', err)
    }
  }

  async function handleDelete(id) {
    try {
      await fetch(`http://localhost:3000/api/test_cases/${id}`, { method: 'DELETE' })
      setConfirmDelete(null)
      await fetchTestCases()
    } catch (err) {
      console.error('Failed to delete:', err)
    }
  }

  async function handleAddCase() {
    if (!newCase.name || !newCase.what_to_test || !newCase.expected_result) {
      setAddError('All fields are required')
      return
    }
    try {
      const res = await fetch(`http://localhost:3000/api/projects/${project.id}/test_cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newCase)
      })
      if (res.ok) {
        setNewCase({ name: '', what_to_test: '', expected_result: '' })
        setShowAddForm(false)
        setAddError('')
        await fetchTestCases()
      }
    } catch (err) {
      console.error('Failed to add:', err)
    }
  }

  const passed = testCases.filter(tc => tc.status === 'Passed').length
  const failed = testCases.filter(tc => tc.status === 'Failed').length
  const notRun = testCases.filter(tc => tc.status === 'Not Run').length

  return (
    <>
      <div className="panel-overlay" onClick={onClose} />
      <div className="panel">

        <div className="panel-header">
          <div>
            <h2>{project.name}</h2>
            <p className="panel-subtitle">
              {testCases.length > 0
                ? `${testCases.length} test case${testCases.length !== 1 ? 's' : ''}`
                : 'No test cases yet'}
            </p>
          </div>
          <button className="panel-close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="panel-actions">
          {testCases.length === 0 ? (
            <button className="panel-generate-btn" onClick={handleGenerate} disabled={loading}>
              {loading ? <><span className="btn-spinner" /> Generating...</> : '✦ Generate'}
            </button>
          ) : (
            <>
              <button className="panel-run-btn" onClick={handleRun} disabled={running || loading}>
                {running ? <><span className="btn-spinner" /> Running...</> : '▶ Run Tests'}
              </button>
              <button className="panel-regenerate-btn" onClick={handleGenerate} disabled={loading || running}>
                {loading ? <><span className="btn-spinner" /> Generating...</> : '↺ Regenerate'}
              </button>
              <button className="panel-add-btn" onClick={() => setShowAddForm(true)} disabled={running}>
                + Add
              </button>
            </>
          )}
        </div>

        {/* Results summary */}
        {testCases.length > 0 && (passed > 0 || failed > 0) && (
          <div className="panel-summary">
            <span className="summary-passed">✓ {passed} Passed</span>
            <span className="summary-failed">✗ {failed} Failed</span>
            {notRun > 0 && <span className="summary-notrun">— {notRun} Not Run</span>}
          </div>
        )}

        {testCases.length > 0 && testCases.length < 5 && (
          <div className="panel-warning">
            ⚠ Only {testCases.length} test case{testCases.length !== 1 ? 's' : ''} — consider adding more manually.
          </div>
        )}

        {(loading || running) && testCases.length === 0 && (
          <div className="panel-loading">
            <div className="panel-spinner" />
          </div>
        )}

        {running && (
          <div className="panel-running-msg">
            🔄 Playwright is running your tests — a browser window will open automatically...
          </div>
        )}

        <div className="panel-list">
          {testCases.length === 0 && !loading ? (
            <p className="panel-empty">No test cases yet. Click Generate to get started.</p>
          ) : (
            testCases.map((tc, index) => (
              <div className={`panel-card ${tc.status === 'Passed' ? 'card-passed' : tc.status === 'Failed' ? 'card-failed' : ''}`} key={tc.id}>
                {editingId === tc.id ? (
                  <div className="panel-edit-form">
                    <input
                      className="panel-input"
                      value={editForm.name}
                      onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                      placeholder="Test case name"
                    />
                    <input
                      className="panel-input"
                      value={editForm.what_to_test}
                      onChange={e => setEditForm({ ...editForm, what_to_test: e.target.value })}
                      placeholder="What to test"
                    />
                    <input
                      className="panel-input"
                      value={editForm.expected_result}
                      onChange={e => setEditForm({ ...editForm, expected_result: e.target.value })}
                      placeholder="Expected result"
                    />
                    <div className="card-btns">
                      <button className="btn-save" onClick={() => handleSaveEdit(tc.id)}>Save</button>
                      <button className="btn-cancel" onClick={() => setEditingId(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="card-top">
                      <span className="card-num">{index + 1}</span>
                      <span className="card-name">{tc.name}</span>
                      <span className={`tc-status ${tc.status === 'Passed' ? 'tc-passed' : tc.status === 'Failed' ? 'tc-failed' : 'tc-notrun'}`}>
                        {tc.status === 'Passed' ? '✓ Passed' : tc.status === 'Failed' ? '✗ Failed' : 'Not Run'}
                      </span>
                      <div className="card-btns">
                        <button className="btn-edit" onClick={() => startEdit(tc)}>Edit</button>
                        <button className="btn-delete" onClick={() => setConfirmDelete(tc)}>Delete</button>
                      </div>
                    </div>
                    <div className="card-body">
                      <div className="card-field">
                        <span className="field-label">What to test</span>
                        <span className="field-value">{tc.what_to_test}</span>
                      </div>
                      <div className="card-field">
                        <span className="field-label">Expected result</span>
                        <span className="field-value">{tc.expected_result}</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>

        {showAddForm && (
          <div className="panel-add-form">
            <h3>Add Test Case</h3>
            <label>Test Case Name</label>
            <input
              className="panel-input"
              type="text"
              placeholder="e.g. Empty first name field"
              value={newCase.name}
              onChange={e => setNewCase({ ...newCase, name: e.target.value })}
            />
            <label>What to Test</label>
            <input
              className="panel-input"
              type="text"
              placeholder="e.g. Leave first name blank and submit"
              value={newCase.what_to_test}
              onChange={e => setNewCase({ ...newCase, what_to_test: e.target.value })}
            />
            <label>Expected Result</label>
            <input
              className="panel-input"
              type="text"
              placeholder="e.g. Error message appears"
              value={newCase.expected_result}
              onChange={e => setNewCase({ ...newCase, expected_result: e.target.value })}
            />
            {addError && <p className="panel-error">{addError}</p>}
            <div className="card-btns" style={{ marginTop: '12px' }}>
              <button className="btn-cancel" onClick={() => { setShowAddForm(false); setAddError('') }}>Cancel</button>
              <button className="btn-save" onClick={handleAddCase}>Add</button>
            </div>
          </div>
        )}

      </div>

      {/* Confirm delete modal */}
      {confirmDelete && (
        <div className="modal-overlay" style={{ zIndex: 300 }}>
          <div className="confirm-modal">
            <h3>Delete Test Case</h3>
            <p>Are you sure you want to delete <strong>{confirmDelete.name}</strong>? This cannot be undone.</p>
            <div className="confirm-btns">
              <button className="btn-cancel" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn-confirm-delete" onClick={() => handleDelete(confirmDelete.id)}>Yes, Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default TestPanel