/* global chrome, CONFIG, resolveApiUrl */
let API_BASE = CONFIG.API_URL
let APP_BASE = CONFIG.API_URL
const APP_BASES = ['http://localhost:5173', 'https://qa-helper-tool.onrender.com', CONFIG.LOCAL_URL, CONFIG.PRODUCTION_URL]
const ACTIVE_JOB_KEY = 'qa_ext_active_job'
const REUSABLE_ID_KEY = 'qa_ext_reusable_id_value'
let lastEventSeq = 0

function deriveAppBase(apiBase) {
  const base = String(apiBase || '').trim()
  if (!base) return CONFIG.PRODUCTION_URL
  if (/^https?:\/\/localhost:3000\b/i.test(base)) return 'http://localhost:5173'
  return base
}

const els = {
  email: document.getElementById('email'),
  password: document.getElementById('password'),
  loginBtn: document.getElementById('loginBtn'),
  runBtn: document.getElementById('runTest'),
  stopBtn: document.getElementById('stopTest'),
  projectSelect: document.getElementById('projectSelect'),
  reusableIdValue: document.getElementById('reusableIdValue'),
  status: document.getElementById('status'),
  statusWrap: document.getElementById('statusWrap'),
  results: document.getElementById('results'),
  viewBtn: document.getElementById('viewResultsBtn'),
  openAppBtn: document.getElementById('openAppBtn')
}

function setRunControls(running) {
  if (els.runBtn) {
    els.runBtn.style.display = 'block'
    els.runBtn.disabled = Boolean(running)
  }
  if (els.stopBtn) {
    els.stopBtn.style.display = 'block'
    els.stopBtn.disabled = !running
  }
}

async function syncRunControlsWithBackgroundState() {
  try {
    const statusResp = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'QA_HELPER_GET_EXTENSION_RUN_STATE' }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
        resolve(resp || {})
      })
    })
    const st = statusResp?.state || {}
    const isRunning = st.status === 'running'
    setRunControls(isRunning)
    if (isRunning) {
      const msg = String(st.message || '').trim() || 'Test run is still active...'
      setStatus(msg, true)
      const total = Number(st.total || 0)
      const current = Number(st.current || 0)
      renderProgress(Math.min(current, total), Math.max(total, 1), msg)
    }
  } catch {
    // Ignore state sync failures and keep default controls.
  }
}

async function resumeBackgroundRunIfAny() {
  try {
    const statusResp = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'QA_HELPER_GET_EXTENSION_RUN_STATE' }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
        resolve(resp || {})
      })
    })
    const st = statusResp?.state || {}
    if (st.status !== 'running') return

    setRunControls(true)
    const projectId = Number(st.projectId || Number(els.projectSelect?.value || 0))
    const pollStarted = Date.now()
    const pollTimeoutMs = 45 * 60 * 1000

    while (Date.now() - pollStarted < pollTimeoutMs) {
      const next = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'QA_HELPER_GET_EXTENSION_RUN_STATE' }, (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
          resolve(resp || {})
        })
      })
      const rs = next?.state || {}
      const total = Number(rs.total || 0)
      const current = Number(rs.current || 0)
      const msg = String(rs.message || 'Running tests...')
      setStatus(msg, rs.status === 'running')
      renderProgress(Math.min(current, total), Math.max(total, 1), msg)

      if (rs.status === 'done') {
        const summary = String(rs.summary || 'Done')
        setStatus(summary, false)
        els.results.innerHTML = `<div class="check"><strong>${summary}</strong></div>`
        if (rs.runId && projectId) {
          els.viewBtn.style.display = 'block'
          els.viewBtn.onclick = () => {
            chrome.tabs.create({ url: `${APP_BASE}/?project=${projectId}&run=${rs.runId}` })
          }
        }
        setRunControls(false)
        return
      }
      if (rs.status === 'stopped') {
        const summary = String(rs.summary || rs.message || 'Stopped')
        setStatus(summary, false)
        els.results.innerHTML = `<div class="check"><strong>${summary}</strong></div>`
        setRunControls(false)
        return
      }
      if (rs.status === 'error') {
        throw new Error(String(rs.message || 'Background run failed'))
      }

      await new Promise(resolve => setTimeout(resolve, 260))
    }
  } catch (err) {
    setStatus(err.message || 'Failed to resume running test', false)
    setRunControls(false)
  }
}

async function stopExtensionTests() {
  try {
    const stopped = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'QA_HELPER_STOP_EXTENSION_RUN' }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
        resolve(resp || {})
      })
    })
    if (!stopped?.ok) throw new Error(stopped?.error || 'Failed to stop test run')
    setStatus('Stopping test run after current step...', true)
  } catch (err) {
    setStatus(err.message || 'Failed to stop test run', false)
  }
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

function getReusableIdValue() {
  return String(localStorage.getItem(REUSABLE_ID_KEY) || '').trim()
}

function setReusableIdValue(value) {
  const v = String(value || '').trim()
  if (v) localStorage.setItem(REUSABLE_ID_KEY, v)
  else localStorage.removeItem(REUSABLE_ID_KEY)
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

function renderProgress(current, total, label = '') {
  const safeTotal = Number(total || 0)
  const safeCurrent = Number(current || 0)
  const pct = safeTotal > 0 ? Math.max(0, Math.min(100, Math.round((safeCurrent / safeTotal) * 100))) : 0
  const title = label ? `<div class="check"><strong>${label}</strong></div>` : ''
  els.results.innerHTML = `${title}
    <div class="check">
      <div style="margin-bottom:6px;">Progress: ${safeCurrent}/${safeTotal} (${pct}%)</div>
      <div style="height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden;">
        <div style="height:10px;width:${pct}%;background:#2563eb;"></div>
      </div>
    </div>`
}

function _sendTabMessageWithTimeout(tabId, payload, timeoutMs = 3 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      reject(new Error(`Test timed out after ${Math.round(timeoutMs / 1000)} seconds`))
    }, timeoutMs)

    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      resolve(response)
    })
  })
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

function readCookiesForUrl(url) {
  return new Promise((resolve) => {
    try {
      chrome.cookies.getAll({ url }, (cookies) => {
        if (chrome.runtime.lastError) {
          resolve([])
          return
        }
        resolve(Array.isArray(cookies) ? cookies : [])
      })
    } catch {
      resolve([])
    }
  })
}

async function collectSessionCookies(activeUrl) {
  const seen = new Set()
  const targets = []
  const safeActive = String(activeUrl || '').trim()
  if (safeActive) {
    targets.push(safeActive)
    try {
      const u = new URL(safeActive)
      targets.push(`${u.protocol}//${u.host}/`)
    } catch {
      // ignore malformed URL and continue with default targets
    }
  }
  targets.push('https://keycloak.sandbox.iremboinc.com/')

  const merged = []
  for (const target of targets) {
    if (!target || seen.has(target)) continue
    seen.add(target)
    const cookies = await readCookiesForUrl(target)
    for (const c of cookies) {
      const key = `${c?.domain || ''}|${c?.path || ''}|${c?.name || ''}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(c)
    }
  }
  // #region agent log
  fetch('http://127.0.0.1:7811/ingest/193ceff3-13cc-4a5d-8fcb-570fabc3b13e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'64e698'},body:JSON.stringify({sessionId:'64e698',runId:'pre-fix-auth',hypothesisId:'H1',location:'qa_extension/popup.js:collectSessionCookies',message:'Collected extension session cookies',data:{targetCount:targets.length,totalCookies:merged.length,domains:Array.from(new Set(merged.map(c=>String(c?.domain||'').toLowerCase()).filter(Boolean))).slice(0,20)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  return merged
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
      const fields = await scanFieldsFromTab(tabs[0].id)
      if (!fields.length) throw new Error('No fields found on active page')
      const sessionCookies = await collectSessionCookies(String(tabs[0].url || ''))
      // #region agent log
      fetch('http://127.0.0.1:7811/ingest/193ceff3-13cc-4a5d-8fcb-570fabc3b13e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'64e698'},body:JSON.stringify({sessionId:'64e698',runId:'pre-fix-auth',hypothesisId:'H2',location:'qa_extension/popup.js:runFromExtension',message:'Sending extension-scan request',data:{projectId,urlHost:(()=>{try{return new URL(String(tabs[0].url||'')).host}catch{return''}})(),sessionCookiesCount:sessionCookies.length},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

      setStatus('Connecting to QA Helper...', true)
      const res = await fetch(`${API_BASE}/api/extension-scan`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          url: tabs[0].url,
          projectId,
          fields,
          sessionCookies
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
      setActiveJob({ jobId, projectId, startedAt: Date.now() })

      lastEventSeq = 0
      const pendingScreenshots = []
      const finalResult = await pollJobUntilDone(jobId, pendingScreenshots)
      if (!finalResult) {
        setStatus('Still running in background... reopen popup to continue tracking.', false)
        els.results.innerHTML = '<div class="check">Run is still active. You can close and reopen the popup to continue tracking progress.</div>'
        return
      }

      if (pendingScreenshots.length > 0 && finalResult.runId) {
        await uploadExtensionScreenshots(finalResult.runId, pendingScreenshots)
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

async function runExtensionTests() {
  els.results.innerHTML = ''
  els.viewBtn.style.display = 'none'
  setRunControls(true)

  const token = await ensureExtensionToken()
  if (!token) {
    showOpenApp('Please log in to QA Helper first')
    setRunControls(false)
    return
  }

  const projectId = Number(els.projectSelect.value || 0)
  const reusableIdValue = String(els.reusableIdValue?.value || '').trim()
  if (!projectId) {
    setStatus('Select a project first')
    setRunControls(false)
    return
  }
  if (!reusableIdValue) {
    setStatus('Enter Reusable ID value before running tests')
    if (els.reusableIdValue) els.reusableIdValue.focus()
    setRunControls(false)
    return
  }
  setReusableIdValue(reusableIdValue)

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const activeTab = tabs?.[0]
    if (!activeTab?.id) throw new Error('Could not access active tab')

    setStatus('Starting background run...', true)
    renderProgress(0, 1, 'Preparing tests...')

    const started = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: 'QA_HELPER_START_EXTENSION_RUN',
          projectId,
          apiBase: API_BASE,
          token: getStoredToken(),
          tabId: activeTab.id,
          reusableIdValue
        },
        (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
          resolve(resp || {})
        }
      )
    })
    if (!started?.ok) throw new Error(started?.error || 'Failed to start background run')

    const pollStarted = Date.now()
    const pollTimeoutMs = 45 * 60 * 1000
    while (Date.now() - pollStarted < pollTimeoutMs) {
      const statusResp = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'QA_HELPER_GET_EXTENSION_RUN_STATE' }, (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
          resolve(resp || {})
        })
      })
      const st = statusResp?.state || {}
      const total = Number(st.total || 0)
      const current = Number(st.current || 0)
      const msg = String(st.message || '')
      if (msg) setStatus(msg, st.status === 'running')
      renderProgress(Math.min(current, total), Math.max(total, 1), msg || 'Running tests...')

      if (st.status === 'done') {
        const summary = String(st.summary || 'Done')
        setStatus(summary, false)
        els.results.innerHTML = `<div class="check"><strong>${summary}</strong></div>`
        if (st.runId) {
          els.viewBtn.style.display = 'block'
          els.viewBtn.onclick = () => {
            chrome.tabs.create({ url: `${APP_BASE}/?project=${projectId}&run=${st.runId}` })
          }
        }
        setRunControls(false)
        return
      }
      if (st.status === 'stopped') {
        const summary = String(st.summary || st.message || 'Stopped')
        setStatus(summary, false)
        els.results.innerHTML = `<div class="check"><strong>${summary}</strong></div>`
        setRunControls(false)
        return
      }
      if (st.status === 'error') {
        throw new Error(String(st.message || 'Background run failed'))
      }
      await new Promise(resolve => setTimeout(resolve, 260))
    }
    throw new Error('Background run timed out')
  } catch (err) {
    setStatus(err.message || 'Failed to run extension tests', false)
    els.results.innerHTML = `<div class="check fail">${err.message || 'Unknown extension error'}</div>`
  } finally {
    setRunControls(false)
  }
}

async function captureCurrentPagePng() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const winId = tabs?.[0]?.windowId
      if (!winId) return reject(new Error('No active window for screenshot capture'))
      chrome.tabs.captureVisibleTab(winId, { format: 'jpeg', quality: 55 }, (dataUrl) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
        if (!dataUrl) return reject(new Error('Screenshot capture returned empty data'))
        resolve(dataUrl)
      })
    })
  })
}

async function uploadExtensionScreenshots(runId, screenshots) {
  const items = Array.isArray(screenshots) ? screenshots : []
  if (!runId || items.length === 0) return
  const chunkSize = 2
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize)
    await fetch(`${API_BASE}/api/runs/${runId}/extension-screenshots`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ screenshots: chunk })
    }).catch(() => {})
  }
}

async function uploadFailureScreenshotForJob(jobId, testCaseId, imageDataUrl) {
  if (!jobId || !testCaseId || !imageDataUrl) return false
  try {
    const res = await fetch(`${API_BASE}/api/extension-scan/${jobId}/screenshot`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ testCaseId, imageDataUrl })
    })
    return res.ok
  } catch {
    return false
  }
}

async function pollJobUntilDone(jobId, pendingScreenshots = []) {
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
    renderProgress(Math.min(completed, total), Math.max(total, 1), message || 'Running tests...')

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

    const events = Array.isArray(statusData.events) ? statusData.events : []
    for (const ev of events) {
      const seq = Number(ev?.seq || 0)
      if (seq <= lastEventSeq) continue
      lastEventSeq = seq
      if (ev?.phase === 'capture_failure' && ev?.caseResult && ev.caseResult.passed === false) {
        try {
          const imageDataUrl = await captureCurrentPagePng()
          const testCaseId = Number(ev.caseResult.id)
          const uploaded = await uploadFailureScreenshotForJob(jobId, testCaseId, imageDataUrl)
          if (!uploaded) {
            pendingScreenshots.push({ testCaseId, imageDataUrl })
          }
        } catch {
          // Continue run flow even if one screenshot capture fails.
        }
      }
    }

    if (statusData.status === 'error') {
      setActiveJob(null)
      throw new Error(statusData.error || statusData.message || 'Extension scan failed')
    }
    if (statusData.status === 'done') {
      finalResult = statusData.result || null
      setActiveJob(null)
      break
    }
    if (statusData.result && String(statusData.phase || '').toLowerCase() === 'done') {
      finalResult = statusData.result
      setActiveJob(null)
      break
    }

    await new Promise(resolve => setTimeout(resolve, 300))
  }

  if (!finalResult) return null
  return finalResult
}

async function resumeActiveJobIfAny() {
  const active = getActiveJob()
  if (!active?.jobId) return
  try {
    setStatus('Resuming running test...', true)
    const pendingScreenshots = []
    const result = await pollJobUntilDone(String(active.jobId), pendingScreenshots)
    if (!result) {
      setStatus('Still running in background... reopen popup to continue tracking.', false)
      return
    }
    if (pendingScreenshots.length > 0 && result.runId) {
      await uploadExtensionScreenshots(result.runId, pendingScreenshots)
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

els.loginBtn.addEventListener('click', login)
els.runBtn.addEventListener('click', runExtensionTests)
if (els.stopBtn) {
  els.stopBtn.addEventListener('click', stopExtensionTests)
}
if (els.openAppBtn) {
  els.openAppBtn.addEventListener('click', openApp)
}

async function initExtension() {
  try {
    const resolved = await resolveApiUrl()
    API_BASE = resolved
    APP_BASE = deriveAppBase(resolved)
  } catch {
    // Fallback to whatever CONFIG.API_URL already points at.
  }
  loadProjects()
  if (els.reusableIdValue) {
    els.reusableIdValue.value = getReusableIdValue()
    els.reusableIdValue.addEventListener('change', () => {
      setReusableIdValue(els.reusableIdValue.value)
    })
  }
  await syncRunControlsWithBackgroundState()
  resumeBackgroundRunIfAny()
  resumeActiveJobIfAny()
}

// Keep a debug handle to legacy backend-driven flow without wiring it to Run Test.
globalThis.qaHelperLegacyRunFromExtension = runFromExtension

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'QA_HELPER_CAPTURE_VISIBLE_TAB') return false
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const winId = tabs?.[0]?.windowId
    if (!winId) {
      sendResponse({ ok: false, dataUrl: '' })
      return
    }
    chrome.tabs.captureVisibleTab(winId, { format: 'jpeg', quality: 55 }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, dataUrl: '' })
        return
      }
      sendResponse({ ok: true, dataUrl: String(dataUrl || '') })
    })
  })
  return true
})

initExtension()