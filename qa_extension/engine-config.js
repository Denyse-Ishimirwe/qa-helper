/* global chrome */
// QA Helper — remote-tunable engine settings.
//
// This file holds the DEFAULT copy of every tunable setting (selectors, timeouts,
// test values, thresholds). On each run, background.js downloads the latest copy
// from the backend (GET /api/extension-config) and sends it here via the
// QA_HELPER_SET_ENGINE_CONFIG message. If the backend is unreachable, these
// defaults are used, so a run never fails because of the config download.
//
// IMPORTANT (Chrome MV3): only DATA lives here / on the backend — never code.

;(function () {
  if (globalThis.QA_ENGINE) return // guard against double injection

  const DEFAULTS = {
    version: 1,

    timeouts: {
      // getVisibleValidationEntriesWithRetry
      validationInitialWaitMs: 600,
      validationMaxMs: 800,
      validationStepMs: 90,
      validationQuickInitialWaitMs: 180,
      validationQuickMaxMs: 360,
      validationQuickStepMs: 60,
      // ng-select option polling (selectFirstNonEmptyNgSelect)
      ngSelectOptionsMaxWaitMs: 6000,
      ngSelectOptionsStepMs: 300,
      // How long the new section may take to render after Continue before the
      // advance is reported as failed
      sectionReadyMs: 4000,
      // background.js per-test-case caps (ms)
      perTestCaseDefaultMs: 180000,
      perTestCaseByType: {
        successful_submit: 300000,
        conditional_display: 240000,
        conditional_required: 240000,
        conditional_field: 240000,
        required_field: 180000,
        format_validation: 180000,
        label_check: 15000
      }
    },

    selectors: {
      // Where validation/error messages appear on the portal
      validationMessages: [
        '.invalid-feedback',
        'formly-validation-message',
        'mat-error',
        '.mat-mdc-form-field-error',
        '.mdc-text-field-helper-text--validation-msg',
        '.text-danger',
        '[class*="validation-message"]',
        '.ng-star-inserted .text-danger'
      ],
      // Field-container-scoped error messages (required_field flow)
      requiredFieldContainerMsg: [
        '.invalid-feedback',
        'formly-validation-message',
        'mat-error',
        '.mat-mdc-form-field-error',
        '.mdc-text-field-helper-text--validation-msg',
        '.text-danger',
        '[class*="validation-message"]'
      ],
      // Date-picker day cells across the widget libraries the portal uses
      datePickerDayCells: [
        '.mat-calendar-body-cell-content',
        '.mat-calendar-body-cell',
        '.day:not(.old):not(.new)',
        '.ngb-dp-day div[role="button"]',
        '.ngb-dp-day',
        '[role="gridcell"] button',
        '[role="gridcell"]',
        '.datepicker td:not(.disabled):not(.off) button',
        '.datepicker td:not(.disabled):not(.off)'
      ],
      // ng-select / listbox dropdown options
      ngSelectOptions: [
        '.ng-dropdown-panel .ng-option',
        '[role="listbox"] [role="option"]',
        '.ng-option',
        '[role="option"]'
      ]
    },

    // Run orchestration (used by background.js)
    run: {
      // Max Continue clicks per run — generous so forms with many wizard steps
      // are fully traversed; the loop still exits when Continue stops working.
      maxSectionAdvances: 10,
      // Settle time before retrying a failed section advance once.
      advanceRetryDelayMs: 1800
    },

    // Rwanda administrative location cascade, outermost first
    locationCascadeSteps: ['district', 'sector', 'cell', 'village', 'province'],

    // Upload modal menu entries (case-insensitive regex source strings)
    uploadSourceMenuPatternStrings: {
      previous: ['previous\\s+uploaded\\s+documents?', 'previously\\s+uploaded'],
      certificates: ['my\\s+certificates?'],
      device: ['upload\\s+from\\s+device', 'from\\s+(?:your\\s+)?device']
    },

    // Field-target matching thresholds (minAcceptScoreForDeclaredField)
    matching: {
      minAcceptScores: {
        threeOrMoreWords: 36,
        twoWords: 26,
        oneLongWord: 20,
        oneShortWord: 14,
        fallback: 10
      }
    },

    // Values typed to INTENTIONALLY break a format rule (format_validation)
    invalidValues: {
      lettersOnlyViolation: '12345',
      numbersOnlyViolation: 'abcdef',
      email: 'notanemail',
      phone: 'abcdef',
      fallback: 'INVALID123!@#'
    },

    // Safe values typed when filling a field with VALID data
    validValues: {
      email: 'test@example.com',
      phone: '0781234567',
      number: '123',
      name: 'John',
      url: 'https://example.com',
      fallback: 'ValidInput'
    }
  }

  function clone(v) {
    return JSON.parse(JSON.stringify(v))
  }

  // Merge `src` over `target`, MUTATING target's arrays/objects in place so any
  // alias taken before the remote config arrived (e.g. const STEPS = QA_ENGINE.x)
  // still sees fresh values afterwards.
  function mergeInPlace(target, src) {
    if (!src || typeof src !== 'object') return
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined || v === null) continue
      if (Array.isArray(v)) {
        if (Array.isArray(target[k])) {
          target[k].length = 0
          target[k].push(...v)
        } else {
          target[k] = v.slice()
        }
      } else if (typeof v === 'object') {
        if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {}
        mergeInPlace(target[k], v)
      } else {
        target[k] = v
      }
    }
  }

  function compileUploadPatterns(engine) {
    if (!engine.uploadSourceMenuPatterns) engine.uploadSourceMenuPatterns = {}
    const out = engine.uploadSourceMenuPatterns
    for (const key of Object.keys(out)) delete out[key]
    for (const [key, sources] of Object.entries(engine.uploadSourceMenuPatternStrings || {})) {
      out[key] = (Array.isArray(sources) ? sources : [])
        .map(s => {
          try {
            return new RegExp(String(s), 'i')
          } catch {
            return null // a bad pattern from the server must never crash a run
          }
        })
        .filter(Boolean)
    }
  }

  const QA_ENGINE = clone(DEFAULTS)
  compileUploadPatterns(QA_ENGINE)
  globalThis.QA_ENGINE = QA_ENGINE
  globalThis.QA_ENGINE_DEFAULTS = DEFAULTS

  globalThis.applyQaEngineConfig = function applyQaEngineConfig(remote) {
    if (!remote || typeof remote !== 'object') return false
    try {
      mergeInPlace(QA_ENGINE, remote)
      compileUploadPatterns(QA_ENGINE)
      console.log('[QA config] applied remote engine config, version:', QA_ENGINE.version)
      return true
    } catch (err) {
      console.warn('[QA config] failed to apply remote config, using defaults:', err?.message)
      return false
    }
  }
})()
