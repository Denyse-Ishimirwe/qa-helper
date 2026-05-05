import Groq from 'groq-sdk'
import 'dotenv/config'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

/** Primary model (large). Override with GROQ_MODEL. */
const GROQ_PRIMARY_MODEL = (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim()
/**
 * Used automatically when the primary model returns 429 (e.g. daily token cap).
 * Smaller models have separate limits on Groq. Override with GROQ_FALLBACK_MODEL or set to '' to disable.
 */
const GROQ_FALLBACK_MODEL = String(process.env.GROQ_FALLBACK_MODEL ?? 'llama-3.1-8b-instant').trim()

/** Generic head+tail truncation (form JSON, etc.). */
function trimWithHeadTail(text, maxChars) {
  const raw = String(text || '')
  if (raw.length <= maxChars) return raw
  const head = Math.max(1000, Math.floor(maxChars * 0.66))
  const tail = Math.max(700, maxChars - head)
  return `${raw.slice(0, head)}\n\n[... truncated ...]\n\n${raw.slice(-tail)}`
}

/**
 * SRD validation tables often sit in the middle of the document. Plain head+tail drops them.
 * This keeps start + end + rule-heavy paragraphs in the middle up to midBudget.
 */
function trimSrdForPrompt(text, maxChars) {
  const raw = String(text || '')
  if (raw.length <= maxChars) return raw

  const reserve = 280
  const headN = Math.min(Math.floor(maxChars * 0.34), 24000)
  const tailN = Math.min(Math.floor(maxChars * 0.3), 24000)
  let midBudget = maxChars - headN - tailN - reserve
  if (midBudget < 2000) {
    return trimWithHeadTail(text, maxChars)
  }

  const head = raw.slice(0, headN)
  const tail = raw.slice(-tailN)
  const ruleHint =
    /\b(validation|verif|incorrect|error|message|required|mandatory|format|invalid|min\.|max\.|length|pattern|regex|attachment|upload|file|size|mb|kb|conditional|when\b|if\b|visible|hidden|displayed|success|confirm|widget|auto[\s-]?fill|national\s*id|\bnin\b|annex|appendix|table|rule|criteria)\b/i

  const chunks = raw.split(/\n{2,}/)
  const ranked = chunks
    .map((c) => c.trim())
    .filter((c) => c.length > 30 && ruleHint.test(c.slice(0, 4000)))
    .sort((a, b) => b.length - a.length)

  const seen = new Set()
  const parts = []
  let used = 0
  for (const c of ranked) {
    const snippet = c.length > 4000 ? `${c.slice(0, 4000)}\n[…]` : c
    const key = snippet.slice(0, 160)
    if (seen.has(key)) continue
    seen.add(key)
    if (used + snippet.length + 2 > midBudget) break
    parts.push(snippet)
    used += snippet.length + 2
  }

  let mid = parts.join('\n\n')
  if (mid.length < 500) {
    const startMid = Math.max(headN, Math.floor(raw.length / 2) - Math.floor(midBudget / 2))
    mid = raw.slice(startMid, startMid + midBudget)
  }

  return `${head}\n\n[--- SRD excerpts: validation, errors, rules, tables ---]\n\n${mid}\n\n[--- end excerpts ---]\n\n${tail}`
}

/**
 * System message: rules stay separate from the SRD so the model does not ignore them.
 * User message is almost entirely the document + form JSON.
 */
const GENERATE_TEST_CASES_SYSTEM = `You output ONLY a JSON array of test case objects. No markdown fences, no commentary before or after.

You must base every test case ONLY on the Requirements document (SRD) in the user message and optional form-structure JSON there.

ANTI-HALLUCINATION (highest priority):
— Do NOT invent validation rules, error messages, field labels, conditional behaviour, or success text. Every test must trace to something explicitly stated in the SRD (tables, annexes, bullets, quoted strings).
— If the SRD does not mention an attachment field, widget auto-fill, or conditional rule, do NOT generate that test_type for it.
— For expected_result: paste the exact user-visible message from the SRD when the document provides it. If the SRD only describes the rule in prose, quote that prose and add "(SRD section/table reference)" — never fabricate UI copy.
— Prefer fewer faithful tests over many vague ones. Never pad the array.

HOW TO READ THE SRD:
PASS A — Inventory: fields, validation rules, conditionals, attachments, widgets, submit/success.
PASS B — Messages verbatim into expected_result when the SRD gives exact wording.
PASS C — One distinct rule → one test case.
PASS D — If form JSON exists, align field names; still only test what the SRD authorizes.
PASS E — Add a test only for an explicitly documented rule; no filler.

REQUIRED PRODUCT STYLE (follow this layout so tests match the QA template — SRD text always wins when it differs):
Use concise English. Field labels in names and sentences must match the SRD / form (same spelling and capitalization as the form).

name (title pattern):
— Mandatory field empty test: "{FieldLabel} Required Field Test"  (e.g. First Name Required Field Test)
— SRD-optional field empty test: "{FieldLabel} Optional Field Test"
— Single format rule: "{FieldLabel} {RuleShortName} Test"  (e.g. Date of Birth Age Restriction Test)
— Visibility-only check: "{FieldLabel} Conditional Display Test"
— Submit: "Successful Submit Test"

what_to_test (one clear sentence; short — NOT long numbered steps unless the SRD requires a cascade chain):
— Required empty: "Leaving {FieldLabel} field empty"
— Optional empty (expect no error): same leaving-empty wording; pair with name "... Optional Field Test" and expected_result "No error message"
— Parent + required empty: "Selecting '{Value}' on {ParentFieldLabel} field and leaving {TargetFieldLabel} field empty"
— Parent + visibility check: "Selecting '{Value}' on {ParentFieldLabel} field and checking if {TargetFieldLabel} field appears"
— Format / rule: "Entering …" describing the invalid input in plain English (e.g. date below minimum age)
— Successful submit: "Filling out all required fields and submitting the form"

expected_result:
— Prefer exact user-visible strings from the SRD; if the exemplar uses short canonical phrases ("First name is required", "District is required") and the SRD matches that meaning, you may use that style.
— Optional-field negative test: "No error message"
— Visibility: "{FieldLabel} field appears" (or exact SRD wording)
— Submit: "Form is submitted successfully" or exact success message from SRD

conditional_field / widget_auto_fill / attachment / label_check: still use this short name + what_to_test style where possible; for strict automation, conditional_field may use expected_result format Displayed: Yes; Required: Yes; Validation: "…" when the SRD requires combined visibility + required checks.

General:
— Never placeholders only ("Required error", "See SRD").
— Never disabled_field type.
— Widget flows (e.g. ID type before ID number): reflect SRD order inside what_to_test in the same short sentence style.

Output schema per element:
{ "name": string, "what_to_test": string, "expected_result": string, "test_type": "required_field"|"format_validation"|"successful_submit"|"conditional_field"|"widget_auto_fill"|"attachment"|"label_check" }

STYLE EXEMPLAR (structure only — replace with real SRD fields and messages):
[
  {"name":"First Name Required Field Test","what_to_test":"Leaving First Name field empty","expected_result":"First name is required","test_type":"required_field"},
  {"name":"Last Name Optional Field Test","what_to_test":"Leaving Last Name field empty","expected_result":"No error message","test_type":"required_field"},
  {"name":"Date of Birth Age Restriction Test","what_to_test":"Entering a date of birth that is below 18 years old","expected_result":"Must be above 18 years old","test_type":"format_validation"},
  {"name":"District Required Field Test","what_to_test":"Selecting 'Yes' on Live in Rwanda? field and leaving District field empty","expected_result":"District is required","test_type":"required_field"},
  {"name":"District Conditional Display Test","what_to_test":"Selecting 'Yes' on Live in Rwanda? field and checking if District field appears","expected_result":"District field appears","test_type":"required_field"},
  {"name":"Successful Submit Test","what_to_test":"Filling out all required fields and submitting the form","expected_result":"Form is submitted successfully","test_type":"successful_submit"}
]`

function groqApiMessage(err) {
  const e = err?.error ?? err?.response?.data?.error ?? err?.body?.error
  if (typeof e === 'string') {
    try {
      const j = JSON.parse(e)
      return String(j?.error?.message || j?.message || e)
    } catch {
      return e
    }
  }
  if (e && typeof e === 'object') return String(e.message || e.error || JSON.stringify(e))
  return String(err?.message || err || '')
}

function isGroqRateLimitError(err) {
  const status = err?.status ?? err?.response?.status ?? err?.statusCode
  const msg = groqApiMessage(err)
  if (status === 429) return true
  if (/rate[_\s]?limit|429|tokens per day|TPD/i.test(msg)) return true
  return false
}

function humanizeGroqRateLimit(apiMessage) {
  const msg = String(apiMessage || '')
  const m = msg.match(/try again in\s+(\d+)m\s*([\d.]+)\s*s/i)
  if (m) {
    const mins = parseInt(m[1], 10)
    const secs = Math.min(59, Math.ceil(parseFloat(m[2], 10)))
    return `Groq rate limit (daily tokens for this model). Try again in about ${mins}m ${secs}s, or retry now using a smaller model: set GROQ_FALLBACK_MODEL (default: llama-3.1-8b-instant). Upgrade: https://console.groq.com/settings/billing`
  }
  if (/try again in/i.test(msg)) {
    return `Groq rate limit. ${msg.slice(0, 280)}`
  }
  return `Groq rate limit or quota issue. ${msg.slice(0, 280)}`
}

function isGroqRequestTooLargeError(err) {
  const status = err?.status ?? err?.response?.status ?? err?.statusCode
  const msg = String(groqApiMessage(err) || err?.message || '')
  if (status === 413) return true
  if (/request too large/i.test(msg)) return true
  if (/tokens per minute|TPM/i.test(msg)) return true
  if (/limit\s+\d+.*requested\s+\d+/i.test(msg)) return true
  return false
}

function extractFirstJsonArrayBlock(text) {
  const s = String(text || '').trim()
  if (!s) return ''
  const codeFence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = codeFence?.[1] ? String(codeFence[1]).trim() : s
  const start = candidate.indexOf('[')
  if (start < 0) return ''
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i]
    if (inStr) {
      if (esc) {
        esc = false
      } else if (ch === '\\') {
        esc = true
      } else if (ch === '"') {
        inStr = false
      }
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '[') depth += 1
    if (ch === ']') {
      depth -= 1
      if (depth === 0) return candidate.slice(start, i + 1)
    }
  }
  return ''
}

function parseJsonArrayOrThrow(rawText) {
  const raw = String(rawText || '').trim()
  if (!raw) return []
  const cleaned = raw.replace(/```json|```/gi, '').trim()
  try {
    const parsed = JSON.parse(cleaned)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    const extracted = extractFirstJsonArrayBlock(raw)
    if (!extracted) {
      throw new Error(`AI returned non-JSON output: ${raw.slice(0, 120)}`)
    }
    const parsed = JSON.parse(extracted)
    return Array.isArray(parsed) ? parsed : []
  }
}

async function repairResponseToJsonArray(rawText) {
  const raw = String(rawText || '').trim()
  if (!raw) return []
  const completion = await groqChatCompletionsCreate({
    model: GROQ_PRIMARY_MODEL,
    temperature: 0,
    max_tokens: 8192,
    messages: [
      {
        role: 'system',
        content: `Convert broken model output into a valid JSON array only. Schema per item: name, what_to_test, expected_result, test_type.
Preserve every test case and all SRD-quoted text exactly; do not invent new rules or messages.
Keep what_to_test as numbered steps when present. Output ONLY JSON, no markdown.`
      },
      {
        role: 'user',
        content: `Input to repair into one JSON array:\n\n${raw}`
      }
    ]
  })
  const repaired = completion.choices?.[0]?.message?.content || '[]'
  return parseJsonArrayOrThrow(repaired)
}

/** @param {Record<string, unknown>} payload */
async function groqChatCompletionsCreate(payload) {
  const preferred = (payload.model || GROQ_PRIMARY_MODEL).trim()
  const fallback = GROQ_FALLBACK_MODEL && GROQ_FALLBACK_MODEL !== preferred ? GROQ_FALLBACK_MODEL : ''

  try {
    return await groq.chat.completions.create({ ...payload, model: preferred })
  } catch (err) {
    if (!isGroqRateLimitError(err)) throw err
    const primaryMsg = groqApiMessage(err)
    if (!fallback) {
      throw new Error(humanizeGroqRateLimit(primaryMsg))
    }
    try {
      return await groq.chat.completions.create({ ...payload, model: fallback })
    } catch (err2) {
      if (!isGroqRateLimitError(err2)) throw err2
      throw new Error(
        `${humanizeGroqRateLimit(groqApiMessage(err2))} (fallback model ${fallback} is also limited.)`
      )
    }
  }
}

async function generateTestCases(srdText, formStructure) {
  function compactStructureForPrompt(structure, maxChars) {
    if (!structure) return ''
    const asText = typeof structure === 'string' ? structure : JSON.stringify(structure)
    return trimWithHeadTail(asText, maxChars)
  }

  function getStructureFields(structure) {
    if (Array.isArray(structure)) return structure
    if (Array.isArray(structure?.fields)) return structure.fields
    return []
  }

  function buildCoverageCases(baseCases) {
    const fields = getStructureFields(formStructure)
    if (!fields.length) return baseCases

    const out = [...baseCases]
    const hasSuccessful = out.some(tc => tc.test_type === 'successful_submit')
    if (!hasSuccessful) {
      out.push({
        name: 'Successful Submit Test',
        what_to_test: 'Filling out all required fields and submitting the form',
        expected_result:
          'Form is submitted successfully (use exact success or confirmation wording from the SRD when the document provides it).',
        test_type: 'successful_submit'
      })
    }

    // Do not synthesize required_field / format_validation rows here — those must come from the SRD via the model
    // so expected_result always carries real messages and rules, not generic placeholders.

    return out
  }

  /** Collapse punctuation / spacing so near-identical LLM rows dedupe as one. */
  function normalizeDedupeText(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[''`´""]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function dedupeCases(list) {
    const seenPrimary = new Set()
    const seenSecondary = new Set()
    let keptSuccessfulSubmit = false
    const unique = []
    for (const tc of list) {
      const tt = String(tc.test_type || '').trim()
      if (tt === 'successful_submit') {
        if (keptSuccessfulSubmit) continue
      }

      const n = normalizeDedupeText
      const keyPrimary = `${tt}|${n(tc.name)}|${n(tc.what_to_test)}`
      const keySecondary = `${tt}|${n(tc.what_to_test)}|${n(tc.expected_result)}`

      if (seenPrimary.has(keyPrimary)) continue
      if (seenSecondary.has(keySecondary)) continue

      seenPrimary.add(keyPrimary)
      seenSecondary.add(keySecondary)
      if (tt === 'successful_submit') keptSuccessfulSubmit = true
      unique.push(tc)
    }
    return unique
  }

  function normalizeCases(raw) {
    function normalizeGeneratedType(rawType) {
      const t = String(rawType || '').toLowerCase().trim()
      const allowed = [
        'required_field',
        'format_validation',
        'successful_submit',
        'conditional_field',
        'widget_auto_fill',
        'attachment',
        'label_check'
      ]
      if (t === 'conditional_display' || t === 'conditional_required') return 'conditional_field'
      if (allowed.includes(t)) return t
      if (t === 'conditional_displayed' || t === 'conditional' || t === 'display_conditional') return 'conditional_field'
      if (t === 'conditional_required_field' || t === 'required_if') return 'conditional_field'
      if (t === 'optional' || t === 'optional_validation' || t === 'optional_field') return '__drop__'
      if (t === 'disabled_field' || t === 'disabled') return '__drop__'
      if (t === 'widget_autofill' || t === 'autofill' || t === 'auto_fill') return 'widget_auto_fill'
      if (t === 'file_attachment' || t === 'attachment_validation') return 'attachment'
      return 'required_field'
    }

    const list = Array.isArray(raw) ? raw : []
    return list
      .map(tc => ({
        name: String(tc?.name || '').trim(),
        what_to_test: String(tc?.what_to_test || '').trim(),
        expected_result: String(tc?.expected_result || '').trim(),
        test_type: normalizeGeneratedType(tc?.test_type)
      }))
      .filter(tc => tc.name && tc.what_to_test && tc.expected_result && tc.test_type !== '__drop__')
  }

  function retagSpecialCaseTypes(list) {
    const cases = Array.isArray(list) ? list : []
    return cases.map((tc) => {
      const merged = `${tc.name} ${tc.what_to_test} ${tc.expected_result}`.toLowerCase()
      const currentType = String(tc?.test_type || '').toLowerCase().trim()

      if (
        currentType === 'conditional_display' ||
        currentType === 'conditional_displayed' ||
        currentType === 'display_conditional' ||
        currentType === 'conditional_required' ||
        currentType === 'conditional_required_field' ||
        currentType === 'required_if' ||
        currentType === 'conditional_field'
      ) {
        return { ...tc, test_type: 'conditional_field' }
      }

      if (
        merged.includes('auto-fill') ||
        merged.includes('autofill') ||
        merged.includes('auto populate') ||
        merged.includes('auto-populate') ||
        merged.includes('gets populated') ||
        merged.includes('field destination') ||
        merged.includes('widget data')
      ) {
        return { ...tc, test_type: 'widget_auto_fill' }
      }

      if (
        merged.includes('attachment') ||
        merged.includes('upload') ||
        merged.includes('file format') ||
        merged.includes('500kb') ||
        merged.includes('larger than')
      ) {
        return { ...tc, test_type: 'attachment' }
      }

      const conditionalLeadIn =
        merged.includes('if "') ||
        merged.includes('when "') ||
        /\bonly\s+(when|if)\b/.test(merged) ||
        /\bappears\s+(when|if)\b/.test(merged) ||
        /\bshown\s+(when|if)\b/.test(merged) ||
        /\bvisible\s+(when|if)\b/.test(merged) ||
        /\bhidden\s+(when|if)\b/.test(merged) ||
        merged.includes('display rule') ||
        /\bwhen\s+[^.]{2,120}\s+is\s+/.test(merged) ||
        /\bif\s+[^.]{2,120}\s+is\s+/.test(merged) ||
        /\brequired\s+when\b/.test(merged) ||
        /\brequired\s+if\b/.test(merged)

      if (conditionalLeadIn) {
        return { ...tc, test_type: 'conditional_field' }
      }

      return tc
    })
  }

  /** Drop only rows that are clearly unusable; do not second-guess SRD-faithful wording from the model. */
  function passesMinimalUsability(tc) {
    const name = String(tc?.name || '').trim()
    const what = String(tc?.what_to_test || '').trim()
    const exp = String(tc?.expected_result || '').trim()
    if (name.length < 2 || what.length < 6 || exp.length < 6) return false
    if (/^(tbd|n\/a|none|test)\.?$/i.test(exp.trim()) && exp.length < 12) return false
    return true
  }

  function finalizeCases(rawPass) {
    const merged = dedupeCases(buildCoverageCases(rawPass))
    const kept = merged.filter(passesMinimalUsability)
    return kept.length ? kept : merged
  }

  async function requestOnce(extraRules = '') {
    const payloadPlans = [
      { maxTokens: 8192, srdChars: 72000, structureChars: 14000 },
      { maxTokens: 6000, srdChars: 52000, structureChars: 10000 },
      { maxTokens: 4500, srdChars: 36000, structureChars: 7000 },
      { maxTokens: 3200, srdChars: 22000, structureChars: 4500 }
    ]

    let lastErr = null
    for (const plan of payloadPlans) {
      try {
        const srdForPrompt = trimSrdForPrompt(srdText, plan.srdChars)
        const compactStructure = compactStructureForPrompt(formStructure, plan.structureChars)
        const structureSection = compactStructure
          ? `=== FORM STRUCTURE (JSON — match field names; rules only from SRD) ===\n${compactStructure}`
          : '=== FORM STRUCTURE (JSON) ===\nNot provided.'

        const userBody = `Generate the full JSON array of test cases for automation.

=== REQUIREMENTS DOCUMENT (SRD) ===
${srdForPrompt}

${structureSection}

${extraRules ? `Additional instructions:\n${extraRules}\n` : ''}
Respond with ONLY one JSON array. Each object must have: name, what_to_test, expected_result, test_type.
Follow the PRODUCT STYLE in the system message: short titles, one-sentence what_to_test (like the EXEMPLAR), expected_result from SRD or the same concise style as the exemplar.`

        const completion = await groqChatCompletionsCreate({
          model: GROQ_PRIMARY_MODEL,
          temperature: 0,
          max_tokens: plan.maxTokens,
          messages: [
            { role: 'system', content: GENERATE_TEST_CASES_SYSTEM },
            { role: 'user', content: userBody }
          ]
        })

        const response = completion.choices?.[0]?.message?.content || '[]'
        let parsed
        try {
          parsed = parseJsonArrayOrThrow(response)
        } catch {
          parsed = await repairResponseToJsonArray(response)
        }
        return retagSpecialCaseTypes(normalizeCases(parsed))
      } catch (err) {
        lastErr = err
        if (isGroqRequestTooLargeError(err)) continue
        throw err
      }
    }
    throw new Error(
      `SRD payload is too large for current Groq TPM limits. Please retry after reducing SRD size or upgrading Groq tier. Last error: ${String(
        groqApiMessage(lastErr) || lastErr?.message || 'unknown'
      ).slice(0, 280)}`
    )
  }

  try {
    const firstPass = await requestOnce()
    return finalizeCases(firstPass)
  } catch (err) {
    // Retry once for transient network/API failures.
    const msg = String(err?.message || '')
    const code = String(err?.cause?.code || '')
    const isConnectionIssue =
      msg.toLowerCase().includes('connection error') ||
      msg.toLowerCase().includes('fetch failed') ||
      code === 'ETIMEDOUT'

    if (isConnectionIssue) {
      try {
        const retried = await requestOnce()
        return finalizeCases(retried)
      } catch {
        throw new Error('AI service is temporarily unavailable. Please try regenerate again in a moment.')
      }
    }

    throw err
  }
}

async function validateManualTestCase({ name, what_to_test, expected_result, srd_text }) {
  async function requestOnce() {
    const completion = await groqChatCompletionsCreate({
      model: GROQ_PRIMARY_MODEL,
      messages: [
        {
          role: 'user',
          content: `
            You are a QA validation expert. A tester has written this test case for a registration form.
            Decide if it is valid and what type it is.

            Requirements document:
            ${srd_text || ''}

            Test case:
            - name: ${name || ''}
            - what_to_test: ${what_to_test || ''}
            - expected_result: ${expected_result || ''}

            Return JSON only:
            { "valid": true/false, "test_type": "required_field" | "format_validation" | "successful_submit" | "conditional_field" | "widget_auto_fill" | "attachment" | "label_check", "reason": "short explanation" }

            If the test case does not make sense, is vague, contradicts the form requirements, or cannot be automated, return valid: false.
          `
        }
      ]
    })

    const response = completion.choices?.[0]?.message?.content || '{}'
    const cleaned = response.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(cleaned)

    const valid = Boolean(parsed?.valid)
    const rawType = String(parsed?.test_type || '').trim()
    const coerced =
      rawType === 'conditional_display' || rawType === 'conditional_required' ? 'conditional_field' : rawType
    const safeType = ['required_field', 'format_validation', 'successful_submit', 'conditional_field', 'widget_auto_fill', 'attachment', 'label_check'].includes(coerced)
      ? coerced
      : 'required_field'
    const reason = String(parsed?.reason || '').trim() || (valid ? 'Valid test case' : 'Invalid test case')

    return { valid, test_type: safeType, reason }
  }

  try {
    return await requestOnce()
  } catch (err) {
    const msg = String(err?.message || '')
    const code = String(err?.cause?.code || '')
    const isConnectionIssue =
      msg.toLowerCase().includes('connection error') ||
      msg.toLowerCase().includes('fetch failed') ||
      code === 'ETIMEDOUT'

    if (isConnectionIssue) {
      try {
        return await requestOnce()
      } catch {
        return {
          valid: false,
          test_type: 'required_field',
          reason: 'AI validation unavailable at the moment'
        }
      }
    }

    return {
      valid: false,
      test_type: 'required_field',
      reason: 'AI validation failed to parse this test case'
    }
  }
}

async function analyzeFormStructure(fields) {
  async function requestOnce() {
    const completion = await groqChatCompletionsCreate({
      model: GROQ_PRIMARY_MODEL,
      messages: [
        {
          role: 'user',
          content: `
            You are a QA expert. Here is a list of form fields found on a web page:
            ${JSON.stringify(fields)}

            Analyse these fields and return a JSON object describing the form structure:
            { "fields": [{ "id": "", "name": "", "label": "", "type": "", "required": false, "selector": "" }], "submitButton": { "id": "", "selector": "" } }.
            Use this to help generate intelligent test cases.
            Return JSON only.
          `
        }
      ]
    })

    const response = completion.choices?.[0]?.message?.content || '{}'
    const cleaned = response.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(cleaned)

    const fieldsArray = Array.isArray(parsed?.fields) ? parsed.fields : []
    const safeFields = fieldsArray.map((f, idx) => ({
      id: String(f?.id || '').trim(),
      name: String(f?.name || '').trim(),
      label: String(f?.label || '').trim(),
      type: String(f?.type || 'text').trim().toLowerCase() || 'text',
      required: Boolean(f?.required),
      selector: String(
        f?.selector || (f?.id ? `#${String(f.id || '').trim()}` : '')
      ).trim() || `field_${idx}`
    }))
    const submitButton = {
      id: String(parsed?.submitButton?.id || '').trim(),
      selector: String(parsed?.submitButton?.selector || '').trim()
    }

    return { fields: safeFields, submitButton }
  }

  try {
    return await requestOnce()
  } catch {
    const safeFields = (Array.isArray(fields) ? fields : []).map((f, idx) => ({
      id: String(f?.id || '').trim(),
      name: String(f?.name || '').trim(),
      label: String(f?.label || '').trim(),
      type: String(f?.type || 'text').trim().toLowerCase() || 'text',
      required: Boolean(f?.required),
      selector: String(f?.selector || '').trim() || `field_${idx}`
    }))

    const submitCandidate = (Array.isArray(fields) ? fields : []).find(f => String(f?.type || '').toLowerCase() === 'submit')
    return {
      fields: safeFields,
      submitButton: {
        id: String(submitCandidate?.id || '').trim(),
        selector: String(submitCandidate?.selector || '').trim()
      }
    }
  }
}

export default generateTestCases
export { validateManualTestCase, analyzeFormStructure, groqChatCompletionsCreate, GROQ_PRIMARY_MODEL }