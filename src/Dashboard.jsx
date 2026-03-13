import './Dashboard.css'
import { useState } from 'react'

function Dashboard({ email, onLogout }) {
  const [showModal, setShowModal] = useState(false)
  const [projects, setProjects] = useState([])
  const [projectName, setProjectName] = useState('')
  const [formUrl, setFormUrl] = useState('')

  function handleCreateProject() {
    if (projectName === '' || formUrl === '') return
    setProjects([...projects, { name: projectName, url: formUrl, status: 'Not Tested' }])
    setProjectName('')
    setFormUrl('')
    setShowModal(false)
  }

  function handleDelete(index) {
    setProjects(projects.filter((_, i) => i !== index))
  }

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
        <h2>Projects</h2>

        <div className="filters">
          <button className="filter active">All Projects</button>
          <button className="filter">Not Tested</button>
          <button className="filter">In Progress</button>
          <button className="filter">Passed</button>
          <button className="filter">Failed</button>
        </div>

        <div className="table-header">
          <span>Project Name</span>
          <span>Form URL</span>
          <span>Last Tested</span>
          <span>Status</span>
          <span>Actions</span>
        </div>

        {projects.length === 0 ? (
          <div className="empty-state">
            <p>No projects yet. Click New Project to get started.</p>
          </div>
        ) : (
          projects.map((project, index) => (
            <div className="table-row" key={index}>
              <span>{project.name}</span>
              <span>{project.url}</span>
              <span>Never</span>
              <span className="status-badge">{project.status}</span>
              <div className="action-buttons">
                <button className="run-btn">Run Test</button>
                <button className="delete-btn" onClick={() => handleDelete(index)}>Delete</button>
              </div>
            </div>
          ))
        )}

        <button className="new-project-btn" onClick={() => setShowModal(true)}>+ New Project</button>
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
              placeholder="Enter form URL"
              value={formUrl}
              onChange={(e) => setFormUrl(e.target.value)}
            />
            <label>Requirements Document</label>
            <input type="file" accept=".pdf,.doc,.docx" />
            <div className="modal-buttons">
              <button onClick={() => setShowModal(false)}>Cancel</button>
              <button className="submit-btn" onClick={handleCreateProject}>Create Project</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Dashboard