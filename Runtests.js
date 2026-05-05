import 'dotenv/config'
import { launchChromiumBrowser } from './playwright-launch.js'
import { groqChatCompletionsCreate, GROQ_PRIMARY_MODEL } from './ai.js'
import db from './db.js'
import fs from 'node:fs'
import path from 'node:path'

const SUPPORTED_TEST_TYPES = [
  'required_field',
  'format_validation',
  'successful_submit',
  'conditional_field',
  'widget_auto_fill',
  'attachment',
  'label_check'
]

function normalizeTestType(rawType) {
  const t = String(rawType || '').toLowerCase().trim()
  if (!t) return 'required_field'
  if (t === 'conditional_display' || t === 'conditional_required') return 'conditional_field'
  if (t === 'conditional_displayed' || t === 'conditional' || t === 'display_conditional') return 'conditional_field'
  if (t === 'conditional_required_field' || t === 'required_if') return 'conditional_field'
  if (SUPPORTED_TEST_TYPES.includes(t)) return t
  if (t === 'widget_autofill' || t === 'auto_fill' || t === 'autofill') return 'widget_auto_fill'
  if (t === 'optional' || t === 'optional_validation') return 'required_field'
  if (t === 'file_attachment' || t === 'attachment_validation') return 'attachment'
  return 'required_field'
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function testLog(line) {
  console.log(`[TEST] ${line}`)
}

async function isOnLoginPage(page) {
  try {
    const url = page.url()
    if (url.includes('login') || url.includes('signin') || url.includes('auth')) return true
    const loginSignals = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase()
      return (
        text.includes('sign in with irembo') ||
        text.includes('enter your details to continue') ||
        text.includes('invalid username or password') ||
        (text.includes('phone number') && text.includes('password') && text.includes('sign in'))
      )
    })
    return Boolean(loginSignals)
  } catch {
    return false
  }
}

// ─── AI validation — ONLY for manually added test cases ──────────────────────
// AI-generated test cases already have a test_type — skip validation for them

async function validateManualTestCase({ name, what_to_test, expected_result }) {
  const key = process.env.GROQ_API_KEY
  if (!key) return { valid: false, test_type: 'required_field', reason: 'GROQ_API_KEY not set' }

  const content = `
You are a strict QA validator. A tester manually wrote this test case for a registration form:
Name: ${name}
What to test: ${what_to_test}
Expected result: ${expected_result}

Return JSON only — no other text:
{ "valid": true, "test_type": "required_field", "reason": "explanation" }

Rules:
- Return valid: false if the test case is vague, nonsensical, contradicts itself, or cannot be automated by filling a form and clicking submit
- Return valid: true if it clearly describes a specific automatable form test
- test_type must be exactly one of: required_field, format_validation, successful_submit, conditional_field, widget_auto_fill, attachment, label_check
- required_field: tests that an error appears when a required field is left empty
- format_validation: tests that an error appears when a field has wrong format (e.g. wrong ID number)
- successful_submit: tests that the form submits successfully when all fields are correct
`.trim()

  try {
    const completion = await groqChatCompletionsCreate({
      model: GROQ_PRIMARY_MODEL,
      messages: [{ role: 'user', content }]
    })
    const response = completion.choices?.[0]?.message?.content || '{}'
    const cleaned = response.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(cleaned)
    const valid = Boolean(parsed?.valid)
    const rawType = String(parsed?.test_type || '')
    const test_type = normalizeTestType(rawType)
    const reason = String(parsed?.reason || '').trim() || (valid ? 'Valid test case' : 'Invalid test case')
    return { valid, test_type, reason }
  } catch {
    // If AI validation fails, allow the test to run rather than blocking it
    return { valid: true, test_type: 'required_field', reason: 'AI validation unavailable — running as required_field' }
  }
}

// ─── Known form fields ────────────────────────────────────────────────────────

const KNOWN_FIELDS = [
  {
    selector: '#firstName',
    optional: true,
    type: 'text',
    label: 'First Name',
    keywords: ['first name', 'firstname'],
    validValue: 'John'
  },
  {
    selector: '#lastName',
    errorSelector: '#lastNameError',
    type: 'text',
    label: 'Last Name',
    keywords: ['last name', 'lastname'],
    validValue: 'Doe'
  },
  {
    selector: '#dob',
    errorSelector: '#dobError',
    formatErrorSelector: '#dobAgeError',
    type: 'date',
    label: 'Date of Birth',
    keywords: ['date of birth', 'dob', 'birth date', 'birth'],
    validValue: '1990-01-01'
  },
  {
    selector: '#gender',
    errorSelector: '#genderError',
    type: 'select',
    label: 'Gender',
    keywords: ['gender'],
    validValue: 'male'
  },
  {
    selector: '#nationality',
    errorSelector: '#nationalityError',
    type: 'text',
    label: 'Nationality',
    keywords: ['nationality'],
    validValue: 'Rwandan'
  },
  {
    selector: '#idNumber',
    errorSelector: '#idNumberError',
    formatErrorSelector: '#idNumberFormatError',
    type: 'text',
    label: 'ID Number',
    keywords: ['id number', 'national id', 'id no', 'id'],
    validValue: '1199880012345678',
    invalidValue: '9999999999999999'
  }
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeType(rawType) {
  const t = String(rawType || '').toLowerCase()
  return t || 'text'
}

function toNormalizedText(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-./]+/g, ' ')
    .replace(/[0-9]+/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function toTokenSet(value) {
  const base = toNormalizedText(value)
  if (!base) return []
  const parts = base.split(' ').filter(Boolean)
  const compact = base.replace(/\s+/g, '')
  return Array.from(new Set([...parts, compact]))
}

function guessValidValue(field) {
  if (field.validValue) return field.validValue
  const type = normalizeType(field.type)
  const labelText = `${field.label || ''} ${field.name || ''}`.toLowerCase()
  if (type === 'email' || labelText.includes('email')) return 'qa.tester@example.com'
  if (type === 'tel' || labelText.includes('phone') || labelText.includes('mobile')) return '0788123456'
  if (type === 'date' || labelText.includes('birth')) return '1990-01-01'
  if (type === 'number') return '10'
  if (type === 'select') return field.validValue || ''
  return 'SampleValue'
}

function guessInvalidValue(field) {
  if (field.invalidValue) return field.invalidValue
  const type = normalizeType(field.type)
  const labelText = `${field.label || ''} ${field.name || ''}`.toLowerCase()
  if (type === 'email' || labelText.includes('email')) return 'invalid-email'
  if (type === 'tel' || labelText.includes('phone') || labelText.includes('mobile')) return 'abc'
  if (type === 'number') return 'abc'
  if (type === 'date' || labelText.includes('birth')) return null
  return '!!!invalid!!!'
}

function deriveInvalidValueForTestCase(tc, field, fallbackValue) {
  const text = `${tc?.name || ''} ${tc?.what_to_test || ''} ${tc?.expected_result || ''}`.toLowerCase()
  const labelText = `${field?.label || ''} ${field?.name || ''}`.toLowerCase()
  const isIdLike = labelText.includes('id') || labelText.includes('identifier')

  if (text.includes('non-numeric') || text.includes('letters') || text.includes('alphabet')) {
    return 'ABCXYZ'
  }
  if (text.includes('special') || text.includes('symbol')) {
    return '@@@###'
  }
  if (text.includes('length') || text.includes('too short')) {
    return isIdLike ? '12345' : 'x'
  }
  if (text.includes('too long')) {
    return isIdLike ? '1234567890123456789012345' : 'xxxxxxxxxxxxxxxxxxxxxxxx'
  }
  if (isIdLike && String(fallbackValue || '').replace(/\D/g, '').length >= 10) {
    // Prefer clearly invalid alpha input for id-like fields unless test explicitly asks length.
    return 'ABC123XYZ'
  }
  return fallbackValue
}

async function fillAllFields(page, fields = KNOWN_FIELDS, options = {}) {
  const exclude = new Set(Array.isArray(options?.excludeSelectors) ? options.excludeSelectors : [])
  const excludeNames = new Set(
    Array.isArray(options?.excludeNames)
      ? options.excludeNames.map(v => String(v || '').trim()).filter(Boolean)
      : []
  )
  const excludePredicate = typeof options?.excludePredicate === 'function' ? options.excludePredicate : null
  for (const f of fields) {
    if (exclude.has(f.selector)) continue
    if (excludeNames.has(String(f?.name || '').trim())) continue
    if (excludePredicate && excludePredicate(f)) continue
    try {
      const loc = page.locator(f.selector).first()
      const type = normalizeType(f.type)
      if (type === 'select') {
        const val = guessValidValue(f)
        if (val) {
          await loc.selectOption(val, { timeout: 700 })
        } else {
          // Pick first non-empty option for generic dropdowns.
          await loc.selectOption({ index: 1 }, { timeout: 700 }).catch(() => {})
        }
      } else if (type === 'radio' || type === 'checkbox') {
        await loc.check({ timeout: 700 }).catch(() => {})
      } else {
        await loc.fill(guessValidValue(f), { timeout: 700 })
      }
    } catch { /* field may not exist on this form */ }
  }
}

async function clearField(page, field) {
  try {
    const loc = page.locator(field.selector).first()
    const type = normalizeType(field.type)
    if (type === 'select') {
      await loc.selectOption('', { timeout: 700 })
    } else if (type === 'checkbox') {
      await loc.uncheck({ timeout: 700 }).catch(() => {})
    } else if (type === 'radio') {
      // Radios cannot always be programmatically "unchecked"; for required tests we
      // skip selecting this target radio in fillAllFields instead.
      return
    } else {
      await loc.fill('', { timeout: 700 })
    }
  } catch { /* ignore */ }
}

function matchFieldFromTestCaseInSet(tc, fields) {
  const text = toNormalizedText(`${tc.name || ''} ${tc.what_to_test || ''} ${tc.expected_result || ''}`)
  const tokens = new Set(toTokenSet(text))
  const quotedRaw = `${tc.name || ''} ${tc.what_to_test || ''} ${tc.expected_result || ''}`
  const quotedParts = Array.from(quotedRaw.matchAll(/"([^"]{2,80})"/g))
    .map(m => toNormalizedText(m[1]))
    .filter(Boolean)
    .filter(qp => !['yes', 'no', 'male', 'female', 'full time', 'part time'].includes(qp))
  let best = null
  let bestScore = 0
  let bestLabel = ''
  for (const f of fields) {
    let score = 0
    const label = toNormalizedText(f.label || '')
    const name = toNormalizedText(f.name || '')
    const selector = toNormalizedText(f.selector || '')

    // Strong signal: quoted field names in test case text.
    for (const qp of quotedParts) {
      if (!qp) continue
      if (label && (qp === label || label.includes(qp) || qp.includes(label))) score += 12
      if (name && (qp === name || name.includes(qp) || qp.includes(name))) score += 10
      if (selector && selector.includes(qp)) score += 8
    }

    for (const kw of (f.keywords || [])) {
      const nk = toNormalizedText(kw)
      if (!nk) continue
      const kwTokens = toTokenSet(nk)
      for (const t of kwTokens) {
        if (tokens.has(t)) score += 2
      }
      if (text.includes(nk)) score += Math.max(1, nk.split(' ').length)
    }
    if (label && text.includes(label)) score += Math.max(2, label.split(' ').length)
    if (name && text.includes(name)) score += Math.max(1, name.split(' ').length)
    if (score > bestScore) {
      bestScore = score
      best = f
      bestLabel = f.label || f.name || f.selector || ''
    }
  }
  const confidence = bestScore >= 6 ? 'high' : bestScore >= 3 ? 'medium' : 'low'
  return {
    field: bestScore > 0 ? best : null,
    score: bestScore,
    confidence,
    matchedLabel: bestLabel
  }
}

async function discoverLiveFields(page) {
  const readOnce = async () => page.evaluate(() => {
    const normalizeText = (value) =>
      String(value || '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_\-./]+/g, ' ')
        .replace(/[0-9]+/g, ' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()

    const tokenSet = (value) => {
      const base = normalizeText(value)
      if (!base) return []
      const parts = base.split(' ').filter(Boolean)
      const compact = base.replace(/\s+/g, '')
      return Array.from(new Set([...parts, compact]))
    }

    const getLabel = (el) => {
      const id = el.id
      if (id) {
        const byFor = document.querySelector(`label[for="${id}"]`)
        if (byFor?.textContent?.trim()) return byFor.textContent.trim()
      }
      const wrapped = el.closest('label')
      if (wrapped?.textContent?.trim()) return wrapped.textContent.trim()
      return (el.getAttribute('aria-label') || '').trim()
    }

    const fields = []
    const nodes = Array.from(document.querySelectorAll('input, select, textarea'))
    for (const el of nodes) {
      const tag = el.tagName.toLowerCase()
      const inputType = String(el.getAttribute('type') || '').toLowerCase()
      if (tag === 'input' && ['hidden', 'submit', 'button', 'image', 'reset'].includes(inputType)) continue

      const id = el.id || ''
      const name = el.getAttribute('name') || ''
      const placeholder = el.getAttribute('placeholder') || ''
      const label = getLabel(el)
      const required = el.hasAttribute('required') || el.getAttribute('aria-required') === 'true'
      const selector = id
        ? `#${id}`
        : name
          ? `${tag}[name="${name.replace(/"/g, '\\"')}"]`
          : ''
      if (!selector) continue

      fields.push({
        selector,
        type: inputType || tag,
        label: label || name || id || tag,
        name,
        optional: !required,
        keywords: [label, name, id, placeholder]
          .flatMap(v => tokenSet(v))
      })
    }
    return fields
  })

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await readOnce()
      return Array.isArray(raw) ? raw : []
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase()
      const contextDestroyed =
        msg.includes('execution context was destroyed') ||
        msg.includes('cannot find context with specified id')
      if (!contextDestroyed || attempt === 2) {
        throw err
      }
      // The page navigated while evaluating; wait for next document and retry.
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
      await page.waitForTimeout(250)
    }
  }

  return []
}

function mergeFields(known, live) {
  const map = new Map()
  for (const f of [...known, ...live]) {
    if (!f?.selector) continue
    if (!map.has(f.selector)) map.set(f.selector, f)
    else map.set(f.selector, { ...map.get(f.selector), ...f })
  }
  return Array.from(map.values())
}

/** `<input type="date">` only accepts yyyy-mm-dd; "invalid" strings become empty → wrong errors. */
function resolveDobFormatValidation(tc) {
  const text = `${tc.name || ''} ${tc.what_to_test || ''} ${tc.expected_result || ''}`.toLowerCase()
  const mentionsUnderage =
    /under\s*18|under eighteen|minor|less than 18|below 18|too young|younger than 18|person is under/i.test(
      text
    )
  if (!mentionsUnderage) return null
  const d = new Date()
  d.setFullYear(d.getFullYear() - 10)
  return { invalidVal: d.toISOString().slice(0, 10), formatErrorSelector: '#dobAgeError' }
}

async function isVisible(page, selector) {
  try {
    const el = page.locator(selector).first()
    return await el.isVisible({ timeout: 200 })
  } catch {
    return false
  }
}

function normalizeForCompare(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenizeForCompare(value) {
  const stop = new Set(['the', 'is', 'are', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'field', 'please'])
  return normalizeForCompare(value)
    .split(' ')
    .filter(Boolean)
    .filter(t => !stop.has(t))
}

function tokenOverlapScore(a, b) {
  const as = new Set(tokenizeForCompare(a))
  const bs = new Set(tokenizeForCompare(b))
  if (as.size === 0 || bs.size === 0) return 0
  let hits = 0
  for (const t of as) if (bs.has(t)) hits += 1
  return hits / Math.max(1, Math.min(as.size, bs.size))
}

async function collectVisibleValidationMessages(page) {
  try {
    const msgs = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll(`
        [role="alert"],
        [aria-live],
        .error,
        .errors,
        .invalid-feedback,
        .text-danger,
        .mat-error,
        .ant-form-item-explain-error,
        .help-block,
        .form-error,
        .field-error,
        .validation-message,
        .error-message,
        small,
        p,
        span,
        div
      `))
      const visible = (el) => {
        const style = window.getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      }
      const looksLikeValidation = (txt) => {
        const t = String(txt || '').trim().toLowerCase()
        if (!t || t.length < 3 || t.length > 220) return false
        return /required|invalid|must|missing|mandatory|please|select|enter|choose|upload|format|larger than|not allowed|error/.test(t)
      }
      return candidates
        .filter(visible)
        .map(el => String(el.textContent || '').trim())
        .filter(looksLikeValidation)
        .filter((msg, idx, arr) => arr.indexOf(msg) === idx)
        .slice(0, 20)
    })
    return Array.isArray(msgs) ? msgs : []
  } catch {
    return []
  }
}

function pickBestMessageMatch(expected, messages = []) {
  const expectedNorm = normalizeForCompare(expected)
  let best = ''
  let bestScore = 0
  for (const msg of messages) {
    const msgNorm = normalizeForCompare(msg)
    let score = tokenOverlapScore(expectedNorm, msgNorm)
    if (expectedNorm && msgNorm.includes(expectedNorm)) score = Math.max(score, 0.95)
    if (score > bestScore) {
      bestScore = score
      best = msg
    }
  }
  return { bestMessage: best, score: bestScore }
}

async function detectFieldInvalidState(page, field) {
  if (!field?.selector) return false
  try {
    return await page.locator(field.selector).first().evaluate((el) => {
      const selfInvalid =
        el.getAttribute('aria-invalid') === 'true' ||
        el.classList.contains('is-invalid') ||
        el.classList.contains('ng-invalid') ||
        el.classList.contains('error')
      if (selfInvalid) return true
      const group = el.closest('[role="group"], .form-group, .field-group, .mat-form-field, .radio-group')
      if (!group) return false
      return (
        group.classList.contains('is-invalid') ||
        group.classList.contains('ng-invalid') ||
        group.classList.contains('error') ||
        group.getAttribute('aria-invalid') === 'true'
      )
    })
  } catch {
    return false
  }
}

function evaluateValidationEvidence({ expectedText, field, visibleMessages, fieldError, invalidState }) {
  const { bestMessage, score } = pickBestMessageMatch(expectedText || '', visibleMessages || [])
  const fieldLabelNorm = normalizeForCompare(field?.label || '')
  const mentionsTarget = (visibleMessages || []).some(msg => {
    const m = normalizeForCompare(msg)
    return Boolean(fieldLabelNorm) && m.includes(fieldLabelNorm)
  })
  const hasValidationLike = (visibleMessages || []).some(msg => /required|must|missing|mandatory|invalid|error|choose|select/i.test(msg))
  const strongSemanticMatch = score >= 0.6
  const targetLinkedMessage = mentionsTarget && hasValidationLike
  const semanticMatch = strongSemanticMatch || targetLinkedMessage
  const hasEvidence = Boolean(fieldError) || Boolean(invalidState) || semanticMatch
  return { hasEvidence, bestMessage, semanticMatch, mentionsTarget, hasValidationLike, strongSemanticMatch, targetLinkedMessage, score }
}

function detectConditionValueToken(tc) {
  const text = `${tc?.name || ''} ${tc?.what_to_test || ''} ${tc?.expected_result || ''}`.toLowerCase()
  if (/\bfull\s*time\b/.test(text)) return 'full time'
  if (/\bpart\s*time\b/.test(text)) return 'part time'
  if (/\bnational\s*id\b/.test(text)) return 'national id'
  if (/\bcitizen application number\b/.test(text)) return 'citizen application number'
  if (/\bnin\b/.test(text)) return 'nin'
  if (/\byes\b/.test(text)) return 'yes'
  if (/\bno\b/.test(text)) return 'no'
  return ''
}

function findConditionControllerField(tc, runtimeFields) {
  const text = `${tc?.name || ''} ${tc?.what_to_test || ''} ${tc?.expected_result || ''}`.toLowerCase()
  const keywordGroups = [
    ['live in rwanda', 'residence'],
    ['contract type', 'employment'],
    ['id type', 'identification']
  ]
  for (const group of keywordGroups) {
    if (!group.some(k => text.includes(k))) continue
    const hit = runtimeFields.find((f) => {
      const label = String(f?.label || '').toLowerCase()
      const name = String(f?.name || '').toLowerCase()
      return group.some(k => label.includes(k) || name.includes(k))
    })
    if (hit) return hit
  }
  return null
}

async function applyConditionValue(page, controllerField, valueToken) {
  if (!controllerField || !valueToken) return false
  const type = normalizeType(controllerField.type)
  try {
    if (type === 'select') {
      const done = await page.locator(controllerField.selector).first().evaluate((el, token) => {
        const select = el
        const wanted = String(token || '').toLowerCase().trim()
        const options = Array.from(select.options || [])
        const match = options.find(opt => {
          const label = String(opt.textContent || '').toLowerCase().trim()
          const value = String(opt.value || '').toLowerCase().trim()
          return label === wanted || value === wanted || label.includes(wanted)
        })
        if (!match) return false
        select.value = match.value
        select.dispatchEvent(new Event('input', { bubbles: true }))
        select.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      }, valueToken)
      if (done) return true
    }
  } catch { /* fall through to generic click strategy */ }

  try {
    const clicked = await page.evaluate((token) => {
      const wanted = String(token || '').toLowerCase().trim()
      const labels = Array.from(document.querySelectorAll('label'))
      for (const lb of labels) {
        const txt = String(lb.textContent || '').toLowerCase().trim()
        if (!txt || !txt.includes(wanted)) continue
        const forId = lb.getAttribute('for')
        const byFor = forId ? document.getElementById(forId) : null
        const nested = lb.querySelector('input[type="radio"], input[type="checkbox"]')
        const input = byFor || nested
        if (input) {
          input.click()
          return true
        }
      }
      return false
    }, valueToken)
    return clicked
  } catch {
    return false
  }
}

function detectAttachmentCaseKind(tc) {
  const text = `${tc?.name || ''} ${tc?.what_to_test || ''} ${tc?.expected_result || ''}`.toLowerCase()
  if (text.includes('larger than') || text.includes('500kb') || text.includes('size')) return 'size_limit'
  if (text.includes('wrong format') || text.includes('allowed file format') || text.includes('file format')) return 'invalid_format'
  if (text.includes('required') || text.includes('left empty') || text.includes('without attachment')) return 'required'
  return 'required'
}

function findAttachmentField(tc, runtimeFields) {
  const match = matchFieldFromTestCaseInSet(tc, runtimeFields)
  if (match.field) return match.field
  return runtimeFields.find((f) => {
    const t = normalizeType(f?.type)
    const label = String(f?.label || '').toLowerCase()
    return t === 'file' || label.includes('attachment') || label.includes('document') || label.includes('contract')
  }) || null
}

function buildAttachmentFixtures(projectId) {
  const base = process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.join(process.cwd(), 'uploads')
  const dir = path.join(base, 'fixtures', `project-${projectId}`)
  fs.mkdirSync(dir, { recursive: true })
  const invalidFormatPath = path.join(dir, 'invalid-format.txt')
  const oversizedPdfPath = path.join(dir, 'oversized.pdf')
  if (!fs.existsSync(invalidFormatPath)) fs.writeFileSync(invalidFormatPath, 'invalid format fixture')
  if (!fs.existsSync(oversizedPdfPath)) fs.writeFileSync(oversizedPdfPath, Buffer.alloc(520 * 1024, 65))
  return { invalidFormatPath, oversizedPdfPath }
}

async function waitForPostSubmitSignals(page, selectors = [], timeoutMs = 1200) {
  const deadline = Date.now() + timeoutMs
  const unique = Array.from(new Set((selectors || []).filter(Boolean)))
  while (Date.now() < deadline) {
    for (const sel of unique) {
      if (await isVisible(page, sel)) return { selector: sel, seen: true }
    }
    await page.waitForTimeout(50)
  }
  return { selector: null, seen: false }
}

async function clickSubmit(page) {
  const candidates = [
    'button:has-text("Continue")',
    'button:has-text("Next")',
    '#submitBtn',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Apply")',
    'button:has-text("Save")'
  ]
  for (const sel of candidates) {
    const el = page.locator(sel).first()
    if (await el.count()) {
      try { await el.scrollIntoViewIfNeeded({ timeout: 1000 }) } catch { /* ignore */ }
      await el.click()
      return
    }
  }
  throw new Error('Continue/Next/Submit button not found')
}

async function goToForm(page, url) {
  if (!url) return false
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForTimeout(120)
    return true
  } catch {
    try {
      // Fallback for complex portals that keep long-running network requests.
      await page.goto(url, { waitUntil: 'commit', timeout: 10000 })
      await page.waitForTimeout(120)
      return true
    } catch {
      return false
    }
  }
}

async function resetFormPage(page, url, hasLoadedOnce) {
  if (!hasLoadedOnce) {
    return goToForm(page, url)
  }
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 8000 })
    await page.waitForTimeout(120)
    return true
  } catch {
    return goToForm(page, url)
  }
}

function mapScannedFieldsToRuntime(scannedFields = []) {
  return scannedFields
    .map((f, idx) => {
      const type = normalizeType(f?.type)
      const id = String(f?.id || '').trim()
      const name = String(f?.name || '').trim()
      const placeholder = String(f?.placeholder || '').trim()
      const element = String(f?.element || '').trim().toLowerCase()
      const label = String(f?.label || f?.name || f?.id || `field-${idx + 1}`).trim()
      const selectorTag =
        element === 'textarea'
          ? 'textarea'
          : (type === 'select-one' || type === 'select' || element === 'select')
            ? 'select'
            : 'input'
      const selector = id
        ? `#${id}`
        : name
          ? `${selectorTag}[name="${name.replace(/"/g, '\\"')}"]`
          : ''
      if (!selector) return null
      return {
        selector,
        type: (type === 'select-one' || type === 'select') ? 'select' : type,
        label,
        name,
        optional: !f?.required,
        keywords: [label, name, id, placeholder].flatMap(v => toTokenSet(v))
      }
    })
    .filter(Boolean)
}

function ensureScreenshotDir(projectId) {
  const base = process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.join(process.cwd(), 'uploads')
  const dir = path.join(base, 'screenshots', `project-${projectId}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function captureFailureScreenshot(page, projectId, testCaseId) {
  try {
    const dir = ensureScreenshotDir(projectId)
    const fileName = `tc-${testCaseId}-${Date.now()}.png`
    const fullPath = path.join(dir, fileName)
    await page.screenshot({ path: fullPath, fullPage: true })
    return `/uploads/screenshots/project-${projectId}/${fileName}`
  } catch (err) {
    testLog(`Screenshot capture failed for test case ${testCaseId}: ${String(err?.message || err)}`)
    return null
  }
}

// ─── Main runner ──────────────────────────────────────────────────────────────

async function runTests(projectId, options = {}) {
  const project = await db.get('SELECT * FROM projects WHERE id = ?', projectId)
  const testCases = await db.all('SELECT * FROM test_cases WHERE project_id = ?', projectId)

  if (!project) throw new Error('Project not found')
  if (testCases.length === 0) throw new Error('No test cases found')

  const browser = await launchChromiumBrowser()
  const page = await browser.newPage()
  const context = page.context()
  const extensionCookies = Array.isArray(options.sessionCookies) ? options.sessionCookies : []
  const targetUrlForSession = String(options.overrideUrl || project.form_url || '').trim()
  // #region agent log
  fetch('http://127.0.0.1:7811/ingest/193ceff3-13cc-4a5d-8fcb-570fabc3b13e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'64e698'},body:JSON.stringify({sessionId:'64e698',runId:'pre-fix-auth',hypothesisId:'H3',location:'Runtests.js:runTests:initCookies',message:'Runner received session cookies',data:{targetUrlHost:(()=>{try{return new URL(targetUrlForSession).host}catch{return''}})(),sessionCookiesCount:extensionCookies.length,cookieDomains:Array.from(new Set(extensionCookies.map(c=>String(c?.domain||'').toLowerCase()).filter(Boolean))).slice(0,20)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (extensionCookies.length > 0 && targetUrlForSession) {
    try {
      const mapped = extensionCookies
        .map((c) => {
          const name = String(c?.name || '').trim()
          const value = String(c?.value || '')
          if (!name) return null
          const domain = String(c?.domain || '').trim()
          const pathValue = String(c?.path || '/').trim() || '/'
          const secure = Boolean(c?.secure)
          const httpOnly = Boolean(c?.httpOnly)
          const sameSiteRaw = String(c?.sameSite || '').toLowerCase()
          let sameSite = 'Lax'
          if (sameSiteRaw === 'strict') sameSite = 'Strict'
          else if (sameSiteRaw === 'no_restriction' || sameSiteRaw === 'none') sameSite = 'None'
          const expiresRaw = Number(c?.expirationDate)
          const cookie = {
            name,
            value,
            domain: domain || undefined,
            path: pathValue,
            secure,
            httpOnly,
            sameSite
          }
          if (Number.isFinite(expiresRaw) && expiresRaw > 0) cookie.expires = expiresRaw
          if (!cookie.domain) {
            cookie.url = targetUrlForSession
          }
          return cookie
        })
        .filter(Boolean)
      if (mapped.length > 0) {
        await context.addCookies(mapped)
        // #region agent log
        fetch('http://127.0.0.1:7811/ingest/193ceff3-13cc-4a5d-8fcb-570fabc3b13e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'64e698'},body:JSON.stringify({sessionId:'64e698',runId:'pre-fix-auth',hypothesisId:'H3',location:'Runtests.js:runTests:addCookies',message:'Runner added cookies to browser context',data:{mappedCookiesCount:mapped.length,mappedDomains:Array.from(new Set(mapped.map(c=>String(c?.domain||'').toLowerCase()).filter(Boolean))).slice(0,20)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
      }
    } catch (err) {
      testLog(`Session cookie import skipped: ${String(err?.message || err)}`)
      // #region agent log
      fetch('http://127.0.0.1:7811/ingest/193ceff3-13cc-4a5d-8fcb-570fabc3b13e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'64e698'},body:JSON.stringify({sessionId:'64e698',runId:'pre-fix-auth',hypothesisId:'H3',location:'Runtests.js:runTests:addCookies:catch',message:'Runner failed to add cookies',data:{error:String(err?.message||err)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    }
  }
  const results = []
  let hasLoadedOnce = false
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  const useExtensionScreenshots = String(options.screenshotSource || '').toLowerCase() === 'extension'
  const captureAtFailure = async (testCaseId, selectorHints = []) => {
    if (useExtensionScreenshots) return null
    const hints = Array.isArray(selectorHints) ? selectorHints.filter(Boolean) : []
    for (const sel of hints) {
      try {
        // Wait for UI feedback (error/result) before capturing failure state.
        await page.waitForSelector(sel, { state: 'visible', timeout: 1200 })
        break
      } catch {
        // If this selector does not appear, try the next hint and still capture.
      }
    }
    return captureFailureScreenshot(page, projectId, testCaseId)
  }
  const emitProgress = (payload) => {
    if (!onProgress) return
    try {
      onProgress(payload)
    } catch {
      // Ignore progress callback failures to keep test run stable.
    }
  }

  emitProgress({
    phase: 'running_tests',
    message: 'Running tests...',
    total: testCases.length,
    completed: 0
  })

  for (let index = 0; index < testCases.length; index += 1) {
    const tc = testCases[index]
    testLog('─────────────────────────────────────────')
    testLog(`Name: "${tc.name}"`)
    emitProgress({
      phase: 'checking_field',
      message: `Checking field: ${tc.name}...`,
      total: testCases.length,
      completed: index
    })

    try {

      // ── Determine test type ────────────────────────────────────────────────
      // If the test case already has a test_type (AI-generated), use it directly.
      // Only run AI validation for manually added ones (no test_type set).
      let testType = normalizeTestType(tc.test_type)

      const isManualTestCase = !tc.test_type ||
        !SUPPORTED_TEST_TYPES.includes(normalizeTestType(tc.test_type))

      if (isManualTestCase) {
        testLog('Type: manually added — validating with AI...')
        const validation = await validateManualTestCase({
          name: tc.name,
          what_to_test: tc.what_to_test,
          expected_result: tc.expected_result
        })

        if (!validation.valid) {
          const note = `Failed: invalid test case — ${validation.reason}`
          testLog(`RESULT: ✗ Failed — ${validation.reason}`)
          const screenshotPath = await captureAtFailure(tc.id)
          await saveCaseResult(false, note, screenshotPath)
          continue
        }

        testType = validation.test_type
        testLog(`Type (from AI): ${testType}`)
      } else {
        testLog(`Type: ${testType}`)
      }

      // ── Navigate to form ───────────────────────────────────────────────────
      testLog('Step: navigating to form')
      const targetUrl = String(options.overrideUrl || project.form_url || '').trim()
      const loaded = await resetFormPage(page, targetUrl, hasLoadedOnce)
      if (!loaded) {
        const note = 'Failed: page did not load'
        testLog('RESULT: ✗ Failed — page did not load')
        const screenshotPath = await captureAtFailure(tc.id)
        await saveCaseResult(false, note, screenshotPath)
        continue
      }
      hasLoadedOnce = true
      if (index === 0) {
        // #region agent log
        fetch('http://127.0.0.1:7811/ingest/193ceff3-13cc-4a5d-8fcb-570fabc3b13e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'64e698'},body:JSON.stringify({sessionId:'64e698',runId:'pre-fix-auth',hypothesisId:'H4',location:'Runtests.js:runTests:firstNavigation',message:'Runner first loaded URL',data:{currentUrl:page.url()},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
      }

      const scannedRuntimeFields = mapScannedFieldsToRuntime(options.scannedFields || [])
      const liveFields = scannedRuntimeFields.length > 0 ? [] : await discoverLiveFields(page)
      const runtimeFields = mergeFields(KNOWN_FIELDS, [...liveFields, ...scannedRuntimeFields])
      const expectedOutcome = String(tc.expected_outcome || 'should_pass')
      const shouldFailExpected = expectedOutcome === 'should_fail'

      function finalizeByExpected(assertionPassed, baseNotes) {
        const finalPassed = shouldFailExpected ? !assertionPassed : assertionPassed
        let finalNotes = baseNotes
        if (shouldFailExpected) {
          finalNotes += finalPassed
            ? '\nExpected outcome: should_fail (captured as expected).'
            : '\nExpected outcome: should_fail, but form behaved like should_pass.'
        }
        return { finalPassed, finalNotes }
      }

      async function saveCaseResult(assertionPassed, baseNotes, screenshotOverride = null) {
        const { finalPassed, finalNotes } = finalizeByExpected(assertionPassed, baseNotes)
        let notesToSave = finalNotes
        let screenshotPath = screenshotOverride
        if (!finalPassed && !useExtensionScreenshots && screenshotPath) {
          if (screenshotPath) notesToSave = `${notesToSave}\nScreenshot: ${screenshotPath}`
        }
        if (!finalPassed && useExtensionScreenshots) {
          // Tell extension to capture immediately while failed values/errors are still visible.
          emitProgress({
            phase: 'capture_failure',
            message: `Capture failure: ${tc.name}`,
            total: testCases.length,
            completed: index + 1,
            caseResult: { id: tc.id, name: tc.name, passed: false }
          })
          await page.waitForTimeout(1500)
        }
        await db.run(
          "UPDATE test_cases SET status = ?, notes = ? WHERE id = ?",
          finalPassed ? 'Passed' : 'Failed',
          notesToSave,
          tc.id
        )
        results.push({
          id: tc.id,
          name: tc.name,
          passed: finalPassed,
          notes: notesToSave,
          screenshotPath,
          generationReason: tc.generation_reason || ''
        })
        emitProgress({
          phase: 'case_done',
          message: `Finished: ${tc.name}`,
          total: testCases.length,
          completed: index + 1,
          caseResult: { id: tc.id, name: tc.name, passed: finalPassed }
        })
      }

      const onLogin = await isOnLoginPage(page)
      if (onLogin) {
        const note = 'Skipped: Playwright landed on the login page instead of the form. This form requires authentication. Use the extension Run Test button while logged into the portal.'
        testLog('RESULT: Skipped, landed on login page')
        await saveCaseResult(false, note, null)
        continue
      }

      let passed = false
      let notes = ''
      let failureWaitSelectors = []

      // ══════════════════════════════════════════════════════════════════════
      // REQUIRED FIELD
      // What we check: leave ONE specific field empty, fill everything else.
      // Pass: that field's specific error appears AND form did not submit.
      // Fail: form submitted (field not required) OR no error appeared.
      // ══════════════════════════════════════════════════════════════════════
      if (testType === 'required_field') {

        const match = matchFieldFromTestCaseInSet(tc, runtimeFields)
        const targetField = match.field

        if (!targetField) {
          testLog('Step: field mapping failed, running form submit for evidence')
          await fillAllFields(page, runtimeFields)
          await clickSubmit(page).catch(() => {})
          await page.waitForTimeout(300)
          const success = await isVisible(page, '#successMsg')
          const note =
            `Failed: the field named in this test could not be found on the live form, so this check could not be executed reliably. Form submission success was: ${success}.`
          testLog('RESULT: ✗ Failed — field not found on form')
          const screenshotPath = await captureAtFailure(tc.id)
          await saveCaseResult(false, note, screenshotPath)
          continue
        }
        if (match.confidence === 'low') {
          const note =
            `Failed: the runner could not confidently match this test case to one field on the live form. Best guess was "${match.matchedLabel || 'unknown'}", which is too uncertain. Please make the field name clearer in "What to test".`
          testLog('RESULT: ✗ Failed — low-confidence field mapping')
          const screenshotPath = await captureAtFailure(tc.id)
          await saveCaseResult(false, note, screenshotPath)
          continue
        }

        const targetType = normalizeType(targetField.type)
        const targetLabelNorm = toNormalizedText(targetField.label || '')
        testLog(`Step: filling all fields except "${targetField.label}"`)
        await fillAllFields(page, runtimeFields, {
          excludeSelectors: [targetField.selector],
          excludeNames: targetField.name ? [targetField.name] : [],
          excludePredicate: (f) => {
            const fType = normalizeType(f?.type)
            if (targetType === 'radio' && fType === 'radio') {
              const sameName = Boolean(targetField.name) && String(f?.name || '') === String(targetField.name)
              const sameLabel = toNormalizedText(f?.label || '') === targetLabelNorm
              return sameName || sameLabel
            }
            return false
          }
        })
        await clearField(page, targetField)

        testLog('Step: clicking submit')
        await clickSubmit(page)
        await waitForPostSubmitSignals(page, ['#successMsg', targetField.errorSelector, targetField.selector], 1500)

        testLog('Step: checking results')
          const [fieldError, success] = await Promise.all([
          targetField.errorSelector ? isVisible(page, targetField.errorSelector) : Promise.resolve(false),
          isVisible(page, '#successMsg')
        ])
        const visibleMessages = await collectVisibleValidationMessages(page)
        const invalidState = await detectFieldInvalidState(page, targetField)
        const evidence = evaluateValidationEvidence({
          expectedText: tc.expected_result,
          field: targetField,
          visibleMessages,
          fieldError,
          invalidState
        })

        testLog(`"${targetField.label}" error visible: ${fieldError}`)
        testLog(`Success visible: ${success}`)

        // Required-field pass must be tied to target field evidence, not unrelated page errors.
        passed = success === false && evidence.hasEvidence

        if (passed) {
          notes = `Passed: when "${targetField.label}" was left empty, the form blocked submission and showed a validation message.`
          const shownMessage = evidence.bestMessage || visibleMessages[0] || ''
          if (shownMessage) {
            notes += `\nValidation shown: "${shownMessage}"`
          } else {
            notes += '\nValidation shown: (no readable message text captured)'
          }
          testLog(`RESULT: ✓ Passed`)
        } else if (success === true) {
          notes = `Failed: "${targetField.label}" was left empty, but the form still submitted. This means required validation did not block submission as expected.`
          testLog(`RESULT: ✗ Failed — form submitted with empty "${targetField.label}"`)
          failureWaitSelectors = [targetField.errorSelector, targetField.selector, '#successMsg']
        } else {
          notes = `Failed: "${targetField.label}" was left empty and the form did not submit, but no clear validation message could be matched to the expected result.`
          if (visibleMessages.length) notes += `\nVisible validation text: ${visibleMessages.map(m => `"${m}"`).join(' | ')}`
          testLog(`RESULT: ✗ Failed — no error appeared for "${targetField.label}"`)
          failureWaitSelectors = [targetField.errorSelector, targetField.selector]
        }
      }

      // ══════════════════════════════════════════════════════════════════════
      // FORMAT VALIDATION
      // What we check: fill everything correctly, then put wrong format in one field.
      // Pass: format error appears AND form did not submit.
      // Fail: form submitted (no format check) OR no error appeared.
      // ══════════════════════════════════════════════════════════════════════
      else if (testType === 'format_validation') {

        const match = matchFieldFromTestCaseInSet(tc, runtimeFields)
        const targetField = match.field

        if (!targetField) {
          testLog('Step: field mapping failed, running form submit for evidence')
          await fillAllFields(page, runtimeFields)
          await clickSubmit(page).catch(() => {})
          await page.waitForTimeout(300)
          const success = await isVisible(page, '#successMsg')
          const note =
            `Failed: the field named in this test could not be found on the live form, so this format check could not be executed reliably. Form submission success was: ${success}.`
          testLog('RESULT: ✗ Failed — field not found on form')
          const screenshotPath = await captureAtFailure(tc.id)
          await saveCaseResult(false, note, screenshotPath)
          continue
        }
        if (match.confidence === 'low') {
          const note =
            `Failed: the runner could not confidently match this format test to one field on the live form. Best guess was "${match.matchedLabel || 'unknown'}", which is too uncertain. Please make the field name clearer in "What to test".`
          testLog('RESULT: ✗ Failed — low-confidence field mapping')
          const screenshotPath = await captureAtFailure(tc.id)
          await saveCaseResult(false, note, screenshotPath)
          continue
        }

        let invalidVal = guessInvalidValue(targetField)
        invalidVal = deriveInvalidValueForTestCase(tc, targetField, invalidVal)
        let formatErrorSelector = targetField.formatErrorSelector || targetField.errorSelector

        if (targetField.type === 'date') {
          const dobPlan = resolveDobFormatValidation(tc)
          if (dobPlan) {
            invalidVal = dobPlan.invalidVal
            formatErrorSelector = dobPlan.formatErrorSelector
          } else {
            const note =
              "Failed: Date format-validation case is not executable from this wording. Use explicit age/date-range wording (for example under-18, minimum date, or maximum date) so the runner can verify a real rule."
            testLog('RESULT: ✗ Failed — DOB format case not executable from current wording')
            const screenshotPath = await captureAtFailure(tc.id, [formatErrorSelector, targetField.selector])
            await saveCaseResult(false, note, screenshotPath)
            continue
          }
        }

        testLog(`Step: filling all fields, then setting invalid value for "${targetField.label}": "${invalidVal}"`)
        await fillAllFields(page, runtimeFields)

        if (targetField.type === 'select' || targetField.type === 'radio' || targetField.type === 'checkbox') {
          const combined = `${tc.what_to_test || ''} ${tc.expected_result || ''}`.toLowerCase()
          const expectsNoError =
            /no error|without error|should pass|valid|accepted|does not show/i.test(combined)

          if (expectsNoError) {
            testLog(`Step: option-field validation for "${targetField.label}" (expecting no error)`)
            await clickSubmit(page).catch(() => {})
            await waitForPostSubmitSignals(page, ['#successMsg', targetField.errorSelector], 1200)
            const [fieldError, success] = await Promise.all([
              targetField.errorSelector ? isVisible(page, targetField.errorSelector) : Promise.resolve(false),
              isVisible(page, '#successMsg')
            ])
            passed = fieldError === false
            if (passed) {
              notes = `Passed: "${targetField.label}" used a valid option and no validation message appeared, which matches the expected behavior.`
              testLog('RESULT: ✓ Passed — valid option accepted without error')
            } else {
              notes = `Failed: "${targetField.label}" used a valid option, but a validation message still appeared.`
              testLog('RESULT: ✗ Failed — unexpected validation error for valid option')
              failureWaitSelectors = [targetField.errorSelector, targetField.selector, '#successMsg']
            }
            // Keep success signal in notes for troubleshooting without forcing it.
            notes += success ? '\nSubmission signal: success message visible.' : '\nSubmission signal: success message not visible.'
            // Skip default text-input format path for option fields.
            invalidVal = null
          } else {
            const note = `Failed: format_validation test type is not executable for option field "${targetField.label}". Use conditional or required behavior wording for this field.`
            testLog('RESULT: ✗ Failed — format_validation not executable for option field')
            const screenshotPath = await captureAtFailure(tc.id, [targetField.selector])
            await saveCaseResult(false, note, screenshotPath)
            continue
          }
        } else {
          await page.locator(targetField.selector).first().fill(invalidVal, { timeout: 700 }).catch(() => {})
        }

        if (invalidVal === null && (targetField.type === 'select' || targetField.type === 'radio' || targetField.type === 'checkbox')) {
          // Option-field path already evaluated and saved in passed/notes.
          // Do not run generic format submit assertions below.
        } else {

          testLog('Step: clicking submit')
          await clickSubmit(page)
          await waitForPostSubmitSignals(page, ['#successMsg', formatErrorSelector, targetField.errorSelector], 1200)

          testLog('Step: checking results')
          const [formatError, success] = await Promise.all([
            formatErrorSelector ? isVisible(page, formatErrorSelector) : Promise.resolve(false),
            isVisible(page, '#successMsg')
          ])
          const visibleMessages = await collectVisibleValidationMessages(page)
          const invalidState = await detectFieldInvalidState(page, targetField)
          const evidence = evaluateValidationEvidence({
            expectedText: tc.expected_result,
            field: targetField,
            visibleMessages,
            fieldError: formatError,
            invalidState
          })

          testLog(`Format error for "${targetField.label}" visible: ${formatError}`)
          testLog(`Success visible: ${success}`)

          // If there is no known format error selector, fallback to "did not submit".
          passed = success === false && evidence.hasEvidence

          if (passed) {
            notes =
              targetField.type === 'date' && formatErrorSelector === '#dobAgeError'
                ? `Passed: Date of Birth rejected the minor date "${invalidVal}" and showed the age restriction message.`
                : `Passed: "${targetField.label}" rejected invalid input "${invalidVal}" and prevented successful submission.`
            if (evidence.bestMessage) notes += `\nValidation shown: "${evidence.bestMessage}"`
            testLog(`RESULT: ✓ Passed`)
          } else if (success === true) {
            notes = `Failed: "${targetField.label}" accepted invalid input "${invalidVal}" and the form submitted successfully.`
            testLog(`RESULT: ✗ Failed — form accepted invalid value for "${targetField.label}"`)
            failureWaitSelectors = [formatErrorSelector, targetField.errorSelector, targetField.selector, '#successMsg']
          } else {
            notes = `Failed: "${targetField.label}" used invalid input "${invalidVal}", but no clear validation message appeared for that field.`
            if (visibleMessages.length) notes += `\nVisible validation text: ${visibleMessages.map(m => `"${m}"`).join(' | ')}`
            testLog(`RESULT: ✗ Failed — no format error for "${targetField.label}"`)
            failureWaitSelectors = [formatErrorSelector, targetField.errorSelector, targetField.selector]
          }
        }
      }

      // ══════════════════════════════════════════════════════════════════════
      // SUCCESSFUL SUBMIT
      // What we check: fill everything correctly and submit.
      // Pass: success message appears AND no errors appear.
      // Fail: any error appears OR success does not appear.
      // ══════════════════════════════════════════════════════════════════════
      else if (testType === 'successful_submit') {

        testLog('Step: filling all fields with valid values')
        await fillAllFields(page, runtimeFields)

        testLog('Step: clicking submit')
        await clickSubmit(page)
        const checkSelectors = ['#successMsg', ...runtimeFields.map(f => f?.errorSelector).filter(Boolean)]
        await waitForPostSubmitSignals(page, checkSelectors, 1400)

        testLog('Step: checking results')
        const success = await isVisible(page, '#successMsg')

        // Check if any field errors appeared
        let anyError = false
        for (const f of runtimeFields) {
          if (f.optional || !f.errorSelector) continue
          if (await isVisible(page, f.errorSelector)) {
            anyError = true
            testLog(`Error visible: ${f.errorSelector}`)
            break
          }
        }

        testLog(`Success visible: ${success}`)
        testLog(`Any error visible: ${anyError}`)

        // STRICT: pass only if success appeared AND no errors appeared
        passed = success === true && anyError === false

        if (passed) {
          notes = 'Passed: form submitted successfully with all valid values and no errors appeared.'
          testLog('RESULT: ✓ Passed')
        } else if (anyError) {
          notes = 'Failed: errors appeared even though all fields were filled correctly. The form has a validation problem.'
          testLog('RESULT: ✗ Failed — errors appeared after valid submission')
        } else {
          notes = 'Failed: success message did not appear after submitting valid data. The form may not be submitting correctly.'
          testLog('RESULT: ✗ Failed — no success message appeared')
        }
      }

      // CONDITIONAL FIELD — visibility (per expected_result / what_to_test) then required-if-visible
      else if (testType === 'conditional_field') {
        const match = matchFieldFromTestCaseInSet(tc, runtimeFields)
        const targetField = match.field
        if (!targetField) {
          const note = 'Failed: could not identify the conditional target field on the live form.'
          const screenshotPath = await captureAtFailure(tc.id)
          await saveCaseResult(false, note, screenshotPath)
          continue
        }

        const conditionValue = detectConditionValueToken(tc)
        const controllerField = findConditionControllerField(tc, runtimeFields)
        const targetType = normalizeType(targetField.type)
        const targetLabelNorm = toNormalizedText(targetField.label || '')
        await fillAllFields(page, runtimeFields, {
          excludeSelectors: [targetField.selector],
          excludeNames: targetField.name ? [targetField.name] : [],
          excludePredicate: (f) => {
            const fType = normalizeType(f?.type)
            if (targetType === 'radio' && fType === 'radio') {
              const sameName = Boolean(targetField.name) && String(f?.name || '') === String(targetField.name)
              const sameLabel = toNormalizedText(f?.label || '') === targetLabelNorm
              return sameName || sameLabel
            }
            return false
          }
        })
        await applyConditionValue(page, controllerField, conditionValue)
        await page.waitForTimeout(500)

        const probe = `${tc.what_to_test || ''} ${tc.expected_result || ''}`.toLowerCase()
        const expectsHidden = /not\s+appear|does\s+not\s+appear|hidden|hide|not\s+visible|not\s+displayed|not\s+shown|displayed\s*:\s*no|is\s+displayed\s*:\s*no/i.test(probe)
        const visible = await isVisible(page, targetField.selector)

        if (expectsHidden) {
          passed = !visible
          if (passed) {
            notes = `Passed: "${targetField.label}" stayed hidden after applying the condition as expected.`
          } else {
            notes = `Failed: "${targetField.label}" appeared, but it was expected to stay hidden for this condition.`
            failureWaitSelectors = [targetField.selector]
          }
        } else {
          if (!visible) {
            passed = false
            notes = `Failed: "${targetField.label}" did not appear after applying the condition (cannot assert required behaviour).`
            failureWaitSelectors = [targetField.selector]
          } else {
            await clearField(page, targetField)
            await clickSubmit(page).catch(() => {})
            await waitForPostSubmitSignals(page, ['#successMsg', targetField.errorSelector, targetField.selector], 1400)

            const [fieldError, success] = await Promise.all([
              targetField.errorSelector ? isVisible(page, targetField.errorSelector) : Promise.resolve(false),
              isVisible(page, '#successMsg')
            ])
            const visibleMessages = await collectVisibleValidationMessages(page)
            const invalidState = await detectFieldInvalidState(page, targetField)
            const evidence = evaluateValidationEvidence({
              expectedText: tc.expected_result,
              field: targetField,
              visibleMessages,
              fieldError,
              invalidState
            })
            passed = success === false && evidence.hasEvidence

            if (passed) {
              notes = `Passed: "${targetField.label}" is visible after the condition, and leaving it empty correctly triggered validation.`
              if (evidence.bestMessage) notes += `\nValidation shown: "${evidence.bestMessage}"`
            } else {
              notes = `Failed: conditional field "${targetField.label}" was visible but required validation was not enforced as expected.`
              if (visibleMessages.length) notes += `\nVisible validation text: ${visibleMessages.map(m => `"${m}"`).join(' | ')}`
              failureWaitSelectors = [targetField.errorSelector, targetField.selector, '#successMsg']
            }
          }
        }
      }

      else if (testType === 'label_check') {
        const match = matchFieldFromTestCaseInSet(tc, runtimeFields)
        const targetField = match.field
        if (!targetField) {
          const note = 'Failed: could not identify the field for label_check.'
          const screenshotPath = await captureAtFailure(tc.id)
          await saveCaseResult(false, note, screenshotPath)
          continue
        }
        const check = await page.locator(targetField.selector).first().evaluate((el) => {
          const id = el.id || ''
          let label = ''
          if (id) {
            const byFor = document.querySelector(`label[for="${id}"]`)
            if (byFor?.textContent?.trim()) label = byFor.textContent.trim()
          }
          if (!label) {
            const wrapped = el.closest('label')
            if (wrapped?.textContent?.trim()) label = wrapped.textContent.trim()
          }
          const placeholder = String(el.getAttribute('placeholder') || '').trim()
          return { label, placeholder }
        })
        const expected = String(tc.expected_result || tc.what_to_test || '')
        const expLabel = (expected.match(/label:\s*"([^"]*)"/i)?.[1] || '').trim()
        const expPlaceholder = (expected.match(/placeholder:\s*"([^"]*)"/i)?.[1] || '').trim()
        const labelOk = expLabel ? check.label === expLabel : Boolean(check.label)
        const placeholderOk = expPlaceholder ? check.placeholder === expPlaceholder : true
        passed = labelOk && placeholderOk
        notes = passed
          ? `Passed: label_check matched for "${targetField.label}".`
          : `Failed: label_check mismatch. Expected label "${expLabel}" placeholder "${expPlaceholder}", got label "${check.label}" placeholder "${check.placeholder}".`
      }

      else if (testType === 'widget_auto_fill') {
        const match = matchFieldFromTestCaseInSet(tc, runtimeFields)
        const sourceField = match.field || runtimeFields.find((f) => {
          const label = String(f?.label || '').toLowerCase()
          const name = String(f?.name || '').toLowerCase()
          return label.includes('id number') || name.includes('id')
        })

        if (!sourceField) {
          const note = 'Failed: could not identify the widget source field for auto-fill validation.'
          const screenshotPath = await captureAtFailure(tc.id)
          await saveCaseResult(false, note, screenshotPath)
          continue
        }

        const targetCandidates = runtimeFields.filter((f) => {
          if (!f?.selector || f.selector === sourceField.selector) return false
          const label = String(f?.label || '').toLowerCase()
          const name = String(f?.name || '').toLowerCase()
          return (
            label.includes('first name') ||
            label.includes('last name') ||
            label.includes('gender') ||
            label.includes('date of birth') ||
            label.includes('nationality') ||
            name.includes('first') ||
            name.includes('last') ||
            name.includes('gender') ||
            name.includes('birth') ||
            name.includes('nation')
          )
        })

        await fillAllFields(page, runtimeFields)
        for (const t of targetCandidates) {
          await clearField(page, t)
        }
        await page.locator(sourceField.selector).first().fill(guessValidValue(sourceField), { timeout: 900 }).catch(() => {})
        await page.waitForTimeout(700)

        let populatedCount = 0
        for (const t of targetCandidates) {
          try {
            const val = await page.locator(t.selector).first().inputValue({ timeout: 400 })
            if (String(val || '').trim()) populatedCount += 1
          } catch {
            // Non-text targets can still be considered populated if visible and checked/selected.
            try {
              const checked = await page.locator(t.selector).first().isChecked({ timeout: 300 })
              if (checked) populatedCount += 1
            } catch { /* ignore */ }
          }
        }
        passed = populatedCount > 0
        if (passed) {
          notes = `Passed: entering a valid value in "${sourceField.label}" auto-populated ${populatedCount} dependent field(s).`
        } else {
          notes = `Failed: entering a valid value in "${sourceField.label}" did not auto-populate the expected dependent fields.`
          failureWaitSelectors = [sourceField.selector, ...targetCandidates.map(f => f.selector)]
        }
      }

      else if (testType === 'attachment') {
        const targetField = findAttachmentField(tc, runtimeFields)
        if (!targetField) {
          const note = 'Failed: could not identify the attachment field for this test case.'
          const screenshotPath = await captureAtFailure(tc.id)
          await saveCaseResult(false, note, screenshotPath)
          continue
        }

        const kind = detectAttachmentCaseKind(tc)
        const fixtures = buildAttachmentFixtures(projectId)
        await fillAllFields(page, runtimeFields, { excludeSelectors: [targetField.selector] })

        if (kind === 'invalid_format') {
          await page.locator(targetField.selector).first().setInputFiles(fixtures.invalidFormatPath).catch(() => {})
        } else if (kind === 'size_limit') {
          await page.locator(targetField.selector).first().setInputFiles(fixtures.oversizedPdfPath).catch(() => {})
        }

        await clickSubmit(page).catch(() => {})
        await waitForPostSubmitSignals(page, ['#successMsg', targetField.errorSelector, targetField.selector], 1400)

        const success = await isVisible(page, '#successMsg')
        const fieldError = targetField.errorSelector ? await isVisible(page, targetField.errorSelector) : false
        passed = success === false || fieldError === true
        if (passed) {
          if (kind === 'required') {
            notes = `Passed: attachment validation blocked submission when "${targetField.label}" was left empty.`
          } else if (kind === 'invalid_format') {
            notes = `Passed: attachment validation rejected invalid file format for "${targetField.label}".`
          } else {
            notes = `Passed: attachment validation rejected oversized file for "${targetField.label}".`
          }
        } else {
          if (kind === 'required') {
            notes = `Failed: form submitted even though required attachment "${targetField.label}" was not provided.`
          } else if (kind === 'invalid_format') {
            notes = `Failed: form accepted an invalid file format for "${targetField.label}".`
          } else {
            notes = `Failed: form accepted an oversized file for "${targetField.label}".`
          }
          failureWaitSelectors = [targetField.errorSelector, targetField.selector, '#successMsg']
        }
      }

      else {
        const note = `Failed: unknown test type "${testType}".`
        testLog(`RESULT: ✗ Failed — ${note}`)
        const screenshotPath = await captureAtFailure(tc.id)
        await saveCaseResult(false, note, screenshotPath)
        continue
      }

      // Save result
      let failureScreenshotPath = null
      if (!passed) {
        // Capture exactly at failure state before next test navigates away.
        failureScreenshotPath = await captureAtFailure(tc.id, failureWaitSelectors)
      }
      await saveCaseResult(passed, notes, failureScreenshotPath)
      emitProgress({
        phase: 'running_tests',
        message: 'Running tests...',
        total: testCases.length,
        completed: index + 1
      })

      if (testType === 'successful_submit' && passed) {
        const skipNote =
          'Skipped: successful submit completed earlier in this run — case not executed (results page may differ from the form).'
        for (let j = index + 1; j < testCases.length; j += 1) {
          const rest = testCases[j]
          await db.run('UPDATE test_cases SET status = ?, notes = ? WHERE id = ?', 'Skipped', skipNote, rest.id)
          results.push({
            id: rest.id,
            name: rest.name,
            passed: false,
            notes: skipNote,
            screenshotPath: null,
            generationReason: rest.generation_reason || ''
          })
        }
        emitProgress({
          phase: 'running_tests',
          message: `Stopping after successful submit (${testCases.length - index - 1} case(s) skipped).`,
          total: testCases.length,
          completed: testCases.length
        })
        break
      }

    } catch (err) {
      const note = `Failed: runtime error — ${String(err?.message || 'Unknown error')}`
      testLog(`RESULT: ✗ Failed — ${note}`)
      const screenshotPath = await captureAtFailure(tc.id)
      const noteWithShot = screenshotPath ? `${note}\nScreenshot: ${screenshotPath}` : note
      await db.run("UPDATE test_cases SET status = ?, notes = ? WHERE id = ?", 'Failed', noteWithShot, tc.id)
      results.push({
        id: tc.id,
        name: tc.name,
        passed: false,
        notes: noteWithShot,
        screenshotPath,
        generationReason: tc.generation_reason || ''
      })
      emitProgress({
        phase: 'case_done',
        message: `Finished: ${tc.name}`,
        total: testCases.length,
        completed: index + 1,
        caseResult: { id: tc.id, name: tc.name, passed: false }
      })
      emitProgress({
        phase: 'running_tests',
        message: 'Running tests...',
        total: testCases.length,
        completed: index + 1
      })
    }

    testLog('─────────────────────────────────────────')
  }

  await browser.close()

  const skippedRow = (r) => /^skipped:/i.test(String(r.notes || '').trim())
  const allPassed = results.length > 0 && results.every(r => r.passed || skippedRow(r))
  const anyFailed = results.some(r => !r.passed && !skippedRow(r))
  const newStatus = allPassed ? 'Passed' : anyFailed ? 'Failed' : 'In Progress'

  await db.run("UPDATE projects SET status = ?, last_tested = datetime('now') WHERE id = ?", newStatus, projectId)

  return results
}

export default runTests