# QA Helper — Project Context for Cursor

> Read this file before doing anything. It contains everything you need to know about this project — what it is, how it works, what is done, and what needs to be built next.

---

## What the App Does

QA Helper is a web app that automates form testing for a QA team. Instead of manually testing every field after each developer fix, a QA tester:

1. Creates a project and uploads a requirements document (PDF or Word)
2. The AI reads the document and generates a list of test cases
3. The tester reviews, edits, adds to, or deletes the test cases
4. Clicks Run Tests — Playwright opens the form in a real browser, fills in fields, clicks submit, and checks results
5. Each test case gets a Pass or Fail result shown in the app

---

## Tech Stack


| Tool                    | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| React + Vite            | Frontend UI (runs on port 5173)                 |
| Node.js + Express       | Backend server and API (runs on port 3000)      |
| SQLite (better-sqlite3) | Database — stores projects and test cases       |
| Groq API (Llama 3.3)    | AI that reads SRD and generates test cases      |
| Playwright (Chromium)   | Opens real browser and automates form testing   |
| Multer                  | Handles file uploads (SRD documents)            |
| Mammoth                 | Extracts text from Word documents (.doc, .docx) |
| pdfreader               | Extracts text from PDF files                    |


---

## Project Location

```
C:/Users/Hp/Desktop/qa-helper

```

---

## File Structure

### Backend (project root)


| File                        | What It Does                                                     |
| --------------------------- | ---------------------------------------------------------------- |
| `server.js`                 | Main Express server. All API endpoints live here.                |
| `db.js`                     | Sets up SQLite database with projects and test_cases tables.     |
| `ai.js`                     | Calls Groq API to generate test cases from SRD text.             |
| `upload.js`                 | Extracts text from uploaded PDF and Word files.                  |
| `multer.js`                 | Handles file upload configuration and saves to uploads/ folder.  |
| `runTests.js`               | Playwright script — opens the form and runs all test cases.      |
| `testform.html`             | Simple registration form used for Month 1 testing.               |
| `qahelper.db`               | SQLite database file.                                            |
| `.env`                      | Contains GROQ_API_KEY.                                           |
| `RegistrationForm_SRD.docx` | The SRD document matching testform.html — use this when testing. |


### Frontend (src/ folder)


| File                              | What It Does                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `App.jsx` + `App.css`             | Root component. Handles login and shows Dashboard or login page.                                 |
| `Dashboard.jsx` + `Dashboard.css` | Main projects page. Table with 3-dot menu (edit/delete), create project modal, filter by status. |
| `TestPanel.jsx` + `TestPanel.css` | Side panel for a project. Generate, view, edit, delete, run test cases.                          |
| `main.jsx`                        | React entry point.                                                                               |
| `index.css`                       | Global styles (empty).                                                                           |


---

## How to Run

```bash
# Terminal 1 — start backend
node server.js

# Terminal 2 — start frontend
npm run dev

```

- Backend: http://localhost:3000
- Frontend: http://localhost:5173
- Test form: http://localhost:3000/testform.html

---

## Environment Variables

Create a `.env` file in the project root:

```
GROQ_API_KEY=your_groq_api_key_here

```

Get a free key at: https://console.groq.com

---

## Database Tables

### projects


| Column      | Type    | Description                                |
| ----------- | ------- | ------------------------------------------ |
| id          | INTEGER | Auto-incrementing primary key              |
| name        | TEXT    | Project name                               |
| form_url    | TEXT    | URL of the form to test                    |
| srd_text    | TEXT    | Extracted text from uploaded SRD           |
| status      | TEXT    | Not Tested / In Progress / Passed / Failed |
| last_tested | TEXT    | Datetime of last test run                  |
| created_at  | TEXT    | Datetime project was created               |


### test_cases


| Column          | Type    | Description                                            |
| --------------- | ------- | ------------------------------------------------------ |
| id              | INTEGER | Auto-incrementing primary key                          |
| project_id      | INTEGER | Foreign key linking to projects                        |
| name            | TEXT    | Test case name                                         |
| what_to_test    | TEXT    | What the test does                                     |
| expected_result | TEXT    | What should happen if form works correctly             |
| test_type       | TEXT    | required_field / format_validation / successful_submit |
| status          | TEXT    | Not Run / Passed / Failed                              |
| created_at      | TEXT    | Datetime created                                       |


---

## API Endpoints

All endpoints on http://localhost:3000


| Method | Endpoint                     | What It Does                               |
| ------ | ---------------------------- | ------------------------------------------ |
| GET    | /api/projects                | Get all projects                           |
| POST   | /api/projects                | Create project (with SRD file upload)      |
| PUT    | /api/projects/:id            | Edit project (name, URL, optional new SRD) |
| DELETE | /api/projects/:id            | Delete project and all its test cases      |
| POST   | /api/projects/:id/generate   | AI generates test cases from SRD           |
| POST   | /api/projects/:id/run        | Run all test cases with Playwright         |
| GET    | /api/projects/:id/test_cases | Get all test cases for a project           |
| POST   | /api/projects/:id/test_cases | Add a test case manually                   |
| PUT    | /api/test_cases/:id          | Edit a test case                           |
| DELETE | /api/test_cases/:id          | Delete a test case                         |


---

## Test Form Details (testform.html)

The test form is a simple registration form with these fields:


| Field           | HTML id                | Type                                   |
| --------------- | ---------------------- | -------------------------------------- |
| First Name      | `#firstName`           | Text input                             |
| Last Name       | `#lastName`            | Text input                             |
| Date of Birth   | `#dob`                 | Date input                             |
| Gender          | `#gender`              | Dropdown (male/female/other)           |
| Nationality     | `#nationality`         | Text input                             |
| ID Number       | `#idNumber`            | Text input                             |
| Submit button   | `#submitBtn`           | Button                                 |
| Success message | `#successMsg`          | Div (gets class `visible` on success)  |
| Error messages  | `.error-msg`           | Span (gets class `visible` when shown) |
| ID format error | `#idNumberFormatError` | Span (gets class `visible` when shown) |


**ID Number validation:** Must be exactly 16 digits starting with 1 (Rwandan format). Example valid ID: `1199880012345678`. Example invalid ID: `9999999999999999`.

---

## How runTests.js Works

Playwright uses the `test_type` field on each test case to decide what to do — NO keyword matching on test case names:

### required_field

- Clicks submit with nothing filled in
- Checks that `.error-msg.visible` elements appear
- Pass = at least one error message visible

### format_validation

- Fills all fields correctly except ID number (uses `9999999999999999` — invalid, does not start with 1)
- Clicks submit
- Checks that `#idNumberFormatError.visible` appears
- Pass = format error message visible

### successful_submit

- Fills all fields correctly including valid ID `1199880012345678`
- Clicks submit
- Checks that `#successMsg.visible` appears
- Pass = success message visible

---

## Progress Status

### ✅ Week 1 — COMPLETE

- Login page with validation
- Dashboard with project table and status filters
- Create / edit / delete projects
- SRD file upload and text extraction
- SQLite database

### ✅ Week 2 — COMPLETE

- AI generates test cases from SRD
- Side panel (TestPanel) to review test cases
- Edit, delete, add test cases manually
- Regenerate clears old cases first
- Project status updates (Not Tested → In Progress)
- Edit project (name, URL, new SRD)
- New SRD upload resets test cases and status
- 3-dot dropdown menu (⋯) for edit and delete
- Confirm popup before any delete

### 🔄 Week 3 — IN PROGRESS

**Working:**

- Playwright opens form, fills fields, clicks submit
- Pass/fail results shown per test case with colour coding
- Summary bar (Passed / Failed / Not Run counts)
- Project status updates to Passed or Failed after run

**Still needs to be done:**

- Apply the 4 updated files below (ai.js, db.js, runTests.js, server.js changes)
- Verify fail case shows correctly

### ⏳ Week 4 — NOT STARTED

- Store each run's results in a test_runs table
- Compare current run with previous run
- Show what changed: fixed / still failing / newly broken
- Plain English summary
- Excel export with full report

---

## What Needs to Be Done Now (Start Here)

### Step 1 — Update ai.js

Update the Groq prompt to ask the AI to also return a `test_type` for each test case. The AI must return exactly one of: `required_field`, `format_validation`, `successful_submit`.

Add this to the prompt:

```
- Test type (must be exactly one of: required_field, format_validation, successful_submit)
  - required_field: tests that an error appears when a required field is left empty
  - format_validation: tests that an error appears when a field has wrong format
  - successful_submit: tests that the form submits successfully when all fields are correct

```

Update the JSON format to include `"test_type": "required_field"`.

---

### Step 2 — Update db.js

Add `test_type TEXT DEFAULT 'required_field'` to the test_cases table definition.

Also add a safe migration for existing databases:

```js
try {
  db.exec(`ALTER TABLE test_cases ADD COLUMN test_type TEXT DEFAULT 'required_field'`)
} catch {
  // Column already exists — ignore
}

```

---

### Step 3 — Update runTests.js

Replace all keyword matching logic with clean test_type logic:

```js
const testType = tc.test_type || 'required_field'

if (testType === 'required_field') {
  // click submit with nothing filled, check .error-msg.visible count > 0
}
else if (testType === 'format_validation') {
  // fill all fields correctly except idNumber = '9999999999999999'
  // check #idNumberFormatError.visible count > 0
}
else if (testType === 'successful_submit') {
  // fill all fields correctly, idNumber = '1199880012345678'
  // check #successMsg.visible count > 0
}

```

---

### Step 4 — Update server.js

In the POST /api/projects/:id/generate endpoint, update the INSERT to include test_type:

```js
const insertTestCase = db.prepare(
  'INSERT INTO test_cases (project_id, name, what_to_test, expected_result, test_type) VALUES (?, ?, ?, ?, ?)'
)

for (const tc of testCases) {
  const testType = ['required_field', 'format_validation', 'successful_submit'].includes(tc.test_type)
    ? tc.test_type
    : 'required_field'
  insertTestCase.run(req.params.id, tc.name, tc.what_to_test, tc.expected_result, testType)
}

```

---

### Step 5 — Test it

1. Restart the server
2. Delete the existing project
3. Create a new project using `RegistrationForm_SRD.docx` and form URL `http://localhost:3000/testform.html`
4. Click Generate — confirm test cases have test_type values
5. Click Run Tests — confirm pass/fail results appear correctly
6. Deliberately break one test case to confirm fail shows red

---

## Important Rules (Do Not Break These)

- Always delete test_cases before deleting a project (FOREIGN KEY constraint)
- When a new SRD is uploaded on edit, delete test cases and reset status to `Not Tested` and last_tested to `Never`
- When regenerating, delete old test cases before inserting new ones
- File names are case sensitive on Windows — keep `TestPanel.jsx`, `Dashboard.jsx` exactly as named
- The login is frontend only — no real authentication
- Playwright runs with `headless: false` so the browser is visible during testing
- All `localhost:3000` references in the frontend will need updating when deploying (Month 2 task)
- Never use `confirm()` for delete confirmations — use the custom modal already built
- The `test_type` field must always be one of: `required_field`, `format_validation`, `successful_submit`

