/* global chrome */
/**
 * In-page test runner — works across Irembo / ngx-formly style apps, not one static form.
 * Strategy: (1) resolve by Formly id model key when `field_name` matches; (2) label + optional
 * test-name context, with generic synonyms (cascades, nationality); (3) DOM-kind detection
 * (radio, ng-select, date hosts); (4) conditional triggers from natural-language when/if/select
 * (parsed parent + value — not hardcoded to one country or contract label).
 */
let hasExpandedSectionsForRun = false
let cancelCurrentTestRequested = false
let activeHighlightedField = null
let reusableIdValueForRun = ''
/** Set once per extension run: Step A+B discover required messages + fill all. */
let requiredFieldRunPreflightDone = false
/** Text from Step A (.invalid-feedback + formly-validation-message). */
let discoveredRequiredErrors = []

function clearActiveFieldHighlight() {
  if (!activeHighlightedField) return
  try {
    activeHighlightedField.style.outline = ''
    activeHighlightedField.style.outlineOffset = ''
    activeHighlightedField.style.boxShadow = ''
    activeHighlightedField.removeAttribute('data-qa-active-field')
  } catch {
    // Ignore cleanup issues on detached nodes.
  }
  activeHighlightedField = null
}

function getOrCreateRunIndicator() {
  let node = document.getElementById('qa-helper-run-indicator')
  if (node) return node
  node = document.createElement('div')
  node.id = 'qa-helper-run-indicator'
  node.style.position = 'fixed'
  node.style.right = '12px'
  node.style.top = '12px'
  node.style.zIndex = '2147483647'
  node.style.maxWidth = '420px'
  node.style.padding = '8px 10px'
  node.style.borderRadius = '8px'
  node.style.background = 'rgba(31,56,100,0.94)'
  node.style.color = '#fff'
  node.style.fontSize = '12px'
  node.style.lineHeight = '1.35'
  node.style.boxShadow = '0 4px 14px rgba(0,0,0,0.25)'
  node.style.pointerEvents = 'none'
  document.documentElement.appendChild(node)
  return node
}

function updateLiveRunIndicator(tc, fieldEl = null, stage = 'Checking field') {
  const node = getOrCreateRunIndicator()
  const fieldName =
    String(tc?.field_label || '').trim() ||
    String(getLabelText(fieldEl) || '').trim() ||
    String(tc?.field_name || '').trim() ||
    String(tc?.name || '').trim() ||
    'Unknown field'
  const type = String(tc?.test_type || 'required_field').trim()
  node.textContent = `${stage}: ${fieldName} (${type})`
  if (!fieldEl || !isVisible(fieldEl)) return
  clearActiveFieldHighlight()
  activeHighlightedField = fieldEl
  fieldEl.setAttribute('data-qa-active-field', '1')
  fieldEl.style.outline = '2px solid #2e75b6'
  fieldEl.style.outlineOffset = '2px'
  fieldEl.style.boxShadow = '0 0 0 3px rgba(46,117,182,0.2)'
}

function clearLiveRunIndicator() {
  clearActiveFieldHighlight()
  const node = document.getElementById('qa-helper-run-indicator')
  if (node?.parentNode) node.parentNode.removeChild(node)
}

function throwIfCancelled() {
  if (cancelCurrentTestRequested) {
    throw new Error('Test execution cancelled by user')
  }
}
function getLabelText(el) {
  const id = el.id
  if (id) {
    const byFor = document.querySelector(`label[for="${id}"]`)
    if (byFor?.textContent?.trim()) return byFor.textContent.trim()
  }
  const wrapped = el.closest('label')
  if (wrapped?.textContent?.trim()) return wrapped.textContent.trim()
  const aria = el.getAttribute('aria-label')
  if (aria?.trim()) return aria.trim()
  return ''
}

function hasRequiredAsterisk(el, labelText) {
  if (/\*/.test(String(labelText || ''))) return true
  const id = el.id
  if (id) {
    const byFor = document.querySelector(`label[for="${id}"]`)
    if (byFor && /\*/.test(byFor.textContent || '')) return true
  }
  const wrapped = el.closest('label')
  if (wrapped && /\*/.test(wrapped.textContent || '')) return true
  const container = el.closest('.form-group, .field, .input-group, .form-field') || el.parentElement
  if (container && /\*/.test(container.textContent || '')) return true
  return false
}

function scanFormFields() {
  const elements = Array.from(document.querySelectorAll('input, select, textarea, button'))
  return elements
    .map((el, idx) => {
      const tag = el.tagName.toLowerCase()
      const rawType = String(el.getAttribute('type') || '').toLowerCase()
      const type = rawType || (tag === 'select' ? 'select' : tag)
      const id = el.id || ''
      const name = el.getAttribute('name') || ''
      const placeholder = el.getAttribute('placeholder') || ''
      const label = getLabelText(el)
      const requiredAttr = Boolean(el.required) || el.hasAttribute('required')
      const ariaRaw = String(el.getAttribute('aria-required') || '').toLowerCase()
      const ariaRequired = ['true', 'required', '1'].includes(ariaRaw)
      const labelHasAsterisk = hasRequiredAsterisk(el, label)
      const required = Boolean(requiredAttr || ariaRequired || labelHasAsterisk)
      return {
        index: idx + 1,
        element: tag,
        type,
        id,
        name,
        placeholder,
        label,
        required,
        requiredSignals: {
          requiredAttr,
          ariaRequired,
          labelHasAsterisk
        }
      }
    })
}

function wait(ms) {
  return new Promise((resolve, reject) => {
    const raw = Number(ms || 0)
    // Light pacing so runs stay closer to 3–5 min for a full suite.
    const paced =
      raw <= 0 ? 0
        : raw < 120 ? raw + 18
          : Math.min(Math.round(raw * 1.04), raw + 70)
    const started = Date.now()
    const step = () => {
      if (cancelCurrentTestRequested) {
        reject(new Error('Test execution cancelled by user'))
        return
      }
      if (Date.now() - started >= paced) {
        resolve()
        return
      }
      setTimeout(step, 40)
    }
    step()
  })
}

function normalizeText(v) {
  return String(v || '').trim().toLowerCase()
}

function normalizeLabelText(v) {
  return normalizeText(v).replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
}

function sanitizeSearchLabel(v) {
  return normalizeLabelText(v)
    .replace(/\bconditional\b/g, ' ')
    .replace(/\brequired\b/g, ' ')
    .replace(/\boptional\b/g, ' ')
    .replace(/\bdisplay\b/g, ' ')
    .replace(/\btest\b/g, ' ')
    .replace(/\bformat\b/g, ' ')
    .replace(/\bvalidation\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Align raw labels with server inference: trailing " field", and test-title tails like
 * "… required field test for NIN". Without this, falling back to `tc.name` leaves tokens
 * such as "field for nin" after sanitizeSearchLabel strips only "required"/"test".
 */
function normalizeCaseFieldLabelRaw(raw) {
  let h = String(raw || '').trim()
    h = h.replace(/^test\s+(required\s+field|format\s+validation|optional\s+field|conditional\s+(required|display|field)|widget\s+auto\s+fill|attachment|disabled\s+field)\s*:\s*/i, '').trim()
  h = h.replace(/^(required|format|optional|conditional|widget|attachment|disabled)\s+(field|validation|display|required|auto\s+fill)\s*:\s*/i, '').trim()
  h = h.replace(/^[^-:]+-\s*/g, '').trim()
  h = h.replace(/^[^-:]+:\s*/g, '').trim()
  h = h.replace(/\s+required\s+field\s+test(\s+for\s+[^\s.]+)?\s*$/i, '').trim()
  h = h.replace(/\s+optional\s+field\s+test(\s+for\s+[^\s.]+)?\s*$/i, '').trim()
  h = h.replace(/\s+field\s*$/i, '').trim()
  h = h.replace(/^(the|a|an)\s+/i, '').trim()
  h = h
    .replace(/\s+(required|invalid|missing|more\s+than|too\s+long|less\s+than|invalid\s+email|invalid\s+phone|invalid\s+format)\b.*$/i, '')
    .trim()
  h = h.replace(/\s+error\s*$/i, '').trim()
  h = h.replace(/\s+test\s+case\s*$/i, '').trim()
  return h
}

/** Irembo formly ids: `formly_20_radio_gender_6`, `formly_34_customcascadingdropdowns_location_1` → last segment before trailing index is the model key. */
function parseFormlyFieldIdKey(fieldId) {
  const parts = String(fieldId || '').split('_')
  if (parts.length < 4 || parts[0] !== 'formly') return ''
  const last = parts[parts.length - 1]
  if (!/^\d+$/.test(last)) return ''
  return String(parts[parts.length - 2] || '')
}

function splitFieldNameIntoWords(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_\s]/g, '')
  const spaced = cleaned
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim()
  return spaced.split(/\s+/).filter(Boolean)
}

/** Derives plausible formly model keys from any API field_name without name-specific branches. */
function keyResolutionCandidates(fieldName) {
  const raw = String(fieldName || '')
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, '')
  if (!raw) return []
  const out = new Set()
  out.add(raw)
  out.add(raw.toLowerCase())
  if (raw.length) out.add(raw.charAt(0).toLowerCase() + raw.slice(1))
  const words = splitFieldNameIntoWords(raw)
  if (words.length) {
    const lower = words.map(w => w.toLowerCase())
    out.add(lower.join(''))
    out.add(lower.join('_'))
    out.add(
      words
        .map((w, i) =>
          i === 0 ? w.charAt(0).toLowerCase() + w.slice(1).toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        )
        .join('')
    )
    out.add(words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(''))
  }
  return [...out].filter(Boolean)
}

function resolveFieldTargetByFormlyKey(fieldName) {
  const candidates = keyResolutionCandidates(fieldName)
  if (candidates.length === 0) return { element: null, kind: 'unknown' }
  const lowered = new Set(candidates.map(c => String(c).toLowerCase()))
  const wraps = Array.from(document.querySelectorAll('formly-field, formly-wrapper-form-field'))
  for (const wrap of wraps) {
    const fid = String(wrap.id || '')
    const parsed = parseFormlyFieldIdKey(fid)
    if (!parsed || !lowered.has(parsed.toLowerCase())) continue
    const radio = wrap.querySelector('input[type="radio"]')
    if (radio) return { element: radio, kind: 'radio' }
    const ng = wrap.querySelector('ng-select, .ng-select, div[role="combobox"]')
    if (ng) return { element: ng, kind: 'ng-select' }
    const inner = wrap.querySelector(
      'input:not([type="hidden"]), select, textarea, irembogov-custom-date-picker input, irembogov-irembo-date-picker input'
    )
    if (inner) return { element: inner, kind: detectFieldKind(inner) }
  }
  return { element: null, kind: 'unknown' }
}

function significantLabelWords(norm) {
  return norm
    .split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/gi, ''))
    .filter(w => w.length > 2)
}

/**
 * Adds search variants from on-page formly copy: score wrappers by overlap with the label,
 * then combine label tokens with other distinctive tokens from the best-matching wrappers.
 */
function expandLabelSearchTerms(fieldLabel, hintBlob = '') {
  const terms = []
  const add = t => {
    const n = sanitizeSearchLabel(t)
    if (n && !terms.includes(n)) terms.push(n)
  }
  add(fieldLabel)
  const baseNorm = normalizeLabelText(`${fieldLabel} ${hintBlob}`)
  const labelWords = significantLabelWords(baseNorm)
  if (labelWords.length === 0) return terms

  const wraps = Array.from(document.querySelectorAll('formly-field, formly-wrapper-form-field'))
  const scored = wraps
    .map(w => {
      const t = normalizeLabelText(w.textContent || '')
      let score = 0
      for (const lw of labelWords) {
        if (t.includes(lw)) score += 1
      }
      return { t, score }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)

  for (const { t } of scored.slice(0, 8)) {
    if (terms.length >= 36) break
    const extraTokens = [
      ...new Set(
        significantLabelWords(t).filter(w => !labelWords.includes(w))
      )
    ].slice(0, 10)
    for (const ew of extraTokens) {
      if (terms.length >= 36) break
      for (const lw of labelWords) {
        add(`${lw} ${ew}`)
        add(`${ew} ${lw}`)
        if (terms.length >= 36) break
      }
      add(`${labelWords.join(' ')} ${ew}`.trim())
    }
  }
  return terms
}

/** District/Sector/Cell/Village often live under one `location` customcascadingdropdowns field. */
function resolveLocationCascadeChild(fieldLabel, contextHint = '') {
  const norm = sanitizeSearchLabel(fieldLabel)
  const steps = ['district', 'sector', 'cell', 'village']
  const step = steps.find(s => new RegExp(`\\b${s}\\b`).test(norm))
  if (!step) return { element: null, kind: 'unknown' }
  const hint = normalizeLabelText(contextHint)
  const candidates = Array.from(document.querySelectorAll('formly-field, formly-wrapper-form-field')).filter(w => {
    const k = parseFormlyFieldIdKey(w.id)
    return k && /location/i.test(String(k))
  })
  let locationWrap = null
  if (hint.includes('processing')) {
    locationWrap =
      candidates.find(w => normalizeLabelText(w.textContent).includes('processing')) || null
  } else {
    locationWrap =
      candidates.find(w => !normalizeLabelText(w.textContent).includes('processing')) ||
      candidates[0] ||
      null
  }
  if (!locationWrap && candidates.length > 0) locationWrap = candidates[0]
  if (!locationWrap) return { element: null, kind: 'unknown' }
  const selects = Array.from(locationWrap.querySelectorAll('ng-select, .ng-select, div[role="combobox"]'))
  for (const sel of selects) {
    const blob = normalizeLabelText(
      `${getControlContainer(sel)?.textContent || ''} ${sel.textContent || ''}`
    )
    if (blob.includes(step)) return { element: sel, kind: 'ng-select' }
  }
  const idx = steps.indexOf(step)
  if (idx >= 0 && selects[idx]) return { element: selects[idx], kind: 'ng-select' }
  return { element: null, kind: 'unknown' }
}

function resolveNationalityCascadeChild(fieldLabel) {
  const norm = sanitizeSearchLabel(fieldLabel)
  if (!/\bnationality\b/i.test(String(fieldLabel || '')) && !norm.includes('nationality')) {
    return { element: null, kind: 'unknown' }
  }
  const steps = ['province', 'district', 'sector', 'cell', 'village']
  const step = steps.find(s => new RegExp(`\\b${s}\\b`).test(norm))
  if (!step) return { element: null, kind: 'unknown' }
  const natWrap = Array.from(document.querySelectorAll('formly-field, formly-wrapper-form-field')).find(w => {
    const k = parseFormlyFieldIdKey(w.id)
    return k && k.toLowerCase() === 'nationality'
  })
  if (!natWrap) return { element: null, kind: 'unknown' }
  const selects = Array.from(natWrap.querySelectorAll('ng-select, .ng-select, div[role="combobox"]'))
  for (const sel of selects) {
    const blob = normalizeLabelText(
      `${getControlContainer(sel)?.textContent || ''} ${sel.textContent || ''}`
    )
    if (blob.includes(step)) return { element: sel, kind: 'ng-select' }
  }
  const idx = steps.indexOf(step)
  if (idx >= 0 && selects[idx]) return { element: selects[idx], kind: 'ng-select' }
  return { element: null, kind: 'unknown' }
}

function isVisible(el) {
  if (!el) return false
  if (el.offsetParent === null) return false
  const style = window.getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
}

/** Smooth-scroll the active control into view so you can watch the extension run. */
function scrollTestTargetIntoView(el) {
  if (!el || typeof el.scrollIntoView !== 'function') return
  try {
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
  } catch {
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' })
    } catch {
      try {
        el.scrollIntoView(true)
      } catch {
        // ignore
      }
    }
  }
}

function getVisibleValidationEntries() {
  const selectors = [
    '.invalid-feedback',
    'formly-validation-message',
    'mat-error',
    '.mat-mdc-form-field-error',
    '.mdc-text-field-helper-text--validation-msg',
    '.text-danger',
    '[class*="validation-message"]',
    '.ng-star-inserted .text-danger'
  ].join(', ')
  const all = Array.from(document.querySelectorAll(selectors))
  const leafLike = all.filter(el => {
    if (!isVisible(el)) return false
    const txt = String(el.textContent || '').replace(/\s+/g, ' ').trim()
    if (!txt) return false
    // Keep the most specific node: ignore container nodes that include smaller error nodes.
    const childHits = Array.from(el.querySelectorAll(selectors))
      .filter(child => child !== el && isVisible(child))
      .some(child => String(child.textContent || '').replace(/\s+/g, ' ').trim().length > 0)
    return !childHits
  })
  const seen = new Set()
  return leafLike
    .map(el => ({
      element: el,
      text: String(el.textContent || '').replace(/\s+/g, ' ').trim()
    }))
    .filter(entry => {
      if (!entry.text) return false
      const key = normalizeLabelText(entry.text)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

async function getVisibleValidationEntriesWithRetry(opts = {}) {
  const quick = Boolean(opts.quick)
  const initialWaitMs = quick ? 320 : 1100
  const maxMs = quick ? 640 : 1400
  const stepMs = quick ? 80 : 120
  await wait(initialWaitMs)
  const tries = Math.ceil(maxMs / stepMs)
  let last = []
  for (let i = 0; i < tries; i += 1) {
    last = getVisibleValidationEntries()
    if (last.length > 0) return last
    await wait(stepMs)
  }
  return last
}

function getTargetFieldValidationRoot(targetEl) {
  if (!targetEl?.closest) return null
  const formly = targetEl.closest('formly-wrapper-form-field, formly-field, formly-group')
  if (formly) return formly
  const mat = targetEl.closest(
    'mat-form-field, .mat-mdc-form-field, .mat-form-field, .mdc-text-field, .mat-mdc-text-field-wrapper'
  )
  if (mat) return mat
  const radioRoot = getRadioGroupContainer(targetEl)
  if (radioRoot) return radioRoot
  return targetEl.closest('.form-group, .field, .mb-3, .form-field')
}

function isMessageDomDescendantOfTargetFieldContainer(msgEl, targetEl) {
  const root = getTargetFieldValidationRoot(targetEl)
  if (!root || !msgEl) return false
  if (root.contains(msgEl)) return true
  let sib = root.nextElementSibling
  for (let i = 0; i < 6 && sib; i += 1) {
    if (sib === msgEl || sib.contains?.(msgEl)) return true
    sib = sib.nextElementSibling
  }
  const wrap = root.parentElement
  if (wrap && wrap.contains(msgEl)) {
    try {
      const rb = root.getBoundingClientRect?.()
      const mb = msgEl.getBoundingClientRect?.()
      if (rb && mb && mb.height > 0 && Math.abs(mb.top - rb.bottom) < 120 && Math.abs(mb.left - rb.left) < 240) {
        return true
      }
    } catch {
      // ignore geometry failures
    }
  }
  return false
}

function tokenizeNormalizedPhrase(norm) {
  return String(norm || '')
    .split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/gi, ''))
    .filter(Boolean)
}

/** True when msg and expected share the same three consecutive non-empty tokens (no single-word shortcuts). */
function messageContainsThreeConsecutiveWordsFromExpected(msgNorm, expectedNorm) {
  const words = tokenizeNormalizedPhrase(expectedNorm)
  if (words.length < 3) return false
  for (let i = 0; i <= words.length - 3; i += 1) {
    const phrase = `${words[i]} ${words[i + 1]} ${words[i + 2]}`
    if (msgNorm.includes(phrase)) return true
  }
  return false
}

function messageContainsTwoConsecutiveWordsFromExpected(msgNorm, expectedNorm) {
  const words = tokenizeNormalizedPhrase(expectedNorm)
  if (words.length < 2) return false
  for (let i = 0; i <= words.length - 2; i += 1) {
    const phrase = `${words[i]} ${words[i + 1]}`
    if (phrase.length > 3 && msgNorm.includes(phrase)) return true
  }
  return false
}

/** Short expected strings like "Invalid email format" vs real mat-error copy. */
function formatValidationLooseMatch(msgNorm, expectedNorm, whatToTestNorm, targetNorm) {
  if (!/(invalid|incorrect|format|characters|pattern|not\s+valid|must\s+be)/i.test(msgNorm)) return false
  if (/email|e-mail/.test(targetNorm) && /email/.test(whatToTestNorm)) {
    return /(invalid|incorrect|format|address|valid)/i.test(msgNorm)
  }
  if (/(phone|mobile|tel)/.test(targetNorm) && /phone/.test(whatToTestNorm)) {
    return /(invalid|incorrect|format|number|digit)/i.test(msgNorm)
  }
  if (/\blast\s+name\b/.test(targetNorm) || /\blast\s+name\b/.test(whatToTestNorm)) {
    return /(last|name|invalid|characters|format|pattern)/i.test(msgNorm)
  }
  if (/start\s*date/.test(targetNorm) || /start\s*date/.test(whatToTestNorm)) {
    return /(start|date|invalid|format)/i.test(msgNorm)
  }
  if (/date\s+of\s+birth|\bdob\b/.test(targetNorm) || /date\s+of\s+birth/.test(whatToTestNorm)) {
    return /(date|birth|invalid|format|age)/i.test(msgNorm)
  }
  const ew = tokenizeNormalizedPhrase(expectedNorm)
  for (let i = 0; i < ew.length - 1; i += 1) {
    const pair = `${ew[i]} ${ew[i + 1]}`
    if (pair.length > 4 && msgNorm.includes(pair)) return true
  }
  return false
}

function isGenericRequiredLikeMessage(norm) {
  const n = String(norm || '').trim()
  return (
    /^this field is required/i.test(n) ||
    /^field is required/i.test(n) ||
    /^value is required/i.test(n) ||
    /please (select|choose)/i.test(n) ||
    /^(an option|a value) must be selected/i.test(n)
  )
}

function looksAggregatedDiscoveryLine(norm) {
  const n = String(norm || '').trim()
  if (!n) return false
  const reqCount = (n.match(/\brequired\b/g) || []).length
  return n.length > 180 || reqCount > 2
}

/** Require multiple label tokens when the field name has several words (reduces wrong-field matches on long error blobs). */
function labelStrongMatch(norm, targetNorm) {
  const parts = sanitizeSearchLabel(targetNorm).split(/\s+/).filter(Boolean)
  if (!parts.length) return false
  const need = parts.filter(p => p.length > 1)
  if (!need.length) return false
  const hits = need.filter(p => norm.includes(p))
  if (need.length >= 2) return hits.length >= 2
  return hits.length === 1
}

function dobAgeFormatMessageMatch(targetNorm, expectedNorm, whatToTestNorm, msgNorm) {
  if (!/date\s+of\s+birth|dob|birthdate|birth\s+date/.test(targetNorm)) return false
  if (!/under\s+18|below\s+18|less\s+than\s*18|150|greater\s+than|over\s+150|years?\s+old|too\s+old|too\s+young/i.test(whatToTestNorm)) {
    return false
  }
  if (!/date\s+of\s+birth|dob|birth|age|year|18|150|invalid|required|eligib|minor|adult|allowed|least|most|maximum|minimum/i.test(msgNorm)) {
    return false
  }
  if (expectedNorm && /date\s+of\s+birth/.test(expectedNorm) && /required|invalid/.test(expectedNorm)) {
    return true
  }
  return /invalid|required|age|18|150|year|eligib|minor|allowed|must|least|most|maximum|minimum/.test(msgNorm)
}

function pickMatchedMessage(entries, expectedResult, targetLabel = '', targetField = null, whatToTest = '') {
  const targetNorm = sanitizeSearchLabel(targetLabel)
  const targetEl = targetField?.element
  const expectedNorm = normalizeLabelText(String(expectedResult || ''))
  const whatToTestNorm = normalizeLabelText(String(whatToTest || ''))
  const loginPageSignals = /enter your details|sign in|username or password|invalid username/i
  const reqish = /required|invalid|must|select|choose|missing|empty|option/i

  const scored = (entries || [])
    .map(entry => {
      const norm = normalizeLabelText(entry.text)
      if (!norm || loginPageSignals.test(norm)) return null
      const msgEl = entry?.element
      const associated = Boolean(targetEl && msgEl && isMessageDomDescendantOfTargetFieldContainer(msgEl, targetEl))
      const textOk3 = messageContainsThreeConsecutiveWordsFromExpected(norm, expectedNorm)
      const textOk2 = messageContainsTwoConsecutiveWordsFromExpected(norm, expectedNorm)
      const dobAgeOk = dobAgeFormatMessageMatch(targetNorm, expectedNorm, whatToTestNorm, norm)
      const formatOk = formatValidationLooseMatch(norm, expectedNorm, whatToTestNorm, targetNorm)
      const textOk = textOk3 || textOk2 || dobAgeOk || formatOk
      const labelHit = labelStrongMatch(norm, targetNorm)
      const generic = isGenericRequiredLikeMessage(norm)
      return { entry, norm, associated, textOk, labelHit, generic, dobAgeOk, formatOk }
    })
    .filter(Boolean)

  if (scored.length === 0) return ''

  const multi = scored.length > 1
  const pick = (pred) => scored.find(pred)

  let hit = pick(
    c =>
      c.associated &&
      (c.textOk ||
        (c.labelHit && reqish.test(c.norm)) ||
        (c.generic && (!multi || c.labelHit || c.textOk)))
  )
  if (hit) return hit.entry.text

  hit = pick(c => c.dobAgeOk && (c.associated || c.labelHit))
  if (hit) return hit.entry.text

  hit = pick(c => c.formatOk && (c.associated || c.labelHit))
  if (hit) return hit.entry.text

  hit = pick(
    c =>
      c.labelHit &&
      reqish.test(c.norm) &&
      c.norm.length < 200 &&
      (!multi || c.associated || c.textOk)
  )
  if (hit) return hit.entry.text

  hit = pick(c => c.textOk && c.labelHit && (c.associated || c.norm.length < 96))
  if (hit) return hit.entry.text

  return ''
}

function pickMatchedMessageForConditionalRequired(entries, expectedResult, targetLabel = '', targetField = null) {
  const targetEl = targetField?.element
  if (!targetEl || !Array.isArray(entries) || entries.length === 0) return ''
  const expectedNorm = normalizeLabelText(String(expectedResult || ''))
  const targetNorm = sanitizeSearchLabel(targetLabel)
  const loginPageSignals = /enter your details|sign in|username or password|invalid username/i

  let inContainer = entries.filter(entry => {
    const norm = normalizeLabelText(entry?.text || '')
    if (!norm || loginPageSignals.test(norm)) return false
    const msgEl = entry?.element
    return Boolean(msgEl && isMessageDomDescendantOfTargetFieldContainer(msgEl, targetEl))
  })
  if (inContainer.length === 0) {
    inContainer = entries.filter(entry => {
      const norm = normalizeLabelText(entry?.text || '')
      if (!norm || loginPageSignals.test(norm)) return false
      return labelStrongMatch(norm, targetNorm)
    })
  }
  if (inContainer.length === 0) return ''

  const byPhrase = inContainer.find(e =>
    messageContainsThreeConsecutiveWordsFromExpected(normalizeLabelText(e.text), expectedNorm)
  )
  if (byPhrase) return byPhrase.text

  // For required checks, container-scoped generic required messages are acceptable.
  const generic = inContainer.find(e => isGenericRequiredLikeMessage(normalizeLabelText(e.text)))
  if (generic) return generic.text

  const byLabel = inContainer.find(e => labelStrongMatch(normalizeLabelText(e.text), targetNorm))
  if (byLabel) return byLabel.text
  return ''
}

function dispatchInputEvents(el) {
  if (!el) return
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function dispatchBlurEvent(el) {
  if (!el) return
  el.dispatchEvent(new Event('blur', { bubbles: true }))
}

function clearFieldValue(el) {
  if (!el) return
  const tag = String(el.tagName || '').toLowerCase()
  const type = String(el.type || '').toLowerCase()
  if (type === 'radio' || type === 'checkbox') {
    el.checked = false
    dispatchInputEvents(el)
    return
  }
  if (tag === 'select') {
    el.value = ''
    dispatchInputEvents(el)
    return
  }
  el.value = ''
  dispatchInputEvents(el)
}

function forceClearRadioGroupSelection(fieldEl) {
  const group = collectRadioGroup(fieldEl, fieldEl?.name || '')
  if (!group.length) return false
  let changed = false
  for (const radio of group) {
    if (radio.checked) changed = true
    radio.checked = false
    radio.defaultChecked = false
    radio.removeAttribute?.('checked')
    dispatchInputEvents(radio)
    dispatchBlurEvent(radio)
  }
  const holder = getRadioGroupContainer(fieldEl) || fieldEl?.closest?.('fieldset, .form-group, .field')
  if (holder) {
    holder.dispatchEvent(new Event('input', { bubbles: true }))
    holder.dispatchEvent(new Event('change', { bubbles: true }))
    holder.dispatchEvent(new Event('blur', { bubbles: true }))
  }
  return changed
}

function getRadioGroupContainer(fieldEl) {
  const group = collectRadioGroup(fieldEl, fieldEl?.name || '')
  const first = group[0] || fieldEl || null
  if (!first?.closest) return null
  return first.closest('formly-wrapper-form-field, formly-field, fieldset, [role="radiogroup"], .form-group, .field')
}

async function ensureRadioGroupUnselected(fieldEl, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    forceClearRadioGroupSelection(fieldEl)
    await wait(120)
    const group = collectRadioGroup(fieldEl, fieldEl?.name || '')
    if (!group.some(r => Boolean(r.checked))) return true
  }
  return false
}

function cssEscapeSafe(value) {
  try {
    return CSS.escape(String(value || ''))
  } catch {
    return String(value || '').replace(/"/g, '\\"')
  }
}

/** True when the control sits in a field row whose own text (not a giant parent step) includes the label. Stops "Live in Rwanda" resolving to First Name. */
function nearControlMatchesSearchLabel(el, normLabel) {
  if (!el || !normLabel) return false
  const fieldWrap =
    el.closest('formly-wrapper-form-field') ||
    el.closest('formly-field') ||
    el.closest('.form-group, .field')
  if (!fieldWrap) return false
  let chunk = String(fieldWrap.textContent || '').slice(0, 2000)
  const prev = fieldWrap.previousElementSibling
  if (prev && prev.textContent && prev.textContent.length < 500) {
    const prevTag = String(prev.tagName || '').toLowerCase()
    const prevCls = String(prev.className || '')
    if (prevTag === 'label' || /label|legend|form-label|question/i.test(prevCls)) {
      chunk = `${String(prev.textContent || '')} ${chunk}`
    }
  }
  const near = normalizeLabelText(`${getLabelText(el)} ${chunk}`)
  return near.includes(normLabel)
}

function detectFieldKind(el) {
  if (!el) return 'unknown'
  const tag = String(el.tagName || '').toLowerCase()
  const type = String(el.type || '').toLowerCase()
  const placeholder = normalizeLabelText(el.getAttribute?.('placeholder') || '')
  if (type === 'radio') return 'radio'
  if (type === 'file') return 'file'
  if (tag === 'select') return 'select'
  if (el.closest('ng-select, .ng-select') || tag === 'ng-select' || el.getAttribute?.('role') === 'combobox') return 'ng-select'
  if (
    el.closest(
      'irembogov-custom-date-picker, irembogov-irembo-date-picker, [class*="custom-datepicker"], [class*="datepicker"]'
    ) ||
    type === 'date' ||
    placeholder.includes('date')
  ) {
    return 'date'
  }
  if (tag === 'textarea') return 'textarea'
  return 'input'
}

function getLocalFieldTextBlobForScoring(el) {
  if (!el?.closest) return ''
  const wrap = el.closest(
    'formly-wrapper-form-field, formly-field, mat-form-field, .mat-mdc-form-field, fieldset, .form-group, .field'
  )
  let chunk = String(wrap?.textContent || '').slice(0, 2400)
  const prev = wrap?.previousElementSibling
  if (prev && String(prev.textContent || '').length < 450) {
    const prevTag = String(prev.tagName || '').toLowerCase()
    if (prevTag === 'label' || /label|question|legend|form-label/i.test(String(prev.className || ''))) {
      chunk = `${String(prev.textContent || '')} ${chunk}`
    }
  }
  return normalizeLabelText(`${getLabelText(el)} ${chunk}`)
}

function minAcceptScoreForDeclaredField(scoreKey) {
  const words = significantLabelWords(sanitizeSearchLabel(scoreKey))
  if (words.length >= 3) return 36
  if (words.length === 2) return 26
  if (words.length === 1) return words[0].length > 6 ? 20 : 14
  return 10
}

/** How well `el` matches the test case's declared field (label + optional field_name + hint). */
function scoreFieldTargetCandidate(el, declaredLabelNorm, fieldName, contextHint) {
  if (!el) return -1e9
  const blob = getLocalFieldTextBlobForScoring(el)
  const norm = sanitizeSearchLabel(declaredLabelNorm)
  const words = significantLabelWords(norm)
  let s = 0
  const fn = String(fieldName || '').trim()
  if (fn) {
    const wrap = el.closest('formly-field, formly-wrapper-form-field')
    const key = parseFormlyFieldIdKey(wrap?.id || '')
    const fnC = fn.toLowerCase().replace(/[^a-z0-9]+/g, '')
    const keyC = String(key).toLowerCase().replace(/[^a-z0-9]+/g, '')
    if (fnC && keyC && (keyC === fnC || keyC.includes(fnC) || fnC.includes(keyC))) s += 130
    const nm = String(el.getAttribute?.('name') || el.name || '').toLowerCase()
    const fid = String(el.id || '').toLowerCase()
    if (fnC && (nm.includes(fnC) || fid.includes(fnC))) s += 60
  }
  for (const w of words) {
    if (!w) continue
    if (blob.includes(w)) s += w.length >= 5 ? 16 : w.length >= 4 ? 12 : 7
  }
  if (norm && nearControlMatchesSearchLabel(el, norm)) s += 42
  if (words.length >= 2) {
    const allHit = words.every(w => blob.includes(w))
    if (allHit) s += 48
    else s -= 22
  }
  const stop = new Set([
    'test',
    'field',
    'required',
    'conditional',
    'display',
    'validation',
    'format',
    'check',
    'leave',
    'enter',
    'when',
    'select',
    'empty',
    'with',
    'valid',
    'values'
  ])
  for (const hw of significantLabelWords(sanitizeSearchLabel(String(contextHint || '').slice(0, 260)))) {
    if (hw.length < 4 || stop.has(hw)) continue
    if (blob.includes(hw)) s += 5
  }
  const wrapLen = String(el.closest('formly-field, formly-wrapper-form-field')?.textContent || '').length
  if (wrapLen > 5500) s -= 14
  else if (wrapLen > 0 && wrapLen < 900) s += 6
  return s
}

function pickBestFieldTargetFromCandidates(cands, declaredLabelNorm, fieldName, contextHint) {
  if (!cands.length) return { element: null, kind: 'unknown' }
  const hint = String(contextHint || '')
  const scored = cands
    .map(c => ({
      ...c,
      score: scoreFieldTargetCandidate(c.element, declaredLabelNorm, fieldName, hint)
    }))
    .sort((a, b) => b.score - a.score)
  const best = scored[0]
  const minS = minAcceptScoreForDeclaredField(declaredLabelNorm)
  if (best.score < minS) {
    if (best.score < 8) return { element: null, kind: 'unknown' }
    if (scored.length >= 2 && best.score - scored[1].score < 6) return { element: null, kind: 'unknown' }
  }
  if (scored.length >= 2 && best.score - scored[1].score < 8 && scored[1].score >= minS - 4) {
    const n = sanitizeSearchLabel(declaredLabelNorm)
    const aNear = nearControlMatchesSearchLabel(best.element, n)
    const bNear = nearControlMatchesSearchLabel(scored[1].element, n)
    if (aNear && !bNear) return { element: best.element, kind: best.kind }
    if (!aNear && bNear) return { element: scored[1].element, kind: scored[1].kind }
    if (best.score < minS + 12) return { element: null, kind: 'unknown' }
  }
  return { element: best.element, kind: best.kind }
}

/** Every control that plausibly matches `normLabel` (substring / label walk), before global ranking. */
function gatherFieldTargetsByNorm(normLabel, nameText) {
  const out = []
  const seen = new Set()
  const push = (el, kind) => {
    if (!el || seen.has(el)) return
    seen.add(el)
    out.push({ element: el, kind: kind || detectFieldKind(el) })
  }

  if (!normLabel) return out

  const labels = Array.from(document.querySelectorAll('label'))
  for (const labelEl of labels) {
    const lNorm = normalizeLabelText(labelEl.textContent)
    if (!lNorm.includes(normLabel)) continue
    const forId = String(labelEl.getAttribute('for') || '').trim()
    if (forId) {
      const byFor = document.getElementById(forId)
      if (byFor) push(byFor, detectFieldKind(byFor))
    }
    const nested = labelEl.querySelector('input, select, textarea, ng-select, .ng-select, div[role="combobox"]')
    if (nested) push(nested, detectFieldKind(nested))
    const sib = labelEl.nextElementSibling
    if (sib?.matches?.('input, select, textarea, ng-select, .ng-select, div[role="combobox"]')) {
      push(sib, detectFieldKind(sib))
    }
  }

  const containerSelector = 'formly-field, formly-wrapper-form-field, irembogov'
  const innerSelector =
    'input:not([type="hidden"]), select, textarea, ng-select, .ng-select, div[role="combobox"], irembogov-custom-date-picker input, irembogov-irembo-date-picker input'
  const containerCandidates = Array.from(document.querySelectorAll(containerSelector))
    .filter(container => normLabel && normalizeLabelText(container.textContent).includes(normLabel))
    .sort(
      (a, b) =>
        normalizeLabelText(a.textContent).length - normalizeLabelText(b.textContent).length
    )
  for (const container of containerCandidates) {
    const inners = Array.from(container.querySelectorAll(innerSelector))
    for (const inner of inners) {
      if (nearControlMatchesSearchLabel(inner, normLabel)) push(inner, detectFieldKind(inner))
    }
  }

  const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
  for (const radio of radios) {
    const near = normalizeLabelText(getRadioContextText(radio))
    if (normLabel && near.includes(normLabel)) push(radio, 'radio')
  }

  const dateComps = Array.from(
    document.querySelectorAll(
      'irembogov-custom-date-picker, irembogov-irembo-date-picker, [class*="custom-datepicker"], [class*="datepicker"]'
    )
  )
  for (const comp of dateComps) {
    const near = normalizeLabelText(`${comp.textContent || ''} ${comp.closest('formly-field, formly-wrapper-form-field, .form-group, .field')?.textContent || ''}`)
    if (normLabel && near.includes(normLabel)) {
      const input = comp.querySelector('input')
      if (input) push(input, 'date')
    }
  }

  const ngSelects = Array.from(document.querySelectorAll('ng-select, .ng-select, div[role="combobox"]'))
  for (const ngs of ngSelects) {
    const near = normalizeLabelText(`${ngs.textContent || ''} ${ngs.closest('formly-field, formly-wrapper-form-field, .form-group, .field')?.textContent || ''}`)
    if (normLabel && near.includes(normLabel)) push(ngs, 'ng-select')
  }

  const controls = Array.from(document.querySelectorAll('input, textarea, select'))
  for (const control of controls) {
    let cur = control
    for (let depth = 0; depth < 5 && cur; depth += 1) {
      const lbl = cur.querySelector?.('label')
      const txt = normalizeLabelText(`${lbl?.textContent || ''} ${cur.textContent || ''}`)
      if (normLabel && txt.includes(normLabel)) {
        push(control, detectFieldKind(control))
        break
      }
      cur = cur.parentElement
    }
  }

  if (nameText) {
    const byName = document.querySelector(
      `input[name="${cssEscapeSafe(nameText)}"], select[name="${cssEscapeSafe(nameText)}"], textarea[name="${cssEscapeSafe(nameText)}"], #${cssEscapeSafe(nameText)}`
    )
    if (byName) push(byName, detectFieldKind(byName))
  }

  return out
}

function buildSearchTermsForField(fieldLabel, hint) {
  const primary = sanitizeSearchLabel(fieldLabel)
  const terms = []
  const add = t => {
    const s = sanitizeSearchLabel(t)
    if (!s || terms.includes(s)) return
    if (s.length < 4 && s !== primary) return
    terms.push(s)
  }
  add(primary)
  for (const t of expandLabelSearchTerms(fieldLabel, hint)) add(t)
  return terms
}

function resolveFieldTarget(fieldLabel, fieldName, contextHint = '') {
  const nameText = String(fieldName || '').trim()
  const hint = `${nameText} ${String(contextHint || '')}`.trim()
  const declared = sanitizeSearchLabel(fieldLabel)

  const byKey = resolveFieldTargetByFormlyKey(nameText)
  if (byKey.element) {
    const ks = scoreFieldTargetCandidate(byKey.element, declared, nameText, hint)
    if (ks >= 55 || (ks >= 28 && nearControlMatchesSearchLabel(byKey.element, declared))) {
      return byKey
    }
  }

  const locCascade = resolveLocationCascadeChild(fieldLabel, hint)
  if (locCascade.element) return locCascade

  const natCascade = resolveNationalityCascadeChild(fieldLabel)
  if (natCascade.element) return natCascade

  const merged = []
  const seen = new Set()
  const pushUnique = (el, kind) => {
    if (!el || seen.has(el)) return
    seen.add(el)
    merged.push({ element: el, kind })
  }

  if (byKey.element) pushUnique(byKey.element, byKey.kind)

  for (const normLabel of buildSearchTermsForField(fieldLabel, hint)) {
    for (const { element, kind } of gatherFieldTargetsByNorm(normLabel, nameText)) {
      pushUnique(element, kind)
    }
  }

  return pickBestFieldTargetFromCandidates(merged, declared, nameText, hint)
}

function getControlContainer(el) {
  if (!el) return null
  return el.closest('formly-wrapper-form-field, formly-field, .form-group, .field, .ng-star-inserted')
}

function getRadioContextText(radio) {
  if (!radio) return ''
  const own = getLabelText(radio)
  const container = getControlContainer(radio)
  const fieldset = radio.closest('fieldset')
  const legend = fieldset?.querySelector('legend')
  let nearHeading = ''
  const holder = fieldset || container
  if (holder) {
    const prev = holder.previousElementSibling
    if (prev && prev.textContent && prev.textContent.length < 300) {
      const cls = String(prev.className || '')
      const tag = String(prev.tagName || '').toLowerCase()
      if (tag === 'label' || tag === 'legend' || /label|legend|question|title|header/i.test(cls)) {
        nearHeading = String(prev.textContent || '')
      }
    }
  }
  return `${own} ${legend?.textContent || ''} ${fieldset?.textContent || ''} ${container?.textContent || ''} ${nearHeading}`
}

function findRadiosForLabel(fieldLabel) {
  const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
  for (const norm of expandLabelSearchTerms(fieldLabel)) {
    if (!norm) continue
    const matched = radios.filter(radio => {
      const name = String(radio.name || '').trim()
      const sameNameGroupText = name
        ? Array.from(document.querySelectorAll(`input[type="radio"][name="${cssEscapeSafe(name)}"]`))
            .map(r => getRadioContextText(r))
            .join(' ')
        : ''
      const near = `${getRadioContextText(radio)} ${sameNameGroupText}`
      return normalizeLabelText(near).includes(norm)
    })
    if (matched.length > 0) return matched
  }
  return []
}

function findNgSelectForLabel(fieldLabel) {
  const comps = Array.from(document.querySelectorAll('ng-select, .ng-select, div[role="combobox"]'))
  for (const norm of expandLabelSearchTerms(fieldLabel)) {
    if (!norm) continue
    for (const comp of comps) {
      const near = `${comp.textContent || ''} ${getControlContainer(comp)?.textContent || ''}`
      if (normalizeLabelText(near).includes(norm)) return comp
    }
  }
  return null
}

function findDateInputForLabel(fieldLabel) {
  const dateComponents = Array.from(
    document.querySelectorAll(
      'irembogov-custom-date-picker, irembogov-irembo-date-picker, [class*="custom-datepicker"], [class*="datepicker"]'
    )
  )
  for (const norm of expandLabelSearchTerms(fieldLabel)) {
    if (!norm) continue
    const needsBirth = norm.includes('birth')
    for (const comp of dateComponents) {
      const near = `${comp.textContent || ''} ${getControlContainer(comp)?.textContent || ''}`
      const nearNorm = normalizeLabelText(near)
      if (!nearNorm.includes(norm) && !(needsBirth && nearNorm.includes('birth'))) continue
      if (needsBirth && !nearNorm.includes('birth')) continue
      const input = comp.querySelector('input')
      if (input) return input
    }
    const dateInputs = Array.from(document.querySelectorAll('input[type="date"], input[placeholder*="date" i]'))
    for (const input of dateInputs) {
      const near = `${getLabelText(input)} ${getControlContainer(input)?.textContent || ''}`
      const nearNorm = normalizeLabelText(near)
      if (!nearNorm.includes(norm) && !(needsBirth && nearNorm.includes('birth'))) continue
      if (needsBirth && !nearNorm.includes('birth')) continue
      return input
    }
  }
  return null
}

function formatDateDmy(date) {
  const d = String(date.getDate()).padStart(2, '0')
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const y = String(date.getFullYear())
  return `${d}/${m}/${y}`
}

function getSafeDateFallbackValue() {
  // Keep adult-safe default but avoid one fixed hardcoded date.
  const d = new Date()
  d.setFullYear(d.getFullYear() - 30)
  return formatDateDmy(d)
}

function isPickerCellVisible(el) {
  if (!el) return false
  const style = window.getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
  return el.getClientRects().length > 0
}

function isLikelyDobInput(inputEl) {
  const blob = normalizeLabelText(
    `${getLabelText(inputEl)} ${inputEl?.name || ''} ${inputEl?.id || ''} ${inputEl?.placeholder || ''} ${getControlContainer(inputEl)?.textContent || ''}`
  )
  return /\b(date of birth|dob|birth)\b/.test(blob)
}

function parseDateAny(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (dmy) {
    const d = Number(dmy[1])
    const m = Number(dmy[2])
    const y = Number(dmy[3])
    const dt = new Date(y, m - 1, d)
    if (dt && dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) return dt
  }
  const ymd = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (ymd) {
    const y = Number(ymd[1])
    const m = Number(ymd[2])
    const d = Number(ymd[3])
    const dt = new Date(y, m - 1, d)
    if (dt && dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) return dt
  }
  const dt = new Date(raw)
  return Number.isNaN(dt.getTime()) ? null : dt
}

function isAdultDate(value, minAge = 18) {
  const dt = parseDateAny(value)
  if (!dt) return false
  const cutoff = new Date()
  cutoff.setFullYear(cutoff.getFullYear() - minAge)
  return dt <= cutoff
}

function isCustomDatePickerInput(inputEl) {
  return Boolean(
    inputEl?.closest?.(
      'irembogov-custom-date-picker, irembogov-irembo-date-picker'
    )
  )
}

async function setCustomDatePickerValue(inputEl, dateString) {
  if (!inputEl) return false
  const next = String(dateString || '').trim()
  inputEl.click?.()
  inputEl.dispatchEvent(new FocusEvent('focus', { bubbles: true }))
  setInputValueNative(inputEl, next)
  inputEl.dispatchEvent(new Event('input', { bubbles: true }))
  inputEl.dispatchEvent(new Event('change', { bubbles: true }))
  inputEl.dispatchEvent(new Event('blur', { bubbles: true }))
  inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
  inputEl.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }))
  await wait(300)
  return String(inputEl.value || '').trim() === next
}

async function clearCustomDatePickerValue(inputEl) {
  if (!inputEl) return false
  const host =
    inputEl.closest('irembogov-custom-date-picker, irembogov-irembo-date-picker, [class*="custom-datepicker"], [class*="datepicker"]') ||
    inputEl.parentElement
  inputEl.click?.()
  inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))
  inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
  setInputValueNative(inputEl, '')
  inputEl.dispatchEvent(new Event('input', { bubbles: true }))
  inputEl.dispatchEvent(new Event('change', { bubbles: true }))
  inputEl.dispatchEvent(new Event('blur', { bubbles: true }))
  const related = Array.from(host?.querySelectorAll?.('input') || [])
  for (const inp of related) {
    setInputValueNative(inp, '')
    inp.removeAttribute?.('value')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    inp.dispatchEvent(new Event('change', { bubbles: true }))
    inp.dispatchEvent(new Event('blur', { bubbles: true }))
  }
  document.body?.click?.()
  await wait(300)
  return String(inputEl.value || '').trim() === '' && related.every(inp => String(inp.value || '').trim() === '')
}

function formatDateIso(date) {
  const y = String(date.getFullYear())
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function setInputValueNative(input, value) {
  if (!input) return
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
  if (descriptor?.set) {
    descriptor.set.call(input, String(value || ''))
  } else {
    input.value = String(value || '')
  }
}

function commitDateValueToControl(inputEl, host, displayValue) {
  const parsed = parseDateAny(displayValue)
  const display = String(displayValue || '')
  const iso = parsed ? formatDateIso(parsed) : ''
  const scope = host || inputEl?.parentElement || inputEl
  const related = Array.from(scope?.querySelectorAll?.('input') || [])
  const targets = related.length ? related : [inputEl]
  for (const inp of targets) {
    if (!inp) continue
    const isHidden = String(inp.type || '').toLowerCase() === 'hidden'
    const next = isHidden && iso ? iso : display
    setInputValueNative(inp, next)
    inp.setAttribute?.('value', next)
    dispatchInputEvents(inp)
    inp.dispatchEvent(new Event('keyup', { bubbles: true }))
    inp.dispatchEvent(new Event('focusout', { bubbles: true }))
    dispatchBlurEvent(inp)
  }
  if (inputEl && inputEl !== targets[0]) {
    setInputValueNative(inputEl, display)
    inputEl.setAttribute?.('value', display)
    dispatchInputEvents(inputEl)
    dispatchBlurEvent(inputEl)
  }
}

async function setDateValuePreferPicker(inputEl, fallbackValue = '') {
  if (!inputEl) return false
  const safeFallback = fallbackValue || getSafeDateFallbackValue()
  const dobInput = isLikelyDobInput(inputEl)
  scrollTestTargetIntoView(inputEl)
  inputEl.focus?.()
  inputEl.click?.()
  dispatchInputEvents(inputEl)
  await wait(220)

  const host =
    inputEl.closest('irembogov-custom-date-picker, irembogov-irembo-date-picker, [class*="custom-datepicker"], [class*="datepicker"]') ||
    inputEl.parentElement
  const trigger =
    host?.querySelector?.(
      'button, [role="button"], .calendar, .calendar-icon, [class*="calendar"], [aria-label*="calendar" i], [title*="calendar" i]'
    ) || null
  if (trigger) {
    trigger.click?.()
    await wait(180)
  } else {
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await wait(120)
  }

  const daySelectors = [
    '.mat-calendar-body-cell-content',
    '.mat-calendar-body-cell',
    '.day:not(.old):not(.new)',
    '.ngb-dp-day div[role="button"]',
    '.ngb-dp-day',
    '[role="gridcell"] button',
    '[role="gridcell"]',
    '.datepicker td:not(.disabled):not(.off) button',
    '.datepicker td:not(.disabled):not(.off)'
  ]
  const dayCells = Array.from(document.querySelectorAll(daySelectors.join(', '))).filter(isPickerCellVisible)
  const pickable = dayCells.find(cell => {
    const t = String(cell.textContent || '').trim()
    if (!/^\d{1,2}$/.test(t)) return false
    const cls = String(cell.className || '')
    const disabled = cell.getAttribute?.('aria-disabled') === 'true' || cell.hasAttribute?.('disabled')
    return !disabled && !/disabled|off|outside|muted|other-month/i.test(cls)
  })
  if (pickable) {
    const clickTarget = pickable.querySelector?.('button, [role="button"]') || pickable
    clickTarget.click?.()
    await wait(260)
    if (String(inputEl.value || '').trim()) {
      if (dobInput && !isAdultDate(inputEl.value, 18)) {
        commitDateValueToControl(inputEl, host, safeFallback)
      } else {
        commitDateValueToControl(inputEl, host, String(inputEl.value || '').trim())
      }
      document.body?.click?.()
      await wait(120)
      return true
    }
  }

  commitDateValueToControl(inputEl, host, safeFallback)
  document.body?.click?.()
  return Boolean(String(inputEl.value || '').trim())
}

const LOCATION_CASCADE_STEPS = ['district', 'sector', 'cell', 'village', 'province']

/** Earliest location keyword in the field wrapper reading order (district before sector, …). */
function primaryLocationStepForControl(el) {
  if (!el?.closest) return ''
  const wrap = el.closest('formly-field, formly-wrapper-form-field') || getControlContainer(el)
  const lower = String(wrap?.textContent || '').slice(0, 800).toLowerCase()
  let bestPos = 1e9
  let best = ''
  for (const w of LOCATION_CASCADE_STEPS) {
    const re = new RegExp(`\\b${w}\\b`, 'i')
    const idx = lower.search(re)
    if (idx >= 0 && idx < bestPos) {
      bestPos = idx
      best = w
    }
  }
  return best
}

function primaryLocationTierIndex(el) {
  const step = primaryLocationStepForControl(el)
  const idx = LOCATION_CASCADE_STEPS.indexOf(step)
  return idx >= 0 ? idx : 999
}

/** True when this ng-select/combobox sits in a district/sector/cell/village (or province) cascade row. */
function isLocationCascadeSelectRoot(root) {
  if (!root) return false
  const step = primaryLocationStepForControl(root)
  return Boolean(step && LOCATION_CASCADE_STEPS.includes(step))
}

/**
 * Next unfilled step in the location chain only (lowest tier first), up to the tier under test.
 * Does not touch unrelated dropdowns (nationality, etc.).
 */
function pickNextLocationCascadeDropdown(fieldLabel) {
  const wantStep = locationStepFromFieldLabel(fieldLabel)
  const maxTier = wantStep && LOCATION_CASCADE_STEPS.includes(wantStep)
    ? LOCATION_CASCADE_STEPS.indexOf(wantStep)
    : LOCATION_CASCADE_STEPS.length - 1

  const ranked = Array.from(document.querySelectorAll('ng-select, .ng-select, div[role="combobox"]'))
    .filter(el => isVisible(el) && ngSelectRootAppearsUnselected(el))
    .map(el => {
      const step = primaryLocationStepForControl(el)
      const tier =
        step && LOCATION_CASCADE_STEPS.includes(step) ? LOCATION_CASCADE_STEPS.indexOf(step) : 999
      return {
        el,
        tier,
        top: Number(el.getBoundingClientRect?.().top ?? 0)
      }
    })
    .filter(x => x.tier < 999 && x.tier <= maxTier)
    .sort((a, b) => a.tier - b.tier || a.top - b.top)

  return ranked[0]?.el || null
}

/** Which location tier this test targets (e.g. "Sector" → sector). */
function locationStepFromFieldLabel(fieldLabel) {
  const lower = normalizeText(String(fieldLabel || ''))
  let bestPos = 1e9
  let best = ''
  for (const w of LOCATION_CASCADE_STEPS) {
    const re = new RegExp(`\\b${w}\\b`, 'i')
    const idx = lower.search(re)
    if (idx >= 0 && idx < bestPos) {
      bestPos = idx
      best = w
    }
  }
  return best
}

/** True when resolved control is the intended cascade row (not an earlier dropdown). */
function resolvedTargetMatchesLocationStep(fieldLabel, target) {
  const want = locationStepFromFieldLabel(fieldLabel)
  if (!want) return true
  const el = target?.element
  if (!el) return false
  const got = primaryLocationStepForControl(el)
  if (!got) return false
  return got.toLowerCase() === want.toLowerCase()
}

async function resolveTargetWithTypeHints(fieldLabel, fieldName, options = {}) {
  let target = await resolveVisibleTargetWithNavigation(fieldLabel, fieldName, options)
  if (
    target.element &&
    isVisible(target.element) &&
    resolvedTargetMatchesLocationStep(fieldLabel, target)
  ) {
    return target
  }

  const hintedRadios = findRadiosForLabel(fieldLabel)
  if (hintedRadios.length > 0) return { element: hintedRadios[0], kind: 'radio' }

  const hintedDate = findDateInputForLabel(fieldLabel)
  if (hintedDate) return { element: hintedDate, kind: 'date' }

  const hintedNg = findNgSelectForLabel(fieldLabel)
  if (
    hintedNg &&
    resolvedTargetMatchesLocationStep(fieldLabel, { element: hintedNg, kind: 'ng-select' })
  ) {
    return { element: hintedNg, kind: 'ng-select' }
  }

  const byCascadeChain = await resolveWithCascadeChain(fieldLabel, fieldName, options)
  if (byCascadeChain.element && resolvedTargetMatchesLocationStep(fieldLabel, byCascadeChain)) {
    return byCascadeChain
  }
  if (target.element && resolvedTargetMatchesLocationStep(fieldLabel, target)) {
    return target
  }
  if (byCascadeChain.element) return byCascadeChain
  return target
}

async function resolveWithCascadeChain(fieldLabel, fieldName, options = {}) {
  let target = await resolveVisibleTargetWithNavigation(fieldLabel, fieldName, options)
  if (target.element && isVisible(target.element) && resolvedTargetMatchesLocationStep(fieldLabel, target)) {
    return target
  }
  const maxDepth = Number(options?.maxCascadeDepth || 14)
  for (let i = 0; i < maxDepth; i += 1) {
    const next = pickNextLocationCascadeDropdown(fieldLabel)
    if (!next) break
    scrollTestTargetIntoView(next)
    await wait(55)
    await selectFirstNonEmptyNgSelect(next)
    await wait(170)
    target = await resolveVisibleTargetWithNavigation(fieldLabel, fieldName, options)
    if (target.element && isVisible(target.element) && resolvedTargetMatchesLocationStep(fieldLabel, target)) {
      return target
    }
  }
  return target
}

function dropdownAppearsUnselected(el) {
  const tag = String(el?.tagName || '').toLowerCase()
  if (tag === 'select') {
    const value = String(el.value || '').trim()
    return !value
  }
  const root = el.closest?.('ng-select, .ng-select, [role="combobox"]') || el
  const placeholderVisible = Array.from(root.querySelectorAll('.ng-placeholder')).some(isVisible)
  if (placeholderVisible) return true
  const valueContainer = root.querySelector('.ng-value-container')
  const hasValue = Boolean(valueContainer && normalizeLabelText(valueContainer.textContent || ''))
  return !hasValue
}

function pickVisibleCascadeDropdowns() {
  const nodes = Array.from(
    document.querySelectorAll('ng-select, .ng-select, div[role="combobox"], select')
  ).filter(el => isVisible(el) && dropdownAppearsUnselected(el))
  return nodes.sort((a, b) => {
    const ta = Number(a.getBoundingClientRect?.().top ?? 0)
    const tb = Number(b.getBoundingClientRect?.().top ?? 0)
    return ta - tb
  })
}

async function resolveConditionalRequiredWithCascadeLoop(fieldLabel, fieldName, contextHint = '') {
  for (let iteration = 0; iteration < 14; iteration += 1) {
    const target = await resolveTargetWithTypeHints(fieldLabel, fieldName, {
      allowContinue: false,
      contextHint
    })
    if (
      target?.element &&
      isVisible(target.element) &&
      resolvedTargetMatchesLocationStep(fieldLabel, target)
    ) {
      return target
    }

    const nextLoc = pickNextLocationCascadeDropdown(fieldLabel)
    if (nextLoc) {
      scrollTestTargetIntoView(nextLoc)
      await wait(45)
      await selectFirstNonEmptyNgSelect(nextLoc)
      await wait(220)
      const checkLoc = await resolveTargetWithTypeHints(fieldLabel, fieldName, {
        allowContinue: false,
        contextHint
      })
      if (
        checkLoc?.element &&
        isVisible(checkLoc.element) &&
        resolvedTargetMatchesLocationStep(fieldLabel, checkLoc)
      ) {
        return checkLoc
      }
      continue
    }

    const dropdowns = pickVisibleCascadeDropdowns()
      .filter(dd => !isLocationCascadeSelectRoot(dd))
      .map(el => ({ el, tier: primaryLocationTierIndex(el), top: Number(el.getBoundingClientRect?.().top ?? 0) }))
      .sort((a, b) => a.tier - b.tier || a.top - b.top)
      .map(x => x.el)
    const dd = dropdowns[0]
    if (!dd) continue
    const tag = String(dd.tagName || '').toLowerCase()
    if (tag === 'select') {
      const opts = Array.from(dd.options || [])
      const nonEmpty = opts.find(opt => String(opt.value || '').trim())
      if (nonEmpty) {
        dd.value = nonEmpty.value
        dispatchInputEvents(dd)
      }
    } else {
      await selectFirstNonEmptyNgSelect(dd)
    }
    await wait(220)
    const check = await resolveTargetWithTypeHints(fieldLabel, fieldName, {
      allowContinue: false,
      contextHint
    })
    if (
      check?.element &&
      isVisible(check.element) &&
      resolvedTargetMatchesLocationStep(fieldLabel, check)
    ) {
      return check
    }
  }
  return { element: null, kind: 'unknown' }
}

function stripConditionalClause(label) {
  return String(label || '')
    .replace(/\s+if\s+.+$/i, '')
    .replace(/\s+when\s+.+$/i, '')
    .replace(/\s+\(if\s+.+\)$/i, '')
    .trim()
}

function collectRadioGroup(fieldEl, fieldName) {
  const name = String(fieldEl?.name || fieldName || '').trim()
  if (name) {
    const byName = Array.from(document.querySelectorAll(`input[type="radio"][name="${cssEscapeSafe(name)}"]`))
    if (byName.length) return byName
  }
  if (fieldEl?.id) {
    const maybeSame = Array.from(document.querySelectorAll(`input[type="radio"]#${cssEscapeSafe(fieldEl.id)}`))
    if (maybeSame.length) return maybeSame
  }
  const container = fieldEl?.closest?.('formly-wrapper-form-field, formly-field, fieldset, .form-group, .field')
  if (container) {
    const local = Array.from(container.querySelectorAll('input[type="radio"]'))
    if (local.length) return local
  }
  return fieldEl && fieldEl.type === 'radio' ? [fieldEl] : []
}

function findContinueButton() {
  const allButtons = Array.from(document.querySelectorAll('button'))
  const exactContinue = allButtons.find(btn => String(btn.textContent || '').trim() === 'Continue')
  if (exactContinue) return exactContinue
  const exactNext = allButtons.find(btn => String(btn.textContent || '').trim() === 'Next')
  if (exactNext) return exactNext
  const submitBtn = document.querySelector('button[type="submit"], input[type="submit"]')
  if (submitBtn) return submitBtn
  return allButtons.find(btn => /continue|next/i.test(String(btn.textContent || '').trim())) || null
}

async function clickContinueAndReadErrors(expectedResult, targetLabel = '', targetField = null, whatToTest = '') {
  const button = findContinueButton()
  if (!button) return { ok: false, error: 'Continue/Next button not found on page' }
  scrollTestTargetIntoView(button)
  await wait(280)
  button.click()
  const entries = await getVisibleValidationEntriesWithRetry()
  const matched = pickMatchedMessage(entries, expectedResult, targetLabel, targetField, whatToTest)
  return { ok: true, messages: entries.map(e => e.text), matched }
}

function getInvalidValueForFormat(tc) {
  const text = `${tc?.what_to_test || ''} ${tc?.expected_result || ''}`.toLowerCase()
  if (text.includes('16 digits') || text.includes('national id')) return '12345'
  if (text.includes('10 digits') || text.includes('nin')) return '123'
  if (text.includes('8 digits') || text.includes('application number')) return '12'
  if (text.includes('email')) return 'notanemail'
  if (text.includes('phone')) return 'abc'
  if (text.includes('under 18') || text.includes('below 18') || text.includes('age')) {
    const d = new Date()
    d.setFullYear(d.getFullYear() - 17)
    return d.toISOString().slice(0, 10)
  }
  if (text.includes('150') || text.includes('greater than') || text.includes('too old')) {
    const d = new Date()
    d.setFullYear(d.getFullYear() - 151)
    return d.toISOString().slice(0, 10)
  }
  return '!!!invalid!!!'
}

function detectAttachmentCaseKind(tc) {
  const text = `${tc?.name || ''} ${tc?.what_to_test || ''} ${tc?.expected_result || ''}`.toLowerCase()
  if (text.includes('larger than') || text.includes('500kb') || text.includes('size') || text.includes('oversize')) return 'size_limit'
  if (text.includes('wrong format') || text.includes('invalid format') || text.includes('allowed file format') || text.includes('file format')) return 'invalid_format'
  return 'required'
}

function findAttachmentFieldElementByLabel(fieldLabel, fieldName) {
  const normLabel = sanitizeSearchLabel(fieldLabel)
  const normName = String(fieldName || '').trim().toLowerCase()
  const all = Array.from(document.querySelectorAll('input[type="file"]'))
    .filter(el => isVisible(el) && !el.disabled && !el.readOnly)
  if (all.length === 0) return null
  if (all.length === 1) return all[0]
  let best = null
  let bestScore = -1e9
  for (const el of all) {
    const blob = normalizeLabelText(`${getLabelText(el)} ${el.id || ''} ${el.getAttribute('name') || ''} ${getLocalFieldTextBlobForScoring(el)}`)
    let score = 0
    if (normName) {
      if (String(el.getAttribute('name') || '').toLowerCase().includes(normName)) score += 90
      if (String(el.id || '').toLowerCase().includes(normName)) score += 70
      if (blob.includes(normName)) score += 30
    }
    if (normLabel) {
      if (blob.includes(normLabel)) score += 120
      const words = significantLabelWords(normLabel)
      for (const w of words) if (blob.includes(w)) score += 16
    }
    if (score > bestScore) {
      bestScore = score
      best = el
    }
  }
  return best
}

function makeAttachmentTestFile(kind) {
  if (kind === 'invalid_format') {
    const txtBlob = new Blob(['qa helper invalid format fixture'], { type: 'text/plain' })
    return new File([txtBlob], 'invalid-format.txt', { type: 'text/plain' })
  }
  if (kind === 'size_limit') {
    const bytes = new Uint8Array(520 * 1024)
    bytes.fill(65)
    const pdfBlob = new Blob([bytes], { type: 'application/pdf' })
    return new File([pdfBlob], 'oversized.pdf', { type: 'application/pdf' })
  }
  return null
}

function setFileInputValue(inputEl, file) {
  if (!inputEl || !file) return false
  try {
    const dt = new DataTransfer()
    dt.items.add(file)
    inputEl.files = dt.files
    inputEl.dispatchEvent(new Event('input', { bubbles: true }))
    inputEl.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  } catch {
    return false
  }
}

function getLikelyValidValueForAutoFill(tc) {
  const text = normalizeLabelText(`${tc?.name || ''} ${tc?.what_to_test || ''} ${tc?.expected_result || ''} ${tc?.field_label || ''}`)
  if (/\b(national id|nin|citizen application|application number|id number)\b/.test(text)) return reusableIdValueForRun
  if (text.includes('national id') || text.includes('16 digits')) return '1111171111111111'
  if (/\bnin\b/.test(text) || text.includes('10 digits')) return '1234567890'
  if (text.includes('citizen application') || text.includes('8 digits')) return '12345678'
  if (text.includes('phone')) return '0781234567'
  if (text.includes('email')) return 'autofill@example.com'
  return '1234567890'
}

function isIdLikeLabelText(text) {
  const n = normalizeLabelText(text)
  return /\b(id number|id no\.?|national\s*id|nin\b|application number|citizen application|rwanda\s*national|rwanational|identity\s*(number)?|identification(\s*number)?)\b/.test(
    n
  )
}

function idLikeStructuralHints(control) {
  if (!control) return false
  const fc = String(control.getAttribute?.('formcontrolname') || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
  const nm = String(control.name || control.id || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
  const hay = `${fc} ${nm}`
  return /\b(idnumber|nationalid|nin|national_id|idno|citizenid|citizenapplication|applicationnumber)\b/.test(
    hay
  )
}

function isIdLikeControl(control) {
  if (!control) return false
  if (idLikeStructuralHints(control)) return true
  const probe = `${getLabelText(control)} ${control?.name || ''} ${control?.id || ''} ${control?.placeholder || ''} ${control?.getAttribute?.('aria-label') || ''} ${control?.getAttribute?.('formcontrolname') || ''}`
  if (isIdLikeLabelText(probe)) return true
  const blob = String(getLocalFieldTextBlobForScoring(control) || '').slice(0, 1400)
  return isIdLikeLabelText(blob)
}

function seedReusableIdFromPageIfTyped() {
  if (reusableIdValueForRun) return
  const candidates = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea')).filter(
    el => isVisible(el) && !el.disabled && !el.readOnly && isIdLikeControl(el)
  )
  for (const el of candidates) {
    const v = String(el.value || '').trim()
    if (!v) continue
    reusableIdValueForRun = v
    return
  }
}

function readControlValue(el) {
  if (!el) return ''
  const kind = detectFieldKind(el)
  if (kind === 'radio') {
    const group = collectRadioGroup(el, el.name || '')
    const checked = group.find(r => r.checked)
    return checked ? normalizeLabelText(checked.value || getLabelText(checked) || '') : ''
  }
  if (kind === 'ng-select') {
    const root = el.closest('ng-select, .ng-select, [role="combobox"]') || el
    const valueTxt = root.querySelector('.ng-value')?.textContent || root.textContent || ''
    return normalizeLabelText(valueTxt)
  }
  const tag = String(el.tagName || '').toLowerCase()
  if (tag === 'select') {
    const opt = el.options?.[el.selectedIndex]
    return normalizeLabelText(opt?.textContent || opt?.value || '')
  }
  if (tag === 'input' || tag === 'textarea') return normalizeLabelText(el.value || '')
  return normalizeLabelText(el.textContent || '')
}

function extractExpectedAutoFillTargetLabels(tc) {
  const sourceLabel = normalizeLabelText(tc?.field_label || '')
  const text = `${tc?.expected_result || ''} ${tc?.what_to_test || ''}`
  const out = new Set()
  const quoted = text.match(/"([^"]+)"/g) || []
  for (const q of quoted) {
    const raw = q.replace(/^"|"$/g, '').trim()
    const norm = sanitizeSearchLabel(raw)
    if (norm && norm !== sourceLabel) out.add(norm)
  }
  const fieldMentions = text.matchAll(/([A-Za-z][A-Za-z0-9\s/-]{1,80}?)\s+field\b/gi)
  for (const m of fieldMentions) {
    const raw = String(m[1] || '').trim()
    if (!raw) continue
    const norm = sanitizeSearchLabel(raw)
    if (norm && norm !== sourceLabel && !/\b(source|trigger|valid value|auto[-\s]?fill)\b/i.test(norm)) out.add(norm)
  }
  return [...out]
}

function resolveTargetsByLabels(labels) {
  const hits = []
  for (const l of labels) {
    const t = resolveFieldTarget(l, '')
    if (t?.element) hits.push({ label: l, ...t })
  }
  return hits
}

function snapshotVisibleControls() {
  const controls = Array.from(document.querySelectorAll(
    'input:not([type="hidden"]), textarea, select, ng-select, .ng-select, div[role="combobox"]'
  )).filter(isVisible)
  return controls.map(el => ({ el, value: readControlValue(el) }))
}

function countChangedControls(before) {
  let changed = 0
  for (const b of before) {
    const now = readControlValue(b.el)
    if (!b.value && now) changed += 1
  }
  return changed
}

function isLikelyWidgetTriggerControl(control, kind) {
  const type = String(control?.type || '').toLowerCase()
  if (kind === 'ng-select' || kind === 'date' || type === 'date') return false
  return isIdLikeControl(control)
}

async function waitForWidgetSideEffects(beforeSnapshot, timeoutMs = 2800, minChanged = 1) {
  const step = 250
  const tries = Math.ceil(timeoutMs / step)
  for (let i = 0; i < tries; i += 1) {
    const changed = countChangedControls(beforeSnapshot)
    if (changed >= minChanged) return true
    await wait(step)
  }
  return false
}

async function waitForAutoFillTargets(targets, beforeSnapshot, timeoutMs = 2800) {
  const step = 250
  const tries = Math.ceil(timeoutMs / step)
  for (let i = 0; i < tries; i += 1) {
    let ready = 0
    for (const t of targets) {
      if (readControlValue(t.element)) ready += 1
    }
    if (targets.length > 0 && ready === targets.length) return true
    if (targets.length === 0 && countChangedControls(beforeSnapshot) >= 1) return true
    await wait(step)
  }
  return false
}

async function setInputLikeValueManually(control, value) {
  const text = String(value ?? '')
  if (typeof control?.focus === 'function') control.focus()
  control.click?.()
  await wait(40)
  control.value = ''
  dispatchInputEvents(control)
  for (const ch of text) {
    control.value = String(control.value || '') + ch
    control.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(12)
  }
  dispatchInputEvents(control)
  dispatchBlurEvent(control)
}

async function runWidgetAutoFillTest(tc, fieldLabel, fieldName) {
  const source = await resolveTargetWithTypeHints(fieldLabel, fieldName, {
    contextHint: String(tc?.name || '')
  })
  if (!source?.element) {
    return { passed: false, message: `Field ${fieldLabel || fieldName || tc?.name || 'unknown'} not found on page` }
  }
  const src = source.element
  if (src.disabled || src.readOnly) {
    return { passed: false, message: 'Auto-fill source field is disabled/readOnly' }
  }

  const targetLabels = extractExpectedAutoFillTargetLabels(tc)
  const targetFields = resolveTargetsByLabels(targetLabels)
  const before = snapshotVisibleControls()
  const val = getLikelyValidValueForAutoFill(tc)

  if (source.kind === 'ng-select') {
    await selectFirstNonEmptyNgSelect(src)
  } else if (source.kind === 'date') {
    const input = findDateInputForLabel(fieldLabel) || src
    await setDateValuePreferPicker(input, getSafeDateFallbackValue())
  } else {
    await setInputLikeValueManually(src, val)
  }

  const ok = await waitForAutoFillTargets(targetFields, before, 6000)
  if (!ok) {
    if (targetFields.length > 0) {
      const missing = targetFields.filter(t => !readControlValue(t.element)).map(t => t.label)
      return { passed: false, message: `Auto-fill did not populate expected fields: ${missing.join(', ')}` }
    }
    return { passed: false, message: 'Auto-fill not detected after entering valid source value' }
  }
  return { passed: true, message: 'Auto-fill populated destination fields as expected.' }
}

async function clearNgSelectValue(selectRoot) {
  if (!selectRoot) return
  const root = selectRoot.closest('ng-select, .ng-select, [role="combobox"]') || selectRoot
  const clearBtn = root.querySelector('.ng-clear-wrapper, .ng-value-icon, button[aria-label*="clear" i]')
  if (clearBtn && isVisible(clearBtn)) {
    clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wait(100)
    return
  }
  root.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wait(120)
  const filterInput = root.querySelector('input[type="text"], input:not([type="hidden"])')
  if (filterInput) {
    filterInput.focus()
    filterInput.value = ''
    dispatchInputEvents(filterInput)
    dispatchBlurEvent(filterInput)
  }
  const escTarget = root.querySelector('input') || root
  escTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  dispatchInputEvents(root)
}

async function selectFirstNonEmptyNgSelect(selectRoot) {
  if (!selectRoot) return false
  const root = selectRoot.closest('ng-select, .ng-select, [role="combobox"]') || selectRoot
  const before = readControlValue(root)
  root.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wait(180)
  const visibleOptions = Array.from(document.querySelectorAll('.ng-dropdown-panel .ng-option, [role="listbox"] [role="option"], .ng-option, [role="option"]'))
    .filter(el => isVisible(el))
  let option = visibleOptions.find(el => {
    const txt = normalizeLabelText(el.textContent)
    return txt && !/select|choose/.test(txt)
  })
  if (!option) {
    const scoped = Array.from(
      (root.closest('formly-field, formly-wrapper-form-field, .form-group, .field') || root.parentElement || document)
        .querySelectorAll('.ng-option, [role="option"]')
    ).filter(el => isVisible(el))
    option = scoped.find(el => {
      const txt = normalizeLabelText(el.textContent)
      return txt && !/select|choose/.test(txt)
    })
  }
  if (option) {
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wait(140)
    return normalizeLabelText(readControlValue(root)) !== normalizeLabelText(before)
  }
  const escTarget = root.querySelector('input') || root
  escTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  return false
}

async function selectIdTypeOptionByNeedle(idTypeTarget, needleNorm) {
  if (!idTypeTarget?.element || !needleNorm) return
  const el = idTypeTarget.element
  if (idTypeTarget.kind === 'ng-select') {
    const root = el.closest('ng-select, .ng-select') || el
    root.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wait(220)
    const option = Array.from(document.querySelectorAll('.ng-option, [role="option"]')).find(opt => {
      const t = normalizeLabelText(opt.textContent)
      if (needleNorm.includes('national')) return t.includes('national id')
      if (needleNorm.includes('nin')) return /\bnin\b/.test(t) || t === 'nin'
      if (needleNorm.includes('citizen')) return t.includes('citizen') && t.includes('application')
      return t.includes(needleNorm)
    })
    if (option) option.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  } else if (String(el.tagName || '').toLowerCase() === 'select') {
    const option = Array.from(el.options || []).find(opt => {
      const t = normalizeLabelText(opt.textContent)
      if (needleNorm.includes('national')) return t.includes('national id')
      if (needleNorm.includes('nin')) return /\bnin\b/.test(t)
      if (needleNorm.includes('citizen')) return t.includes('citizen')
      return false
    })
    if (option) {
      el.value = option.value
      dispatchInputEvents(el)
    }
  }
  await wait(700)
}

/** Sets ID Type from test wording so conditional ID Number / DOB age widgets appear (National ID, NIN, Citizen Application Number). */
async function maybePrepareIdTypeFromWhatToTest(tc) {
  const what = String(tc?.what_to_test || '')
  const name = String(tc?.name || '')
  const combined = normalizeLabelText(`${name} ${what} ${tc?.expected_result || ''}`)
  if (!/id type|id number|national id|\bnin\b|citizen application|date of birth/i.test(combined)) return

  let needle = ''
  if (/national id/i.test(what) || /national id/i.test(name)) needle = 'national id'
  else if (/\bnin\b/i.test(what) || /\bnin\b/i.test(name)) needle = 'nin'
  else if (/citizen application/i.test(what) || /citizen application/i.test(name)) needle = 'citizen application'
  else if (/id type\s+set\s+to/i.test(what)) {
    if (/national id/i.test(what)) needle = 'national id'
    else if (/\bnin\b/i.test(what)) needle = 'nin'
    else if (/citizen application/i.test(what)) needle = 'citizen application'
  } else if (/date of birth.*(national|nin|id type)/i.test(combined)) {
    needle = /\bnin\b/i.test(combined) ? 'nin' : 'national id'
  } else if (/id number/i.test(combined)) needle = 'national id'

  if (!needle) return

  const idType = resolveFieldTarget('id type', 'idType')
  await selectIdTypeOptionByNeedle(idType, needle)

  if (!combined.includes('id number') || needle !== 'national id') return
}

async function expandCollapsedSectionsOnce() {
  if (hasExpandedSectionsForRun) return
  const nodes = new Set()
  const direct = Array.from(document.querySelectorAll('button.accordion-button.collapsed, div.accordion-item button, button[aria-expanded="false"]'))
  for (const el of direct) nodes.add(el)

  const clickable = Array.from(document.querySelectorAll('button, div[role="button"], div'))
  for (const el of clickable) {
    const txt = normalizeLabelText(el.textContent)
    const hasChevronIcon = Boolean(el.querySelector('i[class*="chevron"], i[class*="arrow"], i[class*="caret"], svg[class*="chevron"], svg[class*="arrow"]'))
    const hasArrowChar = /▾|▸|▼|▶/.test(String(el.textContent || ''))
    const nearHeading = Boolean(el.closest('h1,h2,h3,h4,h5,.accordion-item,.section,.card,.panel'))
    if ((hasChevronIcon || hasArrowChar || /expand|show more|details/.test(txt)) && nearHeading) {
      nodes.add(el)
    }
  }

  for (const el of nodes) {
    if (!isVisible(el)) continue
    const expanded = String(el.getAttribute?.('aria-expanded') || '').toLowerCase()
    const collapsedCls = el.classList?.contains('collapsed')
    if (expanded === 'false' || collapsedCls || el.matches('button.accordion-button.collapsed, div.accordion-item button')) {
      try {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await wait(800)
      } catch {
        // Ignore and continue to next section candidate.
      }
    }
  }
  hasExpandedSectionsForRun = true
}

async function expandCollapsedSectionsNow() {
  const nodes = Array.from(document.querySelectorAll('button.accordion-button.collapsed, div.accordion-item button, button[aria-expanded="false"]'))
  for (const el of nodes) {
    if (!isVisible(el)) continue
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await wait(800)
    } catch {
      // Ignore and continue.
    }
  }
}

async function resolveVisibleTargetWithNavigation(fieldLabel, fieldName, options = {}) {
  const allowContinue = options.allowContinue !== false
  const ch = String(options.contextHint || '')
  let target = resolveFieldTarget(fieldLabel, fieldName, ch)
  if (target.element && isVisible(target.element)) return target

  const continueBtn = allowContinue ? findContinueButton() : null
  if (allowContinue && continueBtn) {
    scrollTestTargetIntoView(continueBtn)
    await wait(260)
    continueBtn.click()
    await wait(580)
    target = resolveFieldTarget(fieldLabel, fieldName, ch)
    if (target.element && isVisible(target.element)) return target
  }

  await expandCollapsedSectionsNow()
  target = resolveFieldTarget(fieldLabel, fieldName, ch)
  return target
}

async function resolveWithPrefillAcrossSections(fieldLabel, fieldName, contextHint = '', maxSteps = 4, fillOptions = {}) {
  let target = await resolveTargetWithTypeHints(fieldLabel, fieldName, {
    allowContinue: false,
    contextHint
  })
  if (target.element && isVisible(target.element)) return target

  for (let i = 0; i < maxSteps; i += 1) {
    await fillAllFieldsWithValidValues(null, fillOptions)
    const btn = findContinueButton()
    if (!btn) break
    scrollTestTargetIntoView(btn)
    await wait(280)
    btn.click()
    await wait(650)
    target = await resolveTargetWithTypeHints(fieldLabel, fieldName, {
      allowContinue: false,
      contextHint
    })
    if (target.element && isVisible(target.element)) return target
  }
  return target
}

/** Uses conditionalParentKey.js (same logic as the background worker). */
function parseConditionalSpec(tc) {
  const fn = globalThis.qaHelperParseConditionalSpec
  if (typeof fn !== 'function') return { parentLabel: '', triggerValue: '' }
  return fn(tc)
}

function parentSetupKeyFromTc(tc) {
  const fn = globalThis.qaHelperParentSetupKey
  if (typeof fn !== 'function') return ''
  return String(fn(tc) || '')
}

function resolveConditionalParentField(spec) {
  if (!spec?.parentLabel) return null
  const exact = resolveFieldTarget(spec.parentLabel, '')
  if (exact.element) return exact.element
  const needle = sanitizeSearchLabel(spec.parentLabel)
  if (needle) {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
    const group = radios.find(r =>
      normalizeLabelText(
        `${getLabelText(r)} ${r.closest('formly-field, formly-wrapper-form-field, .form-group, .field')?.textContent || ''}`
      ).includes(needle)
    )
    if (group) return group
  }
  return null
}

async function resolveTargetAfterCondition(fieldLabel, fieldName, options = {}) {
  const rwandaYesLocation = Boolean(options.rwandaYesLocation)
  const navOpts = { allowContinue: false, contextHint: String(options.contextHint || '') }
  let target = await resolveVisibleTargetWithNavigation(fieldLabel, fieldName, navOpts)
  if (!target.element) {
    const hintedRadios = findRadiosForLabel(fieldLabel)
    if (hintedRadios.length > 0) target = { element: hintedRadios[0], kind: 'radio' }
    const hintedDate = findDateInputForLabel(fieldLabel)
    if (!target.element && hintedDate) target = { element: hintedDate, kind: 'date' }
    const hintedNg = findNgSelectForLabel(fieldLabel)
    if (!target.element && hintedNg) target = { element: hintedNg, kind: 'ng-select' }
  }
  if (
    target.element &&
    isVisible(target.element) &&
    resolvedTargetMatchesLocationStep(fieldLabel, target)
  ) {
    return target
  }
  if (rwandaYesLocation) {
    const cascaded = await resolveWithCascadeChain(fieldLabel, fieldName, navOpts)
    if (
      cascaded.element &&
      isVisible(cascaded.element) &&
      resolvedTargetMatchesLocationStep(fieldLabel, cascaded)
    ) {
      return cascaded
    }
    for (let step = 0; step < 3; step += 1) {
      const btn = findContinueButton()
      if (btn) {
        scrollTestTargetIntoView(btn)
        await wait(160)
        btn.click()
        await wait(300)
      }
      target = await resolveVisibleTargetWithNavigation(fieldLabel, fieldName, navOpts)
      if (!target.element) {
        const hintedNg = findNgSelectForLabel(fieldLabel)
        if (hintedNg) target = { element: hintedNg, kind: 'ng-select' }
      }
      if (
        target.element &&
        isVisible(target.element) &&
        resolvedTargetMatchesLocationStep(fieldLabel, target)
      ) {
        return target
      }
      const again = await resolveWithCascadeChain(fieldLabel, fieldName, navOpts)
      if (
        again.element &&
        isVisible(again.element) &&
        resolvedTargetMatchesLocationStep(fieldLabel, again)
      ) {
        return again
      }
    }
  }
  for (let i = 0; i < 3; i += 1) {
    await wait(120)
    target = await resolveVisibleTargetWithNavigation(fieldLabel, fieldName, navOpts)
    if (
      target.element &&
      isVisible(target.element) &&
      resolvedTargetMatchesLocationStep(fieldLabel, target)
    ) {
      return target
    }
  }
  const byCascade = await resolveWithCascadeChain(fieldLabel, fieldName, navOpts)
  if (byCascade.element && isVisible(byCascade.element)) return byCascade
  return target
}

/** Smallest wrappers whose visible text mentions the parent label (any form). */
function findScopesForParentLabel(parentLabel) {
  const needle = sanitizeSearchLabel(parentLabel)
  if (!needle) return []
  return Array.from(document.querySelectorAll('formly-wrapper-form-field, formly-field'))
    .filter(w => normalizeLabelText(w.textContent).includes(needle))
    .sort(
      (a, b) =>
        normalizeLabelText(a.textContent).length - normalizeLabelText(b.textContent).length
    )
}

function applyBinaryYesNoInScopes(scopes, triggerValue) {
  const lower = normalizeText(triggerValue)
  if (lower !== 'yes' && lower !== 'no') return false
  for (const scope of scopes) {
    const radios = Array.from(scope.querySelectorAll('input[type="radio"]'))
    const match = radios.find(r => {
      const val = normalizeText(r.value)
      const lab = normalizeText(getLabelText(r) || r.closest('label')?.textContent || '')
      return (
        val === lower ||
        lab === lower ||
        (lower && (val.includes(lower) || lab.includes(lower)))
      )
    })
    if (match) {
      match.click()
      dispatchInputEvents(match)
      return true
    }
    const candidates = scope.querySelectorAll(
      'label, button, .mat-mdc-radio-touch-target, mat-radio-button, .mat-mdc-radio-button, [role="radio"]'
    )
    for (const el of candidates) {
      if (!isVisible(el)) continue
      const raw = String(el.textContent || '').trim()
      const parts = raw.split(/\s+/).filter(Boolean)
      if (parts.length > 5) continue
      const head = normalizeText(parts[0] || '')
      if (head === lower) {
        el.click()
        dispatchInputEvents(el)
        return true
      }
    }
  }
  return false
}

function applyRadioChoiceInScopes(scopes, triggerValue) {
  const want = normalizeLabelText(triggerValue)
  if (!want) return false
  for (const scope of scopes) {
    const radios = Array.from(scope.querySelectorAll('input[type="radio"]'))
    const match = radios.find(r => {
      const lab = normalizeLabelText(getLabelText(r) || r.closest('label')?.textContent || '')
      const val = normalizeLabelText(String(r.value || ''))
      return lab.includes(want) || val.includes(want) || want.includes(lab)
    })
    if (match) {
      match.click()
      dispatchInputEvents(match)
      return true
    }
  }
  return false
}

/** When native change() on the resolved parent fails (Material / custom templates). */
function applyConditionalDomFallback(parentLabel, triggerValue) {
  const scopes = findScopesForParentLabel(parentLabel)
  if (scopes.length === 0) return false
  const lower = normalizeText(triggerValue)
  if (lower === 'yes' || lower === 'no') return applyBinaryYesNoInScopes(scopes, triggerValue)
  return applyRadioChoiceInScopes(scopes, triggerValue)
}

function setParentConditionalValue(parentField, triggerValue) {
  if (!parentField) return false
  const lowerTrigger = normalizeText(triggerValue)
  if (parentField.type === 'radio') {
    const radios = collectRadioGroup(parentField, parentField.name)
    const match = radios.find(r => {
      const val = normalizeText(r.value)
      const label = normalizeText(getLabelText(r) || r.closest('label')?.textContent)
      return lowerTrigger && (val === lowerTrigger || label === lowerTrigger || val.includes(lowerTrigger) || label.includes(lowerTrigger))
    })
    if (!match) return false
    match.click()
    dispatchInputEvents(match)
    return true
  }
  if (parentField.tagName.toLowerCase() === 'select') {
    const options = Array.from(parentField.options || [])
    const match = options.find(opt => {
      const v = normalizeText(opt.value)
      const t = normalizeText(opt.textContent)
      return lowerTrigger && (v.includes(lowerTrigger) || t.includes(lowerTrigger))
    }) || options.find(opt => String(opt.value || '').trim())
    if (!match) return false
    parentField.value = match.value
    dispatchInputEvents(parentField)
    return true
  }
  parentField.value = triggerValue || 'Yes'
  dispatchInputEvents(parentField)
  return true
}

function normalizeStepFieldLabel(raw) {
  return String(raw || '')
    .replace(/\s+field\s*$/i, '')
    .replace(/^["']|["']$/g, '')
    .trim()
}

function normalizeStepValue(raw) {
  return String(raw || '')
    .replace(/^["']|["']$/g, '')
    .trim()
}

async function applyAnySelectionStep(fieldLabel, stepText) {
  const target = resolveFieldTarget(fieldLabel, '', stepText)
  if (!target?.element) return false
  const kind = target.kind || detectFieldKind(target.element)
  if (kind === 'ng-select') {
    await selectFirstNonEmptyNgSelect(target.element)
    await wait(380)
    return true
  }
  if (kind === 'radio') {
    const group = collectRadioGroup(target.element, target.element?.name || '')
    if (group.length > 0) {
      group[0].click()
      dispatchInputEvents(group[0])
      await wait(260)
      return true
    }
    return false
  }
  const tag = String(target.element.tagName || '').toLowerCase()
  if (kind === 'select' || tag === 'select') {
    const options = Array.from(target.element.options || [])
    const nonEmpty = options.find(opt => String(opt.value || '').trim())
    if (nonEmpty) {
      target.element.value = nonEmpty.value
      dispatchInputEvents(target.element)
      await wait(260)
      return true
    }
  }
  return false
}

async function applyValueSelectionStep(fieldLabel, triggerValue, stepText) {
  const target = resolveFieldTarget(fieldLabel, '', stepText)
  const lowerTrigger = normalizeText(triggerValue)
  if (target?.element) {
    const kind = target.kind || detectFieldKind(target.element)
    if (kind === 'ng-select') {
      const root = target.element.closest('ng-select, .ng-select, [role="combobox"]') || target.element
      root.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await wait(180)
      const option = Array.from(document.querySelectorAll('.ng-option, [role="option"]')).find(el => {
        const txt = normalizeLabelText(el.textContent || '')
        return lowerTrigger && (txt === lowerTrigger || txt.includes(lowerTrigger))
      })
      if (option) {
        option.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await wait(420)
        return true
      }
    }
    if (kind === 'radio') {
      const group = collectRadioGroup(target.element, target.element?.name || '')
      const match = group.find(r => {
        const val = normalizeText(r.value || '')
        const lab = normalizeText(getLabelText(r) || r.closest('label')?.textContent || '')
        return lowerTrigger && (val === lowerTrigger || lab === lowerTrigger || val.includes(lowerTrigger) || lab.includes(lowerTrigger))
      })
      if (match) {
        match.click()
        dispatchInputEvents(match)
        await wait(420)
        return true
      }
    }
    const tag = String(target.element.tagName || '').toLowerCase()
    if (kind === 'select' || tag === 'select') {
      const options = Array.from(target.element.options || [])
      const match = options.find(opt => {
        const v = normalizeText(opt.value || '')
        const t = normalizeText(opt.textContent || '')
        return lowerTrigger && (v === lowerTrigger || t === lowerTrigger || v.includes(lowerTrigger) || t.includes(lowerTrigger))
      })
      if (match) {
        target.element.value = match.value
        dispatchInputEvents(target.element)
        await wait(420)
        return true
      }
    }
  }
  const fallback = applyConditionalDomFallback(fieldLabel, triggerValue)
  if (fallback) await wait(1000)
  return fallback
}

async function parseAndExecuteSteps(whatToTest) {
  const text = String(whatToTest || '').trim()
  if (!text) return true
  const steps = text
    .split(/\b(?:then|after that|next)\b|,\s*then\b/i)
    .map(s => s.trim())
    .filter(Boolean)
  for (const rawStep of steps) {
    const step = rawStep.replace(/^[,;:\s-]+/, '').trim()
    if (!step) continue

    const anyOn = step.match(/\bselect\s+any\s+option\s+on\s+(?:the\s+)?(.+?)(?:\s+field\b|\s*$)/i)
    if (anyOn?.[1]) {
      const fieldLabel = normalizeStepFieldLabel(anyOn[1])
      await applyAnySelectionStep(fieldLabel, step)
      continue
    }

    const anyField = step.match(/\bselect\s+any\s+(.+?)(?:\s+field\b|\s*$)/i)
    if (anyField?.[1]) {
      const fieldLabel = normalizeStepFieldLabel(anyField[1])
      await applyAnySelectionStep(fieldLabel, step)
      continue
    }

    const valueOnFor = step.match(/\bselect\s+(.+?)\s+(?:on|for)\s+(.+?)(?:\s+field\b|\s*$)/i)
    if (valueOnFor?.[1] && valueOnFor?.[2]) {
      const triggerValue = normalizeStepValue(valueOnFor[1])
      const fieldLabel = normalizeStepFieldLabel(valueOnFor[2])
      if (fieldLabel && triggerValue) {
        await applyValueSelectionStep(fieldLabel, triggerValue, step)
      }
    }
  }
  return true
}

function ngSelectRootAppearsUnselected(root) {
  const el = root.closest?.('ng-select, .ng-select, [role="combobox"]') || root
  if (!el) return true
  const valueBlock = el.querySelector('.ng-value')
  if (!valueBlock) return true
  const t = normalizeLabelText(valueBlock.textContent || '')
  return !t || /^(select|choose)\b/i.test(t)
}

function getSafeDefaultInputValue(control, kind) {
  const type = String(control?.type || '').toLowerCase()
  const label = normalizeLabelText(`${getLabelText(control)} ${control?.name || ''} ${control?.id || ''} ${control?.placeholder || ''}`)
  if (type === 'email' || /\bemail\b/.test(label)) return 'test@example.com'
  if (type === 'tel' || /\b(phone|mobile|tel)\b/.test(label)) return '0781234567'
  if (kind === 'date' || type === 'date') return getSafeDateFallbackValue()
  if (/\b(date of birth|dob)\b/.test(label)) return getSafeDateFallbackValue()
  if (/\bdate\b/.test(label)) return getSafeDateFallbackValue()
  if (isIdLikeControl(control) && String(reusableIdValueForRun || '').trim()) return reusableIdValueForRun
  if (type === 'number' || /\b(age|number|amount|count|qty|quantity)\b/.test(label)) return '123'
  if (/\b(first name|lastname|last name|surname|name)\b/.test(label)) return 'John'
  if (/\b(id number|id no|national id|nin|application number|citizen application)\b/.test(label)) return reusableIdValueForRun
  if (type === 'url' || /\b(url|website|site)\b/.test(label)) return 'https://example.com'
  return 'ValidInput'
}

async function fillAllFieldsWithValidValues(targetToSkip = null, options = {}) {
  const widgetWaitMs = Math.min(8000, Math.max(200, Number(options.widgetWaitMs) || 2400))
  const manualLike = options.manualLike !== false
  const fillEvenIfPopulated = options.fillEvenIfPopulated === true
  /** When testing a location cascade field, do not bulk-fill district/sector/cell/village ng-selects — the cascade resolver fills them in order. */
  const deferCascadeChains = options.deferCascadeChains === true
  const extraSkips = Array.isArray(options.skipControls) ? options.skipControls.filter(Boolean) : []
  const controls = Array.from(document.querySelectorAll('input, select, textarea, ng-select, .ng-select, div[role="combobox"]'))
  const handledRadioGroups = new Set()
  const handledNgSelectRoots = new Set()
  const skipEl = targetToSkip?.element || null
  const skipKind = targetToSkip?.kind || ''
  const skipRadioName = skipKind === 'radio' ? String(skipEl?.name || '').trim() : ''
  const skipRadioContainer = skipKind === 'radio' && skipEl ? getRadioGroupContainer(skipEl) : null
  const excludePredicate = (control) => {
    for (const extra of extraSkips) {
      if (control === extra || control.contains?.(extra) || extra.contains?.(control)) return true
    }
    if (!skipEl) return false
    if (control === skipEl || control.contains?.(skipEl) || skipEl.contains?.(control)) return true
    if (skipKind === 'radio' && detectFieldKind(control) === 'radio') {
      const sameName = Boolean(skipRadioName && String(control.name || '').trim() === skipRadioName)
      const sameContainer = Boolean(skipRadioContainer && skipRadioContainer.contains(control))
      if (sameName || sameContainer) return true
    }
    return false
  }
  for (const control of controls) {
    if (!isVisible(control)) continue
    if (excludePredicate(control)) continue
    const kind = detectFieldKind(control)
    if (kind === 'radio') {
      const name = String(control.name || '').trim()
      const inSkipContainer = Boolean(skipRadioContainer && skipRadioContainer.contains(control))
      if ((skipRadioName && name && name === skipRadioName) || inSkipContainer) continue
      const key = name || `${getLabelText(control)}`
      if (handledRadioGroups.has(key)) continue
      const group = collectRadioGroup(control, name)
      if (group.length > 0) {
        group[0].click()
        dispatchInputEvents(group[0])
      }
      handledRadioGroups.add(key)
      continue
    }
    if (kind === 'ng-select') {
      const root = control.closest('ng-select, .ng-select, [role="combobox"]') || control
      if (deferCascadeChains && isLocationCascadeSelectRoot(root)) continue
      if (handledNgSelectRoots.has(root)) continue
      if (!fillEvenIfPopulated && !ngSelectRootAppearsUnselected(root)) continue
      handledNgSelectRoots.add(root)
      await selectFirstNonEmptyNgSelect(root)
      continue
    }
    if (kind === 'select') {
      if (control.disabled || control.readOnly) continue
      if (!fillEvenIfPopulated && String(control.value || '').trim()) continue
      const options = Array.from(control.options || [])
      const nonEmpty = options.find(opt => String(opt.value || '').trim())
      if (nonEmpty) {
        control.value = nonEmpty.value
        dispatchInputEvents(control)
      }
      continue
    }
    if (control.disabled || control.readOnly) continue
    const type = String(control.type || '').toLowerCase()
    const beforeWidget = isLikelyWidgetTriggerControl(control, kind) ? snapshotVisibleControls() : null
    if (type === 'checkbox') {
      control.checked = true
    } else if (isIdLikeControl(control)) {
      const currentId = String(control.value || '').trim()
      const wantId = String(reusableIdValueForRun || '').trim()
      if (!reusableIdValueForRun && currentId) {
        reusableIdValueForRun = currentId
      } else if (wantId && (fillEvenIfPopulated || !currentId || currentId !== wantId)) {
        if (manualLike) await setInputLikeValueManually(control, reusableIdValueForRun)
        else control.value = reusableIdValueForRun
      }
    } else {
      const hasValue = String(control.value || '').trim().length > 0
      if (!fillEvenIfPopulated && hasValue) {
        // Keep existing user value as-is.
      } else if (
        manualLike &&
        (type === 'text' ||
          type === 'email' ||
          type === 'tel' ||
          type === 'number' ||
          type === 'url' ||
          type === 'search' ||
          kind === 'textarea' ||
          type === 'password')
      ) {
        await setInputLikeValueManually(control, getSafeDefaultInputValue(control, kind))
      } else {
        control.value = getSafeDefaultInputValue(control, kind)
      }
    }
    dispatchInputEvents(control)
    dispatchBlurEvent(control)
    if (beforeWidget) {
      await waitForWidgetSideEffects(beforeWidget, widgetWaitMs, 1)
    }
  }

  const datePickerHosts = Array.from(
    document.querySelectorAll('irembogov-custom-date-picker, irembogov-irembo-date-picker')
  )
  for (const comp of datePickerHosts) {
    if (!isVisible(comp)) continue
    if (excludePredicate(comp)) continue
    const inp = comp.querySelector('input:not([type="hidden"])')
    if (!inp || inp.disabled || inp.readOnly) continue
    await setDateValuePreferPicker(inp, getSafeDateFallbackValue())
    await wait(200)
  }

  const ngRoots = Array.from(document.querySelectorAll('ng-select, .ng-select, div[role="combobox"]'))
  for (const root of ngRoots) {
    if (!isVisible(root)) continue
    if (excludePredicate(root)) continue
    if (deferCascadeChains && isLocationCascadeSelectRoot(root)) continue
    if (!ngSelectRootAppearsUnselected(root)) continue
    await selectFirstNonEmptyNgSelect(root)
    await wait(200)
  }

  const natWraps = Array.from(document.querySelectorAll('formly-field, formly-wrapper-form-field')).filter(w => {
    const k = parseFormlyFieldIdKey(w.id)
    return k && k.toLowerCase() === 'nationality'
  })
  for (const nw of natWraps) {
    if (skipEl && nw.contains(skipEl)) continue
    for (let round = 0; round < 8; round += 1) {
      const open = Array.from(nw.querySelectorAll('ng-select, .ng-select, div[role="combobox"]')).filter(
        el => isVisible(el) && ngSelectRootAppearsUnselected(el)
      )
      if (open.length === 0) break
      for (const el of open) {
        if (excludePredicate(el)) continue
        await selectFirstNonEmptyNgSelect(el)
        await wait(420)
      }
    }
  }

  await wait(350)
}

function collectDiscoveryRequiredErrors() {
  const texts = []
  const seen = new Set()
  for (const entry of getVisibleValidationEntries()) {
    const txt = String(entry?.text || '').trim()
    if (!txt || seen.has(txt)) continue
    seen.add(txt)
    texts.push(txt)
  }
  return texts
}

/**
 * Map a run-start discovery line to this required_field case (label + expected + what_to_test).
 * Used to annotate passes and to rescue when Step C cannot see the message in the field container.
 */
function matchDiscoveryLineForRequiredCase(tc, fieldLabel) {
  if (!Array.isArray(discoveredRequiredErrors) || discoveredRequiredErrors.length === 0) return ''
  const targetNorm = sanitizeSearchLabel(fieldLabel)
  const expNorm = normalizeLabelText(String(tc?.expected_result || ''))
  const whatNorm = normalizeLabelText(String(tc?.what_to_test || ''))
  for (const raw of discoveredRequiredErrors) {
    const line = String(raw || '').trim()
    if (!line) continue
    const norm = normalizeLabelText(line)
    if (looksAggregatedDiscoveryLine(norm)) continue
    if (!labelStrongMatch(norm, targetNorm)) continue
    const one = [{ element: null, text: line }]
    if (pickMatchedMessage(one, tc?.expected_result, fieldLabel, null, String(tc?.what_to_test || ''))) {
      return line
    }
    if (
      expNorm &&
      (messageContainsTwoConsecutiveWordsFromExpected(norm, expNorm) ||
        messageContainsThreeConsecutiveWordsFromExpected(norm, expNorm))
    ) {
      return line
    }
    if (formatValidationLooseMatch(norm, expNorm, whatNorm, targetNorm)) return line
  }
  return ''
}

async function clickContinueWithoutValidationRead() {
  const button = findContinueButton()
  if (!button) return { ok: false, error: 'Continue/Next button not found on page' }
  scrollTestTargetIntoView(button)
  await wait(280)
  button.click()
  return { ok: true }
}

async function requiredFieldRunPreflightStepAB() {
  throwIfCancelled()
  await clickContinueWithoutValidationRead()
  await wait(1500)
  discoveredRequiredErrors = collectDiscoveryRequiredErrors()
  await fillAllFieldsWithValidValues(null, { manualLike: true, widgetWaitMs: 2400 })
  await wait(280)
}

const REQUIRED_FIELD_CONTAINER_MSG_SEL = [
  '.invalid-feedback',
  'formly-validation-message',
  'mat-error',
  '.mat-mdc-form-field-error',
  '.mdc-text-field-helper-text--validation-msg',
  '.text-danger',
  '[class*="validation-message"]'
].join(', ')

function getRequiredFieldValidationRoots(targetEl) {
  const roots = new Set()
  if (!targetEl?.closest) return []
  const r1 = getTargetFieldValidationRoot(targetEl)
  const r2 = getRadioGroupContainer(targetEl)
  const mat = targetEl.closest(
    'mat-form-field, .mat-mdc-form-field, .mat-form-field, .mdc-text-field, .mat-mdc-text-field-wrapper'
  )
  if (r1) roots.add(r1)
  if (r2) roots.add(r2)
  if (mat) roots.add(mat)
  if (roots.size === 0) {
    const p = targetEl.parentElement
    if (p) roots.add(p)
  }
  return Array.from(roots).filter(Boolean)
}

function getRequiredFieldValidationInContainer(targetEl) {
  if (!targetEl) return []
  const roots = getRequiredFieldValidationRoots(targetEl)
  const out = []
  const seen = new Set()
  for (const root of roots) {
    if (!root?.querySelectorAll) continue
    for (const el of root.querySelectorAll(REQUIRED_FIELD_CONTAINER_MSG_SEL)) {
      if (!isVisible(el)) continue
      const t = String(el.textContent || '').replace(/\s+/g, ' ').trim()
      if (!t || seen.has(t)) continue
      seen.add(t)
      out.push({ element: el, text: t })
    }
  }
  return out
}

function detectFormAdvanced(urlBefore, sectionEl) {
  if (String(location.href || '') !== String(urlBefore || '')) return true
  if (sectionEl && document.contains(sectionEl) && !isVisible(sectionEl)) return true
  return false
}

async function refillTargetFieldToValidValue(target, kind, fieldLabel) {
  if (!target) return
  if (kind === 'radio') {
    const group = collectRadioGroup(target, target?.name || '')
    if (group[0]) {
      group[0].click()
      dispatchInputEvents(group[0])
    }
    return
  }
  if (kind === 'date') {
    const dateInput = findDateInputForLabel(fieldLabel) || target
    if (isCustomDatePickerInput(dateInput)) {
      await setDateValuePreferPicker(dateInput, getSafeDateFallbackValue())
    } else {
      dateInput.value = getSafeDateFallbackValue()
      dispatchInputEvents(dateInput)
      dispatchBlurEvent(dateInput)
    }
    return
  }
  if (kind === 'ng-select') {
    const ng =
      findNgSelectForLabel(fieldLabel) ||
      target.closest?.('ng-select, .ng-select, [role="combobox"]') ||
      target
    await selectFirstNonEmptyNgSelect(ng)
    return
  }
  const tag = String(target.tagName || '').toLowerCase()
  if (kind === 'select' || tag === 'select') {
    const options = Array.from(target.options || [])
    const nonEmpty = options.find(opt => String(opt.value || '').trim())
    if (nonEmpty) {
      target.value = nonEmpty.value
      dispatchInputEvents(target)
    }
    return
  }
  const type = String(target.type || '').toLowerCase()
  if (type === 'checkbox') {
    target.checked = true
    dispatchInputEvents(target)
    return
  }
  if (isIdLikeControl(target) && String(reusableIdValueForRun || '').trim()) {
    await setInputLikeValueManually(target, reusableIdValueForRun)
    return
  }
  target.value = getSafeDefaultInputValue(target, kind)
  dispatchInputEvents(target)
  dispatchBlurEvent(target)
}

function appendRunStartMappingNote(message, preflightLine) {
  const base = String(message || '').trim()
  if (!preflightLine) return base
  return base
}

async function executeRequiredFieldStepC(tc, fieldLabel, fieldName, target, field) {
  if (target.kind !== 'radio' && (field.disabled || field.readOnly)) {
    return { skipped: true, reason: 'field is disabled — auto-filled by widget' }
  }

  const preflightLine = matchDiscoveryLineForRequiredCase(tc, fieldLabel)

  const urlBefore = String(location.href || '')
  const sectionEl = field?.closest?.(
    'formly-group, .card, .wizard-step, .step-content, .modal-body, formly-wrapper-form-field, formly-field'
  )

  if (target.kind === 'radio') {
    const group = collectRadioGroup(field, field?.name || '')
    if (group.length > 0) {
      await ensureRadioGroupUnselected(field, 6)
    }
  } else if (target.kind === 'date') {
    const dateInput = findDateInputForLabel(fieldLabel) || field
    if (isCustomDatePickerInput(dateInput)) {
      await clearCustomDatePickerValue(dateInput)
    } else {
      dateInput.value = ''
      dispatchInputEvents(dateInput)
      dispatchBlurEvent(dateInput)
    }
  } else if (target.kind === 'ng-select') {
    const ng = findNgSelectForLabel(fieldLabel) || field
    await clearNgSelectValue(ng)
  } else if (target.kind === 'select') {
    field.value = ''
    dispatchInputEvents(field)
    dispatchBlurEvent(field)
  } else {
    field.value = ''
    dispatchInputEvents(field)
    dispatchBlurEvent(field)
  }

  await wait(200)
  const clicked = await clickContinueWithoutValidationRead()
  if (!clicked.ok) {
    await refillTargetFieldToValidValue(field, target.kind, fieldLabel)
    await wait(350)
    return { passed: false, message: clicked.error, skipFullResetAfter: true }
  }
  await wait(1500)

  if (detectFormAdvanced(urlBefore, sectionEl)) {
    await refillTargetFieldToValidValue(field, target.kind, fieldLabel)
    await wait(350)
    return {
      passed: false,
      message: 'Form advanced — field was not properly cleared',
      skipFullResetAfter: true
    }
  }

  let containerEntries = getRequiredFieldValidationInContainer(field)
  if (containerEntries.length === 0) {
    await wait(450)
    containerEntries = getRequiredFieldValidationInContainer(field)
  }
  if (containerEntries.length > 0) {
    const matched = pickMatchedMessage(
      containerEntries,
      tc?.expected_result,
      fieldLabel,
      target,
      String(tc?.what_to_test || '')
    )
    const msg = (matched || containerEntries.map(e => e.text).join('; ')).trim()
    await refillTargetFieldToValidValue(field, target.kind, fieldLabel)
    await wait(350)
    return {
      passed: true,
      message: appendRunStartMappingNote(
        msg.slice(0, 800) || 'Passed: validation shown for empty field',
        preflightLine
      ),
      skipFullResetAfter: true,
      ...(preflightLine ? { preflightMapped: true } : {})
    }
  }

  const allVis = getVisibleValidationEntries()
  const targetNorm = sanitizeSearchLabel(fieldLabel)
  const scoped = allVis.filter(e => {
    const norm = normalizeLabelText(e.text)
    if (!norm) return false
    return (
      isMessageDomDescendantOfTargetFieldContainer(e.element, field) ||
      labelStrongMatch(norm, targetNorm)
    )
  })
  const pool = scoped.length > 0 ? scoped : allVis
  const looseMatched = pickMatchedMessage(
    pool,
    tc?.expected_result,
    fieldLabel,
    target,
    String(tc?.what_to_test || '')
  )
  if (looseMatched) {
    await refillTargetFieldToValidValue(field, target.kind, fieldLabel)
    await wait(350)
    return {
      passed: true,
      message: appendRunStartMappingNote(
        looseMatched.slice(0, 800) || 'Passed: validation matched for empty field',
        preflightLine
      ),
      skipFullResetAfter: true,
      ...(preflightLine ? { preflightMapped: true } : {})
    }
  }

  if (preflightLine) {
    await refillTargetFieldToValidValue(field, target.kind, fieldLabel)
    await wait(350)
    return {
      passed: true,
      message: 'Passed: required validation for this field was already shown during run-start preflight.',
      skipFullResetAfter: true,
      preflightMapped: true
    }
  }

  await refillTargetFieldToValidValue(field, target.kind, fieldLabel)
  await wait(350)
  const hint =
    discoveredRequiredErrors.length > 0
      ? ` Run-start discovery had ${discoveredRequiredErrors.length} message(s): ${discoveredRequiredErrors.slice(0, 4).join(' | ')}`
      : ''
  return {
    passed: false,
    message: `Failed: no validation message in target field container after Continue.${hint}`.slice(0, 900),
    skipFullResetAfter: true
  }
}

function isConditionalFieldTestType(tt) {
  return tt === 'conditional_field' || tt === 'conditional_required' || tt === 'conditional_display'
}

function expectsConditionalFieldHidden(tc) {
  return /not displayed|not visible|hidden|does not appear|not shown|displayed\s*:\s*no|is displayed\s*:\s*no/i.test(
    String(tc?.expected_result || tc?.what_to_test || '')
  )
}

function shouldStripConditionalClauseForFieldLabel(testType) {
  return testType === 'conditional_display' || testType === 'conditional_field'
}

async function executeTestCase(tc, runContext = {}) {
  throwIfCancelled()
  updateLiveRunIndicator(tc, null, 'Preparing')
  seedReusableIdFromPageIfTyped()
  const testType = String(tc?.test_type || '').trim()
  const rawFieldLabel = normalizeCaseFieldLabelRaw(String(tc?.field_label || tc?.name || '').trim())
  const fieldLabel = sanitizeSearchLabel(
    shouldStripConditionalClauseForFieldLabel(testType) ? stripConditionalClause(rawFieldLabel) : rawFieldLabel
  )
  const fieldName = String(tc?.field_name || '').trim()
  let conditionalTrace = ''
  let conditionalSetupKey = ''

  await expandCollapsedSectionsOnce()
  const deferWhatToTestSteps = isConditionalFieldTestType(testType)
  if (!deferWhatToTestSteps) {
    await parseAndExecuteSteps(tc?.what_to_test)
  }
  if (isConditionalFieldTestType(testType)) {
    await wait(180)
  }

  if (runContext.isRunStart || runContext.primeAfterNavigation) {
    requiredFieldRunPreflightDone = false
    discoveredRequiredErrors = []
    hasExpandedSectionsForRun = false
  }
  if (!requiredFieldRunPreflightDone && (runContext.isRunStart || testType === 'required_field')) {
    await requiredFieldRunPreflightStepAB()
    requiredFieldRunPreflightDone = true
  }

  const executableTypes = new Set([
    'required_field',
    'format_validation',
    'conditional_field',
    'conditional_required',
    'conditional_display',
    'successful_submit',
    'label_check'
  ])
  await maybePrepareIdTypeFromWhatToTest(tc)
  const ctxHint = [String(tc?.name || ''), String(tc?.what_to_test || '').slice(0, 320)]
    .filter(Boolean)
    .join(' | ')
  const locCascadeHint = /\b(district|sector|cell|village|province|location)\b/i.test(
    `${fieldLabel} ${fieldName} ${ctxHint}`
  )
  let target = testType === 'successful_submit'
    ? { element: null, kind: 'unknown' }
    : await resolveTargetWithTypeHints(fieldLabel, fieldName, {
        contextHint: ctxHint
      })
  if (
    !target.element &&
    ['required_field', 'format_validation'].includes(testType)
  ) {
    const spec = parseConditionalSpec(tc)
    if (String(spec.parentLabel || '').trim() && String(spec.triggerValue || '').trim()) {
      const recovered = applyConditionalDomFallback(spec.parentLabel, spec.triggerValue)
      if (recovered) {
        await wait(1000)
        target = await resolveTargetWithTypeHints(fieldLabel, fieldName, {
          contextHint: ctxHint
        })
      }
    }
  }
  const combinedProbe = normalizeLabelText(`${tc?.field_label || ''} ${tc?.name || ''} ${tc?.what_to_test || ''}`)
  if (!target.element && /id number/i.test(combinedProbe)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await wait(500)
      target = await resolveTargetWithTypeHints(fieldLabel, fieldName, {
        contextHint: ctxHint
      })
      if (target.element) break
    }
  }

  if (isConditionalFieldTestType(testType)) {
    const spec = parseConditionalSpec(tc)
    const conditionalParentField = resolveConditionalParentField(spec)
    const setupKey = parentSetupKeyFromTc(tc)
    conditionalSetupKey = setupKey
    const skipParentApply = Boolean(
      setupKey &&
      String(runContext.previousParentSetupKey || '') === setupKey
    )
    conditionalTrace = `Condition: ${String(spec.parentLabel || 'unknown').trim() || 'unknown'}=${String(spec.triggerValue || 'unknown').trim() || 'unknown'}${skipParentApply ? ' [same parent — batch]' : ''}`

    if (!skipParentApply) {
      if (!conditionalParentField) {
        return {
          passed: false,
          message: `Parent field ${spec.parentLabel || 'unknown'} not found on page`,
          parentSetupKey: setupKey
        }
      }
      scrollTestTargetIntoView(conditionalParentField)
      await wait(240)
      let applied = setParentConditionalValue(conditionalParentField, spec.triggerValue)
      if (!applied) applied = applyConditionalDomFallback(spec.parentLabel, spec.triggerValue)
      if (!applied) {
        return {
          passed: false,
          message: 'Could not set conditional parent field value',
          parentSetupKey: setupKey
        }
      }
      await wait(320)
    } else {
      await wait(70)
    }
    await parseAndExecuteSteps(tc?.what_to_test)
    await wait(90)

    const navOpts = { allowContinue: false, contextHint: ctxHint }
    const locNorm = sanitizeSearchLabel(fieldLabel)
    const rwandaYesLocation =
      normalizeText(spec.triggerValue) === 'yes' && /\b(district|sector|cell|village)\b/.test(locNorm)

    const settled = await resolveVisibleTargetWithNavigation(fieldLabel, fieldName, navOpts)
    const quickReady =
      settled.element &&
      isVisible(settled.element) &&
      resolvedTargetMatchesLocationStep(fieldLabel, settled)

    if (quickReady) {
      target = settled
    } else {
      const chainTarget = await resolveWithCascadeChain(fieldLabel, fieldName, navOpts)
      if (chainTarget.element && isVisible(chainTarget.element)) {
        target = chainTarget
      }
      const afterConditionTarget = await resolveTargetAfterCondition(fieldLabel, fieldName, {
        rwandaYesLocation,
        contextHint: ctxHint
      })
      if (afterConditionTarget.element && isVisible(afterConditionTarget.element)) {
        target = afterConditionTarget
      } else if (!target.element) {
        target = await resolveWithCascadeChain(fieldLabel, fieldName, navOpts)
      }
    }
    const expectsHiddenForCascade = expectsConditionalFieldHidden(tc)
    if (
      !expectsHiddenForCascade &&
      (!target?.element || !isVisible(target.element))
    ) {
      const deep = await resolveConditionalRequiredWithCascadeLoop(fieldLabel, fieldName, ctxHint)
      if (deep?.element && isVisible(deep.element)) target = deep
      else {
        return {
          passed: false,
          message: `Field ${fieldLabel || fieldName || tc?.name || 'unknown'} not found after cascade chain resolution`,
          parentSetupKey: setupKey
        }
      }
    }
    conditionalTrace = `${conditionalTrace}; cascade_target=${target?.element ? 'found' : 'missing'}`
    // Keep conditional flow cascade-driven; global prefill here can override location-chain choices.
  } else if (executableTypes.has(testType) && !(testType === 'required_field' && requiredFieldRunPreflightDone)) {
    await fillAllFieldsWithValidValues(target, {
      manualLike: true,
      deferCascadeChains: locCascadeHint
    })
  }

  let field = target.element
  if (!field && ['required_field', 'format_validation', 'conditional_field', 'conditional_required', 'conditional_display', 'label_check'].includes(testType)) {
    const expectsHiddenPrefill = expectsConditionalFieldHidden(tc)
    const prefillMax =
      isConditionalFieldTestType(testType) && expectsHiddenPrefill ? 2 : locCascadeHint ? 3 : 4
    const prefillFill =
      isConditionalFieldTestType(testType) && expectsHiddenPrefill
        ? { widgetWaitMs: 1200 }
        : locCascadeHint
          ? { widgetWaitMs: 1600 }
          : {}
    const bySectionAdvance = await resolveWithPrefillAcrossSections(
      fieldLabel,
      fieldName,
      ctxHint,
      prefillMax,
      prefillFill
    )
    if (bySectionAdvance.element && isVisible(bySectionAdvance.element)) {
      target = bySectionAdvance
      field = target.element
    }
  }
  if (!field && isConditionalFieldTestType(testType) && expectsConditionalFieldHidden(tc)) {
    return {
      passed: true,
      message: `Conditional field not in DOM or not resolved (treated as hidden when parent is No).${conditionalTrace ? ` ${conditionalTrace}` : ''}`.slice(0, 900),
      ...(conditionalSetupKey ? { parentSetupKey: conditionalSetupKey } : {})
    }
  }
  if (!field && ['required_field', 'format_validation', 'conditional_field', 'conditional_required', 'conditional_display', 'label_check'].includes(testType)) {
    return {
      passed: false,
      message: `Field ${fieldLabel || fieldName || tc?.name || 'unknown'} not found on page`,
      ...(conditionalSetupKey ? { parentSetupKey: conditionalSetupKey } : {})
    }
  }

  if (field) {
    scrollTestTargetIntoView(field)
    await wait(260)
    updateLiveRunIndicator(tc, field, 'Testing field')
  }

  if (testType === 'required_field') {
    return executeRequiredFieldStepC(tc, fieldLabel, fieldName, target, field)
  }

  if (testType === 'format_validation') {
    if (field.disabled || field.readOnly) {
      return { skipped: true, reason: 'field is disabled — auto-filled by widget' }
    }
    if (target.kind === 'ng-select') {
      const ng = findNgSelectForLabel(fieldLabel) || field
      await clearNgSelectValue(ng)
    } else if (target.kind === 'date') {
      const dateInput = findDateInputForLabel(fieldLabel) || field
      const invalid = getInvalidValueForFormat(tc)
      if (isCustomDatePickerInput(dateInput)) {
        await setCustomDatePickerValue(dateInput, invalid)
      } else {
        dateInput.value = invalid
        dispatchInputEvents(dateInput)
        dispatchBlurEvent(dateInput)
      }
    } else {
      field.value = getInvalidValueForFormat(tc)
      dispatchInputEvents(field)
      dispatchBlurEvent(field)
    }
    const clicked = await clickContinueAndReadErrors(
      tc?.expected_result,
      fieldLabel,
      target,
      String(tc?.what_to_test || '')
    )
    if (!clicked.ok) return { passed: false, message: clicked.error }
    return { passed: Boolean(clicked.matched), message: clicked.matched || '' }
  }

  if (testType === 'label_check') {
    const actualLabel = String(getLabelText(field) || '').trim()
    const actualPlaceholder = String(field?.getAttribute?.('placeholder') || '').trim()
    const source = String(tc?.expected_result || tc?.what_to_test || '')
    const expectedLabel = String(source.match(/label:\s*"([^"]*)"/i)?.[1] || '').trim()
    const expectedPlaceholder = String(source.match(/placeholder:\s*"([^"]*)"/i)?.[1] || '').trim()
    const labelOk = expectedLabel ? actualLabel === expectedLabel : Boolean(actualLabel)
    const placeholderOk = expectedPlaceholder ? actualPlaceholder === expectedPlaceholder : true
    const passed = labelOk && placeholderOk
    return {
      passed,
      message: passed
        ? `Label check passed for ${fieldLabel || fieldName || tc?.name || 'field'}`
        : `Expected label "${expectedLabel}" and placeholder "${expectedPlaceholder}", got label "${actualLabel}" and placeholder "${actualPlaceholder}"`
    }
  }

  if (isConditionalFieldTestType(testType)) {
    const expectsHidden = expectsConditionalFieldHidden(tc)
    const visible = isVisible(field)

    if (expectsHidden) {
      const passed = !visible
      return {
        passed,
        message: passed
          ? `Conditional field stayed hidden as expected.${conditionalTrace ? ` ${conditionalTrace}` : ''}`
          : `Conditional field appeared but was expected hidden.${conditionalTrace ? ` ${conditionalTrace}` : ''}`,
        ...(conditionalSetupKey ? { parentSetupKey: conditionalSetupKey } : {})
      }
    }

    if (!visible) {
      return {
        passed: false,
        message: `Conditional field did not become visible.${conditionalTrace ? ` ${conditionalTrace}` : ''}`.slice(0, 900),
        ...(conditionalSetupKey ? { parentSetupKey: conditionalSetupKey } : {})
      }
    }

    if (target.kind === 'ng-select') {
      const ng = findNgSelectForLabel(fieldLabel) || field
      await clearNgSelectValue(ng)
    } else if (target.kind === 'date') {
      const dateInput = findDateInputForLabel(fieldLabel) || field
      dateInput.value = ''
      dispatchInputEvents(dateInput)
      dispatchBlurEvent(dateInput)
    } else {
      field.value = ''
      dispatchInputEvents(field)
      dispatchBlurEvent(field)
    }
    const clicked = await clickContinueAndReadErrors(
      tc?.expected_result,
      fieldLabel,
      target,
      String(tc?.what_to_test || '')
    )
    if (!clicked.ok) {
      return {
        passed: false,
        message: clicked.error,
        ...(conditionalSetupKey ? { parentSetupKey: conditionalSetupKey } : {})
      }
    }
    const visibleAfter = await getVisibleValidationEntriesWithRetry({ quick: true })
    const strict = pickMatchedMessageForConditionalRequired(
      visibleAfter,
      tc?.expected_result,
      fieldLabel,
      target
    )
    const base = strict || ''
    const passed = Boolean(strict)
    const visOk = 'Field shown and is required.'
    return {
      passed,
      message: passed
        ? `${visOk} ${base}${conditionalTrace ? `${base ? ' | ' : ''}${conditionalTrace}` : ''}`.trim()
        : `${visOk} Required validation did not match: ${base || 'no matching message'}${conditionalTrace ? ` | ${conditionalTrace}` : ''}`.slice(0, 900),
      ...(conditionalSetupKey ? { parentSetupKey: conditionalSetupKey } : {})
    }
  }

  if (testType === 'successful_submit') {
    for (let round = 0; round < 2; round += 1) {
      await fillAllFieldsWithValidValues(null)
      await wait(160)
      const button = findContinueButton()
      if (!button) break
      scrollTestTargetIntoView(button)
      await wait(280)
      button.click()
      await wait(550)
    }
    await fillAllFieldsWithValidValues(null)
    const finalBtn = findContinueButton()
    if (finalBtn) {
      scrollTestTargetIntoView(finalBtn)
      await wait(280)
      finalBtn.click()
    }
    await wait(260)
    let entries = getVisibleValidationEntries()
    if (entries.length === 0) {
      return { passed: true, message: 'Passed: no validation errors after multi-step fill and submit.' }
    }
    entries = await getVisibleValidationEntriesWithRetry()
    const messages = entries.map(e => String(e.text || '').trim()).filter(Boolean)
    if (messages.length === 0) {
      return { passed: true, message: 'Passed: no validation errors after multi-step fill and submit.' }
    }
    const meaningful = messages.filter(m => m.replace(/[\s*•·]/g, '').length > 1)
    const summary = meaningful.length ? meaningful.join('; ') : messages.join('; ') || 'Validation errors still present'
    return { passed: false, message: summary.slice(0, 500) }
  }

  if (testType === 'widget_auto_fill') {
    return runWidgetAutoFillTest(tc, fieldLabel, fieldName)
  }
  if (testType === 'attachment') {
    const attachmentInput =
      (field && String(field.type || '').toLowerCase() === 'file' ? field : null) ||
      (target?.element && String(target.element.type || '').toLowerCase() === 'file' ? target.element : null) ||
      findAttachmentFieldElementByLabel(fieldLabel, fieldName)
    if (!attachmentInput) {
      return {
        passed: false,
        message: `Attachment input ${fieldLabel || fieldName || tc?.name || 'unknown'} not found on page`
      }
    }

    scrollTestTargetIntoView(attachmentInput)
    await wait(260)
    updateLiveRunIndicator(tc, attachmentInput, 'Testing field')

    const kind = detectAttachmentCaseKind(tc)
    await fillAllFieldsWithValidValues({ element: attachmentInput, kind: 'input' })
    await wait(180)
    attachmentInput.value = ''
    attachmentInput.dispatchEvent(new Event('input', { bubbles: true }))
    attachmentInput.dispatchEvent(new Event('change', { bubbles: true }))

    if (kind !== 'required') {
      const fixture = makeAttachmentTestFile(kind)
      const setOk = setFileInputValue(attachmentInput, fixture)
      if (!setOk) {
        return {
          passed: false,
          message: 'Could not set test file on attachment input'
        }
      }
      await wait(140)
    }

    const clicked = await clickContinueAndReadErrors(
      tc?.expected_result,
      fieldLabel || getLabelText(attachmentInput) || 'attachment',
      { element: attachmentInput, kind: 'input' },
      String(tc?.what_to_test || '')
    )
    if (!clicked.ok) return { passed: false, message: clicked.error }
    const matched = String(clicked.matched || '').trim()
    return {
      passed: Boolean(matched),
      message: matched || `Attachment validation did not match expected result for ${fieldLabel || fieldName || tc?.name || 'attachment'}`
    }
  }
  return { skipped: true, reason: `unsupported test type: ${testType}` }
}

async function requestFailureScreenshot() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'QA_HELPER_CAPTURE_VISIBLE_TAB' }, (response) => {
      if (chrome.runtime.lastError) return resolve('')
      resolve(String(response?.dataUrl || ''))
    })
  })
}

async function resetFormStateAfterTest(targetField) {
  if (targetField?.element) {
    const el = targetField.element
    if (targetField.kind === 'radio') {
      forceClearRadioGroupSelection(el)
    } else if (targetField.kind === 'date') {
      if (isCustomDatePickerInput(el)) {
        await clearCustomDatePickerValue(el)
      } else {
        clearFieldValue(el)
      }
    } else if (targetField.kind === 'select') {
      el.selectedIndex = 0
      dispatchInputEvents(el)
    } else if (targetField.kind === 'ng-select') {
      await clearNgSelectValue(el)
    } else {
      clearFieldValue(el)
    }
    dispatchBlurEvent(el)
  }

  // Keep upcoming required-field tests reliable: ensure no radio remains selected from prior tests.
  const allRadios = Array.from(document.querySelectorAll('input[type="radio"]')).filter(isVisible)
  for (const radio of allRadios) {
    if (!radio.checked) continue
    radio.checked = false
    radio.defaultChecked = false
    radio.removeAttribute?.('checked')
    dispatchInputEvents(radio)
    dispatchBlurEvent(radio)
  }

  // Ensure date-picker model values do not leak into the next test.
  const allCustomDateInputs = Array.from(
    document.querySelectorAll('irembogov-custom-date-picker input, irembogov-irembo-date-picker input')
  ).filter(isVisible)
  for (const input of allCustomDateInputs) {
    await clearCustomDatePickerValue(input)
  }

  await wait(300)
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'QA_HELPER_CANCEL_CURRENT_TEST') {
    cancelCurrentTestRequested = true
    sendResponse({ ok: true })
    return true
  }
  if (message?.type === 'QA_HELPER_SCAN_FIELDS') {
    sendResponse({ ok: true, fields: scanFormFields() })
    return true
  }
  if (message?.type === 'QA_HELPER_ADVANCE_SECTION') {
    ;(async () => {
      try {
        cancelCurrentTestRequested = false
        const clicked = await clickContinueWithoutValidationRead()
        if (!clicked.ok) {
          sendResponse({ ok: false, error: clicked.error || 'Continue button not found' })
          return
        }
        // Give SPA routers / lazy sections time to render the next step.
        await wait(900)
        sendResponse({ ok: true, advanced: true })
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || 'Failed to advance section') })
      }
    })()
    return true
  }
  if (message?.type === 'QA_HELPER_RUN_TEST_CASE') {
    let responded = false
    const safeResponse = (payload) => {
      if (responded) return
      responded = true
      try {
        sendResponse(payload)
      } catch {
        /* Port may already be closed after navigation. */
      }
    }
    const onPageHide = () => {
      cancelCurrentTestRequested = true
      safeResponse({
        ok: true,
        passed: false,
        message: 'Interrupted: page changed during this test — run continues on the new page.'
      })
    }
    window.addEventListener('pagehide', onPageHide)
    ;(async () => {
      try {
        cancelCurrentTestRequested = false
        const tc = message?.testCase || {}
        reusableIdValueForRun = String(message?.reusableIdValue || '').trim()
        throwIfCancelled()
        await expandCollapsedSectionsOnce()
        const result = await executeTestCase(tc, {
          isRunStart: Boolean(message?.isRunStart),
          primeAfterNavigation: Boolean(message?.primeAfterNavigation),
          previousParentSetupKey: String(message?.previousParentSetupKey || '')
        })
        if (message?.skipFormResetAfter) {
          result.skipFullResetAfter = true
        }
        throwIfCancelled()
        if (result && result.passed === false && !result.skipped) {
          result.screenshotDataUrl = await requestFailureScreenshot()
        }
        const targetLabel = sanitizeSearchLabel(String(tc?.field_label || tc?.name || ''))
        const targetField = resolveFieldTarget(targetLabel, String(tc?.field_name || ''))
        if (!result?.skipFullResetAfter) {
          await resetFormStateAfterTest(targetField)
        } else {
          await wait(200)
        }
        clearLiveRunIndicator()
        safeResponse({ ok: true, ...result })
      } catch (err) {
        clearLiveRunIndicator()
        const msg = String(err?.message || 'Unknown execution error')
        if (/cancelled by user/i.test(msg)) {
          safeResponse({ ok: true, skipped: true, reason: 'Stopped by user' })
        } else {
          safeResponse({ ok: true, passed: false, message: msg })
        }
      } finally {
        window.removeEventListener('pagehide', onPageHide)
      }
    })()
    return true
  }
  return false
})