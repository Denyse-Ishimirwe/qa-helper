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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'QA_HELPER_SCAN_FIELDS') {
    sendResponse({ ok: true, fields: scanFormFields() })
    return true
  }
  return false
})