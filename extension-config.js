// QA Helper — remote settings for the Chrome extension.
//
// The extension downloads this at the start of every run (GET /api/extension-config).
// EDIT VALUES HERE and redeploy the backend — every installed extension picks the
// changes up on its next run. No extension republish needed.
//
// Tip: bump "version" whenever you change something; the extension logs it in the
// browser console so you can confirm which config a run used.

export const EXTENSION_CONFIG = {
  version: 1,

  timeouts: {
    validationInitialWaitMs: 600,
    validationMaxMs: 800,
    validationStepMs: 90,
    validationQuickInitialWaitMs: 180,
    validationQuickMaxMs: 360,
    validationQuickStepMs: 60,
    ngSelectOptionsMaxWaitMs: 6000,
    ngSelectOptionsStepMs: 300,
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

  // Rwanda administrative location cascade, outermost first
  locationCascadeSteps: ['district', 'sector', 'cell', 'village', 'province'],

  // Upload modal menu entries — regex SOURCE strings (compiled with 'i' flag in the extension)
  uploadSourceMenuPatternStrings: {
    previous: ['previous\\s+uploaded\\s+documents?', 'previously\\s+uploaded'],
    certificates: ['my\\s+certificates?'],
    device: ['upload\\s+from\\s+device', 'from\\s+(?:your\\s+)?device']
  },

  // Field-target matching thresholds
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
