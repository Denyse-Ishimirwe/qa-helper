/* global chrome */
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

function normalizeText(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-./]+/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenSet(value) {
  const t = normalizeText(value)
  if (!t) return []
  const parts = t.split(' ').filter(Boolean)
  const compact = t.replace(/\s+/g, '')
  return Array.from(new Set([...parts, compact]))
}

function pickTargetField(testCase) {
  const text = normalizeText(`${testCase?.name || ''} ${testCase?.what_to_test || ''} ${testCase?.expected_result || ''}`)
  const tokens = new Set(tokenSet(text))
  const nodes = Array.from(document.querySelectorAll('input, select, textarea'))
  let best = null
  let bestScore = 0
  for (const el of nodes) {
    const tag = el.tagName.toLowerCase()
    const type = String(el.getAttribute('type') || '').toLowerCase()
    if (tag === 'input' && ['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue
    const label = getLabelText(el)
    const name = el.getAttribute('name') || ''
    const id = el.id || ''
    const placeholder = el.getAttribute('placeholder') || ''
    const all = [label, name, id, placeholder].flatMap(v => tokenSet(v))
    let score = 0
    for (const t of all) {
      if (tokens.has(t)) score += 2
      if (text.includes(t)) score += 1
    }
    if (score > bestScore) {
      bestScore = score
      best = el
    }
  }
  return best
}

function getInvalidValueFor(el) {
  const tag = el.tagName.toLowerCase()
  const type = String(el.getAttribute('type') || '').toLowerCase()
  const label = normalizeText(`${getLabelText(el)} ${el.getAttribute('name') || ''}`)
  if (tag === 'select') return ''
  if (type === 'email' || label.includes('email')) return 'not-an-email'
  if (type === 'tel' || label.includes('phone') || label.includes('mobile')) return 'abc'
  if (type === 'number') return 'abc'
  if (type === 'date' || label.includes('date') || label.includes('birth')) return '2099-12-31'
  return '!!!invalid!!!'
}

function setElementValue(el, value) {
  const tag = el.tagName.toLowerCase()
  const type = String(el.getAttribute('type') || '').toLowerCase()
  if (tag === 'select') {
    if (value === '') {
      el.selectedIndex = 0
    } else {
      const option = Array.from(el.options || []).find(o => String(o.value) === String(value))
      if (option) el.value = String(value)
      else if ((el.options || []).length > 0) el.selectedIndex = 0
    }
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }
  if (type === 'checkbox' || type === 'radio') {
    el.checked = Boolean(value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }
  el.focus()
  el.value = String(value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function clickSubmitLike() {
  const candidates = [
    '#submitBtn',
    'button[type="submit"]',
    'input[type="submit"]',
    'button'
  ]
  for (const sel of candidates) {
    const node = document.querySelector(sel)
    if (!node) continue
    const text = normalizeText(node.textContent || node.value || '')
    if (sel === 'button' && !text.includes('submit') && !text.includes('continue') && !text.includes('next')) continue
    node.click()
    return true
  }
  return false
}

async function stageFailureView(testCase) {
  const tc = testCase || {}
  const target = pickTargetField(tc)
  if (!target) {
    clickSubmitLike()
    await new Promise(r => setTimeout(r, 400))
    return { ok: false, reason: 'target_not_found' }
  }

  const type = String(tc?.test_type || '').toLowerCase()
  if (type === 'required_field') {
    const tag = target.tagName.toLowerCase()
    const inputType = String(target.getAttribute('type') || '').toLowerCase()
    if (tag === 'select') setElementValue(target, '')
    else if (inputType === 'checkbox' || inputType === 'radio') setElementValue(target, false)
    else setElementValue(target, '')
    target.blur()
    clickSubmitLike()
    await new Promise(r => setTimeout(r, 500))
    return { ok: true }
  }

  if (type === 'format_validation') {
    const invalid = getInvalidValueFor(target)
    setElementValue(target, invalid)
    target.blur()
    clickSubmitLike()
    await new Promise(r => setTimeout(r, 500))
    return { ok: true, invalid }
  }

  clickSubmitLike()
  await new Promise(r => setTimeout(r, 400))
  return { ok: true }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'QA_HELPER_SCAN_FIELDS') {
    sendResponse({ ok: true, fields: scanFormFields() })
    return true
  }
  if (message?.type === 'QA_HELPER_STAGE_FAILURE_VIEW') {
    stageFailureView(message?.testCase)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }))
    return true
  }
  return false
})