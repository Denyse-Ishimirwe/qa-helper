import './TestPanel.css'
import { useState, useEffect, useCallback, useRef } from 'react'

/** Normalize API/DB status so UI counts match each card. */
function normalizeTestStatus(status) {
  const s = String(status || '').trim().toLowerCase()
  if (s === 'passed') return 'Passed'
  if (s === 'failed') return 'Failed'
  return 'Not Run'
}

function TestPanel({ project, token, onClose }) {
  const [testCases, setTestCases] = useState([])
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState({ name: '', what_to_test: '', expected_result: '', test_type: 'required_field' })
  const [showAddForm, setShowAddForm] = useState(false)
  const [newCase, setNewCase] = useState({ name: '', what_to_test: '', expected_result: '', test_type: 'required_field' })
  const [addError, setAddError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [comparison, setComparison] = useState(null)
  const [downloading, setDownloading] = useState(false)
  const [formStructureHint, setFormStructureHint] = useState('')
  const testCasesRequestRef = useRef(0)
  const comparisonRequestRef = useRef(0)

  const fetchTestCases = useCallback(async () => {
    const requestId = ++testCasesRequestRef.current
    try {
      const res = await fetch(`/api/projects/${project.id}/test_cases`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      if (requestId !== testCasesRequestRef.current) return
      setTestCases(Array.isArray(data) ? data : [])
    } catch (err) {
      if (requestId !== testCasesRequestRef.current) return
      console.error('Failed to fetch test cases:', err)
      setTestCases([])
    }
  }, [project.id, token])

  useEffect(() => {
    // Immediately clear previous project's data while new project is loading.
    setTestCases([])
    setComparison(null)
    fetchTestCases()
  }, [fetchTestCases])

  const fetchComparison = useCallback(async () => {
    const requestId = ++comparisonRequestRef.current
    try {
      const res = await fetch(`/api/projects/${project.id}/runs/latest-comparison`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (requestId !== comparisonRequestRef.current) return
      if (!res.ok) {
        setComparison(null)
        return
      }
      const data = await res.json()
      if (requestId !== comparisonRequestRef.current) return
      setComparison(data)
    } catch (err) {
      if (requestId !== comparisonRequestRef.current) return
      console.error('Failed to fetch run comparison:', err)
      setComparison(null)
    }
  }, [project.id, token])

  useEffect(() => {
    fetchComparison()
  }, [fetchComparison])

  useEffect(() => {
    if (project?.form_structure) {
      try {
        const parsed = JSON.parse(project.form_structure)
        const fieldCount = Array.isArray(parsed?.fields) ? parsed.fields.length : 0
        const hasSubmit = Boolean(parsed?.submitButton)
        if (fieldCount > 0) {
          setFormStructureHint(`Found ${fieldCount} fields${hasSubmit ? ' and a submit button' : ''}`)
        } else {
          setFormStructureHint('')
        }
      } catch {
        setFormStructureHint('')
      }
    } else {
      setFormStructureHint('')
    }
  }, [project])

  async function handleGenerate() {
    setLoading(true)
    try {
      const res = await fetch(`/api/projects/${project.id}/generate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
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
      const res = await fetch(`/api/projects/${project.id}/run`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      if (!res.ok) {
        alert(data.error || 'Failed to run tests')
        return
      }
      await fetchTestCases()
      await fetchComparison()
    } catch {
      alert('Failed to run tests')
    } finally {
      setRunning(false)
    }
  }

  function startEdit(tc) {
    setEditingId(tc.id)
    setEditForm({
      name: tc.name,
      what_to_test: tc.what_to_test,
      expected_result: tc.expected_result,
      test_type: tc.test_type || 'required_field'
    })
  }

  async function handleSaveEdit(id) {
    try {
      const res = await fetch(`/api/test_cases/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
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
      await fetch(`/api/test_cases/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })
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
      const res = await fetch(`/api/projects/${project.id}/test_cases`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(newCase)
      })
      if (res.ok) {
        setNewCase({ name: '', what_to_test: '', expected_result: '', test_type: 'required_field' })
        setShowAddForm(false)
        setAddError('')
        await fetchTestCases()
      }
    } catch (err) {
      console.error('Failed to add:', err)
    }
  }

  const passed = testCases.filter(tc => normalizeTestStatus(tc.status) === 'Passed').length
  const failed = testCases.filter(tc => normalizeTestStatus(tc.status) === 'Failed').length
  const notRun = testCases.filter(tc => normalizeTestStatus(tc.status) === 'Not Run').length
  const hasPreviousRun = Boolean(comparison?.previous_run)

  async function downloadTestCasesReport() {
    try {
      setDownloading(true)
      const res = await fetch(`/api/projects/${project.id}/export/testcases`, {
        headers: { Authorization: `Bearer ${token}` }
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        alert(data.error || 'Failed to download test cases report')
        return
      }

      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${project.name} Test Cases.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
    } catch {
      alert('Failed to download test cases report')
    } finally {
      setDownloading(false)
    }
  }

  const groupDefinitions = [
    { key: 'fixed', label: 'Fixed' },
    { key: 'still_failing', label: 'Still Failing' },
    { key: 'newly_broken', label: 'Newly Broken' },
    { key: 'new_test_case', label: 'New Test Case' },
    { key: 'removed_test_case', label: 'Removed Test Case' }
  ]

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
            <>
              <button className="panel-generate-btn" onClick={handleGenerate} disabled={loading}>
                {loading ? <><span className="btn-spinner" /> Generating...</> : '✦ Generate'}
              </button>
              <button className="panel-add-btn" type="button" onClick={() => setShowAddForm(true)} disabled={loading}>
                + Add
              </button>
            </>
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
        {formStructureHint && (
          <p className="panel-subtitle">{formStructureHint}</p>
        )}

        {testCases.length > 0 && (
          <div className="panel-summary">
            <div className="summary-row summary-counts">
              <span className="summary-passed">✓ {passed} passed</span>
              <span className="summary-failed">✗ {failed} failed</span>
              <span className="summary-notrun">○ {notRun} not run</span>
            </div>
          </div>
        )}

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
            <label>Test Type</label>
            <select
              className="panel-input"
              value={newCase.test_type}
              onChange={e => setNewCase({ ...newCase, test_type: e.target.value })}
            >
              <option value="required_field">required_field</option>
              <option value="format_validation">format_validation</option>
              <option value="successful_submit">successful_submit</option>
            </select>
            {addError && <p className="panel-error">{addError}</p>}
            <div className="card-btns" style={{ marginTop: '12px' }}>
              <button className="btn-cancel" onClick={() => {
                setShowAddForm(false)
                setAddError('')
                setNewCase({ name: '', what_to_test: '', expected_result: '', test_type: 'required_field' })
              }}
              >
                Cancel
              </button>
              <button className="btn-save" onClick={handleAddCase}>Add</button>
            </div>
          </div>
        )}

        {comparison && (
          <div className="panel-comparison">
            <div className="comparison-header">
              <p className="comparison-summary">
                {hasPreviousRun
                  ? 'Compared to previous run'
                  : 'Run one more time to see a comparison with the previous run.'}
              </p>
              {testCases.length > 0 && (
                <button
                  className="comparison-export-btn"
                  onClick={downloadTestCasesReport}
                  disabled={downloading || running || loading}
                  title="Download Test Cases"
                  aria-label="Download Test Cases"
                >
                  {downloading ? 'Downloading...' : 'Download Test Cases'}
                </button>
              )}
            </div>
            {hasPreviousRun && (
              <div className="comparison-counts">
                <span className="comparison-pill comparison-fixed">Fixed: {comparison.counts?.fixed || 0}</span>
                <span className="comparison-pill comparison-still">Still failing: {comparison.counts?.still_failing || 0}</span>
                <span className="comparison-pill comparison-broken">Newly broken: {comparison.counts?.newly_broken || 0}</span>
                <span className="comparison-pill comparison-new">New: {comparison.counts?.new_test_case || 0}</span>
                <span className="comparison-pill comparison-removed">Removed: {comparison.counts?.removed_test_case || 0}</span>
              </div>
            )}
            {hasPreviousRun && (
              <div className="comparison-groups">
                {groupDefinitions.map(group => {
                  const items = comparison.groups?.[group.key] || []
                  if (items.length === 0) return null
                  return (
                    <div className="comparison-group" key={group.key}>
                      <p className="comparison-group-title">{group.label} ({items.length})</p>
                      <ul className="comparison-group-list">
                        {items.slice(0, 5).map(item => (
                          <li key={`${group.key}-${item.id}-${item.test_case_id}`}>
                            {item.snapshot_name || `Test case #${item.test_case_id}`}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {(loading || running) && testCases.length === 0 && (
          <div className="panel-loading">
            <div className="panel-spinner" />
          </div>
        )}

        <div className="panel-list">
          {testCases.length === 0 && !loading ? (
            <p className="panel-empty">No test cases yet. Click Generate to get started.</p>
          ) : (
            testCases.map((tc, index) => {
              const st = normalizeTestStatus(tc.status)
              return (
              <div
                className={`panel-card ${
                  st === 'Passed' ? 'card-passed' : st === 'Failed' ? 'card-failed' : ''
                }`}
                key={tc.id}
              >
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
                    <select
                      className="panel-input"
                      value={editForm.test_type}
                      onChange={e => setEditForm({ ...editForm, test_type: e.target.value })}
                    >
                      <option value="required_field">required_field</option>
                      <option value="format_validation">format_validation</option>
                      <option value="successful_submit">successful_submit</option>
                    </select>
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
                      <span
                        className={`tc-status ${
                          st === 'Passed' ? 'tc-passed' : st === 'Failed' ? 'tc-failed' : 'tc-notrun'
                        }`}
                      >
                        {st === 'Passed' ? '✓ Passed' : st === 'Failed' ? '✗ Failed' : 'Not Run'}
                      </span>
                      <div className="card-btns">
                        <button className="btn-edit" onClick={() => startEdit(tc)}>Edit</button>
                        <button className="btn-delete" onClick={() => setConfirmDelete(tc)}>Delete</button>
                      </div>
                    </div>
                    <div className="card-body">
                      <div className="card-field">
                        <span className="field-label">Test type</span>
                        <span className="field-value">{tc.test_type || 'required_field'}</span>
                      </div>
                      <div className="card-field">
                        <span className="field-label">What to test</span>
                        <span className="field-value">{tc.what_to_test}</span>
                      </div>
                      <div className="card-field">
                        <span className="field-label">Expected result</span>
                        <span className="field-value">{tc.expected_result}</span>
                      </div>
                      {tc.generation_reason && (
                        <div className="card-field">
                          <span className="field-label">Why this test was generated</span>
                          <span className="field-value">{tc.generation_reason}</span>
                        </div>
                      )}
                      {tc.notes && (
                        <div className="card-field">
                          <span className="field-label">Run notes</span>
                          <span className="field-value">
                            {tc.notes}
                            {String(tc.notes).includes('/uploads/') && (
                              <>
                                <br />
                                <a href={String(tc.notes).match(/\/uploads\/[^\s]+/)?.[0] || '#'} target="_blank" rel="noreferrer">
                                  View screenshot
                                </a>
                              </>
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )
            })
          )}
        </div>

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