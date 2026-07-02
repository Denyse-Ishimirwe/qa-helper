import './TestPanel.css'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  buildSectionOrder,
  groupTestCasesBySection,
  inferSectionFromTestCase,
  isUnsetSection,
  GENERAL_SECTION
} from '../sections.js'

/** Normalize API/DB status so UI counts match each card. */
function normalizeTestStatus(status) {
  const s = String(status || '').trim().toLowerCase()
  if (s === 'passed') return 'Passed'
  if (s === 'failed') return 'Failed'
  if (s === 'skipped') return 'Skipped'
  return 'Not Run'
}

/** Map legacy conditional types to the unified type for display and editing. */
function normalizeTestTypeUi(raw) {
  const t = String(raw || '').trim()
  if (t === 'conditional_display' || t === 'conditional_required') return 'conditional_field'
  return t || 'required_field'
}

function TestPanel({ project, token, onProjectsNeedRefresh, onClose }) {
  const [testCases, setTestCases] = useState([])
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState({ name: '', what_to_test: '', expected_result: '', test_type: 'required_field', section: '', block: '' })
  const [showAddForm, setShowAddForm] = useState(false)
  const [newCase, setNewCase] = useState({ name: '', what_to_test: '', expected_result: '', test_type: 'required_field', section: '', block: '' })
  const [addError, setAddError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [comparison, setComparison] = useState(null)
  const [downloading, setDownloading] = useState(false)
  const [formStructureHint, setFormStructureHint] = useState('')
  const [collapsedSections, setCollapsedSections] = useState({})
  const [runningSection, setRunningSection] = useState('')
  const [statusFilter, setStatusFilter] = useState('All')
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
    setStatusFilter('All')
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
        const sectionCount = Array.isArray(parsed?.sections)
          ? parsed.sections.length
          : new Set((parsed?.fields || []).map(f => String(f?.section || '').trim()).filter(Boolean)).size
        const hasSubmit = Boolean(parsed?.submitButton)
        if (fieldCount > 0) {
          setFormStructureHint(
            `Found ${fieldCount} fields${sectionCount > 0 ? ` in ${sectionCount} section${sectionCount !== 1 ? 's' : ''}` : ''}${hasSubmit ? ' and a submit button' : ''}`
          )
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
        if (res.status === 409 && onProjectsNeedRefresh) await onProjectsNeedRefresh()
        alert(data.error || 'Failed to generate test cases')
        return
      }
      await fetchTestCases()
      await onProjectsNeedRefresh?.()
    } catch {
      alert('Failed to generate test cases')
    } finally {
      setLoading(false)
    }
  }

  async function handleRun(sections = null) {
    setRunning(true)
    setRunningSection(Array.isArray(sections) && sections.length === 1 ? sections[0] : '')
    try {
      const body = Array.isArray(sections) && sections.length > 0 ? { sections } : undefined
      const res = await fetch(`/api/projects/${project.id}/run`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      })
      const data = await res.json()
      if (!res.ok) {
        alert(data.error || 'Failed to run tests')
        return
      }
      await fetchTestCases()
      await fetchComparison()
      await onProjectsNeedRefresh?.()
    } catch {
      alert('Failed to run tests')
    } finally {
      setRunning(false)
      setRunningSection('')
    }
  }

  function startEdit(tc) {
    setEditingId(tc.id)
    setEditForm({
      name: tc.name,
      what_to_test: tc.what_to_test,
      expected_result: tc.expected_result,
      test_type: normalizeTestTypeUi(tc.test_type),
      section: displaySection(tc),
      block: tc.block || ''
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
    const idNum = Number(id)
    const snapshot = testCases
    const removed = testCases.find(tc => Number(tc.id) === idNum)
    setTestCases(prev => prev.filter(tc => Number(tc.id) !== idNum))
    setConfirmDelete(null)

    try {
      const res = await fetch(`/api/test_cases/${idNum}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) {
        setTestCases(snapshot)
        if (removed) setConfirmDelete(removed)
        alert('Could not delete that test case. Please try again.')
        return
      }
      void fetchTestCases()
      void onProjectsNeedRefresh?.()
    } catch (err) {
      console.error('Failed to delete:', err)
      setTestCases(snapshot)
      if (removed) setConfirmDelete(removed)
      alert('Could not delete that test case. Please try again.')
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
        setNewCase({ name: '', what_to_test: '', expected_result: '', test_type: 'required_field', section: '', block: '' })
        setShowAddForm(false)
        setAddError('')
        await fetchTestCases()
        await onProjectsNeedRefresh?.()
      }
    } catch (err) {
      console.error('Failed to add:', err)
    }
  }

  const passed = testCases.filter(tc => normalizeTestStatus(tc.status) === 'Passed').length
  const failed = testCases.filter(tc => normalizeTestStatus(tc.status) === 'Failed').length
  const skipped = testCases.filter(tc => normalizeTestStatus(tc.status) === 'Skipped').length
  const notRun = testCases.filter(tc => normalizeTestStatus(tc.status) === 'Not Run').length
  const hasPreviousRun = Boolean(comparison?.previous_run)
  const hasAnyRun = testCases.some(tc => normalizeTestStatus(tc.status) !== 'Not Run')

  function displaySection(tc) {
    const resolved = String(tc?.section || '').trim() || inferSectionFromTestCase(tc)
    return isUnsetSection(resolved) ? GENERAL_SECTION : resolved
  }

  const filteredTestCases = useMemo(() => {
    if (statusFilter === 'All') return testCases
    return testCases.filter(tc => normalizeTestStatus(tc.status) === statusFilter)
  }, [testCases, statusFilter])

  const sectionGroups = useMemo(() => {
    const order = buildSectionOrder(testCases, project?.form_structure)
    const groups = groupTestCasesBySection(filteredTestCases, order)
    return groups.filter(group => group.cases.length > 0)
  }, [filteredTestCases, testCases, project?.form_structure])

  const statusFilterOptions = useMemo(() => {
    const options = [
      { key: 'All', label: 'All', count: testCases.length },
      { key: 'Passed', label: 'Passed', count: passed },
      { key: 'Failed', label: 'Failed', count: failed },
      { key: 'Not Run', label: 'Not run', count: notRun }
    ]
    if (skipped > 0) {
      options.push({ key: 'Skipped', label: 'Skipped', count: skipped })
    }
    return options
  }, [testCases.length, passed, failed, notRun, skipped])

  function sectionCounts(cases) {
    const passed = cases.filter(tc => normalizeTestStatus(tc.status) === 'Passed').length
    const failed = cases.filter(tc => normalizeTestStatus(tc.status) === 'Failed').length
    const skipped = cases.filter(tc => normalizeTestStatus(tc.status) === 'Skipped').length
    const pending = cases.filter(tc => normalizeTestStatus(tc.status) === 'Not Run').length
    return { passed, failed, skipped, pending, total: cases.length }
  }

  function toggleSection(sectionName) {
    setCollapsedSections(prev => ({
      ...prev,
      [sectionName]: !prev[sectionName]
    }))
  }

  function renderTestCard(tc, index) {
    const st = normalizeTestStatus(tc.status)
    return (
      <div
        className={`panel-card ${
          st === 'Passed' ? 'card-passed' : st === 'Failed' ? 'card-failed' : st === 'Skipped' ? 'card-skipped' : ''
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
              value={editForm.section}
              onChange={e => setEditForm({ ...editForm, section: e.target.value })}
              placeholder="Section name"
            />
            <input
              className="panel-input"
              value={editForm.block}
              onChange={e => setEditForm({ ...editForm, block: e.target.value })}
              placeholder="Block name"
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
              <option value="conditional_field">conditional_field</option>
              <option value="widget_auto_fill">widget_auto_fill</option>
              <option value="attachment">attachment</option>
              <option value="label_check">label_check</option>
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
                  st === 'Passed'
                    ? 'tc-passed'
                    : st === 'Failed'
                      ? 'tc-failed'
                      : st === 'Skipped'
                        ? 'tc-skipped'
                        : 'tc-notrun'
                }`}
              >
                {st === 'Passed'
                  ? '✓ Passed'
                  : st === 'Failed'
                    ? '✗ Failed'
                    : st === 'Skipped'
                      ? '⊘ Skipped'
                      : 'Not Run'}
              </span>
              <div className="card-btns">
                <button className="btn-edit" onClick={() => startEdit(tc)}>Edit</button>
                <button className="btn-delete" onClick={() => setConfirmDelete(tc)}>Delete</button>
              </div>
            </div>
            <div className="card-body">
              <div className="card-field">
                <span className="field-label">Section</span>
                <span className="field-value">{displaySection(tc)}</span>
              </div>
              {tc.block && (
                <div className="card-field">
                  <span className="field-label">Block</span>
                  <span className="field-value">{tc.block}</span>
                </div>
              )}
              <div className="card-field">
                <span className="field-label">Test type</span>
                <span className="field-value">{normalizeTestTypeUi(tc.test_type)}</span>
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
  }

  const srdImportStatus = String(project.srd_import_status || 'ready')
  const srdImportPending = srdImportStatus === 'pending'
  const srdImportFailed = srdImportStatus === 'failed'
  const srdBlocksGenerate = srdImportPending || srdImportFailed

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
                ? statusFilter === 'All'
                  ? `${testCases.length} test case${testCases.length !== 1 ? 's' : ''}`
                  : `${filteredTestCases.length} of ${testCases.length} · ${statusFilter}`
                : 'No test cases yet'}
            </p>
          </div>
          <button className="panel-close-btn" onClick={onClose}>✕</button>
        </div>

        {srdBlocksGenerate && (
          <div
            className={`panel-srd-notice ${srdImportFailed ? 'panel-srd-notice-failed' : ''}`}
            role="status"
          >
            {srdImportPending
              ? 'Requirements document is importing in the background. Generate unlocks when it finishes (a few seconds for most files).'
              : `Import failed: ${String(project.srd_import_error || '').trim() || 'Edit the project to upload the SRD again or fix the Notion URL.'}`}
          </div>
        )}

        <div className="panel-actions">
          {testCases.length === 0 ? (
            <>
              <button
                className="panel-generate-btn"
                onClick={handleGenerate}
                disabled={loading || srdBlocksGenerate}
              >
                {loading ? <><span className="btn-spinner" /> Generating...</> : '✦ Generate'}
              </button>
              <button className="panel-add-btn" type="button" onClick={() => setShowAddForm(true)} disabled={loading}>
                + Add
              </button>
            </>
          ) : (
            <>
              <button className="panel-run-btn" onClick={() => handleRun()} disabled={running || loading}>
                {running && !runningSection ? <><span className="btn-spinner" /> Running all sections...</> : runningSection ? <><span className="btn-spinner" /> Running {runningSection}...</> : '▶ Run All Sections'}
              </button>
              <button
                className="panel-regenerate-btn"
                onClick={handleGenerate}
                disabled={loading || running || srdBlocksGenerate}
              >
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
              {skipped > 0 && <span className="summary-skipped">⊘ {skipped} skipped</span>}
              <span className="summary-notrun">○ {notRun} not run</span>
            </div>
            <div className="panel-status-filters" role="group" aria-label="Filter test cases by status">
              {statusFilterOptions.map(option => (
                <button
                  key={option.key}
                  type="button"
                  className={`panel-status-filter ${statusFilter === option.key ? 'active' : ''}`}
                  onClick={() => setStatusFilter(option.key)}
                  aria-pressed={statusFilter === option.key}
                >
                  {option.label}
                  <span className="panel-status-filter-count">{option.count}</span>
                </button>
              ))}
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
            <label>Section</label>
            <input
              className="panel-input"
              type="text"
              placeholder="e.g. Applicant Details"
              value={newCase.section}
              onChange={e => setNewCase({ ...newCase, section: e.target.value })}
            />
            <label>Block</label>
            <input
              className="panel-input"
              type="text"
              placeholder="e.g. Personal Information"
              value={newCase.block}
              onChange={e => setNewCase({ ...newCase, block: e.target.value })}
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
              <option value="conditional_field">conditional_field</option>
              <option value="widget_auto_fill">widget_auto_fill</option>
              <option value="attachment">attachment</option>
              <option value="label_check">label_check</option>
            </select>
            {addError && <p className="panel-error">{addError}</p>}
            <div className="card-btns" style={{ marginTop: '12px' }}>
              <button className="btn-cancel" onClick={() => {
                setShowAddForm(false)
                setAddError('')
                setNewCase({ name: '', what_to_test: '', expected_result: '', test_type: 'required_field', section: '', block: '' })
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
                        {items.map(item => (
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
            <p className="panel-empty">
              {srdImportPending
                ? 'No test cases yet. Wait for the requirements document to finish importing, then click Generate.'
                : srdImportFailed
                  ? 'No test cases yet. Fix the SRD import (Edit project), then click Generate.'
                  : 'No test cases yet. Click Generate to get started.'}
            </p>
          ) : filteredTestCases.length === 0 ? (
            <p className="panel-empty">
              No {statusFilter === 'Not Run' ? 'not run' : statusFilter.toLowerCase()} test cases in this project.
            </p>
          ) : (
            sectionGroups.map(group => {
              const counts = sectionCounts(group.cases)
              const collapsed = Boolean(collapsedSections[group.section])
              let cardIndex = 0
              return (
                <div className="panel-section-group" key={group.section}>
                  <div className="panel-section-header">
                    <button
                      type="button"
                      className="panel-section-toggle"
                      onClick={() => toggleSection(group.section)}
                      aria-expanded={!collapsed}
                    >
                      <span className="panel-section-chevron">{collapsed ? '▸' : '▾'}</span>
                      <span className="panel-section-title">{group.section}</span>
                      <span className="panel-section-counts">
                        {counts.total} test{counts.total !== 1 ? 's' : ''}
                        {counts.passed > 0 && <span className="summary-passed"> · ✓ {counts.passed}</span>}
                        {counts.failed > 0 && <span className="summary-failed"> · ✗ {counts.failed}</span>}
                        {counts.skipped > 0 && <span className="summary-skipped"> · ⊘ {counts.skipped}</span>}
                        {counts.pending > 0 && <span className="summary-notrun"> · ○ {counts.pending}</span>}
                      </span>
                    </button>
                    {hasAnyRun && (
                      <button
                        type="button"
                        className="panel-section-run-btn"
                        onClick={() => handleRun([group.section])}
                        disabled={running || loading}
                        title={`Run only ${group.section}`}
                      >
                        {runningSection === group.section ? 'Running…' : 'Run section'}
                      </button>
                    )}
                  </div>
                  {!collapsed && group.cases.map(tc => {
                    cardIndex += 1
                    return renderTestCard(tc, cardIndex - 1)
                  })}
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