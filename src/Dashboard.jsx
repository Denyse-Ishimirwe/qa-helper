import './Dashboard.css'
import { useState } from 'react'

function Dashboard({ email, onLogout }) {
  const [showModal, setShowModal] = useState(false)
  const [projects, setProjects] = useState([])
  const [projectName, setProjectName] = useState('')
  const [formUrl, setFormUrl] = useState('')
  const [activeFilter, setActiveFilter] = useState('All Projects')

  function handleCreateProject() {
    if (projectName === '' || formUrl === '') return
    setProjects([...projects, {
      name: projectName,
      url: formUrl,
      status: 'Not Tested',
      lastTested: 'Never'
    }])
    setProjectName('')
    setFormUrl('')
    setShowModal(false)
  }

  function handleDelete(index) {
    setProjects(projects.filter((_, i) => i !== index))
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
          filteredProjects.map((project, index) => (
            <div className="table-row" key={index}>
              <span>{project.name}</span>
              <span className="url-cell">{project.url}</span>
              <span>{project.lastTested}</span>
              <span className={`status-badge ${project.status.toLowerCase().replace(' ', '-')}`}>
                {project.status}
              </span>
              <div className="action-buttons">
                <button className="run-btn">Run Test</button>
                <button
                  className="delete-btn"
                  onClick={() => handleDelete(index)}
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
            <input type="file" accept=".pdf,.doc,.docx" />
            <div className="modal-buttons">
              <button onClick={() => setShowModal(false)}>Cancel</button>
              <button
                className="submit-btn"
                onClick={handleCreateProject}
              >
                Create Project
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

export default Dashboard