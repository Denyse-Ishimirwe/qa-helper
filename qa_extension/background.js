/* global chrome */


function isConditionalChainType(t) {
  const x = String(t || '').trim()
  return x === 'conditional_display' || x === 'conditional_required' || x === 'conditional_field'
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function sanitizeSearchLabel(value) {
  return normalizeText(value).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function parseConditionalSpec(tc) {
  const text = `${tc?.what_to_test || ''} ${tc?.expected_result || ''} ${tc?.name || ''}`

  function trimParent(s) {
    return String(s || '').trim().replace(/\?+$/, '').trim()
  }

  function normTrigger(raw) {
    const l = String(raw || '').trim().toLowerCase()
    if (l === 'yes') return 'Yes'
    if (l === 'no') return 'No'
    return String(raw || '').trim()
  }

  const m1 = text.match(/selecting\s+['"]([^'"]+)['"]\s+on\s+(.+?)(?:\s+field\b|\s+and\b|\s*,|\s*then\b|\s*$)/i)
  if (m1) return { parentLabel: trimParent(m1[2]), triggerValue: normTrigger(m1[1]) }

  const m2 = text.match(/after\s+selecting\s+(yes|no)\s+(?:for|on)\s+(.+?)(?:\s*$|\s+and\b|\s+field\b)/i)
  if (m2) return { parentLabel: trimParent(m2[2]), triggerValue: normTrigger(m2[1]) }

  const m3 = text.match(/when\s+(.+?)\s+is\s+(yes|no)\b/i)
  if (m3) return { parentLabel: trimParent(m3[1]), triggerValue: normTrigger(m3[2]) }

  const m4 = text.match(/select\s*['"]?\s*(yes|no)\s*['"]?\s+on\s+(.+?)(?:\s+field\b|\s+and\b|\s*$)/i)
  if (m4) return { parentLabel: trimParent(m4[2]), triggerValue: normTrigger(m4[1]) }

  const m5 = text.match(/when\s+(.+?)\s+(?:is|=)\s+["']?([^"'.;,\n]+)["']?/i)
  if (m5) return { parentLabel: trimParent(m5[1]), triggerValue: normTrigger(String(m5[2] || '').trim()) }

  const m6 = text.match(/if\s+(.+?)\s+(?:is|=)\s+["']?([^"'.;,\n]+)["']?/i)
  if (m6) return { parentLabel: trimParent(m6[1]), triggerValue: normTrigger(String(m6[2] || '').trim()) }

  return { parentLabel: '', triggerValue: '' }
}

function parentSetupKeyFromTc(tc) {
  const spec = parseConditionalSpec(tc)
  const p = sanitizeSearchLabel(String(spec.parentLabel || '').trim().replace(/\?+$/, '').trim())
  const t = normalizeText(spec.triggerValue)
  if (!p || !t) return ''
  return `${p}::${t}`
}

function _nextCaseContinuesConditionalChain(cur, next) {
  if (!cur || !next) return false
  const curT = String(cur.test_type || '').trim()
  const nextT = String(next.test_type || '').trim()
  if (!isConditionalChainType(curT) || !isConditionalChainType(nextT)) return false
  const k1 = parentSetupKeyFromTc(cur)
  const k2 = parentSetupKeyFromTc(next)
  if (k1 && k2 && k1 === k2) return true
  // Keep state across adjacent conditional tests even when cascade parent shifts
  // (e.g. District -> Sector -> Cell -> Village).
  return true
}
/** Default cap when test_type is unknown (keep full runs roughly 3–5 minutes for typical suites). */
const PER_TEST_CASE_TIMEOUT_MS = 3 * 60 * 1000

function perTestCaseTimeoutMs(tc = {}) {
  const t = String(tc?.test_type || '').trim()
  if (t === 'successful_submit') return 5 * 60 * 1000
  if (t === 'conditional_display' || t === 'conditional_required' || t === 'conditional_field') return 4 * 60 * 1000
  if (t === 'required_field' || t === 'format_validation') return 3 * 60 * 1000
  if (t === 'label_check') return 15 * 1000
  return PER_TEST_CASE_TIMEOUT_MS
}

function _shouldRetryAfterSectionAdvance(response) {
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

let _activeRunPromise = null

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
    files: ['config.js', 'content.js']
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

async function runExtensionTestsInBackground({ projectId, apiBase, token, tabId, reusableIdValue, skipTestTypes = [] }) {
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

  const skipQuery = skipTestTypes.length ? `?skipTypes=${encodeURIComponent(skipTestTypes.join(','))}` : ''
  const tcRes = await fetch(`${apiBase}/api/projects/${projectId}/extension-test-cases${skipQuery}`, {
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
  let activeIndex = 0

  // Multi-section bucketer.
  // remaining  = tests still waiting to be probed/run on the current section
  // deferred   = tests whose target/parent field is not on the current section;
  //              tried again after each Continue-advance to the next section
  // deferCount = how many sections a given test has been deferred from; capped
  //              so a hallucinated field doesn't stall the whole run forever
  const MAX_SECTION_ADVANCES = 8
  const MAX_DEFERS_PER_TEST = 3
  let remaining = testCases.slice()
  let deferred = []
  const deferCount = new Map()
  let sectionsAdvanced = 0

  function tcDeferKey(tc) {
    return String(tc?.id || `${tc?.name || ''}::${tc?.test_type || ''}::${tc?.what_to_test || ''}`)
  }

  async function probeReachable(tc) {
    try {
      const response = await sendTabMessageWithTimeout(
        tabId,
        { type: 'QA_HELPER_PROBE_FIELD_VISIBLE', testCase: tc },
        8000
      )
      if (!response) return true
      if (response.ok === false) return true // fail-open on probe error
      if (response.visible) return true
      return false
    } catch {
      return true // fail-open so probe failures don't strand tests
    }
  }

  async function attemptSectionAdvance() {
    try {
      const response = await sendTabMessageWithTimeout(
        tabId,
        { type: 'QA_HELPER_ADVANCE_AND_PROBE' },
        90000
      )
      return Boolean(response?.ok && response?.sectionChanged)
    } catch {
      return false
    }
  }

  async function runOneTest(tc) {
    activeIndex += 1
    const fieldLabel = pickCaseFieldLabel(tc)
    const typeLabel = String(tc?.test_type || 'required_field').trim()
    setRunState({
      current: activeIndex,
      message: `Checking field: ${fieldLabel} | Type: ${typeLabel} (${activeIndex}/${testCases.length})`
    })
    let runResult
    let tabResponse = null
    try {
      let prime = Boolean(RUN_STATE.contentNeedsReprime)
      if (prime) {
        setRunState({ contentNeedsReprime: false })
        lastConditionalParentSetupKey = ''
      }
      // Keep filled state across in-section tests so cascade values persist.
      const skipFormResetAfter = true
      const response = await sendTabMessageWithTimeout(
        tabId,
        {
          type: 'QA_HELPER_RUN_TEST_CASE',
          testCase: tc,
          isRunStart: results.length === 0,
          primeAfterNavigation: prime,
          previousParentSetupKey: lastConditionalParentSetupKey || undefined,
          skipFormResetAfter,
          reusableIdValue: String(reusableIdValue || '')
        },
        perTestCaseTimeoutMs(tc)
      )
      tabResponse = response
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
    setRunState({ passed, failed, skipped, message: `Completed ${results.length}/${testCases.length}` })
  }

  function failUnreachable(tc, reason) {
    failed += 1
    results.push({
      id: tc.id,
      name: tc.name,
      passed: false,
      notes: `Failed: ${reason}`,
      screenshotDataUrl: ''
    })
    setRunState({ passed, failed, skipped, message: `Completed ${results.length}/${testCases.length}` })
  }

  while ((remaining.length > 0 || deferred.length > 0) && !RUN_STATE.cancellationRequested) {
    // 1) Drain everything that's reachable on the current section.
    //    label_check cases for this section run BEFORE its other test types.
    while (remaining.length > 0 && !RUN_STATE.cancellationRequested) {
      const lcIdx = remaining.findIndex(t => String(t?.test_type) === 'label_check')
      const tc = lcIdx >= 0 ? remaining.splice(lcIdx, 1)[0] : remaining.shift()
      const reachable = await probeReachable(tc)
      if (reachable) {
        await runOneTest(tc)
      } else {
        const key = tcDeferKey(tc)
        const count = (deferCount.get(key) || 0) + 1
        deferCount.set(key, count)
        if (count > MAX_DEFERS_PER_TEST) {
          failUnreachable(
            tc,
            `Field never became reachable after ${MAX_DEFERS_PER_TEST} section advances — possibly a stale or hallucinated field name`
          )
        } else {
          deferred.push(tc)
          setRunState({
            message: `Deferred ${pickCaseFieldLabel(tc)} — not on current section (${deferred.length} deferred)`
          })
        }
      }
    }

    if (deferred.length === 0) break
    if (RUN_STATE.cancellationRequested) break
    if (sectionsAdvanced >= MAX_SECTION_ADVANCES) {
      for (const tc of deferred) {
        failUnreachable(
          tc,
          `Field never became reachable — section-advance cap (${MAX_SECTION_ADVANCES}) reached`
        )
      }
      deferred = []
      break
    }

    // 2) Try to advance to the next section. ADVANCE_AND_PROBE fills any
    //    remaining visible fields, clicks Continue, and reports whether the
    //    section signature changed.
    setRunState({
      message: `Advancing to next section (${deferred.length} test${deferred.length === 1 ? '' : 's'} deferred)...`
    })
    const advanced = await attemptSectionAdvance()
    if (advanced) {
      sectionsAdvanced += 1
      remaining = deferred
      deferred = []
      lastConditionalParentSetupKey = ''
      setRunState({ contentNeedsReprime: true })
    } else {
      for (const tc of deferred) {
        failUnreachable(
          tc,
          'Field never became reachable — Continue did not advance the form (likely validation block or last section)'
        )
      }
      deferred = []
      break
    }
  }

  if (RUN_STATE.cancellationRequested) {
    // Persist whatever completed before Stop so the dashboard shows it.
    let stoppedRunId = ''
    if (results.length > 0) {
      try {
        setRunState({ message: 'Saving completed results...' })
        const uploadRes = await fetch(`${apiBase}/api/projects/${projectId}/extension-run`, {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ results })
        })
        const uploadData = await uploadRes.json().catch(() => ({}))
        if (uploadRes.ok) stoppedRunId = String(uploadData.runId || '')
      } catch {
        // Best-effort save on stop — never lose the stopped state if upload fails.
      }
    }
    const summary = `Stopped — ${passed} passed, ${failed} failed, ${skipped} skipped`
    setRunState({
      status: 'stopped',
      summary,
      message: summary,
      runId: stoppedRunId,
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
      reusableIdValue: String(message.reusableIdValue || '').trim(),
      skipTestTypes: Array.isArray(message.skipTestTypes) ? message.skipTestTypes : []
    }
    if (!payload.projectId || !payload.apiBase || !payload.token || !payload.tabId || !payload.reusableIdValue) {
      sendResponse({ ok: false, error: 'Missing run configuration (reusable ID is required)' })
      return true
    }
    _activeRunPromise = runExtensionTestsInBackground(payload)
      .catch(err => {
        setRunState({
          status: 'error',
          message: String(err?.message || 'Background extension run failed'),
          summary: '',
          finishedAt: Date.now()
        })
      })
      .finally(() => {
        _activeRunPromise = null
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
