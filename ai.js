import Groq from 'groq-sdk'
import 'dotenv/config'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

async function generateTestCases(srdText) {
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

          Requirements document:
          ${srdText}

          Return the test cases as a JSON array like this:
          [
            {
              "name": "Test case name",
              "what_to_test": "What to test",
              "expected_result": "Expected result"
            }
          ]
          Return only the JSON array, no other text.
        `
      }
    ]
  })

  const response = completion.choices[0].message.content
  const cleaned = response.replace(/```json|```/g, '').trim()
  return JSON.parse(cleaned)
}

export default generateTestCases