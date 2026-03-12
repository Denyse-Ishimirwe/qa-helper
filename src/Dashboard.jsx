import './Dashboard.css'

function Dashboard({ email, onLogout }) {
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
          <span>Action</span>
        </div>

        <div className="empty-state">
          <p>No projects yet. Click New Project to get started.</p>
        </div>

        <button className="new-project-btn">+ New Project</button>
      </div>

    </div>
  )
}

export default Dashboard