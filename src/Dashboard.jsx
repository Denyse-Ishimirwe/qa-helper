import './Dashboard.css'
import { useState, useEffect, useRef } from 'react'
import TestPanel from './TestPanel'

function Dashboard({ email, token, onLogout }) {
  const [showModal, setShowModal] = useState(false)
  const [projects, setProjects] = useState([])
  const [projectName, setProjectName] = useState('')
  const [formUrl, setFormUrl] = useState('')
  const [notionUrl, setNotionUrl] = useState('')
  const [srdFile, setSrdFile] = useState(null)
  const [activeFilter, setActiveFilter] = useState('All Projects')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedProject, setSelectedProject] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [editProject, setEditProject] = useState(null)
  const [editName, setEditName] = useState('')
  const [editUrl, setEditUrl] = useState('')
  const [editNotionUrl, setEditNotionUrl] = useState('')
  const [editSrd, setEditSrd] = useState(null)
  const [editError, setEditError] = useState('')
  const [editLoading, setEditLoading] = useState(false)
  const [openMenu, setOpenMenu] = useState(null)
  const menuRef = useRef(null)
  const [projectsLoadError, setProjectsLoadError] = useState('')

  useEffect(() => {
    fetchProjects()
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const projectId = Number(params.get('project') || 0)
    if (!projectId || projects.length === 0) return
    const match = projects.find(p => Number(p.id) === projectId)
    if (match) setSelectedProject(match)
  }, [projects])

  useEffect(() => {
    function handleClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setOpenMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  async function fetchProjects() {
    try {
      setProjectsLoadError('')
  
      const res = await fetch('/api/projects', {
        headers: { Authorization: `Bearer ${token}` }
      })
  
      if (!res.ok) {
        throw new Error(`Unable to load projects (HTTP ${res.status})`)
      }
  
      const data = await res.json()
      if (!Array.isArray(data)) {
        throw new Error('Unexpected response while loading projects')
      }

      setProjects(data)
    } catch (err) {
      setProjects([])
      setProjectsLoadError("We couldn't load your projects at the moment. Please refresh and try again.")
      console.error('Failed to load projects:', err)
    }
  }

  async function handleCreateProject() {
    if (projectName === '') {
      setError('Project name is required')
      return
    }
    if (!srdFile && notionUrl.trim() === '') {
      setError('Upload an SRD document or provide a Notion URL')
      return
    }

    setLoading(true)
    setError('')

    try {
      const formData = new FormData()
      formData.append('name', projectName)
      formData.append('form_url', formUrl)
      if (srdFile) formData.append('srd', srdFile)
      if (notionUrl.trim()) formData.append('notion_url', notionUrl.trim())

      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Failed to create project')
        return
      }

      await fetchProjects()
      setProjectName('')
      setFormUrl('')
      setNotionUrl('')
      setSrdFile(null)
      setShowModal(false)

    } catch {
      setError('Failed to create project')
    } finally {
      setLoading(false)
    }
  }

  function openEditModal(project) {
    setEditProject(project)
    setEditName(project.name)
    setEditUrl(project.form_url || '')
    setEditNotionUrl('')
    setEditSrd(null)
    setEditError('')
    setOpenMenu(null)
  }

  async function handleEditProject() {
    if (!editName) {
      setEditError('Project name is required')
      return
    }

    setEditLoading(true)
    setEditError('')

    try {
      const formData = new FormData()
      formData.append('name', editName)
      formData.append('form_url', editUrl)
      if (editSrd) formData.append('srd', editSrd)
      if (editNotionUrl.trim()) formData.append('notion_url', editNotionUrl.trim())

      const res = await fetch(`/api/projects/${editProject.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      })

      const data = await res.json()

      if (!res.ok) {
        setEditError(data.error || 'Failed to update project')
        return
      }

      await fetchProjects()
      setEditProject(null)

    } catch {
      setEditError('Failed to update project')
    } finally {
      setEditLoading(false)
    }
  }

  async function handleDelete(id) {
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to delete project')
      }
      await fetchProjects()
      setConfirmDelete(null)
    } catch (err) {
      console.error('Failed to delete project:', err)
      alert(err.message || 'Failed to delete project')
    }
  }

  const filters = ['All Projects', 'Not Tested', 'In Progress', 'Passed', 'Failed']

  const filteredProjects = activeFilter === 'All Projects'
    ? projects
    : projects.filter(p => p.status === activeFilter)

  return (
    <div className="page">

      <div className="topbar">
        <h1>QA Helper</h1>
        <div className="user-info">
          <span>{email}</span>
          <button onClick={onLogout}>Logout</button>
        </div>
      </div>

      <div className="content">

        <div className="content-top">
          <h2>Projects</h2>
          <button className="new-project-btn" onClick={() => setShowModal(true)}>
            + New Project
          </button>
        </div>

        <div className="filters">
          {filters.map(f => (
            <button
              key={f}
              className={`filter ${activeFilter === f ? 'active' : ''}`}
              onClick={() => setActiveFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        {projectsLoadError && (
          <div className="projects-load-error">
            {projectsLoadError}
          </div>
        )}

        <div className="table-header">
          <span>Project Name</span>
          <span>Form URL</span>
          <span>Last Tested</span>
          <span>Status</span>
          <span>Actions</span>
        </div>

        {filteredProjects.length === 0 ? (
          <div className="empty-state">
            <p>
              {activeFilter === 'All Projects'
                ? 'No projects yet. Click New Project to get started.'
                : `No projects with status "${activeFilter}".`}
            </p>
          </div>
        ) : (
          filteredProjects.map((project) => (
            <div className="table-row" key={project.id}>
              <span>{project.name}</span>
              <span className="url-cell">{project.form_url || 'Portal / no direct URL'}</span>
              <span>{project.last_tested}</span>
              <span className={`status-badge ${project.status.toLowerCase().replace(' ', '-')}`}>
                {project.status}
              </span>
              <div className="action-buttons">
                <button
                  className="run-btn"
                  onClick={() => setSelectedProject(project)}
                >
                  View / Test
                </button>
                <div className="menu-wrapper" ref={openMenu === project.id ? menuRef : null}>
                  <button
                    className="menu-btn"
                    onClick={() => setOpenMenu(openMenu === project.id ? null : project.id)}
                  >
                    ⋯
                  </button>
                  {openMenu === project.id && (
                    <div className="dropdown-menu">
                      <button onClick={() => openEditModal(project)}>Edit</button>
                      <button
                        className="dropdown-delete"
                        onClick={() => { setConfirmDelete(project); setOpenMenu(null) }}
                      >
                         Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))
        )}

      </div>

      {selectedProject && (
        <TestPanel
          project={selectedProject}
          token={token}
          onClose={() => {
            setSelectedProject(null)
            fetchProjects()
          }}
        />
      )}

      {/* Confirm delete modal */}
      {confirmDelete && (
        <div className="modal-overlay">
          <div className="modal">
            <h2>Delete Project</h2>
            <p style={{ color: '#444', fontSize: '14px', marginTop: '-8px' }}>
              Are you sure you want to delete <strong>{confirmDelete.name}</strong>? This will also delete all its test cases and cannot be undone.
            </p>
            <div className="modal-buttons">
              <button onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button
                className="submit-btn"
                style={{ background: 'red', borderColor: 'red' }}
                onClick={() => handleDelete(confirmDelete.id)}
              >
                Yes, Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit project modal */}
      {editProject && (
        <div className="modal-overlay">
          <div className="modal">
            <h2>Edit Project</h2>
            <label>Project Name</label>
            <input
              type="text"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              placeholder="Enter project name"
            />
            <label>Form URL</label>
            <input
              type="text"
              value={editUrl}
              onChange={e => setEditUrl(e.target.value)}
              placeholder="https://example.com/form"
            />
            <label>Replace SRD Document</label>
            <p className="srd-note">Your current SRD is saved. Only upload a new file if you want to replace it.</p>
            <input
              type="file"
              accept=".pdf,.doc,.docx"
              onChange={e => setEditSrd(e.target.files[0])}
            />
            <label>Or Notion SRD URL</label>
            <input
              type="text"
              value={editNotionUrl}
              onChange={e => setEditNotionUrl(e.target.value)}
              placeholder="https://www.notion.so/..."
            />
            {editError && <p className="error-msg">{editError}</p>}
            <div className="modal-buttons">
              <button onClick={() => setEditProject(null)}>Cancel</button>
              <button
                className="submit-btn"
                onClick={handleEditProject}
                disabled={editLoading}
              >
                {editLoading ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New project modal */}
      {showModal && (
        <div className="modal-overlay">
          <div className="modal">
            <h2>New Project</h2>
            <label>Project Name</label>
            <input
              type="text"
              placeholder="Enter project name"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
            />
            <label>Form URL</label>
            <input
              type="text"
              placeholder="https://example.com/form (optional)"
              value={formUrl}
              onChange={(e) => setFormUrl(e.target.value)}
            />
            <label>Requirements Document</label>
            <input
              type="file"
              accept=".pdf,.doc,.docx"
              onChange={(e) => setSrdFile(e.target.files[0])}
            />
            <label>Or Notion SRD URL</label>
            <input
              type="text"
              placeholder="https://www.notion.so/..."
              value={notionUrl}
              onChange={(e) => setNotionUrl(e.target.value)}
            />
            {error && <p className="error-msg">{error}</p>}
            <div className="modal-buttons">
              <button onClick={() => { setShowModal(false); setError('') }}>Cancel</button>
              <button
                className="submit-btn"
                onClick={handleCreateProject}
                disabled={loading}
              >
                {loading ? 'Creating...' : 'Create Project'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

export default Dashboard