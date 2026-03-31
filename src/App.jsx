import { useEffect, useState } from 'react'
import './App.css'
import Dashboard from './Dashboard'

function App() {
  const [loggedIn, setLoggedIn] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [token, setToken] = useState('')
  const [authChecking, setAuthChecking] = useState(true)

  useEffect(() => {
    async function restoreSession() {
      const storedToken = localStorage.getItem('qahelper_token') || ''
      const storedEmail = localStorage.getItem('qahelper_email') || ''

      if (!storedToken) {
        setAuthChecking(false)
        return
      }

      try {
        const res = await fetch('/api/projects', {
          headers: { Authorization: `Bearer ${storedToken}` }
        })

        if (!res.ok) {
          throw new Error('Stored session is invalid')
        }

        setToken(storedToken)
        setEmail(storedEmail)
        setLoggedIn(true)
      } catch {
        localStorage.removeItem('qahelper_token')
        localStorage.removeItem('qahelper_email')
        setToken('')
        setLoggedIn(false)
      } finally {
        setAuthChecking(false)
      }
    }

    restoreSession()
  }, [])

  async function handleLogin() {
    if (email === '' || password === '') {
      setError('Email and Password are required')
      return
    }
    if (!email.includes('@') || !email.includes('.')) {
      setError('Please enter a valid email address')
      return
    }
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Login failed')
        return
      }
      setError('')
      const nextToken = data.token || ''
      const nextEmail = data?.user?.email || email
      setToken(nextToken)
      setEmail(nextEmail)
      setLoggedIn(true)
      localStorage.setItem('qahelper_token', nextToken)
      localStorage.setItem('qahelper_email', nextEmail)
    } catch {
      setError('Login failed')
    }
  }

  if (authChecking) {
    return (
      <div className="login-page">
        <div className="login-container">
          <h1>QA Helper</h1>
          <p>Checking your session...</p>
        </div>
      </div>
    )
  }

  if (loggedIn) {
    return <Dashboard email={email} token={token} onLogout={() => {
      setLoggedIn(false)
      setEmail('')
      setPassword('')
      setToken('')
      localStorage.removeItem('qahelper_token')
      localStorage.removeItem('qahelper_email')
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