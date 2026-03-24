import Groq from 'groq-sdk'
import 'dotenv/config'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

async function generateTestCases(srdText, formStructure) {
  async function requestOnce() {
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
            You are a QA testing expert. Based on the following requirements document,
            generate a list of test cases. For each test case provide:
            - Test case name
            - What to test
            - Expected result
            - Test type (must be exactly one of: required_field, format_validation, successful_submit)
              - required_field: tests that an error appears when a required field is left empty
              - format_validation: tests that an error appears when a field has wrong format
              - successful_submit: tests that the form submits successfully when all fields are correct

            Requirements document:
            ${srdText}

            ${structureBlock}

            If form structure is provided, generate test cases that match those real fields and selectors.

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
    return JSON.parse(cleaned)
  }

  try {
    return await requestOnce()
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
        return await requestOnce()
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