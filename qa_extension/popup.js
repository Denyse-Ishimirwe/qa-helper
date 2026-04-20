/* global chrome */
const API_BASE = 'http://localhost:3000'
const APP_BASE = 'http://localhost:5173'
const APP_BASES = ['http://localhost:5173', 'https://qa-helper-tool.onrender.com']
const ACTIVE_JOB_KEY = 'qa_ext_active_job'
let lastEventSeq = 0

const els = {
  email: document.getElementById('email'),
  password: document.getElementById('password'),
  loginBtn: document.getElementById('loginBtn'),
  runBtn: document.getElementById('runTest'),
  saveSessionBtn: document.getElementById('saveSessionBtn'),
  sessionStatus: document.getElementById('sessionStatus'),
  projectSelect: document.getElementById('projectSelect'),
  status: document.getElementById('status'),
  statusWrap: document.getElementById('statusWrap'),
  results: document.getElementById('results'),
  viewBtn: document.getElementById('viewResultsBtn'),
  openAppBtn: document.getElementById('openAppBtn')
}

function getStoredToken() {
  return localStorage.getItem('qa_ext_token') || ''
}

function setStoredToken(token) {
  if (token) localStorage.setItem('qa_ext_token', token)
  else localStorage.removeItem('qa_ext_token')
}

function setActiveJob(job) {
  if (!job) {
    localStorage.removeItem(ACTIVE_JOB_KEY)
    return
  }
  localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify(job))
}

function getActiveJob() {
  try {
    const raw = localStorage.getItem(ACTIVE_JOB_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getStoredToken()}`
  }
}

function setStatus(text, running = false) {
  if (els.status) els.status.textContent = text
  if (els.statusWrap) {
    if (running) els.statusWrap.classList.add('running')
    else els.statusWrap.classList.remove('running')
  }
}

function setSessionStatus(text, color = '#666') {
  if (!els.sessionStatus) return
  els.sessionStatus.textContent = text || ''
  els.sessionStatus.style.color = color
}

function openApp() {
  chrome.tabs.create({ url: APP_BASE })
}

function showOpenApp(text) {
  setStatus(text)
  if (els.openAppBtn) {
    els.openAppBtn.style.display = 'block'
    els.openAppBtn.onclick = openApp
  }
}

function hideOpenApp() {
  if (els.openAppBtn) els.openAppBtn.style.display = 'none'
}

async function readTokenFromAppTab() {
  const tabs = await chrome.tabs.query({})
  const appTab = tabs.find(t => {
    const u = String(t?.url || '')
    return APP_BASES.some(base => u.startsWith(base))
  })
  if (!appTab?.id) return ''

  const injected = await chrome.scripting.executeScript({
    target: { tabId: appTab.id },
    func: () => localStorage.getItem('qahelper_token') || ''
  })
  return String(injected?.[0]?.result || '').trim()
}

async function ensureExtensionToken() {
  const existing = getStoredToken()
  if (existing) return existing
  try {
    const fromApp = await readTokenFromAppTab()
    if (fromApp) {
      setStoredToken(fromApp)
      return fromApp
    }
  } catch {
    // Fall back to manual extension login if script injection is blocked on current tab.
  }
  return ''
}

function renderResults(data) {
  const checks = Array.isArray(data?.checks) ? data.checks : []
  const summary = data?.summary || 'No summary available.'
  if (!checks.length) {
    els.results.innerHTML = '<div class="check fail">No checks were returned by backend.</div>'
    return
  }
  const rows = checks
    .map(c => {
      const cls = c.passed ? 'pass' : 'fail'
      const icon = c.passed ? 'PASS' : 'FAIL'
      return `<div class="check ${cls}"><strong>${icon}: ${c.name}</strong><br>${c.notes || ''}</div>`
    })
    .join('')
  els.results.innerHTML = `<div class="check"><strong>${summary}</strong></div>${rows}`
}

async function loadProjects() {
  try {
    hideOpenApp()
    const token = await ensureExtensionToken()
    if (!token) {
      showOpenApp('Please log in to QA Helper first')
      return
    }
    const res = await fetch(`${API_BASE}/api/projects`, { headers: authHeaders() })
    if (res.status === 401 || res.status === 403) {
      setStoredToken('')
      showOpenApp('Please log in to QA Helper first')
      return
    }
    if (!res.ok) throw new Error('Failed to fetch projects')
    const projects = await res.json()
    if (!Array.isArray(projects) || projects.length === 0) {
      els.projectSelect.innerHTML = '<option value="">No projects available</option>'
      showOpenApp('No projects found — create one in the app first')
      return
    }
    const options = ['<option value="">Select project</option>']
    for (const p of projects) options.push(`<option value="${p.id}">${p.name}</option>`)
    els.projectSelect.innerHTML = options.join('')
    setStatus(`Loaded ${projects.length} projects`)
    hideOpenApp()
  } catch (err) {
    setStatus(err.message || 'Failed to load projects')
  }
}

async function login() {
  const email = String(els.email.value || '').trim()
  const password = String(els.password.value || '')
  if (!email || !password) {
    setStatus('Enter email and password')
    return
  }
  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.token) throw new Error(data.error || 'Login failed')
    setStoredToken(data.token)
    hideOpenApp()
    setStatus(`Logged in as ${data?.user?.email || email}`)
    await loadProjects()
    await refreshSessionStatus()
  } catch (err) {
    setStatus(err.message || 'Login failed')
  }
}

function scanFieldsFromTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'QA_HELPER_SCAN_FIELDS' }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      if (!response?.ok) {
        reject(new Error('No scan response from content script'))
        return
      }
      resolve(Array.isArray(response.fields) ? response.fields : [])
    })
  })
}

async function scanFieldsViaInjection(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const getLabelText = (el) => {
          const id = el.id
          if (id) {
            const byFor = document.querySelector(`label[for="${id}"]`)
            if (byFor?.textContent?.trim()) return byFor.textContent.trim()
          }
          const wrapped = el.closest('label')
          if (wrapped?.textContent?.trim()) return wrapped.textContent.trim()
          return (el.getAttribute('aria-label') || '').trim()
        }
        const nodes = Array.from(document.querySelectorAll('input, select, textarea, button'))
        return nodes.map((el, idx) => ({
          index: idx + 1,
          element: el.tagName.toLowerCase(),
          type: String(el.getAttribute('type') || '').toLowerCase() || el.tagName.toLowerCase(),
          id: el.id || '',
          name: el.getAttribute('name') || '',
          placeholder: el.getAttribute('placeholder') || '',
          label: getLabelText(el),
          required: Boolean(el.required) || String(el.getAttribute('aria-required') || '').toLowerCase() === 'true'
        }))
      }
    })
    const merged = []
    for (const r of (Array.isArray(results) ? results : [])) {
      const arr = Array.isArray(r?.result) ? r.result : []
      merged.push(...arr)
    }
    return merged
  } catch {
    return []
  }
}

async function runFromExtension() {
  els.results.innerHTML = ''
  els.viewBtn.style.display = 'none'
  const token = await ensureExtensionToken()
  if (!token) {
    showOpenApp('Please log in to QA Helper first')
    return
  }
  const projectId = Number(els.projectSelect.value || 0)
  if (!projectId) {
    setStatus('Select a project first')
    return
  }

  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    try {
      if (!tabs || !tabs[0]?.id) throw new Error('Could not access active tab')
      setStatus('Reading form fields...', true)
      let fields = await scanFieldsFromTab(tabs[0].id)
      if (!fields.length) {
        fields = await scanFieldsViaInjection(tabs[0].id)
      }
      if (!fields.length) throw new Error('No fields found on active page')

      setStatus('Connecting to QA Helper...', true)
      const res = await fetch(`${API_BASE}/api/extension-scan`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          url: tabs[0].url,
          projectId,
          fields
        })
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 401 || res.status === 403) {
        setStoredToken('')
        showOpenApp('Please log in to QA Helper first')
        throw new Error('Please log in to QA Helper first')
      }
      if (!res.ok) throw new Error(data.error || 'Extension scan failed')

      const jobId = String(data.jobId || '').trim()
      if (!jobId) throw new Error('No scan job id returned from backend')
      setActiveJob({
        jobId,
        projectId,
        startedAt: Date.now()
      })

      lastEventSeq = 0
      const finalResult = await pollJobUntilDone(jobId)
      if (!finalResult) {
        setStatus('Still running in background... reopen popup to continue tracking.', false)
        els.results.innerHTML = '<div class="check">Run is still active. You can close and reopen the popup to continue tracking progress.</div>'
        return
      }

      setStatus(finalResult.summary || 'Done', false)
      renderResults(finalResult)
      els.viewBtn.style.display = 'block'
      els.viewBtn.onclick = () => {
        chrome.tabs.create({ url: `${APP_BASE}/?project=${projectId}&run=${finalResult.runId || ''}` })
      }
    } catch (err) {
      setStatus(err.message || 'Failed to run test', false)
      els.results.innerHTML = `<div class="check fail">${err.message || 'Unknown extension error'}</div>`
      setActiveJob(null)
    }
  })
}

async function pollJobUntilDone(jobId) {
  let finalResult = null
  const pollStarted = Date.now()
  const pollTimeoutMs = 25 * 60 * 1000
  while (Date.now() - pollStarted < pollTimeoutMs) {
    const statusRes = await fetch(`${API_BASE}/api/extension-scan/status/${jobId}`, {
      headers: authHeaders()
    })
    const statusData = await statusRes.json().catch(() => ({}))
    if (!statusRes.ok) throw new Error(statusData.error || 'Failed to fetch run progress')

    const phase = String(statusData.phase || '').toLowerCase()
    const message = String(statusData.message || '').trim()
    const progress = statusData.progress || {}
    const total = Number(progress.total || 0)
    const completed = Number(progress.completed || 0)

    if (phase === 'checking_field' && message) {
      setStatus(message, true)
    } else if (phase === 'finishing') {
      setStatus('Almost done...', true)
    } else if (phase === 'running_tests') {
      const runningMsg = total > 0 ? `Running tests... (${completed}/${total})` : 'Running tests...'
      setStatus(runningMsg, true)
    } else if (message) {
      setStatus(message, statusData.status === 'running')
    }

    // We only track sequence numbers now — screenshots are taken by Playwright.
    const events = Array.isArray(statusData.events) ? statusData.events : []
    for (const ev of events) {
      const seq = Number(ev?.seq || 0)
      if (seq > lastEventSeq) lastEventSeq = seq
    }

    if (statusData.status === 'error') {
      setActiveJob(null)
      throw new Error(statusData.error || statusData.message || 'Extension scan failed')
    }
    if (statusData.status === 'done') {
      finalResult = statusData.result
      setActiveJob(null)
      break
    }

    await new Promise(resolve => setTimeout(resolve, 500))
  }

  if (!finalResult) return null
  return finalResult
}

async function resumeActiveJobIfAny() {
  const active = getActiveJob()
  if (!active?.jobId) return
  try {
    setStatus('Resuming running test...', true)
    const result = await pollJobUntilDone(String(active.jobId))
    if (!result) {
      setStatus('Still running in background... reopen popup to continue tracking.', false)
      return
    }
    setStatus(result.summary || 'Done', false)
    renderResults(result)
    if (els.viewBtn && active.projectId) {
      els.viewBtn.style.display = 'block'
      els.viewBtn.onclick = () => {
        chrome.tabs.create({ url: `${APP_BASE}/?project=${active.projectId}&run=${result.runId || ''}` })
      }
    }
  } catch (err) {
    setStatus(err.message || 'Failed to resume running test', false)
  }
}

// ─── Save Session ───────────────────────────────────────────────────────────
// When the tester is already logged into the target site (e.g. Irembo
// portal), clicking "Save Session" here reads the cookies for that site plus
// any localStorage items, and sends them to the backend. The backend saves
// them to auth-state.json. Playwright then loads that file so every test run
// starts already logged in — no blank login screens in screenshots anymore.

function parseOrigin(urlString) {
  try {
    const u = new URL(urlString)
    return `${u.protocol}//${u.host}`
  } catch {
    return ''
  }
}

async function collectCookiesForUrl(url) {
  return new Promise((resolve) => {
    try {
      chrome.cookies.getAll({ url }, (cookies) => {
        if (chrome.runtime.lastError) return resolve([])
        resolve(Array.isArray(cookies) ? cookies : [])
      })
    } catch {
      resolve([])
    }
  })
}

async function collectLocalStorageForTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const out = []
        try {
          for (let i = 0; i < localStorage.length; i += 1) {
            const name = localStorage.key(i)
            if (!name) continue
            out.push({ name, value: String(localStorage.getItem(name) ?? '') })
          }
        } catch {
          // localStorage may be blocked on some pages — ignore.
        }
        return out
      }
    })
    const arr = Array.isArray(results) && Array.isArray(results[0]?.result) ? results[0].result : []
    return arr
  } catch {
    return []
  }
}

async function refreshSessionStatus() {
  const token = getStoredToken()
  if (!token) {
    setSessionStatus('')
    return
  }
  try {
    const res = await fetch(`${API_BASE}/api/save-auth/status`, { headers: authHeaders() })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setSessionStatus('')
      return
    }
    if (data?.exists) {
      const when = data?.savedAt ? new Date(data.savedAt).toLocaleString() : ''
      setSessionStatus(when ? `Session saved (${when})` : 'Session saved', '#0f7b2d')
    } else {
      setSessionStatus('No session saved yet — click Save Session while logged in.', '#b42318')
    }
  } catch {
    setSessionStatus('')
  }
}

async function saveSession() {
  const token = await ensureExtensionToken()
  if (!token) {
    showOpenApp('Please log in to QA Helper first')
    return
  }
  try {
    setStatus('Reading browser session...', true)
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const tab = tabs?.[0]
    if (!tab?.url) throw new Error('Could not read the active tab URL')

    const origin = parseOrigin(tab.url)
    if (!origin) throw new Error('Active tab does not have a valid URL')

    const cookies = await collectCookiesForUrl(tab.url)
    if (!cookies.length) {
      throw new Error('No cookies found on this page — make sure you are logged in.')
    }

    const localStorageItems = await collectLocalStorageForTab(tab.id)
    const origins = localStorageItems.length
      ? [{ origin, localStorage: localStorageItems }]
      : []

    setStatus('Saving session to backend...', true)
    const res = await fetch(`${API_BASE}/api/save-auth`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ cookies, origins })
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Failed to save session')

    setStatus(`Session saved (${data.cookieCount || 0} cookies)`, false)
    await refreshSessionStatus()
  } catch (err) {
    setStatus(err.message || 'Failed to save session', false)
  }
}

els.loginBtn.addEventListener('click', login)
els.runBtn.addEventListener('click', runFromExtension)
if (els.saveSessionBtn) {
  els.saveSessionBtn.addEventListener('click', saveSession)
}
if (els.openAppBtn) {
  els.openAppBtn.addEventListener('click', openApp)
}

loadProjects()
resumeActiveJobIfAny()
refreshSessionStatus()
