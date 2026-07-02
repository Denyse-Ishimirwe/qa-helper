import 'dotenv/config'
import Groq from 'groq-sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { assignSectionsFromFormStructure } from './sections.js'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
const genAI = process.env.GOOGLE_API_KEY ? new GoogleGenerativeAI(process.env.GOOGLE_API_KEY) : null

/** Gemini PRIMARY model. Override with GEMINI_MODEL. (2.5-flash is a thinking model — needs a large token budget.) */
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim()
/**
 * gemini-2.5-flash real limits (Google): max OUTPUT tokens = 65,536; thinking budget
 * configurable 0–24,576. We size from those, not a guess. The old 8,192 floor caused
 * truncation (finishReason=MAX_TOKENS: ~6.3k thinking + ~1.9k JSON ≈ the 8,192 cap),
 * so a large form's array was cut mid-output and repair salvaged only a partial set.
 */
const GEMINI_MAX_OUTPUT_TOKENS = 65536
/** Output floor we request for generation: half the model ceiling. After the bounded
 *  reasoning below (≤8,192), that still leaves ~24k tokens for the JSON array (≈250+
 *  cases) — far beyond any realistic Irembo form. It's a CEILING: small forms still end
 *  early on finishReason=STOP, so there's no extra cost for them. */
const GEMINI_MIN_OUTPUT_TOKENS = 32768
/** Cap reasoning so a thinking model can't spend the whole allowance on thoughts and
 *  starve the JSON (the confirmed bug). 8,192 ≤ the 24,576 max; the rest goes to output. */
const GEMINI_THINKING_BUDGET = 8192
/** Groq fallback #1 when Gemini is unavailable. Override with GROQ_MODEL. */
const GROQ_PRIMARY_MODEL = (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim()
/**
 * Groq fallback #2 when llama-3.3-70b is also rate-limited.
 * Override with GROQ_FALLBACK_MODEL or set to '' to disable.
 */
const GROQ_FALLBACK_MODEL = String(process.env.GROQ_FALLBACK_MODEL ?? 'llama-3.1-8b-instant').trim()

/**
 * Ollama (OpenAI-compatible) provider — e.g. Irembo-hosted UAT server.
 * Selected as primary via AI_PROVIDER=ollama. URL + model come from env
 * (never hardcoded). With AI_FALLBACK=off, a failure here is surfaced instead
 * of silently cascading to Gemini/Groq.
 */
const OLLAMA_BASE_URL = String(process.env.OLLAMA_BASE_URL || '').trim().replace(/\/+$/, '')
const OLLAMA_MODEL = String(process.env.OLLAMA_MODEL || '').trim()
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 60000

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
— Never reuse field names, option labels, form titles, or example messages from this prompt or the STYLE EXEMPLAR below. Those are formatting templates only. Every real label and message must come from the SRD and/or form-structure JSON for this project.
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
— Label check (every labeled field): "{FieldLabel} Label Check Test"
— Mandatory field empty test: "{FieldLabel} Required Field Test" (use the real label text from the SRD/form JSON, not examples from this prompt)
— SRD-optional field empty test: "{FieldLabel} Optional Field Test"
— Single format rule: "{FieldLabel} {RuleShortName} Test"
— Visibility-only check: "{FieldLabel} Conditional Display Test"
— Submit: "Successful Submit Test"

SRD TABLE STRUCTURE — SECTION and BLOCK are two separate levels, BOTH required on every case:
The SRD table columns are: Section | Block | Field name (Label) | … . Section and Block are two DIFFERENT hierarchy levels, and BOTH must be captured on every test case:
  • section = the top-level NAVIGABLE STEP (matches the form's stepper steps). Used for grouping and navigation.
  • block   = a sub-grouping nested INSIDE a section. One section may contain ONE or MANY blocks, and every field belongs to one of them.

Blank-cell inheritance (forward-fill), applied to each column INDEPENDENTLY:
  • Section and Block cells are filled ONLY on the first row of each group, then left blank for following rows that belong to the same group.
  • Carry the last non-blank Section value DOWN to every following field until a new non-blank Section appears.
  • Carry the last non-blank Block value DOWN independently — EXCEPT: when the Section changes, the carried Block is DROPPED. Never carry a block from one section into another; the new Section's first row provides its own first Block.
  • A section has ONE or MANY blocks, and every field sits inside one of its blocks — so block is never empty.

What to emit on every test case (ALL test types — required_field, format_validation, conditional_field, widget_auto_fill, attachment, successful_submit, AND label_check):
  • section: the carried-down SECTION column value (the navigable step). NEVER a Block-column value. Never blank, never "General".
  • block: the carried-down BLOCK column value (dropped/reset on each new Section). Every field has a block, so this is never empty.

Worked example (placeholders — replace with real SRD values, never output literal brackets). Suppose the SRD reads (blanks shown as ·):
  Section | Block | Field
  A       | b1    | f1   → section "A", block "b1"
  ·       | ·     | f2   → section "A", block "b1"   (both carried down)
  ·       | b2    | f3   → section "A", block "b2"   (new block, section carried)
  ·       | ·     | f4   → section "A", block "b2"
  B       | b3    | f5   → section "B", block "b3"   (new SECTION starts with its OWN first block; the previous block "b2" is DROPPED)
  ·       | ·     | f6   → section "B", block "b3"
So f5 gets section "B" with its own block "b3" — the previous block "b2" from section A must NOT leak into section B.

LABEL CHECK (generate these FIRST, grouped by section):
— For EVERY field in the SRD table emit exactly ONE label_check case (test_type: "label_check"), capturing: exact field label, exact placeholder if the SRD specifies one, and the section name = the carried-down SECTION column value (NOT the Block column — see SRD TABLE STRUCTURE above).
— expected_result encoding (verbatim spelling/capitalization; segments separated by "; "):
  • Label only:        "<Label>; section: <Section>; block: <Block>"
  • With placeholder:  "<Label>; placeholder: <Placeholder>; section: <Section>; block: <Block>"
  • Conditional field: "<Label>; placeholder: <Placeholder>; section: <Section>; block: <Block>; parent: <ParentLabel>=<TriggerValue>"  (omit "placeholder:" if none)
  • Include the "; block: <Block>" segment (right after section) ONLY when the field has a Block value; omit it entirely when the block is empty.
— RADIO buttons: capture label and section ONLY — never a placeholder.
— CONDITIONAL fields: generate ONE case per trigger option (one row per trigger), each with its own "parent: <ParentLabel>=<TriggerValue>".
— what_to_test MUST be specific, naming section + block + label (+ placeholder). Include the block clause only when the field has a Block value; omit it entirely when the block is empty. e.g.:
  "Checking that the First Name field in the Applicant Details section, Personal Information block, has the label 'First Name' and placeholder 'Enter your first name'".
— Every test case MUST include "section": the carried-down SECTION column value for that field or rule (apply the FORWARD-FILL rule from SRD TABLE STRUCTURE so blank cells inherit the Section above) — NEVER the Block column text. For successful_submit use the final section name or "Submit".
— ORDER: group output by section in SRD order; within each section emit that section's label_check cases FIRST, then that section's other test types (Section 1 block, then Section 2 block, …).

CONDITIONAL FIELDS (visibility / required-if / display-if — test_type MUST be conditional_field, never required_field):
— Whenever the SRD says a field appears, becomes required, or stays hidden based on another field’s value, use conditional_field.
— Parent condition must appear in what_to_test so automation can parse it. Use this pattern (quotes around value optional but recommended): Selecting '<TriggerValue>' on <ParentFieldLabel> field …
— expected_result MUST use structured lines (SRD messages inside quotes):
  • Target visible and required when empty: Displayed: Yes; Required: Yes; Validation: "<exact SRD error for empty target>"
  • Target must stay hidden: Displayed: No; Required: N/A (hidden by condition)
  • Visibility-only (assert field shows; no required error in same case): Displayed: Yes; Required: N/A; <short visibility phrase from SRD or "<Label> field appears">
— DEDUPLICATION RULE: If you are already generating a Required Field Test for a conditional field (Displayed: Yes; Required: Yes), do NOT also generate a Conditional Display Test for the same field and same parent condition. The required test already proves visibility. Only generate a Conditional Display Test when there is NO required test for that field — for example when a field appears but is optional, or when testing that a field stays hidden.

CASCADING DROPDOWNS / ORDERED CHAINS (any SRD chain where each level unlocks the next):
— what_to_test MUST list ONLY the steps needed to REACH the target field, then the final action on the target itself.
— CRITICAL RULE: Only include levels that come BEFORE the target in the chain. The target is the field being tested — it must be the last step (left empty or checked for visibility). Never select the target as an intermediate step.
— Each level in the chain that comes before the target uses: "then select any valid option on <LevelLabel> field"
— The target itself uses: "then leave <TargetLabel> field empty" (for required tests) or "then checking if <TargetLabel> field appears" (for display tests)
— The chain depth comes entirely from the SRD. If the SRD says Level A unlocks Level B which unlocks Level C, then:
  • Testing Level A: just apply the parent trigger, then act on Level A
  • Testing Level B: apply trigger, select Level A, then act on Level B
  • Testing Level C: apply trigger, select Level A, select Level B, then act on Level C
— This prerequisite chaining rule applies to BOTH conditional outcomes:
  • Displayed: Yes; Required: N/A (visibility-only)
  • Displayed: Yes; Required: Yes; Validation: ...
  If the target is not the first dependent level, what_to_test must include all prior levels before the target.
— Use the exact field labels from the SRD for every level. Never hardcode form-specific names.
— Never skip intermediate levels the SRD defines as required prerequisites.

what_to_test — other cases (keep concise when no cascade):
— Required empty (non-conditional): "Leaving {FieldLabel} field empty"
— Optional empty (expect no error): pair with name "... Optional Field Test" and expected_result "No error message"
— Single parent + target (no cascade): "Selecting '{Value}' on {ParentFieldLabel} field and leaving {TargetFieldLabel} field empty" OR visibility check with "checking if {TargetFieldLabel} field appears"
— Format / rule: "Entering …" (invalid condition per SRD)
— Successful submit: "Filling out all required fields and submitting the form"

expected_result (non-conditional):
— Prefer exact SRD strings. Optional-field negative test: "No error message". Submit: success wording from SRD.

widget_auto_fill / attachment: use same concise style; rules still come only from the SRD.

General:
— Never placeholders only ("Required error", "See SRD").
— Never disabled_field type.
— Widget flows (choose widget type before dependent fields when the SRD says so): reflect SRD order inside what_to_test in the same short sentence style.

Output schema per element:
{ "name": string, "what_to_test": string, "expected_result": string, "test_type": "required_field"|"format_validation"|"successful_submit"|"conditional_field"|"widget_auto_fill"|"attachment"|"label_check", "section": string, "block": string }

STYLE EXEMPLAR (placeholders only — replace every <…> with real SRD/form labels and messages; never output literal angle-bracket tokens). Display Tests use distinct placeholders (<OptionalConditionalFieldLabel>, <OptionalDeepTargetFieldLabel>) to enforce the DEDUPLICATION RULE: a Conditional Display Test is only for conditional fields NOT already covered by a Required Field Test (e.g. optional conditional fields, or fields tested for staying hidden). Never emit a Display Test for the same field+parent that already has a Required Field Test.
[
  {"name":"<FieldLabel> Label Check Test","what_to_test":"Checking that the <FieldLabel> field in the <Section> section, <Block> block, has the label '<FieldLabel>'","expected_result":"<FieldLabel>; section: <Section>; block: <Block>","test_type":"label_check","section":"<Section>","block":"<Block>"},
  {"name":"<FieldLabel> Label Check Test","what_to_test":"Checking that the <FieldLabel> field in the <Section> section, <Block> block, has the label '<FieldLabel>' and placeholder '<Placeholder>'","expected_result":"<FieldLabel>; placeholder: <Placeholder>; section: <Section>; block: <Block>","test_type":"label_check","section":"<Section>","block":"<Block>"},
  {"name":"<ChildLabel> Label Check Test","what_to_test":"Checking that the <ChildLabel> field shown when <ParentLabel> is '<TriggerValue>' in the <Section> section, <Block> block, has the label '<ChildLabel>'","expected_result":"<ChildLabel>; placeholder: <Placeholder>; section: <Section>; block: <Block>; parent: <ParentLabel>=<TriggerValue>","test_type":"label_check","section":"<Section>","block":"<Block>"},
  {"name":"<MandatoryFieldLabel> Required Field Test","what_to_test":"Leaving <MandatoryFieldLabel> field empty","expected_result":"<Exact validation message from SRD for that field>","test_type":"required_field","section":"<Section>","block":"<Block>"},
  {"name":"<OptionalFieldLabel> Optional Field Test","what_to_test":"Leaving <OptionalFieldLabel> field empty","expected_result":"No error message","test_type":"required_field","section":"<Section>","block":"<Block>"},
  {"name":"<FieldLabel> <RuleName> Test","what_to_test":"Entering <plain-English invalid condition from SRD for this rule>","expected_result":"<Exact SRD message for that rule>","test_type":"format_validation","section":"<Section>","block":"<Block>"},
  {"name":"<TargetFieldLabel> Required Field Test","what_to_test":"Selecting '<ParentValue>' on <ParentFieldLabel> field and leaving <TargetFieldLabel> field empty","expected_result":"Displayed: Yes; Required: Yes; Validation: '<Exact SRD message for empty target>'","test_type":"conditional_field","section":"<Section>","block":"<Block>"},
  {"name":"<OptionalConditionalFieldLabel> Conditional Display Test","what_to_test":"Selecting '<ParentValue>' on <ParentFieldLabel> field and checking if <OptionalConditionalFieldLabel> field appears","expected_result":"Displayed: Yes; Required: N/A; <OptionalConditionalFieldLabel> field appears","test_type":"conditional_field","section":"<Section>","block":"<Block>"},
  {"name":"<DeepTargetFieldLabel> Required Field Test","what_to_test":"Selecting '<RootTrigger>' on <RootParentLabel> field, then select any valid option on <Level1Label> field, then on <Level2Label> field, then leave <DeepTargetFieldLabel> field empty","expected_result":"Displayed: Yes; Required: Yes; Validation: '<Exact SRD message>'","test_type":"conditional_field","section":"<Section>","block":"<Block>"},
  {"name":"<OptionalDeepTargetFieldLabel> Conditional Display Test","what_to_test":"Selecting '<RootTrigger>' on <RootParentLabel> field, then select any valid option on <Level1Label> field, then select any valid option on <Level2Label> field, and checking if <OptionalDeepTargetFieldLabel> field appears","expected_result":"Displayed: Yes; Required: N/A; <OptionalDeepTargetFieldLabel> field appears","test_type":"conditional_field","section":"<Section>","block":"<Block>"},
  {"name":"Successful Submit Test","what_to_test":"Filling out all required fields and submitting the form","expected_result":"<Exact success message from SRD, or short confirmation phrase if SRD uses one>","test_type":"successful_submit","section":"<Section>","block":""}
]`

function groqApiMessage(err) {
  if (!err) return ''
  if (typeof err.message === 'string' && err.message.trim()) return err.message.trim()

  const data = err?.response?.data
  const e = err?.error ?? data?.error ?? err?.body?.error ?? data

  if (typeof e === 'string') {
    try {
      const j = JSON.parse(e)
      return String(j?.error?.message || j?.message || e)
    } catch {
      return e
    }
  }

  if (e && typeof e === 'object') {
    const nested =
      (typeof e.message === 'string' && e.message) ||
      (typeof e.error === 'string' && e.error) ||
      (e.error && typeof e.error === 'object' && typeof e.error.message === 'string' && e.error.message)
    if (nested) return String(nested).trim()
    try {
      return JSON.stringify(e).slice(0, 700)
    } catch {
      return '[Groq error object]'
    }
  }

  if (data && typeof data === 'object' && typeof data.message === 'string') return data.message

  try {
    return JSON.stringify(data ?? err).slice(0, 700)
  } catch {
    return String(err)
  }
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
  const msg = `${groqApiMessage(err)} ${String(err?.message || '')}`.toLowerCase()
  if (status === 413) return true
  if (/request too large|payload too large|context length/i.test(msg)) return true
  if (/tokens per minute|\btpm\b|rate.*token|token.*limit/i.test(msg)) return true
  if (/limit\s+\d+.*requested\s+\d+/i.test(msg)) return true
  if (/maximum context|exceeds.*token/i.test(msg)) return true
  return false
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
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

/** Arrays pass through; a wrapper object like {"testCases":[...]} returns its
 *  first array-valued property (smaller models sometimes wrap under response_format). */
function coerceToCaseArray(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    for (const v of Object.values(parsed)) if (Array.isArray(v)) return v
  }
  return []
}

function parseJsonArrayOrThrow(rawText) {
  const raw = String(rawText || '').trim()
  if (!raw) return []
  // Safety net: strip ```json fences and surrounding prose before parsing.
  const cleaned = raw.replace(/```json|```/gi, '').trim()
  try {
    return coerceToCaseArray(JSON.parse(cleaned))
  } catch {
    const extracted = extractFirstJsonArrayBlock(raw)
    if (!extracted) {
      // Never crash silently — log the FULL raw model output for inspection.
      console.error('[ai] Model output was not parseable JSON — full raw response below:\n', raw)
      throw new Error(`AI returned non-JSON output: ${raw.slice(0, 120)}`)
    }
    return coerceToCaseArray(JSON.parse(extracted))
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

/** Run an OpenAI-style payload through Gemini; returns the same { choices:[{message:{content}}] } shape. */
async function geminiGenerate(payload) {
  if (!genAI) throw new Error('Gemini disabled (no GOOGLE_API_KEY)')
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  const systemInstruction =
    messages.filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n\n').trim()
  const userText =
    messages.filter(m => m.role !== 'system').map(m => String(m.content || '')).join('\n\n').trim()
  const generationConfig = {
    // Thinking models (2.5-flash) spend output tokens on reasoning — request a large
    // ceiling so the JSON array is never starved, and BOUND reasoning so it can't eat
    // the whole allowance (the confirmed MAX_TOKENS truncation).
    maxOutputTokens: Math.max(Number(payload.max_tokens) || 0, GEMINI_MIN_OUTPUT_TOKENS),
    thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET }
  }
  if (typeof payload.temperature === 'number') generationConfig.temperature = payload.temperature
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    ...(systemInstruction ? { systemInstruction } : {}),
    generationConfig
  })
  const result = await model.generateContent(userText)
  const finishReason = result?.response?.candidates?.[0]?.finishReason || 'unknown' // TEMP DIAGNOSTIC
  const u = result?.response?.usageMetadata || {} // TEMP DIAGNOSTIC
  console.log('[gen][gemini] finishReason=', finishReason, '| maxOutputTokens=', generationConfig.maxOutputTokens,
    '| usage(thoughts/cand/total)=', `${u.thoughtsTokenCount ?? '?'}/${u.candidatesTokenCount ?? '?'}/${u.totalTokenCount ?? '?'}`) // TEMP DIAGNOSTIC
  const text = typeof result?.response?.text === 'function' ? result.response.text() : ''
  if (!String(text || '').trim()) {
    throw new Error(`Gemini returned empty text (finishReason=${finishReason})`)
  }
  return { choices: [{ message: { content: String(text) } }] }
}

/**
 * Run an OpenAI-style payload through an OpenAI-compatible Ollama server.
 * URL/model come from OLLAMA_BASE_URL / OLLAMA_MODEL (no hardcoding). Tries
 * response_format json_object; the caller retries plain on rejection. Returns
 * the same { choices:[{message:{content}}] } shape as the other providers.
 */
async function ollamaGenerate(payload, { allowJsonFormat = true } = {}) {
  if (!OLLAMA_BASE_URL) throw new Error('AI_PROVIDER=ollama but OLLAMA_BASE_URL is not set')
  if (!OLLAMA_MODEL) throw new Error('AI_PROVIDER=ollama but OLLAMA_MODEL is not set')
  const url = `${OLLAMA_BASE_URL}/chat/completions`

  const body = {
    model: OLLAMA_MODEL,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0,
    ...(payload.max_tokens ? { max_tokens: payload.max_tokens } : {}),
    // OpenAI-compatible structured-output hint; retried without it on rejection.
    ...(allowJsonFormat ? { response_format: { type: 'json_object' } } : {})
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS)
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Server is open, but OpenAI-compatible clients/servers often require a
        // non-empty key string — send a dummy bearer (override via OLLAMA_API_KEY).
        Authorization: `Bearer ${process.env.OLLAMA_API_KEY || 'ollama'}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
  } catch (err) {
    const how = err?.name === 'AbortError' ? `timed out after ${OLLAMA_TIMEOUT_MS}ms` : String(err?.message || err)
    throw new Error(`[ai][ollama] server UNREACHABLE at ${url} (${how}) — check VPN/network/OLLAMA_BASE_URL.`)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    // If the server rejected response_format, signal the caller to retry plain.
    if (allowJsonFormat && (res.status === 400 || /response_format|json_object|unsupported/i.test(errText))) {
      const e = new Error('ollama-json-format-unsupported')
      e.code = 'OLLAMA_JSON_FORMAT_UNSUPPORTED'
      throw e
    }
    throw new Error(`[ai][ollama] HTTP ${res.status} at ${url}: ${errText.slice(0, 300)}`)
  }

  const data = await res.json().catch(() => null)
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    console.error('[ai][ollama] empty/unexpected response — full raw:\n', JSON.stringify(data))
    throw new Error('[ai][ollama] returned an empty/unexpected response (raw logged above).')
  }
  return { choices: [{ message: { content } }] }
}

/** Ollama with response_format json_object, retrying once as a plain call if rejected. */
async function ollamaChatWithJsonFallback(payload) {
  try {
    return await ollamaGenerate(payload, { allowJsonFormat: true })
  } catch (err) {
    if (err?.code === 'OLLAMA_JSON_FORMAT_UNSUPPORTED') {
      console.warn('[ai][ollama] response_format json_object rejected — retrying plain call; JSON safety net will clean the output.')
      return await ollamaGenerate(payload, { allowJsonFormat: false })
    }
    throw err
  }
}

/**
 * Multi-provider cascade (kept named groqChatCompletionsCreate for back-compat with existing imports):
 *   Provider selection (env): AI_PROVIDER=ollama makes Ollama the primary.
 *   AI_FALLBACK=off (default on) means a primary failure is surfaced, NOT cascaded.
 *   Default cascade (AI_PROVIDER unset):
 *   1) Gemini (gemini-2.5-flash via GOOGLE_API_KEY)
 *   2) on any failure → Groq llama-3.3-70b-versatile (GROQ_API_KEY)
 *   3) on 429 → Groq llama-3.1-8b-instant
 *   4) all unavailable → clear combined error
 * @param {Record<string, unknown>} payload
 */
async function groqChatCompletionsCreate(payload) {
  const provider = String(process.env.AI_PROVIDER || '').toLowerCase().trim()
  const fallbackEnabled = !/^(off|false|0|no)$/i.test(String(process.env.AI_FALLBACK ?? 'on').trim())

  // Selectable primary: Ollama (OpenAI-compatible, e.g. Irembo-hosted UAT).
  if (provider === 'ollama') {
    try {
      return await ollamaChatWithJsonFallback(payload)
    } catch (err) {
      if (!fallbackEnabled) {
        // Surface the real failure — do NOT silently fall back to Gemini/Groq.
        throw new Error(`[ai] Ollama failed and fallback is OFF (set AI_FALLBACK=on to cascade). Cause: ${String(err?.message || err)}`)
      }
      console.warn(`[ai] Ollama failed (${String(err?.message || err).slice(0, 160)}) — AI_FALLBACK on; cascading to Gemini/Groq.`)
      // fall through to the existing cascade
    }
  }

  const groqPrimary = (payload.model || GROQ_PRIMARY_MODEL).trim()
  const groqFallback = GROQ_FALLBACK_MODEL && GROQ_FALLBACK_MODEL !== groqPrimary ? GROQ_FALLBACK_MODEL : ''

  // 1) Gemini primary.
  if (genAI) {
    try {
      return await geminiGenerate(payload)
    } catch (err) {
      const why = isGroqRateLimitError(err) ? '429 rate limit' : String(err?.message || err).slice(0, 100)
      console.warn(`[ai] Gemini unavailable (${why}) — falling back to Groq ${groqPrimary}.`)
    }
  }

  // 2) Groq llama-3.3-70b-versatile.
  try {
    return await groq.chat.completions.create({ ...payload, model: groqPrimary })
  } catch (err) {
    if (!isGroqRateLimitError(err)) throw err
    if (!groqFallback) {
      throw new Error(`Gemini and Groq ${groqPrimary} are both rate-limited. ${humanizeGroqRateLimit(groqApiMessage(err))}`)
    }
    console.warn(`[ai] Groq ${groqPrimary} rate-limited — falling back to ${groqFallback}.`)
    // 3) Groq llama-3.1-8b-instant.
    try {
      return await groq.chat.completions.create({ ...payload, model: groqFallback })
    } catch (err2) {
      if (!isGroqRateLimitError(err2)) throw err2
      // 4) Everything rate-limited.
      throw new Error(
        `All AI providers are rate-limited (Gemini, Groq ${groqPrimary}, and Groq ${groqFallback}). ` +
        `Please wait about a minute and click Generate again. ${humanizeGroqRateLimit(groqApiMessage(err2))}`
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
        test_type: normalizeGeneratedType(tc?.test_type),
        section: String(tc?.section || '').trim(),
        block: String(tc?.block || '').trim()
      }))
      .filter(tc => tc.name && tc.what_to_test && tc.expected_result && tc.test_type !== '__drop__')
  }

  function retagSpecialCaseTypes(list) {
    const cases = Array.isArray(list) ? list : []
    const VALID = ['required_field', 'format_validation', 'successful_submit', 'conditional_field', 'widget_auto_fill', 'attachment', 'label_check']

    // Classify by what the test actually CHECKS, not by whether it has a parent
    // prerequisite. A bare "selecting 'X' on Y field" prerequisite appears in
    // widget AND required tests too, so it must NOT, on its own, force conditional.
    return cases.map((tc) => {
      const name = String(tc?.name || '')
      const exp = String(tc?.expected_result || '')
      const merged = `${name} ${tc?.what_to_test || ''} ${exp}`.toLowerCase()
      const t = String(tc?.test_type || '').toLowerCase().trim()

      // 1) WIDGET — highest precedence. Explicit tag or clear intent wins and is
      //    never reachable by the conditional re-tag below.
      const isWidget =
        t === 'widget_auto_fill' ||
        /\bwidget\b/.test(merged) ||
        merged.includes('auto-fill') || merged.includes('autofill') ||
        merged.includes('auto populate') || merged.includes('auto-populate') ||
        merged.includes('gets populated') || merged.includes('field destination') ||
        merged.includes('widget data')
      if (isWidget) return { ...tc, test_type: 'widget_auto_fill' }

      // 2) ATTACHMENT — next precedence.
      const isAttachment =
        t === 'attachment' ||
        merged.includes('attachment') || merged.includes('upload') ||
        merged.includes('file format') || merged.includes('500kb') || merged.includes('larger than')
      if (isAttachment) return { ...tc, test_type: 'attachment' }

      // 3) GENUINE conditional — the test's primary assertion is appearance/hiding
      //    or an appears-but-optional check. Signalled by a display/hidden name or
      //    a "Displayed: No" / "Required: N/A" / "field appears|is hidden" encoding.
      const isVisibilityCheck =
        /\bconditional\s+display\b|\bdisplay\s+test\b/i.test(name) ||
        /\bdisplayed\s*:\s*no\b/i.test(exp) ||
        /\brequired\s*:\s*n\/?a\b/i.test(exp) ||
        /field\s+appears\b|is\s+hidden\b|not\s+displayed\b/i.test(exp)
      if (isVisibilityCheck) return { ...tc, test_type: 'conditional_field' }

      // 4) REQUIRED-once-visible — a required check, even when the field is
      //    revealed by a parent. Keep it required_field; do NOT collapse into
      //    conditional just because it has a parent prerequisite.
      const isRequiredCheck =
        /\brequired\s+field\s+test\b/i.test(name) ||
        /\brequired\s*:\s*yes\b/i.test(exp) ||
        /\bvalidation\s*:/i.test(exp)
      if (isRequiredCheck) return { ...tc, test_type: 'required_field' }

      // 5) Respect an explicit, already-valid tag from the model (don't let text
      //    heuristics overwrite a correct required/format/label/submit/conditional).
      if (VALID.includes(t)) return { ...tc, test_type: t }

      // 6) Last-resort inference for unlabeled cases — narrowed conditional signal
      //    (appears/shown/visible/hidden WHEN…, or required WHEN/IF…), NOT a bare
      //    parent selection.
      const conditionalLeadIn =
        /\b(appears|shown|visible|hidden)\s+(when|if)\b/.test(merged) ||
        /\brequired\s+(when|if)\b/.test(merged) ||
        merged.includes('display rule')
      if (conditionalLeadIn) return { ...tc, test_type: 'conditional_field' }

      return { ...tc, test_type: 'required_field' }
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
    const withSections = assignSectionsFromFormStructure(
      kept.length ? kept : merged,
      formStructure
    )
    return withSections
  }

  async function requestOnce(extraRules = '') {
    const envMaxSrd = Number(process.env.GROQ_GENERATE_MAX_SRD_CHARS)
    const srdCap =
      Number.isFinite(envMaxSrd) && envMaxSrd >= 4000 ? Math.floor(envMaxSrd) : null

    const payloadPlans = [
      { maxTokens: 4096, srdChars: 32000, structureChars: 8000 },
      { maxTokens: 4096, srdChars: 26000, structureChars: 6500 },
      { maxTokens: 3072, srdChars: 20000, structureChars: 5500 },
      { maxTokens: 3072, srdChars: 16000, structureChars: 4500 },
      { maxTokens: 2048, srdChars: 12000, structureChars: 4000 },
      { maxTokens: 2048, srdChars: 9000, structureChars: 3500 },
      { maxTokens: 1536, srdChars: 6500, structureChars: 3000 },
      { maxTokens: 1536, srdChars: 4500, structureChars: 2500 }
    ]

    let lastErr = null
    for (let planIdx = 0; planIdx < payloadPlans.length; planIdx += 1) {
      const plan = payloadPlans[planIdx]
      try {
        let effSrdChars = plan.srdChars
        if (srdCap) effSrdChars = Math.min(effSrdChars, srdCap)
        const srdForPrompt = trimSrdForPrompt(srdText, effSrdChars)
        console.log('[gen] plan', planIdx, '| max_tokens=', plan.maxTokens, '| srd budget=', effSrdChars, '| srd sent=', srdForPrompt.length, '/ full', String(srdText || '').length) // TEMP DIAGNOSTIC
        const compactStructure = compactStructureForPrompt(formStructure, plan.structureChars)
        const structureSection = compactStructure
          ? `=== FORM STRUCTURE (JSON — match field names; rules only from SRD) ===\n${compactStructure}`
          : '=== FORM STRUCTURE (JSON) ===\nNot provided.'

        const userBody = `Generate the full JSON array of test cases for automation.

=== REQUIREMENTS DOCUMENT (SRD) ===
${srdForPrompt}

${structureSection}

${extraRules ? `Additional instructions:\n${extraRules}\n` : ''}
Respond with ONLY one JSON array. Each object must have: name, what_to_test, expected_result, test_type, section (the navigable step, forward-filled, never the Block, never blank/"General"), block (the sub-grouping, reset on each new Section, "" if the field has no block).
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
        let viaRepair = false // TEMP DIAGNOSTIC
        try {
          parsed = parseJsonArrayOrThrow(response)
        } catch {
          viaRepair = true // TEMP DIAGNOSTIC
          parsed = await repairResponseToJsonArray(response)
        }
        console.log('[gen] response chars=', response.length, '| parsed cases=', Array.isArray(parsed) ? parsed.length : 0, '| viaRepair=', viaRepair) // TEMP DIAGNOSTIC
        return retagSpecialCaseTypes(normalizeCases(parsed))
      } catch (err) {
        lastErr = err
        // If every provider is rate-limited, don't fire the payload-size retry
        // loop — that would re-run the whole Gemini→Groq→Groq cascade up to 8x.
        if (isGroqRateLimitError(err)) throw err
        if (isGroqRequestTooLargeError(err)) {
          if (planIdx + 1 < payloadPlans.length) await sleep(2300)
          continue
        }
        throw err
      }
    }
    const detail = groqApiMessage(lastErr) || String(lastErr?.message || 'unknown')
    throw new Error(
      `Could not complete generation within Groq limits (payload size or tokens-per-minute). The app already retried with smaller SRD chunks. Options: shorten the SRD text, set GROQ_GENERATE_MAX_SRD_CHARS (e.g. 20000), use a smaller model via GROQ_MODEL / GROQ_FALLBACK_MODEL, wait one minute and retry, or upgrade your Groq tier. Last error: ${detail.slice(
        0,
        420
      )}`
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
            { "sections": [{ "name": "", "order": 0 }], "fields": [{ "id": "", "name": "", "label": "", "type": "", "required": false, "selector": "", "section": "", "errorSelector": "", "formatErrorSelector": "", "optional": false }], "submitButton": { "id": "", "selector": "" }, "successSelector": "" }.
            sections: ordered list of visible form section/step titles discovered on the page (wizard steps, h1.section-title blocks, etc.). Each field must include "section" with the heading/block it belongs to.
            successSelector: optional single CSS selector for a visible success confirmation after submit (toast, alert, banner). Omit or use "" if unknown.
            errorSelector / formatErrorSelector: optional per-field CSS selectors for validation messages when inferable from the field list; otherwise omit or "".
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
    const safeFields = fieldsArray.map((f, idx) => {
      const row = {
        id: String(f?.id || '').trim(),
        name: String(f?.name || '').trim(),
        label: String(f?.label || '').trim(),
        type: String(f?.type || 'text').trim().toLowerCase() || 'text',
        required: Boolean(f?.required),
        selector: String(
          f?.selector || (f?.id ? `#${String(f.id || '').trim()}` : '')
        ).trim() || `field_${idx}`
      }
      const section = String(f?.section || '').trim()
      if (section) row.section = section
      // Give block the SAME structured reinforcement section has: if the form structure
      // carries a per-field block/sub-group, surface it to the model alongside section.
      // When the structure has no block, this stays empty and is simply omitted.
      const block = String(f?.block || '').trim()
      if (block) row.block = block
      const err = String(f?.errorSelector || '').trim()
      const fmt = String(f?.formatErrorSelector || '').trim()
      if (err) row.errorSelector = err
      if (fmt) row.formatErrorSelector = fmt
      if (f?.optional === true) row.optional = true
      return row
    })
    const submitButton = {
      id: String(parsed?.submitButton?.id || '').trim(),
      selector: String(parsed?.submitButton?.selector || '').trim()
    }
    const successSelector = String(parsed?.successSelector || '').trim()
    const sections = Array.isArray(parsed?.sections)
      ? parsed.sections
          .map((row, idx) => ({
            name: String(row?.name || row?.title || row || '').trim(),
            order: Number.isFinite(Number(row?.order)) ? Number(row.order) : idx
          }))
          .filter(row => row.name)
      : []

    return {
      ...(sections.length ? { sections } : {}),
      fields: safeFields,
      submitButton,
      ...(successSelector ? { successSelector } : {})
    }
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