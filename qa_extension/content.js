/* global chrome */
/**
 * In-page test runner — works across Irembo / ngx-formly style apps, not one static form.
 * Strategy: (1) resolve by Formly id model key when `field_name` matches; (2) label + optional
 * test-name context, with generic synonyms (cascades, nationality); (3) DOM-kind detection
 * (radio, ng-select, date hosts); (4) conditional triggers from natural-language when/if/select
 * (parsed parent + value — not hardcoded to one country or contract label).
 */
let hasExpandedSectionsForRun = false
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
  return new Promise(resolve => setTimeout(resolve, ms))
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
  h = h.replace(/^test\s+(required\s+field|format\s+validation|optional\s+field|conditional\s+(required|display)|widget\s+auto\s+fill|attachment|disabled\s+field)\s*:\s*/i, '').trim()
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

async function getVisibleValidationEntriesWithRetry() {
  const initialWaitMs = 2500
  const maxMs = 3000
  const stepMs = 200
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

function getTargetFieldFormlyContainer(targetEl) {
  if (!targetEl?.closest) return null
  return targetEl.closest('formly-wrapper-form-field, formly-field')
}

function isMessageDomDescendantOfTargetFieldContainer(msgEl, targetEl) {
  const container = getTargetFieldFormlyContainer(targetEl)
  return Boolean(container && msgEl && container.contains(msgEl))
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

function isGenericRequiredLikeMessage(norm) {
  const n = String(norm || '').trim()
  return (
    /^this field is required\.?$/i.test(n) ||
    /^field is required\.?$/i.test(n) ||
    /^value is required\.?$/i.test(n) ||
    /please (select|choose)/i.test(n) ||
    /^(an option|a value) must be selected/i.test(n)
  )
}

function pickMatchedMessage(entries, expectedResult, targetLabel = '', targetField = null) {
  const targetNorm = sanitizeSearchLabel(targetLabel)
  const targetTokens = targetNorm.split(/\s+/).filter(w => w.length > 2)
  const targetEl = targetField?.element
  const expectedNorm = normalizeLabelText(String(expectedResult || ''))
  const loginPageSignals = /enter your details|sign in|username or password|invalid username/i

  const match = entries.find(entry => {
    const norm = normalizeLabelText(entry.text)
    if (loginPageSignals.test(norm)) return false

    const msgEl = entry?.element
    const domOk =
      Boolean(targetEl && msgEl) && isMessageDomDescendantOfTargetFieldContainer(msgEl, targetEl)
    const textOk = messageContainsThreeConsecutiveWordsFromExpected(norm, expectedNorm)
    const labelMention = targetTokens.length > 0 && targetTokens.some(t => norm.includes(t))
    const generic = isGenericRequiredLikeMessage(norm)
    if (textOk) return true
    if (!domOk) return false
    if (labelMention) return true
    if (generic) return true
    return false
  })
  return match?.text || ''
}

function pickMatchedMessageForConditionalRequired(entries, expectedResult, targetLabel = '', targetField = null) {
  const targetEl = targetField?.element
  if (!targetEl || !Array.isArray(entries) || entries.length === 0) return ''
  const expectedNorm = normalizeLabelText(String(expectedResult || ''))
  const targetNorm = sanitizeSearchLabel(targetLabel)
  const targetTokens = targetNorm.split(/\s+/).filter(w => w.length > 2)
  const loginPageSignals = /enter your details|sign in|username or password|invalid username/i

  const inContainer = entries.filter(entry => {
    const norm = normalizeLabelText(entry?.text || '')
    if (!norm || loginPageSignals.test(norm)) return false
    const msgEl = entry?.element
    return Boolean(msgEl && isMessageDomDescendantOfTargetFieldContainer(msgEl, targetEl))
  })
  if (inContainer.length === 0) return ''

  const byPhrase = inContainer.find(e =>
    messageContainsThreeConsecutiveWordsFromExpected(normalizeLabelText(e.text), expectedNorm)
  )
  if (byPhrase) return byPhrase.text

  // For required checks, container-scoped generic required messages are acceptable.
  const generic = inContainer.find(e => isGenericRequiredLikeMessage(normalizeLabelText(e.text)))
  if (generic) return generic.text

  // Fall back to target token mention inside the target container.
  if (targetTokens.length > 0) {
    const byToken = inContainer.find(e => {
      const norm = normalizeLabelText(e.text)
      return targetTokens.some(t => norm.includes(t))
    })
    if (byToken) return byToken.text
  }
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

function findVisibleValidationInContainer(container) {
  if (!container?.querySelectorAll) return []
  const nodes = Array.from(
    container.querySelectorAll('formly-validation-message, .invalid-feedback')
  ).filter(isVisible)
  const seen = new Set()
  return nodes
    .map(el => ({
      element: el,
      text: String(el.textContent || '').replace(/\s+/g, ' ').trim()
    }))
    .filter(e => {
      const n = normalizeLabelText(e.text)
      if (!n || seen.has(n)) return false
      seen.add(n)
      return true
    })
}

async function findVisibleValidationInContainerWithRetry(container, initialWaitMs = 2500, maxMs = 3500, stepMs = 250) {
  await wait(initialWaitMs)
  const tries = Math.max(1, Math.ceil(maxMs / stepMs))
  let last = []
  for (let i = 0; i < tries; i += 1) {
    last = findVisibleValidationInContainer(container)
    if (last.length > 0) return last
    await wait(stepMs)
  }
  return last
}

async function clickContinueAndReadErrorsInContainer(container, expectedResult, targetLabel = '', targetField = null, waitMs = 2500) {
  const button = findContinueButton()
  if (!button) return { ok: false, error: 'Continue/Next button not found on page' }
  scrollTestTargetIntoView(button)
  await wait(420)
  button.click()
  const entries = await findVisibleValidationInContainerWithRetry(
    container,
    Math.max(2500, Number(waitMs || 0)),
    4000,
    250
  )
  const matched = pickMatchedMessage(entries, expectedResult, targetLabel, targetField)
  return { ok: true, messages: entries.map(e => e.text), matched }
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

function resolveFieldTargetByNorm(normLabel, nameText) {
  const labels = Array.from(document.querySelectorAll('label'))
  for (const labelEl of labels) {
    if (!normLabel) continue
    const lNorm = normalizeLabelText(labelEl.textContent)
    if (!lNorm.includes(normLabel)) continue
    const forId = String(labelEl.getAttribute('for') || '').trim()
    if (forId) {
      const byFor = document.getElementById(forId)
      if (byFor) return { element: byFor, kind: detectFieldKind(byFor) }
    }
    const nested = labelEl.querySelector('input, select, textarea, ng-select, .ng-select, div[role="combobox"]')
    if (nested) return { element: nested, kind: detectFieldKind(nested) }
    const sib = labelEl.nextElementSibling
    if (sib?.matches?.('input, select, textarea, ng-select, .ng-select, div[role="combobox"]')) {
      return { element: sib, kind: detectFieldKind(sib) }
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
    const matched = inners.find(el => nearControlMatchesSearchLabel(el, normLabel))
    if (matched) return { element: matched, kind: detectFieldKind(matched) }
  }

  const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
  for (const radio of radios) {
    const near = normalizeLabelText(getRadioContextText(radio))
    if (normLabel && near.includes(normLabel)) return { element: radio, kind: 'radio' }
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
      if (input) return { element: input, kind: 'date' }
    }
  }

  const ngSelects = Array.from(document.querySelectorAll('ng-select, .ng-select, div[role="combobox"]'))
  for (const ngs of ngSelects) {
    const near = normalizeLabelText(`${ngs.textContent || ''} ${ngs.closest('formly-field, formly-wrapper-form-field, .form-group, .field')?.textContent || ''}`)
    if (normLabel && near.includes(normLabel)) return { element: ngs, kind: 'ng-select' }
  }

  const controls = Array.from(document.querySelectorAll('input, textarea, select'))
  for (const control of controls) {
    let cur = control
    for (let depth = 0; depth < 5 && cur; depth += 1) {
      const lbl = cur.querySelector?.('label')
      const txt = normalizeLabelText(`${lbl?.textContent || ''} ${cur.textContent || ''}`)
      if (normLabel && txt.includes(normLabel)) return { element: control, kind: detectFieldKind(control) }
      cur = cur.parentElement
    }
  }

  if (nameText) {
    const byName = document.querySelector(`input[name="${cssEscapeSafe(nameText)}"], select[name="${cssEscapeSafe(nameText)}"], textarea[name="${cssEscapeSafe(nameText)}"], #${cssEscapeSafe(nameText)}`)
    if (byName) return { element: byName, kind: detectFieldKind(byName) }
  }

  return { element: null, kind: 'unknown' }
}

function resolveFieldTarget(fieldLabel, fieldName, contextHint = '') {
  const nameText = String(fieldName || '').trim()
  const hint = `${nameText} ${String(contextHint || '')}`.trim()
  const byKey = resolveFieldTargetByFormlyKey(nameText)
  if (byKey.element) return byKey
  const locCascade = resolveLocationCascadeChild(fieldLabel, hint)
  if (locCascade.element) return locCascade
  const natCascade = resolveNationalityCascadeChild(fieldLabel)
  if (natCascade.element) return natCascade
  const terms = expandLabelSearchTerms(fieldLabel, hint)
  for (const normLabel of terms) {
    const hit = resolveFieldTargetByNorm(normLabel, nameText)
    if (hit.element) return hit
  }
  return { element: null, kind: 'unknown' }
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

async function resolveTargetWithTypeHints(fieldLabel, fieldName, options = {}) {
  let target = await resolveVisibleTargetWithNavigation(fieldLabel, fieldName, options)
  if (target.element) return target

  const hintedRadios = findRadiosForLabel(fieldLabel)
  if (hintedRadios.length > 0) return { element: hintedRadios[0], kind: 'radio' }

  const hintedDate = findDateInputForLabel(fieldLabel)
  if (hintedDate) return { element: hintedDate, kind: 'date' }

  const hintedNg = findNgSelectForLabel(fieldLabel)
  if (hintedNg) return { element: hintedNg, kind: 'ng-select' }

  const byCascadeChain = await resolveWithCascadeChain(fieldLabel, fieldName, options)
  if (byCascadeChain.element) return byCascadeChain

  return target
}

async function resolveWithCascadeChain(fieldLabel, fieldName, options = {}) {
  let target = await resolveVisibleTargetWithNavigation(fieldLabel, fieldName, options)
  if (target.element && isVisible(target.element)) return target
  const contextNorm = normalizeLabelText(`${fieldLabel || ''} ${fieldName || ''} ${options?.contextHint || ''}`)
  const targetTokens = new Set(
    String(contextNorm || '')
      .split(/\s+/)
      .filter(t => t.length > 2)
  )
  const locationOrder = ['district', 'sector', 'cell', 'village']
  const touched = new Set()
  const maxDepth = Number(options?.maxCascadeDepth || 8)
  for (let i = 0; i < maxDepth; i += 1) {
    const candidates = Array.from(document.querySelectorAll('ng-select, .ng-select, div[role="combobox"]'))
      .filter(el => isVisible(el) && ngSelectRootAppearsUnselected(el))
      .map(el => {
        const key = String(el.id || el.getAttribute?.('formcontrolname') || el.getAttribute?.('name') || '')
        const container = getControlContainer(el) || el.closest('formly-field, formly-wrapper-form-field, .form-group, .field') || el
        const scopeNorm = normalizeLabelText(`${el.textContent || ''} ${container?.textContent || ''}`)
        let score = 0
        for (const t of targetTokens) {
          if (scopeNorm.includes(t)) score += 2
        }
        for (let idx = 0; idx < locationOrder.length; idx += 1) {
          const k = locationOrder[idx]
          if (scopeNorm.includes(k)) score += (locationOrder.length - idx)
        }
        if (touched.has(el) || (key && touched.has(key))) score -= 3
        return { el, score, key }
      })
      .sort((a, b) => b.score - a.score)
    const next = candidates[0]?.el || null
    if (!next) break
    const nextKey = candidates[0]?.key || ''
    scrollTestTargetIntoView(next)
    await wait(220)
    const changed = await selectFirstNonEmptyNgSelect(next)
    touched.add(next)
    if (nextKey) touched.add(nextKey)
    if (!changed) {
      await wait(180)
    }
    await wait(800)
    target = await resolveVisibleTargetWithNavigation(fieldLabel, fieldName, options)
    if (target.element && isVisible(target.element)) return target
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
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const target = await resolveTargetWithTypeHints(fieldLabel, fieldName, {
      allowContinue: false,
      contextHint
    })
    if (target?.element && isVisible(target.element)) return target

    const dropdowns = pickVisibleCascadeDropdowns()
    if (dropdowns.length === 0) continue
    for (const dd of dropdowns) {
      const tag = String(dd.tagName || '').toLowerCase()
      if (tag === 'select') {
        const options = Array.from(dd.options || [])
        const nonEmpty = options.find(opt => String(opt.value || '').trim())
        if (nonEmpty) {
          dd.value = nonEmpty.value
          dispatchInputEvents(dd)
        }
      } else {
        await selectFirstNonEmptyNgSelect(dd)
      }
      await wait(1000)
      const check = await resolveTargetWithTypeHints(fieldLabel, fieldName, {
        allowContinue: false,
        contextHint
      })
      if (check?.element && isVisible(check.element)) return check
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

async function clickContinueAndReadErrors(expectedResult, targetLabel = '', targetField = null) {
  const button = findContinueButton()
  if (!button) return { ok: false, error: 'Continue/Next button not found on page' }
  scrollTestTargetIntoView(button)
  await wait(420)
  button.click()
  const entries = await getVisibleValidationEntriesWithRetry()
  const matched = pickMatchedMessage(entries, expectedResult, targetLabel, targetField)
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
    const under18 = readTesterProfileValue(['dob_under_18', 'dob_minor'])
    if (under18) return under18
    const d = new Date()
    d.setFullYear(d.getFullYear() - 17)
    return d.toISOString().slice(0, 10)
  }
  return '!!!invalid!!!'
}

function readTesterProfileValue(keys = []) {
  try {
    if (!window?.localStorage) return ''
    for (const key of keys) {
      const direct = String(window.localStorage.getItem(key) || '').trim()
      if (direct) return direct
    }
    const profileRaw = String(window.localStorage.getItem('qa_test_data_profile') || '').trim()
    if (!profileRaw) return ''
    const parsed = JSON.parse(profileRaw)
    if (!parsed || typeof parsed !== 'object') return ''
    for (const key of keys) {
      const value = String(parsed?.[key] || '').trim()
      if (value) return value
    }
  } catch {
    // Ignore malformed profile payloads.
  }
  return ''
}

function readTesterProfileObject() {
  try {
    const profileRaw = String(window.localStorage.getItem('qa_test_data_profile') || '').trim()
    if (!profileRaw) return {}
    const parsed = JSON.parse(profileRaw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  } catch {
    return {}
  }
}

function findProfileValueByLabelSimilarity(labelBlob) {
  const blob = normalizeLabelText(labelBlob)
  if (!blob) return ''
  const blobTokens = new Set(blob.split(/\s+/).filter(t => t.length > 2))
  const profile = readTesterProfileObject()
  let best = { score: 0, value: '' }
  for (const [k, v] of Object.entries(profile)) {
    const value = String(v ?? '').trim()
    if (!value) continue
    const keyNorm = normalizeLabelText(String(k || '').replace(/_/g, ' '))
    if (!keyNorm) continue
    if (blob === keyNorm || blob.includes(keyNorm) || keyNorm.includes(blob)) return value
    const keyTokens = keyNorm.split(/\s+/).filter(t => t.length > 2)
    let overlap = 0
    for (const t of keyTokens) {
      if (blobTokens.has(t)) overlap += 1
    }
    if (overlap > best.score) {
      best = { score: overlap, value }
    }
  }
  return best.score >= 2 ? best.value : ''
}

function getPreferredNationalIdValue() {
  const fromProfile = readTesterProfileValue([
    'national_id',
    'nationalId',
    'id_number',
    'idNumber'
  ])
  if (fromProfile) return fromProfile
  return '1111171111111111'
}

function getPreferredProfileValueForControl(labelBlob, fallback = '') {
  const blob = normalizeLabelText(labelBlob)
  if (/\bfirst name\b/.test(blob)) return readTesterProfileValue(['first_name', 'firstName']) || fallback
  if (/\blast name|surname\b/.test(blob)) return readTesterProfileValue(['last_name', 'lastName', 'surname']) || fallback
  if (/\b(phone|mobile|tel)\b/.test(blob)) return readTesterProfileValue(['phone', 'phone_number', 'mobile']) || fallback
  if (/\bemail\b/.test(blob)) return readTesterProfileValue(['email']) || fallback
  if (/\b(date of birth|dob)\b/.test(blob)) return readTesterProfileValue(['dob_adult', 'date_of_birth']) || fallback
  if (/\bnin\b/.test(blob)) return readTesterProfileValue(['nin']) || fallback
  if (/\b(application number|citizen application)\b/.test(blob)) {
    return readTesterProfileValue(['application_number', 'citizen_application_number']) || fallback
  }
  if (/\b(id number|national id|id no)\b/.test(blob)) return getPreferredNationalIdValue()
  const bySimilarity = findProfileValueByLabelSimilarity(labelBlob)
  if (bySimilarity) return bySimilarity
  return fallback
}

function getLikelyValidValueForAutoFill(tc) {
  const text = normalizeLabelText(`${tc?.name || ''} ${tc?.what_to_test || ''} ${tc?.expected_result || ''} ${tc?.field_label || ''}`)
  if (text.includes('national id') || text.includes('16 digits')) return getPreferredNationalIdValue()
  if (/\bnin\b/.test(text) || text.includes('10 digits')) return '1234567890'
  if (text.includes('citizen application') || text.includes('8 digits')) return '12345678'
  if (text.includes('phone')) return '0781234567'
  if (text.includes('email')) return 'autofill@example.com'
  return '1234567890'
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
  const label = normalizeLabelText(
    `${getLabelText(control)} ${control?.name || ''} ${control?.id || ''} ${control?.placeholder || ''}`
  )
  return /\b(id number|national id|nin|citizen application|application number)\b/.test(label)
}

async function waitForWidgetSideEffects(beforeSnapshot, timeoutMs = 5000, minChanged = 1) {
  const step = 250
  const tries = Math.ceil(timeoutMs / step)
  for (let i = 0; i < tries; i += 1) {
    const changed = countChangedControls(beforeSnapshot)
    if (changed >= minChanged) return true
    await wait(step)
  }
  return false
}

async function waitForAutoFillTargets(targets, beforeSnapshot, timeoutMs = 5000) {
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
    src.value = val
    dispatchInputEvents(src)
    dispatchBlurEvent(src)
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
    await wait(380)
    continueBtn.click()
    await wait(900)
    target = resolveFieldTarget(fieldLabel, fieldName, ch)
    if (target.element && isVisible(target.element)) return target
  }

  await expandCollapsedSectionsNow()
  target = resolveFieldTarget(fieldLabel, fieldName, ch)
  return target
}

async function resolveWithPrefillAcrossSections(fieldLabel, fieldName, contextHint = '', maxSteps = 4) {
  let target = await resolveTargetWithTypeHints(fieldLabel, fieldName, {
    allowContinue: false,
    contextHint
  })
  if (target.element && isVisible(target.element)) return target

  for (let i = 0; i < maxSteps; i += 1) {
    await fillAllFieldsWithValidValues(null)
    const btn = findContinueButton()
    if (!btn) break
    scrollTestTargetIntoView(btn)
    await wait(380)
    btn.click()
    await wait(1000)
    target = await resolveTargetWithTypeHints(fieldLabel, fieldName, {
      allowContinue: false,
      contextHint
    })
    if (target.element && isVisible(target.element)) return target
  }
  return target
}

/** Normalize Yes/No for common radio model values; leave other triggers unchanged. */
function normalizeConditionalTrigger(raw) {
  const s = String(raw || '').trim()
  const l = normalizeText(s)
  if (l === 'yes' || l === 'no') return l === 'yes' ? 'Yes' : 'No'
  return s
}

function trimParentQuestionLabel(s) {
  return String(s || '')
    .trim()
    .replace(/\?+$/, '')
    .trim()
}

/**
 * Parse conditional preconditions from free text — any parent field, not one product.
 * Supports: "when <Parent> is <value>", "select Yes/No on/for <Parent>", legacy "if … is …".
 */
function parseConditionalSpec(tc) {
  const text = `${tc?.what_to_test || ''} ${tc?.expected_result || ''} ${tc?.name || ''}`

  const afterSelectingYesNo = text.match(
    /after\s+selecting\s+(yes|no)\s+(?:for|on)\s+(.+?)(?:\s*$|\s+and\b|\s+field\b)/i
  )
  if (afterSelectingYesNo) {
    return {
      parentLabel: trimParentQuestionLabel(afterSelectingYesNo[2]),
      triggerValue: normalizeConditionalTrigger(afterSelectingYesNo[1])
    }
  }

  const afterSelectingGeneral = text.match(
    /after\s+selecting\s+(.+?)\s+(?:for|on)\s+(.+?)(?:\s+field\b|\s+and\b|\s*$)/i
  )
  if (afterSelectingGeneral) {
    return {
      parentLabel: trimParentQuestionLabel(afterSelectingGeneral[2]),
      triggerValue: normalizeConditionalTrigger(afterSelectingGeneral[1])
    }
  }

  const haveSet = text.match(/\bhave\s+(.+?)\s+set\s+to\s+(yes|no)\b/i)
  if (haveSet) {
    return {
      parentLabel: trimParentQuestionLabel(haveSet[1]),
      triggerValue: normalizeConditionalTrigger(haveSet[2])
    }
  }

  const whenYesNo = text.match(/when\s+(.+?)\s+is\s+(yes|no)\b/i)
  if (whenYesNo) {
    return {
      parentLabel: trimParentQuestionLabel(whenYesNo[1]),
      triggerValue: normalizeConditionalTrigger(whenYesNo[2])
    }
  }

  const selectForGeneric = text.match(
    /\bselect\s+(.+?)\s+for\s+(.+?)(?:\s+and\b|\s+leave\b|\s+when\b|\s*$)/i
  )
  if (selectForGeneric) {
    const a = String(selectForGeneric[1] || '').trim()
    const b = trimParentQuestionLabel(selectForGeneric[2])
    const aNorm = normalizeText(a)
    if (aNorm === 'yes' || aNorm === 'no') {
      return { parentLabel: b, triggerValue: normalizeConditionalTrigger(a) }
    }
    return { parentLabel: b, triggerValue: a }
  }

  const whenGeneral = text.match(
    /when\s+(.+?)\s+is\s+(.+?)(?:\s+and\b|\s+attachment\b|\s+for\b|\s+field\b|\s+is\b\s+required|\s*$)/i
  )
  if (whenGeneral) {
    const rawVal = String(whenGeneral[2] || '')
      .trim()
      .replace(/\s+attachment.*$/i, '')
      .trim()
    return {
      parentLabel: trimParentQuestionLabel(whenGeneral[1]),
      triggerValue: normalizeConditionalTrigger(rawVal)
    }
  }

  const selectOn = text.match(
    /select\s*['"]?\s*(yes|no)\s*['"]?\s+on\s+(.+?)(?:\s+field\b|\s+and\b|\s*$)/i
  )
  if (selectOn) {
    return {
      parentLabel: trimParentQuestionLabel(selectOn[2]),
      triggerValue: normalizeConditionalTrigger(selectOn[1])
    }
  }

  const byWhen = text.match(/when\s+(.+?)\s+(?:is|=)\s+["']?([^"'.;,\n]+)["']?/i)
  if (byWhen) {
    return {
      parentLabel: trimParentQuestionLabel(byWhen[1]),
      triggerValue: normalizeConditionalTrigger(String(byWhen[2] || '').trim())
    }
  }
  const byIf = text.match(/if\s+(.+?)\s+(?:is|=)\s+["']?([^"'.;,\n]+)["']?/i)
  if (byIf) {
    return {
      parentLabel: trimParentQuestionLabel(byIf[1]),
      triggerValue: normalizeConditionalTrigger(String(byIf[2] || '').trim())
    }
  }
  return { parentLabel: '', triggerValue: '' }
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
  if (target.element && isVisible(target.element)) return target
  if (rwandaYesLocation) {
    for (let step = 0; step < 3; step += 1) {
      const btn = findContinueButton()
      if (btn) {
        scrollTestTargetIntoView(btn)
        await wait(380)
        btn.click()
        await wait(1000)
      }
      target = await resolveVisibleTargetWithNavigation(fieldLabel, fieldName, navOpts)
      if (!target.element) {
        const hintedNg = findNgSelectForLabel(fieldLabel)
        if (hintedNg) target = { element: hintedNg, kind: 'ng-select' }
      }
      if (target.element && isVisible(target.element)) return target
    }
  }
  for (let i = 0; i < 3; i += 1) {
    await wait(250)
    target = await resolveVisibleTargetWithNavigation(fieldLabel, fieldName, navOpts)
    if (target.element && isVisible(target.element)) return target
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
    await wait(800)
    return true
  }
  if (kind === 'radio') {
    const group = collectRadioGroup(target.element, target.element?.name || '')
    if (group.length > 0) {
      group[0].click()
      dispatchInputEvents(group[0])
      await wait(500)
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
      await wait(500)
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
        await wait(1000)
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
        await wait(1000)
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
        await wait(1000)
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

    const anyOn = step.match(/\bselect\s+any\s+option\s+on\s+(.+?)(?:\s+field\b|\s*$)/i)
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
  const fromProfile = getPreferredProfileValueForControl(label, '')
  if (fromProfile) return fromProfile
  if (type === 'email' || /\bemail\b/.test(label)) return 'test@example.com'
  if (type === 'tel' || /\b(phone|mobile|tel)\b/.test(label)) return '0781234567'
  if (kind === 'date' || type === 'date') return getSafeDateFallbackValue()
  if (/\b(date of birth|dob)\b/.test(label)) return getSafeDateFallbackValue()
  if (/\bdate\b/.test(label)) return getSafeDateFallbackValue()
  if (type === 'number' || /\b(age|number|amount|count|qty|quantity)\b/.test(label)) return '123'
  if (/\b(first name|lastname|last name|surname|name)\b/.test(label)) return 'John'
  if (/\b(id number|id no|national id)\b/.test(label)) return getPreferredNationalIdValue()
  if (/\b(nin|application number)\b/.test(label)) return '1234567890'
  if (type === 'url' || /\b(url|website|site)\b/.test(label)) return 'https://example.com'
  return 'ValidInput'
}

async function fillAllFieldsWithValidValues(targetToSkip = null) {
  const controls = Array.from(document.querySelectorAll('input, select, textarea, ng-select, .ng-select, div[role="combobox"]'))
  const handledRadioGroups = new Set()
  const handledNgSelectRoots = new Set()
  const skipEl = targetToSkip?.element || null
  const skipKind = targetToSkip?.kind || ''
  const skipRadioName = skipKind === 'radio' ? String(skipEl?.name || '').trim() : ''
  const skipRadioContainer = skipKind === 'radio' && skipEl ? getRadioGroupContainer(skipEl) : null
  const excludePredicate = (control) => {
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
      if (handledNgSelectRoots.has(root)) continue
      handledNgSelectRoots.add(root)
      await selectFirstNonEmptyNgSelect(root)
      continue
    }
    if (kind === 'select') {
      if (control.disabled || control.readOnly) continue
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
    if (type === 'checkbox') control.checked = true
    else control.value = getSafeDefaultInputValue(control, kind)
    dispatchInputEvents(control)
    dispatchBlurEvent(control)
    if (beforeWidget) {
      await waitForWidgetSideEffects(beforeWidget, 5500, 1)
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
    if (!ngSelectRootAppearsUnselected(root)) continue
    await selectFirstNonEmptyNgSelect(root)
    await wait(200)
  }

  await wait(500)
}

async function executeTestCase(tc) {
  const testType = String(tc?.test_type || '').trim()
  const rawFieldLabel = normalizeCaseFieldLabelRaw(String(tc?.field_label || tc?.name || '').trim())
  const fieldLabel = sanitizeSearchLabel(
    testType === 'conditional_display' ? stripConditionalClause(rawFieldLabel) : rawFieldLabel
  )
  const fieldName = String(tc?.field_name || '').trim()
  let conditionalTrace = ''

  await expandCollapsedSectionsOnce()
  await parseAndExecuteSteps(tc?.what_to_test)
  if (testType === 'conditional_required') {
    await wait(500)
  }

  const executableTypes = new Set([
    'required_field',
    'format_validation',
    'optional_field',
    'conditional_required',
    'conditional_display',
    'successful_submit'
  ])
  await maybePrepareIdTypeFromWhatToTest(tc)
  const ctxHint = String(tc?.name || '')
  let target = testType === 'successful_submit'
    ? { element: null, kind: 'unknown' }
    : await resolveTargetWithTypeHints(fieldLabel, fieldName, {
        contextHint: ctxHint
      })
  if (
    !target.element &&
    ['required_field', 'format_validation', 'optional_field'].includes(testType)
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

  if (testType === 'conditional_required' || testType === 'conditional_display') {
    const spec = parseConditionalSpec(tc)
    const parentField = resolveConditionalParentField(spec)
    if (!parentField) return { passed: false, message: `Parent field ${spec.parentLabel || 'unknown'} not found on page` }
    conditionalTrace = `Condition: ${String(spec.parentLabel || 'unknown').trim() || 'unknown'}=${String(spec.triggerValue || 'unknown').trim() || 'unknown'}`
    scrollTestTargetIntoView(parentField)
    await wait(380)
    let applied = setParentConditionalValue(parentField, spec.triggerValue)
    if (!applied) applied = applyConditionalDomFallback(spec.parentLabel, spec.triggerValue)
    if (!applied) return { passed: false, message: 'Could not set conditional parent field value' }
    await wait(1000)
    const chainTarget = await resolveWithCascadeChain(fieldLabel, fieldName, {
      allowContinue: false,
      contextHint: String(tc?.name || '')
    })
    if (chainTarget.element && isVisible(chainTarget.element)) {
      target = chainTarget
    }
    const locNorm = sanitizeSearchLabel(fieldLabel)
    const rwandaYesLocation = normalizeText(spec.triggerValue) === 'yes' &&
      /\b(district|sector|cell|village)\b/.test(locNorm)
    const afterConditionTarget = await resolveTargetAfterCondition(fieldLabel, fieldName, {
      rwandaYesLocation,
      contextHint: String(tc?.name || '')
    })
    if (afterConditionTarget.element && isVisible(afterConditionTarget.element)) {
      target = afterConditionTarget
    } else if (!target.element) {
      // Last guard for deep cascading chains (district->sector->cell->village and similar).
      target = await resolveWithCascadeChain(fieldLabel, fieldName, {
        allowContinue: false,
        contextHint: String(tc?.name || '')
      })
    }
    if (testType === 'conditional_required' && (!target?.element || !isVisible(target.element))) {
      const deep = await resolveConditionalRequiredWithCascadeLoop(fieldLabel, fieldName, String(tc?.name || ''))
      if (deep?.element && isVisible(deep.element)) target = deep
      else return { passed: false, message: `Field ${fieldLabel || fieldName || tc?.name || 'unknown'} not found after cascade chain resolution` }
    }
    conditionalTrace = `${conditionalTrace}; cascade_target=${target?.element ? 'found' : 'missing'}`
  } else if (executableTypes.has(testType)) {
    await fillAllFieldsWithValidValues(target)
  }

  let field = target.element
  if (!field && ['required_field', 'format_validation', 'optional_field', 'conditional_required', 'conditional_display'].includes(testType)) {
    const bySectionAdvance = await resolveWithPrefillAcrossSections(fieldLabel, fieldName, ctxHint, 4)
    if (bySectionAdvance.element && isVisible(bySectionAdvance.element)) {
      target = bySectionAdvance
      field = target.element
    }
  }
  if (!field && ['required_field', 'format_validation', 'optional_field', 'conditional_required', 'conditional_display'].includes(testType)) {
    return { passed: false, message: `Field ${fieldLabel || fieldName || tc?.name || 'unknown'} not found on page` }
  }

  if (field) {
    scrollTestTargetIntoView(field)
    await wait(400)
  }

  if (testType === 'required_field') {
    if (target.kind !== 'radio' && (field.disabled || field.readOnly)) {
      return { skipped: true, reason: 'field is disabled — auto-filled by widget' }
    }
    if (target.kind === 'radio') {
      const group = collectRadioGroup(field, field?.name || '')
      if (group.length > 0) {
        await ensureRadioGroupUnselected(field, 6)
      }
      const radioContainer = getRadioGroupContainer(field)
      const clicked = await clickContinueAndReadErrorsInContainer(
        radioContainer,
        tc?.expected_result,
        fieldLabel,
        target,
        2500
      )
      if (!clicked.ok) return { passed: false, message: clicked.error }
      return { passed: Boolean(clicked.matched), message: clicked.matched || '' }
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
    const clicked = await clickContinueAndReadErrors(tc?.expected_result, fieldLabel, target)
    if (!clicked.ok) return { passed: false, message: clicked.error }
    return { passed: Boolean(clicked.matched), message: clicked.matched || '' }
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
    const clicked = await clickContinueAndReadErrors(tc?.expected_result, fieldLabel, target)
    if (!clicked.ok) return { passed: false, message: clicked.error }
    return { passed: Boolean(clicked.matched), message: clicked.matched || '' }
  }

  if (testType === 'optional_field') {
    if (field.disabled || field.readOnly) {
      return { passed: true, message: 'Field is disabled/readonly and not blocking submit.' }
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
    const button = findContinueButton()
    if (!button) return { passed: false, message: 'Continue/Next button not found on page' }
    scrollTestTargetIntoView(button)
    await wait(420)
    button.click()
    const entries = await getVisibleValidationEntriesWithRetry()
    const allMessages = entries.map(e => e.text)
    const relevant = allMessages.filter(msg => !/enter your details|sign in|login/i.test(msg))
    const mention = relevant.find(msg => normalizeText(msg).includes(normalizeText(fieldLabel || fieldName)))
    return { passed: !mention, message: mention || '' }
  }

  if (testType === 'conditional_display') {
    const visible = isVisible(field)
    const expectsHidden = /not displayed|not visible|hidden|does not appear|not shown/i.test(String(tc?.expected_result || tc?.what_to_test || ''))
    const passed = expectsHidden ? !visible : visible
    return {
      passed,
      message: passed
        ? `${expectsHidden ? 'Conditional field stayed hidden as expected.' : 'Conditional field is visible.'}${conditionalTrace ? ` ${conditionalTrace}` : ''}`
        : `${expectsHidden ? 'Conditional field appeared but was expected hidden.' : 'Conditional field did not become visible.'}${conditionalTrace ? ` ${conditionalTrace}` : ''}`
    }
  }

  if (testType === 'conditional_required') {
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
    const clicked = await clickContinueAndReadErrors(tc?.expected_result, fieldLabel, target)
    if (!clicked.ok) return { passed: false, message: clicked.error }
    const strict = pickMatchedMessageForConditionalRequired(
      getVisibleValidationEntries(),
      tc?.expected_result,
      fieldLabel,
      target
    )
    const base = strict || ''
    return { passed: Boolean(strict), message: `${base}${conditionalTrace ? `${base ? ' | ' : ''}${conditionalTrace}` : ''}` }
  }

  if (testType === 'successful_submit') {
    for (let round = 0; round < 3; round += 1) {
      await fillAllFieldsWithValidValues(null)
      await wait(200)
      const button = findContinueButton()
      if (!button) break
      scrollTestTargetIntoView(button)
      await wait(420)
      button.click()
      await wait(900)
    }
    await fillAllFieldsWithValidValues(null)
    const finalBtn = findContinueButton()
    if (finalBtn) {
      scrollTestTargetIntoView(finalBtn)
      await wait(420)
      finalBtn.click()
    }
    await wait(400)
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
    return { skipped: true, reason: 'attachment tests require file system access — not supported in extension mode yet' }
  }
  if (testType === 'disabled_field') {
    return { skipped: true, reason: 'disabled_field is verified through widget_auto_fill — not supported standalone in extension mode yet' }
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
  if (message?.type === 'QA_HELPER_SCAN_FIELDS') {
    sendResponse({ ok: true, fields: scanFormFields() })
    return true
  }
  if (message?.type === 'QA_HELPER_RUN_TEST_CASE') {
    ;(async () => {
      try {
        const tc = message?.testCase || {}
        const profile = message?.testDataProfile
        if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
          try {
            window.localStorage.setItem('qa_test_data_profile', JSON.stringify(profile))
          } catch {
            // Ignore storage limits/availability and continue with fallbacks.
          }
        }
        await expandCollapsedSectionsOnce()
        const result = await executeTestCase(tc)
        if (result && result.passed === false && !result.skipped) {
          result.screenshotDataUrl = await requestFailureScreenshot()
        }
        const targetLabel = sanitizeSearchLabel(String(tc?.field_label || tc?.name || ''))
        const targetField = resolveFieldTarget(targetLabel, String(tc?.field_name || ''))
        await resetFormStateAfterTest(targetField)
        sendResponse({ ok: true, ...result })
      } catch (err) {
        sendResponse({ ok: true, passed: false, message: String(err?.message || 'Unknown execution error') })
      }
    })()
    return true
  }
  return false
})