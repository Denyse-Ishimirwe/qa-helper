# QA Helper — Chrome Web Store Submission Guide

Files you need (both in the qa-helper-1 folder):
- `qa-helper-extension-v1.0.zip` — the extension package to upload
- `store-screenshot-1280x800.png` — the required screenshot

---

## Step 1 — Create a developer account (once, $5)

1. Go to https://chrome.google.com/webstore/devconsole
2. Sign in with your Google account (mugishac777@gmail.com or a work account)
3. Accept the developer agreement and pay the one-time $5 registration fee

## Step 2 — Upload the extension

1. Click **+ New item**
2. Upload `qa-helper-extension-v1.0.zip`

## Step 3 — Store listing tab (copy-paste below)

**Description:**
```
QA Helper runs automated test cases against your team's form applications.
It works together with the QA Helper web app: you define test cases in your
QA Helper project, then this extension executes them in the browser — filling
fields, clicking Continue, and reading validation messages — and uploads
pass/fail results back to your project dashboard.

Test types supported: required-field checks, format validation, conditional
field display, label checks, attachment uploads, widget auto-fill, and full
successful-submit flows.

This is an internal QA tool. It only activates on the team's configured test
portals and localhost, and requires a QA Helper account to use.
```

**Category:** Developer Tools
**Language:** English

**Store icon:** it's taken from the ZIP automatically (icon128.png).
**Screenshots:** upload `store-screenshot-1280x800.png`.
(You can also add real screenshots of the popup — nice but not required.)

## Step 4 — Privacy tab (copy-paste below)

**Single purpose description:**
```
Executes predefined QA test cases against forms on the Irembo sandbox portal
and reports pass/fail results to the user's QA Helper project dashboard.
```

**Permission justifications:**

- **activeTab** — `Lets the user run a form scan or test suite on the tab they
  are currently viewing after clicking the extension.`
- **scripting** — `Injects the test-runner content script into the Irembo
  portal page so it can fill fields, click buttons, and read validation
  messages during a test run.`
- **tabs** — `Tracks the tab a test run started in so the long-running test
  suite can keep sending test commands to the correct tab and detect page
  navigation between form sections.`
- **storage** — `Stores the user's QA Helper login token, the active run
  state, and cached engine settings so a test run can resume if the popup
  closes.`
- **cookies** — `Reads the user's own session cookies for the Irembo sandbox
  portal so the backend scanner can analyze the same logged-in form the user
  sees.`
- **Host permission justification:** `The extension automates form testing
  only on the Irembo sandbox portals (citizen-portal / keycloak
  .sandbox.iremboinc.com), on localhost during development, and communicates
  with the QA Helper backend (qa-helper-1.onrender.com) to fetch test cases
  and upload results.`

**Remote code:** answer **No, I am not using remote code.**
(The extension downloads JSON settings only — that is data, not code.)

**Data usage disclosures — tick these:**
- ☑ Authentication information (the QA Helper login token; session cookies for the portal)
- ☑ Website content (form field labels and validation messages read during test runs)

Then tick the three certification checkboxes (data is not sold, not used for
unrelated purposes, not used for creditworthiness).

## Step 5 — Distribution tab

- **Visibility:** **Unlisted** — only people with the link can install.

## Step 6 — Submit

1. Click **Submit for review**
2. Review typically takes 1–3 days (you'll get an email)
3. When approved, open the item in the developer console → copy the store
   link → share it with your team. They click "Add to Chrome" — done.

## After it's live — your update workflow

- Change test cases → QA Helper web app (instant, nothing to do)
- Tune selectors/timeouts/test values → edit `extension-config.js`, merge to
  main, Render redeploys (instant on next run)
- New extension capability → bump `"version"` in manifest.json, re-zip, upload
  in the developer console, submit — users auto-update within hours of approval

## Notes

- Local dev quirk: if a locally running backend on port 3000 answers the
  health check, the extension prefers it. Restart your local server after
  pulling new backend code, or stop it to force the extension to use Render.
