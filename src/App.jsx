import { useState } from 'react'
import './App.css'
import Dashboard from './Dashboard'

function App() {
  const [loggedIn, setLoggedIn] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  function handleLogin() {
    if (email === '' || password === '') {
      setError('Email and Password are required')
      return
    }
    if (!email.includes('@') || !email.includes('.')) {
      setError('Please enter a valid email address')
      return
    }
    setError('')
    setLoggedIn(true)
  }

  if (loggedIn) {
    return <Dashboard email={email} onLogout={() => {
      setLoggedIn(false)
      setEmail('')
      setPassword('')
    }} />
  }

  return (
    <div className="login-page">
      <div className="login-container">
        <h1>QA Helper</h1>
        <label>Email Address</label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          placeholder="Enter your email address"
        />
        <label>Password</label>
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          placeholder="Enter your password"
        />
        {error && <p className="error-msg">{error}</p>}
        <button onClick={handleLogin}>Login</button>
      </div>
    </div>
  )
}

export default App