/* global chrome, fetch */
importScripts('conditionalParentKey.js')

function isConditionalChainType(t) {
  const x = String(t || '').trim()
  return x === 'conditional_display' || x === 'conditional_required' || x === 'conditional_field'
}

function nextCaseContinuesConditionalChain(cur, next) {
  if (!cur || !next) return false
  const curT = String(cur.test_type || '').trim()
  const nextT = String(next.test_type || '').trim()
  if (!isConditionalChainType(curT) || !isConditionalChainType(nextT)) return false
  const keyFn = globalThis.qaHelperParentSetupKey
  if (typeof keyFn !== 'function') return false
  const k1 = String(keyFn(cur) || '')
  const k2 = String(keyFn(next) || '')
  if (!k1 || k1 !== k2) return false
  // Unified conditional tests clear the target and Continue; never chain on the same parent.
  return false
}
/** Default cap when test_type is unknown (keep full runs roughly 3–5 minutes for typical suites). */
const PER_TEST_CASE_TIMEOUT_MS = 3 * 60 * 1000

function perTestCaseTimeoutMs(tc = {}) {
  const t = String(tc?.test_type || '').trim()
  if (t === 'successful_submit') return 5 * 60 * 1000
  if (t === 'conditional_display' || t === 'conditional_required' || t === 'conditional_field') return 4 * 60 * 1000
  if (t === 'required_field' || t === 'format_validation') return 3 * 60 * 1000
  return PER_TEST_CASE_TIMEOUT_MS
}

function shouldRetryAfterSectionAdvance(response) {
  if (!response || !response.ok || response.skipped || response.passed) return false
  const msg = String(response?.message || '').toLowerCase()
  return (
    msg.includes('not found on page') ||
    msg.includes('not found after cascade') ||
    msg.includes('did not become visible') ||
    msg.includes('not found after')
  )
}

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
  tabId: 0,
  cancellationRequested: false,
  startedAt: 0,
  finishedAt: 0,
  /** After in-tab navigation, content context resets — next message re-runs required-field preflight. */
  contentNeedsReprime: false,
  lastRunTabUrl: ''
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

function pickCaseFieldLabel(tc = {}) {
  const direct = String(tc?.field_label || '').trim()
  if (direct) return direct
  const byName = String(tc?.field_name || '').trim()
  if (byName) return byName
  const name = String(tc?.name || '').trim()
  if (!name) return 'Unknown field'
  const stripped = name
    .replace(/\brequired field\b/gi, '')
    .replace(/\bformat validation\b/gi, '')
    .replace(/\bconditional required\b/gi, '')
    .replace(/\bconditional display\b/gi, '')
    .replace(/\bconditional field\b/gi, '')
    .replace(/\bwidget auto[-\s]?fill\b/gi, '')
    .replace(/\blabel check\b/gi, '')
    .replace(/\btest\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped || name
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isTransientTabMessageError(msg) {
  return /Receiving end does not exist|Could not establish connection|message port closed|Extension context invalidated|The message port closed before a response was received/i.test(
    String(msg || '')
  )
}

async function injectContentIntoTab(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['config.js', 'conditionalParentKey.js', 'content.js']
  })
}

function sendTabMessageOnce(tabId, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      resolve(response)
    })
  })
}

function sendTabMessageWithTimeout(tabId, payload, timeoutMs = PER_TEST_CASE_TIMEOUT_MS) {
  const effectiveMs = Math.max(20000, Number(timeoutMs) || PER_TEST_CASE_TIMEOUT_MS)
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      reject(new Error(`Test timed out after ${Math.round(effectiveMs / 1000)} seconds`))
    }, effectiveMs)

    const finish = (fn) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }

    ;(async () => {
      let lastErr = ''
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (done) return
        try {
          const response = await sendTabMessageOnce(tabId, payload)
          finish(() => resolve(response))
          return
        } catch (err) {
          lastErr = String(err?.message || err || '')
          if (!isTransientTabMessageError(lastErr) || attempt >= 2) {
            finish(() => reject(new Error(lastErr)))
            return
          }
          try {
            await injectContentIntoTab(tabId)
            await sleep(attempt === 0 ? 500 : 900)
            if (done) return
          } catch (injectErr) {
            finish(() => reject(new Error(String(injectErr?.message || lastErr))))
            return
          }
        }
      }
    })()
  })
}

async function runExtensionTestsInBackground({ projectId, apiBase, token, tabId, reusableIdValue }) {
  let startUrl = ''
  try {
    const t = await chrome.tabs.get(tabId)
    startUrl = String(t?.url || '')
  } catch {
    // Tab may be closing; still attempt the run.
  }
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
    tabId: Number(tabId || 0),
    cancellationRequested: false,
    startedAt: Date.now(),
    finishedAt: 0,
    contentNeedsReprime: false,
    lastRunTabUrl: startUrl
  })

  const tcRes = await fetch(`${apiBase}/api/projects/${projectId}/extension-test-cases`, {
    headers: authHeaders(token)
  })
  const tcData = await tcRes.json().catch(() => ({}))
  if (!tcRes.ok) throw new Error(tcData.error || 'Failed to fetch extension test cases')

  const testCases = Array.isArray(tcData) ? tcData : (Array.isArray(tcData?.testCases) ? tcData.testCases : [])
  if (!testCases.length) throw new Error('No test cases found — generate them in the app first')

  setRunState({ total: testCases.length, message: `Starting tests (1/${testCases.length})...` })

  const results = []
  let passed = 0
  let failed = 0
  let skipped = 0
  let lastConditionalParentSetupKey = ''

  for (let i = 0; i < testCases.length; i += 1) {
    if (RUN_STATE.cancellationRequested) {
      break
    }
    const tc = testCases[i]
    const current = i + 1
    const fieldLabel = pickCaseFieldLabel(tc)
    const typeLabel = String(tc?.test_type || 'required_field').trim()
    setRunState({
      current,
      message: `Checking field: ${fieldLabel} | Type: ${typeLabel} (${current}/${testCases.length})`
    })
    let runResult
    let tabResponse = null
    try {
      let prime = Boolean(RUN_STATE.contentNeedsReprime)
      if (prime) {
        setRunState({ contentNeedsReprime: false })
        lastConditionalParentSetupKey = ''
      }
      const skipFormResetAfter = nextCaseContinuesConditionalChain(tc, testCases[i + 1])
      let response = null
      for (let attempt = 0; attempt < 2; attempt += 1) {
        response = await sendTabMessageWithTimeout(
          tabId,
          {
            type: 'QA_HELPER_RUN_TEST_CASE',
            testCase: tc,
            isRunStart: i === 0,
            primeAfterNavigation: prime,
            previousParentSetupKey: lastConditionalParentSetupKey || undefined,
          skipFormResetAfter,
          reusableIdValue: String(reusableIdValue || '')
          },
          perTestCaseTimeoutMs(tc)
        )
        tabResponse = response
        if (!shouldRetryAfterSectionAdvance(response)) break
        if (attempt > 0) break
        const advanced = await sendTabMessageWithTimeout(
          tabId,
          { type: 'QA_HELPER_ADVANCE_SECTION' },
          20000
        ).catch(() => ({ ok: false }))
        if (!advanced?.ok || !advanced?.advanced) break
        prime = true
        lastConditionalParentSetupKey = ''
      }
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
        const mapTag = response.preflightMapped ? ' [run-start mapped]' : ''
        runResult = {
          id: tc.id,
          name: tc.name,
          passed: testPassed,
          notes: testPassed
            ? `Passed: ${response.message || 'Validation behaved as expected'}${mapTag}`
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
        notes: /timed out/i.test(msg)
          ? `Failed: ${msg}`
          : `Failed: ${msg || 'Unknown extension execution error'}`,
        screenshotDataUrl: ''
      }
    }
    if (tabResponse?.ok && tabResponse.passed === true && String(tabResponse.parentSetupKey || '')) {
      lastConditionalParentSetupKey = String(tabResponse.parentSetupKey)
    } else {
      lastConditionalParentSetupKey = ''
    }
    results.push(runResult)
    setRunState({ passed, failed, skipped, message: `Completed ${current}/${testCases.length}` })
    if (RUN_STATE.cancellationRequested) {
      break
    }
    const stopAfterSubmit =
      String(tc?.test_type || '').trim() === 'successful_submit' &&
      !runResult.skipped &&
      Boolean(runResult.passed)
    if (stopAfterSubmit) {
      const skipNote =
        'Skipped: successful submit completed earlier in this run — case not executed (results page may differ from the form).'
      for (let j = i + 1; j < testCases.length; j += 1) {
        const rest = testCases[j]
        skipped += 1
        results.push({
          id: rest.id,
          name: rest.name,
          passed: false,
          skipped: true,
          notes: skipNote,
          screenshotDataUrl: ''
        })
      }
      setRunState({
        passed,
        failed,
        skipped,
        message: `Submission succeeded — skipped ${testCases.length - current} remaining test(s).`
      })
      break
    }
  }

  if (RUN_STATE.cancellationRequested) {
    const summary = `Stopped — ${passed} passed, ${failed} failed, ${skipped} skipped`
    setRunState({
      status: 'stopped',
      summary,
      message: summary,
      finishedAt: Date.now()
    })
    return
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
      tabId: Number(message.tabId || 0),
      reusableIdValue: String(message.reusableIdValue || '').trim()
    }
    if (!payload.projectId || !payload.apiBase || !payload.token || !payload.tabId || !payload.reusableIdValue) {
      sendResponse({ ok: false, error: 'Missing run configuration (reusable ID is required)' })
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

  if (message?.type === 'QA_HELPER_STOP_EXTENSION_RUN') {
    if (RUN_STATE.status !== 'running') {
      sendResponse({ ok: true, state: getRunSnapshot() })
      return true
    }
    try {
      chrome.tabs.sendMessage(Number(RUN_STATE.tabId || 0), { type: 'QA_HELPER_CANCEL_CURRENT_TEST' }, () => {})
    } catch {
      // Ignore messaging failures here; cancellation flag below still stops the loop.
    }
    setRunState({
      cancellationRequested: true,
      message: 'Stopping test run after current step...'
    })
    sendResponse({ ok: true, stopping: true, state: getRunSnapshot() })
    return true
  }

  return false
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (RUN_STATE.status !== 'running') return
  if (Number(tabId) !== Number(RUN_STATE.tabId || 0)) return
  if (changeInfo.status === 'loading') {
    setRunState({ message: 'Page loading — tests resume after the new page is ready…' })
    return
  }
  if (changeInfo.status !== 'complete') return
  const url = String(tab?.url || '')
  if (!url || /^chrome(-extension)?:/i.test(url)) return
  const prev = String(RUN_STATE.lastRunTabUrl || '')
  if (url === prev) return
  setRunState({
    lastRunTabUrl: url,
    contentNeedsReprime: true,
    message: 'Page ready — continuing tests on this tab…'
  })
  injectContentIntoTab(tabId).catch(() => {})
})
