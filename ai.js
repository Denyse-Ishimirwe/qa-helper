import Groq from 'groq-sdk'
import 'dotenv/config'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

async function generateTestCases(srdText, formStructure) {
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
        what_to_test: 'Fill all required fields with valid values and submit the form.',
        expected_result: 'The form should submit successfully without validation errors.',
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
            what_to_test: `Leave "${label}" empty and submit the form.`,
            expected_result: `The form should show a required validation error for "${label}".`,
            test_type: 'required_field'
          })
        }
      }

      if (shouldGenerateFormat(type)) {
        const hasFormatCase = out.some(tc => tc.test_type === 'format_validation' && caseMentionsField(tc, key))
        if (!hasFormatCase) {
          out.push({
            name: `${label} format validation`,
            what_to_test: `Enter an invalid value in "${label}" and submit the form.`,
            expected_result: `The form should reject the invalid value for "${label}" and show a validation message.`,
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
    const list = Array.isArray(raw) ? raw : []
    return list
      .map(tc => ({
        name: String(tc?.name || '').trim(),
        what_to_test: String(tc?.what_to_test || '').trim(),
        expected_result: String(tc?.expected_result || '').trim(),
        test_type: ['required_field', 'format_validation', 'successful_submit'].includes(tc?.test_type)
          ? tc.test_type
          : 'required_field'
      }))
      .filter(tc => tc.name && tc.what_to_test && tc.expected_result)
  }

  async function requestOnce(extraRules = '') {
    const structureBlock = formStructure
      ? `
            Here is the actual structure of the form with its real fields:
            ${typeof formStructure === 'string' ? formStructure : JSON.stringify(formStructure)}
      `
      : ''

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'user',
          content: `
            You are a senior QA engineer. Your job is to read the SRD document below and generate every possible test case that can be automated on the form.

            For every field in the form, you must consider and generate test cases for ALL of the following that apply:

            1. REQUIRED FIELD TESTS — if the field is required, generate a test that leaves it empty and expects a required error message

            2. FORMAT VALIDATION TESTS — if the field has a format rule such as minimum digits, maximum digits, email format, phone format, age restriction, or date range, generate a SEPARATE test case for each individual format rule

            3. CONDITIONAL REQUIRED TESTS — if a field is only required when another field has a specific value, generate a test that first sets that condition and then leaves the conditional field empty. Always describe in what_to_test which field needs to be set first and to what value

            4. CONDITIONAL DISPLAY TESTS — if a field only appears when another field has a specific value, always describe in what_to_test that the condition must be set first before interacting with that field

            5. OPTIONAL FIELD TESTS — if a field is explicitly marked as optional or has no required validation rule, generate a test confirming that leaving it empty does not show an error

            6. WIDGET AUTO-FILL TESTS — if the SRD describes that entering a value in one field automatically populates other fields, generate a test that enters a valid value in the trigger field and checks that all the described fields get automatically filled

            7. ATTACHMENT TESTS — for every file upload or attachment field in the form, generate three separate test cases: one for when the attachment is required and left empty, one for uploading a file with a wrong format, and one for uploading a file that exceeds the maximum allowed size

            8. DISABLED FIELD TESTS — if a field is described as disabled or read-only and gets its value from another field, generate a test confirming it is auto-filled correctly when the source field is filled

            Important rules:
            - Read every single validation rule, display rule, conditional rule, and widget behavior described in the SRD
            - Generate a completely separate test case for each individual rule — never combine two rules into one test case
            - For fields that have multiple format rules, generate one test case per format rule
            - For conditional fields, always mention in what_to_test exactly which parent field needs to be set and to what value before testing the conditional field
            - Never skip attachment fields, optional fields, conditional fields, auto-fill behaviors, or disabled fields
            - Every test case must be specific and detailed enough that an automated testing tool can execute it without any guessing
            - Always include at least one successful submit test case at the end

            Requirements document:
            ${srdText}

            ${structureBlock}

            If form structure is provided, generate test cases that match those real fields and selectors.
            ${extraRules}

            Return the test cases as a JSON array like this:
            [
              {
                "name": "Test case name",
                "what_to_test": "What to test",
                "expected_result": "Expected result",
                "test_type": "required_field"
              }
            ]
            Return only the JSON array, no other text.
          `
        }
      ]
    })

    const response = completion.choices?.[0]?.message?.content || '[]'
    const cleaned = response.replace(/```json|```/g, '').trim()
    return normalizeCases(JSON.parse(cleaned))
  }

  try {
    const firstPass = await requestOnce()
    const fieldCount = getFieldCount(formStructure)
    const minimumTarget = fieldCount > 0
      ? Math.max(25, Math.min(60, fieldCount * 3))
      : 12

    if (firstPass.length >= minimumTarget) {
      return dedupeCases(buildCoverageCases(firstPass))
    }

    const secondPass = await requestOnce(
      `IMPORTANT COVERAGE RULES:
      - You must generate at least ${minimumTarget} test cases
      - Go through every single field in the form structure one by one
      - For each field check: is it required, does it have format rules, is it conditional, is it optional, is it an attachment, is it auto-filled
      - Generate a separate test case for each rule you find
      - Do not stop early — cover every field completely before moving on to the next
      - Do not generate duplicate test cases`
    )

    const richer = secondPass.length > firstPass.length ? secondPass : firstPass
    return dedupeCases(buildCoverageCases(richer))
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
        return dedupeCases(buildCoverageCases(retried))
      } catch {
        throw new Error('AI service is temporarily unavailable. Please try regenerate again in a moment.')
      }
    }

    throw err
  }
}

async function validateManualTestCase({ name, what_to_test, expected_result, srd_text }) {
  async function requestOnce() {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
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
            { "valid": true/false, "test_type": "required_field" | "format_validation" | "successful_submit", "reason": "short explanation" }

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
    const safeType = ['required_field', 'format_validation', 'successful_submit'].includes(rawType)
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
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
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
export { validateManualTestCase, analyzeFormStructure }