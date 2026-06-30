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

// Shared POST so both the popup-driven SAVE message and the in-run auto-capture
// persist through one path. (A service worker can't message its own onMessage,
// so auto-capture calls this directly rather than re-sending SAVE.)
async function postFormStructure({ projectId, apiBase, token, structure }) {
  const res = await fetch(`${apiBase}/api/projects/${projectId}/form-structure`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(structure || {})
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Failed to save form structure')
  return data
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

function normalizeSectionName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim()
}

function sectionsMatch(a, b) {
  const na = normalizeSectionName(a).toLowerCase()
  const nb = normalizeSectionName(b).toLowerCase()
  if (!na && !nb) return true
  if (!na || !nb) return false
  if (na === nb) return true

  // Tokenize to significant words (drop punctuation and 1–2 char noise like
  // "of", "to", numbering). Generic — no section-name lists.
  const toks = s => new Set(
    s.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w.length > 2)
  )
  const ta = toks(na)
  const tb = toks(nb)
  if (!ta.size || !tb.size) return na.includes(nb) || nb.includes(na)

  let shared = 0
  for (const w of ta) if (tb.has(w)) shared += 1
  const ratio = shared / Math.min(ta.size, tb.size)
  // Pass if the shorter name is fully contained (ratio===1), or they share
  // most significant words.
  return ratio === 1 || shared >= 2 || ratio >= 0.6
}

function sortCasesWithinSection(cases) {
  const labelChecks = []
  const rest = []
  const submit = []
  for (const tc of Array.isArray(cases) ? cases : []) {
    const tt = String(tc?.test_type || '').trim()
    if (tt === 'label_check') labelChecks.push(tc)
    else if (tt === 'successful_submit') submit.push(tc)
    else rest.push(tc)
  }
  return [...labelChecks, ...rest, ...submit]
}

function inferSectionFromTc(tc) {
  const explicit = normalizeSectionName(tc?.section)
  if (explicit && explicit.toLowerCase() !== 'general') return explicit

  const fromExp = String(tc?.expected_result || '').match(/;\s*section\s*:\s*([^;]+)/i)
  if (fromExp?.[1]) return normalizeSectionName(fromExp[1])

  const fromWtt = String(tc?.what_to_test || '').match(/\bin\s+the\s+(.+?)\s+section\b/i)
  if (fromWtt?.[1]) return normalizeSectionName(fromWtt[1])

  if (String(tc?.test_type || '').trim() === 'successful_submit') return 'Submit'
  return ''
}

function collectAllExtensionTestCases(tcData, sectionGroups) {
  if (Array.isArray(tcData?.testCases) && tcData.testCases.length) return tcData.testCases
  return sectionGroups.flatMap(group => (Array.isArray(group?.testCases) ? group.testCases : []))
}

async function runExtensionTestsInBackground({ projectId, apiBase, token, tabId, reusableIdValue, skipTestTypes = [], sectionsFilter = [] }) {
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
    headers: authHeaders(token),
    cache: 'no-store' // always pull the CURRENT cases (e.g. just-regenerated), never a stale HTTP-cached copy
  })
  const tcData = await tcRes.json().catch(() => ({}))
  if (!tcRes.ok) throw new Error(tcData.error || 'Failed to fetch extension test cases')

  const sectionGroups = Array.isArray(tcData?.sections) && tcData.sections.length
    ? tcData.sections
    : [{
        name: 'General',
        testCases: Array.isArray(tcData?.testCases)
          ? tcData.testCases
          : (Array.isArray(tcData) ? tcData : [])
      }]

  const filterList = Array.isArray(sectionsFilter)
    ? sectionsFilter.map(s => normalizeSectionName(s)).filter(Boolean)
    : []

  let groupsToRun = sectionGroups
  if (filterList.length > 0) {
    const allCases = collectAllExtensionTestCases(tcData, sectionGroups)
    groupsToRun = filterList.map(sectionName => ({
      name: sectionName,
      testCases: sortCasesWithinSection(
        allCases.filter(tc => sectionsMatch(sectionName, inferSectionFromTc(tc)))
      )
    })).filter(group => group.testCases.length > 0)
  }

  const testCases = groupsToRun.flatMap(group => sortCasesWithinSection(group?.testCases || []))
  if (!testCases.length) {
    throw new Error(
      filterList.length
        ? `No test cases found for section "${filterList[0]}" — check section names match the SRD or re-generate test cases`
        : 'No test cases found — generate them in the app first'
    )
  }

  setRunState({ total: testCases.length, message: `Starting tests (1/${testCases.length})...` })

  const results = []
  let passed = 0
  let failed = 0
  let skipped = 0
  let lastConditionalParentSetupKey = ''
  const MAX_SECTION_ADVANCES = 8

  async function getCurrentSectionName() {
    try {
      const response = await sendTabMessageWithTimeout(tabId, { type: 'QA_HELPER_GET_CURRENT_SECTION' }, 8000)
      return normalizeSectionName(response?.section || '')
    } catch {
      return ''
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

  async function navigateToSection(targetSection) {
    const target = normalizeSectionName(targetSection)
    if (!target) return true

    for (let attempt = 0; attempt <= MAX_SECTION_ADVANCES; attempt += 1) {
      const current = await getCurrentSectionName()
      console.log('[QA nav] attempt', attempt, '— target:', JSON.stringify(target), '| current:', JSON.stringify(current), '| match:', sectionsMatch(current, target)) // TEMP DIAGNOSTIC
      if (sectionsMatch(current, target)) return true
      if (attempt >= MAX_SECTION_ADVANCES) break
      const advanced = await attemptSectionAdvance()
      if (!advanced) return false
      setRunState({ contentNeedsReprime: true })
      lastConditionalParentSetupKey = ''
      await captureAndPersistFormStructure()   // silent, best-effort — never blocks the run
    }
    const finalSection = await getCurrentSectionName()
    console.log('[QA nav] FINAL — target:', JSON.stringify(target), '| current:', JSON.stringify(finalSection), '| match:', sectionsMatch(finalSection, target)) // TEMP DIAGNOSTIC
    return sectionsMatch(finalSection, target)
  }

  async function probeReachable(tc) {
    try {
      const response = await sendTabMessageWithTimeout(
        tabId,
        { type: 'QA_HELPER_PROBE_FIELD_VISIBLE', testCase: tc },
        8000
      )
      if (!response) return true
      if (response.ok === false) return true
      if (response.visible) return true
      return false
    } catch {
      return true
    }
  }

  async function runOneTest(tc) {
    const fieldLabel = pickCaseFieldLabel(tc)
    const typeLabel = String(tc?.test_type || 'required_field').trim()
    setRunState({
      message: `Checking field: ${fieldLabel} | Type: ${typeLabel} (${results.length + 1}/${testCases.length})`
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
    setRunState({ current: results.length, passed, failed, skipped, message: `Completed ${results.length}/${testCases.length}` })
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
    setRunState({ current: results.length, passed, failed, skipped, message: `Completed ${results.length}/${testCases.length}` })
  }

  // Best-effort: grab the now-rendered section's headings+fields and persist them.
  // Awaits the (fast, synchronous) DOM read so we capture the right step; the POST
  // is fire-and-forget so the network never delays the run. All errors swallowed.
  async function captureAndPersistFormStructure() {
    try {
      const resp = await sendTabMessageWithTimeout(tabId, { type: 'QA_HELPER_CAPTURE_FORM_STRUCTURE' }, 5000)
      if (!resp?.ok || !resp.structure) return
      postFormStructure({ projectId, apiBase, token, structure: resp.structure }).catch(() => {})
    } catch {
      // Auto-capture must never disrupt a run.
    }
  }

  // Section-1 capture: grab the initial visible section before any advance, since
  // navigateToSection returns early (no advance) when already on the target section.
  await captureAndPersistFormStructure()

  console.log('[QA groups]', groupsToRun.length, 'groups:', groupsToRun.map(g => g.name)) // TEMP DIAGNOSTIC
  for (let groupIndex = 0; groupIndex < groupsToRun.length && !RUN_STATE.cancellationRequested; groupIndex += 1) {
    const group = groupsToRun[groupIndex]
    const sectionName = normalizeSectionName(group?.name || 'General')
    const sectionCases = sortCasesWithinSection(group?.testCases || [])
    if (!sectionCases.length) continue

    setRunState({
      message: `Section ${groupIndex + 1}/${groupsToRun.length}: ${sectionName} (${sectionCases.length} test${sectionCases.length === 1 ? '' : 's'})`
    })

      const reached = await navigateToSection(sectionName)
      if (!reached) {
        for (const tc of sectionCases) {
          failUnreachable(tc, `Could not navigate to section "${sectionName}"`)
        }
        continue
      }

      for (const tc of sectionCases) {
      if (RUN_STATE.cancellationRequested) break
      const reachable = await probeReachable(tc)
      if (!reachable) {
        failUnreachable(
          tc,
          `Field not visible on section "${sectionName}" — check section tagging or form state`
        )
        continue
      }
      await runOneTest(tc)
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
    // Only block a double-start when a run is GENUINELY executing — `_activeRunPromise`
    // is the truth (set while runExtensionTestsInBackground is in flight, nulled when it
    // settles). A `status: 'running'` left behind by a run that ended without a clean
    // terminal state is stale and must NOT strand the user — fall through and start fresh.
    if (RUN_STATE.status === 'running' && _activeRunPromise) {
      sendResponse({ ok: true, alreadyRunning: true, state: getRunSnapshot() })
      return true
    }
    const payload = {
      projectId: Number(message.projectId || 0),
      apiBase: String(message.apiBase || ''),
      token: String(message.token || ''),
      tabId: Number(message.tabId || 0),
      reusableIdValue: String(message.reusableIdValue || '').trim(),
      skipTestTypes: Array.isArray(message.skipTestTypes) ? message.skipTestTypes : [],
      sectionsFilter: Array.isArray(message.sectionsFilter) ? message.sectionsFilter : []
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

  if (message?.type === 'QA_HELPER_SAVE_FORM_STRUCTURE') {
    ;(async () => {
      try {
        const projectId = Number(message.projectId || 0)
        const apiBase = String(message.apiBase || '')
        const token = String(message.token || '')
        if (!projectId || !apiBase || !token) {
          sendResponse({ ok: false, error: 'Missing projectId, apiBase, or token' })
          return
        }
        const data = await postFormStructure({ projectId, apiBase, token, structure: message.structure || {} })
        sendResponse({ ok: true, summary: String(data.summary || ''), form_structure: data.form_structure || null })
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || 'Failed to save form structure') })
      }
    })()
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
