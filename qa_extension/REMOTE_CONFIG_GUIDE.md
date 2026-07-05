# QA Helper — "Host Once, Update from Backend" Refactor Guide

## Where you stand today (good news)

Your architecture is already ~70% of the way there:

- **Test cases are already remote.** `background.js` fetches them from
  `/api/projects/:id/extension-test-cases` and `content.js` interprets them by
  `test_type` (`required_field`, `format_validation`, `conditional_field`,
  `label_check`, `attachment`, `widget_auto_fill`, `successful_submit`, ...).
  Adding/changing test cases already requires **no extension update**.

- **What still forces a republish:** the *engine tuning* baked into `content.js`
  (5,595 lines): ~133 hardcoded selector call sites, ~105 hardcoded timeouts,
  matching heuristics, and constants like `LOCATION_CASCADE_STEPS`,
  `UPLOAD_SOURCE_MENU_PATTERNS`, `REQUIRED_FIELD_CONTAINER_MSG_SEL`, the
  invalid-value generator in `getInvalidValueForFormat()`, and score thresholds
  in `minAcceptScoreForDeclaredField()`.

When the Irembo portal changes its DOM (new CSS classes, new modal layout),
you currently must edit `content.js` and republish. The fix: move those
tunables to the backend as a versioned JSON config.

## The rule you must respect (Chrome MV3)

- ✅ Allowed: fetching **JSON data/config** and interpreting it.
- ❌ Forbidden: fetching **JavaScript** and executing it (`eval`, `new Function`,
  injecting remote `<script>`). This gets you rejected/delisted from the store.

So: selectors, patterns, timeouts, value tables → remote JSON.
New *logic* (a genuinely new action/algorithm) → still a republish, but rare.

---

## Step 1 — Add a config endpoint to your backend

`GET /api/extension-config` returning versioned JSON:

```json
{
  "version": 3,
  "minEngineVersion": "1.0",
  "timeouts": {
    "validationRetryMs": 4500,
    "widgetSideEffectMs": 2800,
    "cascadeStepMs": 2400,
    "perTestCaseMs": 180000
  },
  "selectors": {
    "validationMessages": [".invalid-feedback", ".error-message", "[role=alert]"],
    "requiredFieldContainerMsg": ["...move REQUIRED_FIELD_CONTAINER_MSG_SEL here..."],
    "continueButton": ["button[type=submit]", "..."],
    "ngSelectOption": ["...move optionSelectors (content.js ~line 2716) here..."],
    "datePickerDay": ["...move daySelectors (~line 1460) here..."]
  },
  "locationCascadeSteps": ["district", "sector", "cell", "village", "province"],
  "uploadSourceMenuPatterns": { "...move UPLOAD_SOURCE_MENU_PATTERNS here...": "" },
  "matching": {
    "minAcceptScores": { "default": 3, "idLike": 4 },
    "genericRequiredPhrases": ["is required", "this field is required"]
  },
  "invalidValuesByFormat": {
    "email": "not-an-email",
    "phone": "abc123",
    "nid": "111"
  },
  "validValuesByKind": {
    "text": "Test Value",
    "email": "qa.helper@test.com"
  }
}
```

Serve it from a DB table or even a JSON file in your backend repo — the point
is you can redeploy the backend (or edit a DB row) without touching the extension.

## Step 2 — Fetch + cache the config in the extension

In `background.js` (service worker), fetch on startup and before each run;
cache in `chrome.storage.local` so the extension still works offline/if the
backend is briefly down:

```js
const DEFAULT_ENGINE_CONFIG = { /* current hardcoded values as fallback */ }

async function getEngineConfig(apiBase, token) {
  try {
    const res = await fetch(`${apiBase}/api/extension-config`, { headers: authHeaders(token) })
    if (res.ok) {
      const cfg = await res.json()
      await chrome.storage.local.set({ engineConfig: cfg })
      return cfg
    }
  } catch { /* fall through to cache */ }
  const { engineConfig } = await chrome.storage.local.get('engineConfig')
  return engineConfig || DEFAULT_ENGINE_CONFIG
}
```

Pass it to the content script with the run message (you already send messages
per test case), or send a `SET_ENGINE_CONFIG` message right after
`injectContentIntoTab()`.

## Step 3 — Thread the config through content.js

Replace module-level constants with a config object:

```js
// top of content.js
let ENGINE = { /* same DEFAULT_ENGINE_CONFIG fallback */ }
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SET_ENGINE_CONFIG') ENGINE = msg.config
})
```

Then mechanical replacements, e.g.:

| Today (hardcoded)                         | After                                        |
|-------------------------------------------|----------------------------------------------|
| `const LOCATION_CASCADE_STEPS = [...]`     | `ENGINE.locationCascadeSteps`                 |
| `const UPLOAD_SOURCE_MENU_PATTERNS = {...}`| `ENGINE.uploadSourceMenuPatterns`             |
| `REQUIRED_FIELD_CONTAINER_MSG_SEL`         | `ENGINE.selectors.requiredFieldContainerMsg`  |
| `timeoutMs = 4500` (validation retry)      | `ENGINE.timeouts.validationRetryMs`           |
| literals in `getInvalidValueForFormat()`   | `ENGINE.invalidValuesByFormat[format]`        |
| literals in `getSafeDefaultInputValue()`   | `ENGINE.validValuesByKind[kind]`              |
| thresholds in `minAcceptScoreForDeclaredField()` | `ENGINE.matching.minAcceptScores`       |

Do this incrementally — start with the 5–6 things that break most often when
the portal UI changes (probably validation-message selectors, ng-select option
selectors, upload modal patterns, and timeouts).

## Step 4 — Version guard

Include `minEngineVersion` in the config. On fetch, compare with
`chrome.runtime.getManifest().version`; if the installed extension is too old
for the config, show "Please update QA Helper" in the popup instead of running
with a mismatched config.

## Step 5 — Publish once, then iterate on the backend

1. Zip the extension folder (exclude this guide) and publish to the Chrome Web
   Store — **unlisted** is the right fit for an internal QA tool ($5 one-time
   developer fee, only people with the link can install, auto-updates work).
2. From then on, your day-to-day changes are:
   - New/changed **test cases** → backend DB (already works today)
   - Portal DOM changed, selector/timeout tweaks → edit `/api/extension-config`
   - New **capability** (new test_type with new logic) → extension update →
     one-click republish; users auto-update within hours.

## What can never be remote

- New permissions / host_permissions (manifest change → republish + user re-approval)
- Genuinely new algorithms (new resolution strategy, new action type)
- Anything requiring executing downloaded JS — don't do it, it's a policy ban

## Suggested order of work

1. Backend: add `/api/extension-config` serving today's hardcoded values (1–2 hrs)
2. Extension: fetch + cache + fallback in `background.js` (1 hr)
3. Extension: replace top ~6 brittle constants in `content.js` with `ENGINE.*` (2–4 hrs)
4. Test a full run locally with `Load unpacked`
5. Publish to Chrome Web Store (unlisted)
6. Migrate remaining constants opportunistically whenever one of them needs a change
