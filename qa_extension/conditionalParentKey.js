/* global globalThis, self */
/**
 * Shared by the service worker and the content script: parse "when parent is value"
 * from test case text and build a stable key so consecutive conditional_* cases
 * with the same parent precondition can skip re-applying the parent and skip form reset.
 */
;(function () {
  const root = typeof globalThis !== 'undefined' ? globalThis : self

  function normalizeText(v) {
    return String(v || '')
      .trim()
      .toLowerCase()
  }

  function normalizeLabelText(v) {
    return normalizeText(v)
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function sanitizeSearchLabel(v) {
    return normalizeLabelText(v)
      .replace(/\bconditional\b/g, ' ')
      .replace(/\brequired\b/g, ' ')
      .replace(/\boptional\b/g, ' ')
      .replace(/\bdisplay\b/g, ' ')
      .replace(/\btest\b/g, ' ')
      .replace(/\bformat\b/g, ' ')
      .replace(/\bvalidation\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function normalizeConditionalTrigger(raw) {
    const s = String(raw || '').trim()
    const l = normalizeText(s)
    if (l === 'yes' || l === 'no') return l === 'yes' ? 'Yes' : 'No'
    return s
  }

  function trimParentQuestionLabel(s) {
    return String(s || '')
      .trim()
      .replace(/\?+$/, '')
      .trim()
  }

  function parseConditionalSpec(tc) {
    const text = `${tc?.what_to_test || ''} ${tc?.expected_result || ''} ${tc?.name || ''}`

    const afterSelectingYesNo = text.match(
      /after\s+selecting\s+(yes|no)\s+(?:for|on)\s+(.+?)(?:\s*$|\s+and\b|\s+field\b)/i
    )
    if (afterSelectingYesNo) {
      return {
        parentLabel: trimParentQuestionLabel(afterSelectingYesNo[2]),
        triggerValue: normalizeConditionalTrigger(afterSelectingYesNo[1])
      }
    }

    const afterSelectingGeneral = text.match(
      /after\s+selecting\s+(.+?)\s+(?:for|on)\s+(.+?)(?:\s+field\b|\s+and\b|\s*$)/i
    )
    if (afterSelectingGeneral) {
      return {
        parentLabel: trimParentQuestionLabel(afterSelectingGeneral[2]),
        triggerValue: normalizeConditionalTrigger(afterSelectingGeneral[1])
      }
    }

    const haveSet = text.match(/\bhave\s+(.+?)\s+set\s+to\s+(yes|no)\b/i)
    if (haveSet) {
      return {
        parentLabel: trimParentQuestionLabel(haveSet[1]),
        triggerValue: normalizeConditionalTrigger(haveSet[2])
      }
    }

    const whenYesNo = text.match(/when\s+(.+?)\s+is\s+(yes|no)\b/i)
    if (whenYesNo) {
      return {
        parentLabel: trimParentQuestionLabel(whenYesNo[1]),
        triggerValue: normalizeConditionalTrigger(whenYesNo[2])
      }
    }

    const selectForGeneric = text.match(
      /\bselect\s+(.+?)\s+for\s+(.+?)(?:\s+and\b|\s+leave\b|\s+when\b|\s*$)/i
    )
    if (selectForGeneric) {
      const a = String(selectForGeneric[1] || '').trim()
      const b = trimParentQuestionLabel(selectForGeneric[2])
      const aNorm = normalizeText(a)
      if (aNorm === 'yes' || aNorm === 'no') {
        return { parentLabel: b, triggerValue: normalizeConditionalTrigger(a) }
      }
      return { parentLabel: b, triggerValue: a }
    }

    const whenGeneral = text.match(
      /when\s+(.+?)\s+is\s+(.+?)(?:\s+and\b|\s+attachment\b|\s+for\b|\s+field\b|\s+is\b\s+required|\s*$)/i
    )
    if (whenGeneral) {
      const rawVal = String(whenGeneral[2] || '')
        .trim()
        .replace(/\s+attachment.*$/i, '')
        .trim()
      return {
        parentLabel: trimParentQuestionLabel(whenGeneral[1]),
        triggerValue: normalizeConditionalTrigger(rawVal)
      }
    }

    const selectOn = text.match(
      /select\s*['"]?\s*(yes|no)\s*['"]?\s+on\s+(.+?)(?:\s+field\b|\s+and\b|\s*$)/i
    )
    if (selectOn) {
      return {
        parentLabel: trimParentQuestionLabel(selectOn[2]),
        triggerValue: normalizeConditionalTrigger(selectOn[1])
      }
    }

    const byWhen = text.match(/when\s+(.+?)\s+(?:is|=)\s+["']?([^"'.;,\n]+)["']?/i)
    if (byWhen) {
      return {
        parentLabel: trimParentQuestionLabel(byWhen[1]),
        triggerValue: normalizeConditionalTrigger(String(byWhen[2] || '').trim())
      }
    }
    const byIf = text.match(/if\s+(.+?)\s+(?:is|=)\s+["']?([^"'.;,\n]+)["']?/i)
    if (byIf) {
      return {
        parentLabel: trimParentQuestionLabel(byIf[1]),
        triggerValue: normalizeConditionalTrigger(String(byIf[2] || '').trim())
      }
    }
    return { parentLabel: '', triggerValue: '' }
  }

  function qaHelperParentSetupKey(tc) {
    const spec = parseConditionalSpec(tc)
    const p = sanitizeSearchLabel(trimParentQuestionLabel(spec.parentLabel))
    const t = normalizeText(spec.triggerValue)
    if (!p || !t) return ''
    return `${p}::${t}`
  }

  root.qaHelperParseConditionalSpec = parseConditionalSpec
  root.qaHelperParentSetupKey = qaHelperParentSetupKey
})()
