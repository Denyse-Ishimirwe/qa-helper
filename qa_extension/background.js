/* global chrome, fetch */
const RUN_STATE = {
  status: 'idle',
  projectId: 0,
  total: 0,
  current: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  message: '',
  summary: '',
  runId: '',
  startedAt: 0,
  finishedAt: 0
}

let activeRunPromise = null

function getRunSnapshot() {
  return { ...RUN_STATE }
}

function setRunState(patch) {
  Object.assign(RUN_STATE, patch || {})
}

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${String(token || '')}`
  }
}

function sendTabMessageWithTimeout(tabId, payload, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      reject(new Error(`Test timed out after ${Math.round(timeoutMs / 1000)} seconds`))
    }, timeoutMs)
    chrome.tabs.sendMessage(tabId, payload, async (response) => {
      if (done) return
      if (chrome.runtime.lastError) {
        const msg = String(chrome.runtime.lastError.message || '')
        if (/Receiving end does not exist|Could not establish connection/i.test(msg)) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId },
              files: ['config.js', 'content.js']
            })
            chrome.tabs.sendMessage(tabId, payload, (retryResp) => {
              if (done) return
              done = true
              clearTimeout(timer)
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message))
                return
              }
              resolve(retryResp)
            })
            return
          } catch (injectErr) {
            done = true
            clearTimeout(timer)
            reject(new Error(String(injectErr?.message || msg)))
            return
          }
        }
        done = true
        clearTimeout(timer)
        reject(new Error(msg))
        return
      }
      done = true
      clearTimeout(timer)
      resolve(response)
    })
  })
}

async function runExtensionTestsInBackground({ projectId, apiBase, token, tabId }) {
  setRunState({
    status: 'running',
    projectId: Number(projectId || 0),
    total: 0,
    current: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    message: 'Fetching test cases...',
    summary: '',
    runId: '',
    startedAt: Date.now(),
    finishedAt: 0
  })

  const tcRes = await fetch(`${apiBase}/api/projects/${projectId}/extension-test-cases`, {
    headers: authHeaders(token)
  })
  const tcData = await tcRes.json().catch(() => ({}))
  if (!tcRes.ok) throw new Error(tcData.error || 'Failed to fetch extension test cases')

  const testCases = Array.isArray(tcData) ? tcData : (Array.isArray(tcData?.testCases) ? tcData.testCases : [])
  if (!testCases.length) throw new Error('No test cases found — generate them in the app first')

  let projectTestDataProfile = {}
  try {
    const tdRes = await fetch(`${apiBase}/api/projects/${projectId}/test-data`, {
      headers: authHeaders(token)
    })
    if (tdRes.ok) {
      const tdData = await tdRes.json().catch(() => ({}))
      if (tdData?.profile && typeof tdData.profile === 'object') {
        projectTestDataProfile = tdData.profile
      }
    }
  } catch {
    // Continue run even when test-data profile fetch fails.
  }

  setRunState({ total: testCases.length, message: `Starting tests (1/${testCases.length})...` })

  const results = []
  let passed = 0
  let failed = 0
  let skipped = 0

  for (let i = 0; i < testCases.length; i += 1) {
    const tc = testCases[i]
    const current = i + 1
    setRunState({ current, message: `Testing: ${tc.name} (${current}/${testCases.length})...` })
    let runResult
    try {
      const response = await sendTabMessageWithTimeout(tabId, {
        type: 'QA_HELPER_RUN_TEST_CASE',
        testCase: tc,
        testDataProfile: projectTestDataProfile
      }, 45000)
      if (!response?.ok) {
        failed += 1
        runResult = {
          id: tc.id,
          name: tc.name,
          passed: false,
          notes: 'Failed: no response from content script',
          screenshotDataUrl: ''
        }
      } else if (response.skipped) {
        skipped += 1
        runResult = {
          id: tc.id,
          name: tc.name,
          passed: false,
          skipped: true,
          notes: `Skipped: ${response.reason || 'Not executable in extension mode'}`,
          screenshotDataUrl: ''
        }
      } else {
        const testPassed = Boolean(response.passed)
        if (testPassed) passed += 1
        else failed += 1
        runResult = {
          id: tc.id,
          name: tc.name,
          passed: testPassed,
          notes: testPassed
            ? `Passed: ${response.message || 'Validation behaved as expected'}`
            : `Failed: ${response.message || 'Validation did not match expected behavior'}`,
          screenshotDataUrl: String(response.screenshotDataUrl || '')
        }
      }
    } catch (err) {
      failed += 1
      const msg = String(err?.message || '')
      runResult = {
        id: tc.id,
        name: tc.name,
        passed: false,
        notes: msg.includes('timed out')
          ? 'Failed: Test timed out after 45 seconds'
          : `Failed: ${msg || 'Unknown extension execution error'}`,
        screenshotDataUrl: ''
      }
    }
    results.push(runResult)
    setRunState({ passed, failed, skipped, message: `Completed ${current}/${testCases.length}` })
  }

  setRunState({ message: 'Uploading results...' })
  const uploadRes = await fetch(`${apiBase}/api/projects/${projectId}/extension-run`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ results })
  })
  const uploadData = await uploadRes.json().catch(() => ({}))
  if (!uploadRes.ok) throw new Error(uploadData.error || 'Failed to upload extension results')

  const summary = `Done — ${passed} passed, ${failed} failed, ${skipped} skipped`
  setRunState({
    status: 'done',
    summary,
    message: summary,
    runId: String(uploadData.runId || ''),
    finishedAt: Date.now()
  })
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'QA_HELPER_START_EXTENSION_RUN') {
    if (RUN_STATE.status === 'running') {
      sendResponse({ ok: true, alreadyRunning: true, state: getRunSnapshot() })
      return true
    }
    const payload = {
      projectId: Number(message.projectId || 0),
      apiBase: String(message.apiBase || ''),
      token: String(message.token || ''),
      tabId: Number(message.tabId || 0)
    }
    if (!payload.projectId || !payload.apiBase || !payload.token || !payload.tabId) {
      sendResponse({ ok: false, error: 'Missing run configuration' })
      return true
    }
    activeRunPromise = runExtensionTestsInBackground(payload)
      .catch(err => {
        setRunState({
          status: 'error',
          message: String(err?.message || 'Background extension run failed'),
          summary: '',
          finishedAt: Date.now()
        })
      })
      .finally(() => {
        activeRunPromise = null
      })
    sendResponse({ ok: true, started: true, state: getRunSnapshot() })
    return true
  }

  if (message?.type === 'QA_HELPER_GET_EXTENSION_RUN_STATE') {
    sendResponse({ ok: true, state: getRunSnapshot() })
    return true
  }

  return false
})
