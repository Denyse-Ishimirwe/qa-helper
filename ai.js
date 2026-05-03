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
    max_tokens: 2200,
    messages: [
      {
        role: 'user',
        content: `
Convert the following AI output into a valid JSON array of objects.

Required object schema:
{
  "name": string,
  "what_to_test": string,
  "expected_result": string,
  "test_type": "required_field" | "format_validation" | "successful_submit" | "conditional_required" | "conditional_display" | "widget_auto_fill" | "attachment" | "disabled_field"
}

Rules:
- Output ONLY JSON (one array), no prose, no markdown.
- Preserve the original meaning; do not invent new rules.
- If any key is missing, infer minimally from context.
- If no test cases are recoverable, return [].

Input to repair:
${raw}
`
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
  function trimWithHeadTail(text, maxChars) {
    const raw = String(text || '')
    if (raw.length <= maxChars) return raw
    const head = Math.max(1000, Math.floor(maxChars * 0.66))
    const tail = Math.max(700, maxChars - head)
    return `${raw.slice(0, head)}\n\n[... SRD truncated for token budget ...]\n\n${raw.slice(-tail)}`
  }

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

  function normalizeLabel(field, idx) {
    const label = String(field?.label || '').trim()
    const name = String(field?.name || '').trim()
    const id = String(field?.id || '').trim()
    return label || name || id || `Field ${idx + 1}`
  }

  function normalizeType(raw) {
    const t = String(raw || '').toLowerCase().trim()
    if (!t) return 'text'
    if (t === 'select-one' || t === 'select') return 'select'
    return t
  }

  function fieldKey(label) {
    return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  }

  function caseMentionsField(tc, key) {
    const text = `${tc.name} ${tc.what_to_test} ${tc.expected_result}`.toLowerCase()
    return key && text.includes(key)
  }

  function shouldGenerateFormat(type) {
    return !['checkbox', 'radio', 'submit', 'button', 'hidden'].includes(type)
  }

  function buildCoverageCases(baseCases) {
    const fields = getStructureFields(formStructure)
    if (!fields.length) return baseCases

    const out = [...baseCases]
    const hasSuccessful = out.some(tc => tc.test_type === 'successful_submit')
    if (!hasSuccessful) {
      out.push({
        name: 'Successful submission with valid data',
        what_to_test:
          'Fill every required field with valid values according to the requirements document, then submit the form using the primary submit action.',
        expected_result:
          'The application accepts the submission: no blocking validation errors remain, and the user reaches the success or confirmation state described in the requirements (use that exact outcome text from the SRD where applicable).',
        test_type: 'successful_submit'
      })
    }

    fields.forEach((f, idx) => {
      const label = normalizeLabel(f, idx)
      const key = fieldKey(label)
      const type = normalizeType(f?.type || f?.element)
      const required = Boolean(f?.required)
      if (!required) return

      if (required) {
        const hasRequiredCase = out.some(tc => tc.test_type === 'required_field' && caseMentionsField(tc, key))
        if (!hasRequiredCase) {
          out.push({
            name: `${label} required field validation`,
            what_to_test: `Leave the "${label}" field empty (do not enter any value), then submit the form.`,
            expected_result: `The same required-field validation message for "${label}" that is written verbatim in the requirements validation table must appear (paste that exact string from the SRD, not a paraphrase).`,
            test_type: 'required_field'
          })
        }
      }

      if (shouldGenerateFormat(type)) {
        const hasFormatCase = out.some(tc => tc.test_type === 'format_validation' && caseMentionsField(tc, key))
        if (!hasFormatCase) {
          out.push({
            name: `${label} format validation`,
            what_to_test: `Enter a value in "${label}" that violates one specific format or range rule from the requirements (wrong pattern, length, or type), then submit the form.`,
            expected_result: `The exact format or validation error message for "${label}" defined in the requirements document must be shown (copy the literal SRD wording).`,
            test_type: 'format_validation'
          })
        }
      }
    })

    return out
  }

  function dedupeCases(list) {
    const seen = new Set()
    const unique = []
    for (const tc of list) {
      const key = `${tc.test_type}|${tc.name.toLowerCase()}|${tc.what_to_test.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(tc)
    }
    return unique
  }

  function getFieldCount(structure) {
    if (Array.isArray(structure)) return structure.length
    if (Array.isArray(structure?.fields)) return structure.fields.length
    return 0
  }

  function normalizeCases(raw) {
    function normalizeGeneratedType(rawType) {
      const t = String(rawType || '').toLowerCase().trim()
      const allowed = [
        'required_field',
        'format_validation',
        'successful_submit',
        'conditional_required',
        'conditional_display',
        'widget_auto_fill',
        'attachment',
        'disabled_field'
      ]
      if (allowed.includes(t)) return t
      if (t === 'conditional_displayed' || t === 'conditional' || t === 'display_conditional') return 'conditional_display'
      if (t === 'conditional_required_field' || t === 'required_if') return 'conditional_required'
      if (t === 'optional' || t === 'optional_validation' || t === 'optional_field') return '__drop__'
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
        currentType === 'display_conditional'
      ) {
        return { ...tc, test_type: 'conditional_display' }
      }

      if (
        currentType === 'conditional_required' ||
        currentType === 'conditional_required_field' ||
        currentType === 'required_if'
      ) {
        return { ...tc, test_type: 'conditional_required' }
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
        if (
          merged.includes('appear') ||
          merged.includes('display') ||
          merged.includes('visible') ||
          merged.includes('shown') ||
          merged.includes('show') ||
          merged.includes('hide')
        ) {
          return { ...tc, test_type: 'conditional_display' }
        }
        return { ...tc, test_type: 'conditional_required' }
      }

      if (currentType === 'disabled_field') {
        const explicitNonEditable =
          merged.includes('read-only') ||
          merged.includes('read only') ||
          merged.includes('cannot be edited') ||
          merged.includes('not editable') ||
          merged.includes('field is disabled')
        if (explicitNonEditable) {
          return { ...tc, test_type: 'disabled_field' }
        }
        return { ...tc, test_type: 'widget_auto_fill' }
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
      { maxTokens: 2600, srdChars: 28000, structureChars: 9000 },
      { maxTokens: 2200, srdChars: 19000, structureChars: 6000 },
      { maxTokens: 1800, srdChars: 13000, structureChars: 4000 },
      { maxTokens: 1400, srdChars: 9000, structureChars: 2200 }
    ]

    let lastErr = null
    for (const plan of payloadPlans) {
      try {
        const srdForPrompt = trimWithHeadTail(srdText, plan.srdChars)
        const compactStructure = compactStructureForPrompt(formStructure, plan.structureChars)
        const structureBlock = compactStructure
          ? `
            Here is the actual structure of the form with its real fields:
            ${compactStructure}
      `
          : ''

        const completion = await groqChatCompletionsCreate({
          model: GROQ_PRIMARY_MODEL,
          temperature: 0.1,
          max_tokens: plan.maxTokens,
          messages: [
            {
              role: 'user',
              content: `
            You must base every test case ONLY on the Requirements document (SRD) text below and on the optional form-structure JSON. Do not invent rules, messages, or fields that are not stated there.

            HOW TO READ THE SRD (perform mentally before writing JSON — coverage and accuracy depend on this):

            PASS A — Inventory: Scan the entire SRD for (1) every field or data element the user can enter, (2) every validation rule including format, length, allowed values, age, cross-field rules, (3) every conditional rule (required-if, visible-if), (4) every attachment rule including format and size limits, (5) every widget or auto-fill chain, (6) submit/success behaviour. Note table names, section headings, and row identifiers so you do not skip annexes or appendices.

            PASS B — Messages verbatim: Where the SRD gives an exact user-visible error, warning, or success message (table cell, quoted string, bullet), copy that text into expected_result for the matching test. Prefer character-for-character transcription including punctuation and language. If the SRD only describes the meaning in prose, still write the full intended message as stated, not a one-word placeholder.

            PASS C — One rule → one test: Each distinct validation or behavioural rule becomes its own array element. Multiple formats on one field → multiple format_validation entries. Never merge two rules into one test case.

            PASS D — Cross-check structure: If a JSON form structure is included, every non-derived input field from that structure should appear in at least one test (name, what_to_test, or expected_result) unless the SRD explicitly marks it as system-filled with no tester action.

            PASS E — Gap check: Before finishing, ask whether you missed optional fields, attachments, conditionals, multi-step widgets, or success path — add cases until the SRD is exhaustively covered for automation.

            STRICT RULES FOR EVERY TEST CASE:

            For required_field:
            — what_to_test must describe leaving the field empty or not filling it
            — expected_result must contain the exact error message from the SRD validation table
            — Never describe selecting or filling a value correctly in a required_field test

            For format_validation:
            — what_to_test must describe entering an invalid value wrong format or a value that violates a specific rule
            — expected_result must contain the exact error message from the SRD
            — Never say "enter a valid value" in a format_validation test

            For conditional_required:
            — what_to_test must describe setting the parent field to the triggering value first then leaving the conditional field empty
            — Use this exact sentence pattern: "Select [triggerValue] on [parentFieldLabel] field, then leave [targetFieldLabel] field empty"
            — expected_result must contain the exact error message

            For conditional_display:
            — Only generate for fields that the SRD explicitly states have a display rule controlled by another field
            — The parent field must be the field that controls the display not the target field itself
            — Never generate a conditional_display test where the parent field and target field are from the same cascading group
            — Use this exact pattern: "Select [triggerValue] on [parentField] field and check if [targetField] field is displayed"

            For fields in a cascading dropdown chain (each level appears only after selecting a parent level):
            — Always describe the full chain of prerequisite selections in what_to_test.
            — Use this pattern for display checks: "Select [triggerValue] on [rootControllerField] field, then select any option on [level1Field] field, then select any option on [level2Field] field, then check if [targetField] field is displayed"
            — Use this pattern for required checks: "Select [triggerValue] on [rootControllerField] field, then select any option on [level1Field] field, then select any option on [level2Field] field, then leave [targetField] field empty"
            — Identify cascading fields from SRD parent-child display dependencies and wording like selecting one level within a previously selected parent level.

            For widget_auto_fill:
            — what_to_test must describe entering a valid value in the source field and checking which fields get auto-populated
            — expected_result must describe which specific fields should be populated

            For successful_submit:
            — what_to_test must describe filling all required fields with valid values and submitting
            — expected_result must continue to another section of the form 

            For attachment:
            — what_to_test must describe the specific scenario: required attachment missing wrong file format or oversized file
            — expected_result must contain the exact error message from the SRD

            General rules:
            — Never generate a test case where what_to_test says to fill a field correctly and expected_result says no error
            — expected_result must always be specific — never just say "Required error message" or "No error" or "Invalid format" without the actual message text from the SRD
            — Every test case must be actionable without any guesswork
            — Do not force every test_type on every form. Generate only the test types that are explicitly supported by the SRD for that specific form and field behavior.
            — If the SRD does not define a rule type (for example: no attachment fields, no widget behavior, no conditional display), do not generate that test_type.
            — Do not generate optional_field test cases.
            — Never generate a widget_auto_fill test for a plain input field unless the SRD explicitly describes widget/auto-fill behavior for it.
            — Never generate an attachment test for any field that is not a file upload/attachment field in the SRD.
            — Never generate a disabled_field test as conditional_required. Disabled fields may only use widget_auto_fill or disabled_field types.

            STEP 1 — BEFORE generating any test cases, carefully read the entire SRD and identify:
            — Which fields use widgets — these are fields where the Type column says Widget or has multiple types listed
            — Which fields are marked as Disabled — these get their values auto-filled from other fields and should NOT be tested with required field tests directly
            — Which fields have conditional validation — validation rules that only apply when another field has a specific value
            — Which fields have conditional display — fields that only appear when another field has a specific value
            — Which fields have auto-fill behavior — described in Widget data column where entering a value populates other fields

            STEP 2 — For widget fields specifically:
            — If a field has multiple widget types like National ID Widget, NIN Widget, Citizen Application Number — generate separate test cases for each type. For each type test the specific format validation described in the SRD
            — Always first select the ID Type before testing the ID Number field
            — Never test a Disabled field directly — instead test the auto-fill behavior by entering a valid value in the source field and verifying the disabled field gets populated

            STEP 3 — For conditional fields:
            — Always describe in what_to_test exactly what needs to be set first before the field appears or becomes required
            — Never generate a test case for a conditional field without mentioning the condition that triggers it
            - The fields might have many fields above it or below forexample like country, province, district, sector, cell and cell, make sure one leads to another and you cover all of them

            STEP 4 — Use the EXACT error messages from the SRD validation rules table — do not make up error messages
            STEP 5 — Use the EXACT field names from the SRD — do not use option values like Yes, No, Full Time as field names

            You are a senior QA engineer. Your job is to read the SRD document below and generate every possible test case that can be automated on the form.

            For every field in the form, you must consider and generate test cases for ALL of the following that apply:

            1. REQUIRED FIELD TESTS — if the field is required, generate a test that leaves it empty and expects a required error message

            2. FORMAT VALIDATION TESTS — if the field has a format rule such as minimum digits, maximum digits, email format, phone format, age restriction, or date range, generate a SEPARATE test case for each individual format rule

            3. CONDITIONAL REQUIRED TESTS — if a field is only required when another field has a specific value, generate a test that first sets that condition and then leaves the conditional field empty. Always describe in what_to_test which field needs to be set first and to what value

            4. CONDITIONAL DISPLAY TESTS — if a field only appears when another field has a specific value, always describe in what_to_test that the condition must be set first before interacting with that field

            5. WIDGET AUTO-FILL TESTS — if the SRD describes that entering a value in one field automatically populates other fields, generate a test that enters a valid value in the trigger field and checks that all the described fields get automatically filled

            6. ATTACHMENT TESTS — for every file upload or attachment field in the form, generate three separate test cases: one for when the attachment is required and left empty, one for uploading a file with a wrong format, and one for uploading a file that exceeds the maximum allowed size

            7. DISABLED FIELD TESTS — if a field is described as disabled or read-only and gets its value from another field, generate a test confirming it is auto-filled correctly when the source field is filled

            Important rules:
            - Read every single validation rule, display rule, conditional rule, and widget behavior described in the SRD
            - Generate a completely separate test case for each individual rule — never combine two rules into one test case
            - For fields that have multiple format rules, generate one test case per format rule
            - For conditional fields, always mention in what_to_test exactly which parent field needs to be set and to what value before testing the conditional field
            - Never skip attachment fields, conditional fields, auto-fill behaviors, or disabled fields
            - Every test case must be specific and detailed enough that an automated testing tool can execute it without any guessing
            - Always include at least one successful submit test case at the end

            Requirements document:
            ${srdForPrompt}

            ${structureBlock}

            If form structure is provided, generate test cases that match those real fields and selectors.
            ${extraRules}

            Return the test cases as a JSON array like this:
            [
              {
                "name": "Test case name",
                "what_to_test": "What to test",
                "expected_result": "Expected result",
                "test_type": "required_field" | "format_validation" | "successful_submit" | "conditional_required" | "conditional_display" | "widget_auto_fill" | "attachment" | "disabled_field"
              }
            ]
            Return only valid JSON (one array). Do not truncate the list: include every test case implied by passes A–E. If the SRD is long, prioritize completeness over brevity in the array length.
          `
            }
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
    const fieldCount = getFieldCount(formStructure)
    const minimumTarget = fieldCount > 0
      ? Math.max(25, Math.min(60, fieldCount * 3))
      : 12

    let mergedForFinalize = firstPass
    if (firstPass.length < minimumTarget && process.env.GROQ_API_KEY) {
      const secondPass = await requestOnce(
        `IMPORTANT COVERAGE PASS — merge with prior output mentally; produce additional cases only where the SRD still has uncovered rules.

      - You must add enough cases so that together with a prior batch the project reaches at least ${minimumTarget} distinct tests when the SRD is large enough to support that count.
      - Walk the form structure field-by-field again: required, format, conditional, optional, attachment, widget auto-fill, disabled, display rules.
      - One rule per test case. Use exact SRD messages in expected_result wherever the document states them.
      - Do not duplicate the same rule; vary name and steps so deduplication can keep both batches.`
      )
      mergedForFinalize = dedupeCases([...firstPass, ...secondPass])
    }

    let out = finalizeCases(mergedForFinalize)
    if (out.length < minimumTarget && fieldCount > 0 && process.env.GROQ_API_KEY) {
      try {
        const repair = await requestOnce(
          `QUALITY REPAIR — the last batch was too small or failed automated quality checks. Return ONLY a JSON array of new test cases (same schema) that strictly follow every STRICT RULE at the top of this prompt. Each expected_result must contain the real validation or success wording from the SRD (verbatim or clearly quoted), not one-word placeholders. Aim for at least ${minimumTarget} distinct cases if the SRD supports them.`
        )
        out = finalizeCases([...out, ...repair])
      } catch {
        // keep out
      }
    }
    return out
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
            { "valid": true/false, "test_type": "required_field" | "format_validation" | "successful_submit" | "conditional_required" | "conditional_display" | "widget_auto_fill" | "attachment" | "disabled_field", "reason": "short explanation" }

            If the test case does not make sense, is vague, contradicts the form requirements, or cannot be automated, return valid: false.
          `
        }
      ]
    })

    const response = completion.choices?.[0]?.message?.content || '{}'
    const cleaned = response.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(cleaned)

    const valid = Boolean(parsed?.valid)
    const rawType = String(parsed?.test_type || '')
    const safeType = ['required_field', 'format_validation', 'successful_submit', 'conditional_required', 'conditional_display', 'widget_auto_fill', 'attachment', 'disabled_field'].includes(rawType)
      ? rawType
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