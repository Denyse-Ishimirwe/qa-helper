import './Dashboard.css'
import { useState, useEffect } from 'react'

function Dashboard({ email, onLogout }) {
  const [showModal, setShowModal] = useState(false)
  const [projects, setProjects] = useState([])
  const [projectName, setProjectName] = useState('')
  const [formUrl, setFormUrl] = useState('')
  const [srdFile, setSrdFile] = useState(null)
  const [activeFilter, setActiveFilter] = useState('All Projects')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Load projects from backend when dashboard opens
  useEffect(() => {
    fetchProjects()
  }, [])

  async function fetchProjects() {
    try {
      const res = await fetch('http://localhost:3000/api/projects')
      const data = await res.json()
      setProjects(data)
    } catch (err) {
      console.error('Failed to load projects:', err)
    }
  }

  async function handleCreateProject() {
    if (projectName === '' || formUrl === '') {
      setError('Project name and form URL are required')
      return
    }
    if (!srdFile) {
      setError('Please upload an SRD document')
      return
    }

    setLoading(true)
    setError('')

    try {
      const formData = new FormData()
      formData.append('name', projectName)
      formData.append('form_url', formUrl)
      formData.append('srd', srdFile)

      const res = await fetch('http://localhost:3000/api/projects', {
        method: 'POST',
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
      setSrdFile(null)
      setShowModal(false)

    } catch (err) {
      setError('Failed to create project')
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(id) {
    try {
      await fetch(`http://localhost:3000/api/projects/${id}`, {
        method: 'DELETE'
      })
      await fetchProjects()
    } catch (err) {
      console.error('Failed to delete project:', err)
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
          <button
            className="new-project-btn"
            onClick={() => setShowModal(true)}
          >
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
              <span className="url-cell">{project.form_url}</span>
              <span>{project.last_tested}</span>
              <span className={`status-badge ${project.status.toLowerCase().replace(' ', '-')}`}>
                {project.status}
              </span>
              <div className="action-buttons">
                <button className="run-btn">Run Test</button>
                <button
                  className="delete-btn"
                  onClick={() => handleDelete(project.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}

      </div>

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
              placeholder="https://example.com/form"
              value={formUrl}
              onChange={(e) => setFormUrl(e.target.value)}
            />
            <label>Requirements Document</label>
            <input
              type="file"
              accept=".pdf,.doc,.docx"
              onChange={(e) => setSrdFile(e.target.files[0])}
            />
            {error && <p className="error-msg">{error}</p>}
            <div className="modal-buttons">
              <button onClick={() => {
                setShowModal(false)
                setError('')
              }}>Cancel</button>
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