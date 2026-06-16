/** Shared helpers for form-section grouping and ordering. */

export const GENERAL_SECTION = 'General'
export const SUBMIT_SECTION = 'Submit'

export function normalizeSectionName(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isUnsetSection(name) {
  const n = normalizeSectionName(name).toLowerCase()
  return !n || n === GENERAL_SECTION.toLowerCase()
}

export function sectionsMatch(a, b) {
  const na = normalizeSectionName(a).toLowerCase()
  const nb = normalizeSectionName(b).toLowerCase()
  if (!na && !nb) return true
  return na === nb
}

function parseSectionFromExpectedResult(expectedResult) {
  const exp = String(expectedResult || '')
  const fromExp = (exp.match(/;\s*section\s*:\s*([^;]+)/i) || [])[1]
  return fromExp ? normalizeSectionName(fromExp) : ''
}

function parseSectionFromWhatToTest(whatToTest) {
  const wtt = String(whatToTest || '')
  const fromWtt = (wtt.match(/\bin\s+the\s+(.+?)\s+section\b/i) || [])[1]
  return fromWtt ? normalizeSectionName(fromWtt) : ''
}

/** Infer section from stored value, label_check encoding, or what_to_test prose. */
export function inferSectionFromTestCase(tc) {
  const explicit = normalizeSectionName(tc?.section)
  if (!isUnsetSection(explicit)) return explicit

  const fromExp = parseSectionFromExpectedResult(tc?.expected_result)
  if (fromExp) return fromExp

  const fromWtt = parseSectionFromWhatToTest(tc?.what_to_test)
  if (fromWtt) return fromWtt

  if (String(tc?.test_type || '').trim() === 'successful_submit') return SUBMIT_SECTION
  return GENERAL_SECTION
}

export function parseFormStructure(raw) {
  if (raw == null || raw === '') return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Ordered section names from analyse JSON, else first-seen order on fields. */
export function extractSectionsFromFormStructure(formStructure) {
  const parsed = parseFormStructure(formStructure)
  if (!parsed || typeof parsed !== 'object') return []

  const fromMeta = Array.isArray(parsed.sections) ? parsed.sections : []
  if (fromMeta.length > 0) {
    return fromMeta
      .map((row, idx) => ({
        name: normalizeSectionName(row?.name || row?.title || row),
        order: Number.isFinite(Number(row?.order)) ? Number(row.order) : idx
      }))
      .filter(row => row.name)
      .sort((a, b) => a.order - b.order)
      .map(row => row.name)
  }

  const seen = new Set()
  const order = []
  const fields = Array.isArray(parsed.fields) ? parsed.fields : []
  for (const field of fields) {
    const name = normalizeSectionName(field?.section)
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    order.push(name)
  }
  return order
}

export function buildSectionOrder(testCases, formStructure) {
  const fromForm = extractSectionsFromFormStructure(formStructure)
  const seen = new Set()
  const order = []

  for (const name of fromForm) {
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    order.push(name)
  }

  for (const tc of Array.isArray(testCases) ? testCases : []) {
    const name = inferSectionFromTestCase(tc)
    if (isUnsetSection(name)) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    order.push(name)
  }

  const submitIdx = order.findIndex(s => sectionsMatch(s, SUBMIT_SECTION))
  if (submitIdx >= 0 && submitIdx < order.length - 1) {
    const [submit] = order.splice(submitIdx, 1)
    order.push(submit)
  }

  const generalIdx = order.findIndex(s => sectionsMatch(s, GENERAL_SECTION))
  if (generalIdx >= 0 && generalIdx < order.length - 1) {
    const [general] = order.splice(generalIdx, 1)
    order.push(general)
  }

  return order.length ? order : [GENERAL_SECTION]
}

export function groupTestCasesBySection(testCases, sectionOrder) {
  const order = sectionOrder?.length ? sectionOrder : buildSectionOrder(testCases, null)
  const buckets = new Map()

  for (const name of order) {
    buckets.set(name.toLowerCase(), { section: name, cases: [] })
  }

  for (const tc of Array.isArray(testCases) ? testCases : []) {
    const sec = inferSectionFromTestCase(tc)
    const key = sec.toLowerCase()
    if (!buckets.has(key)) buckets.set(key, { section: sec, cases: [] })
    buckets.get(key).cases.push(tc)
  }

  const result = []
  const used = new Set()
  for (const name of order) {
    const key = name.toLowerCase()
    if (!buckets.has(key)) continue
    const bucket = buckets.get(key)
    if (isUnsetSection(bucket.section) && bucket.cases.length === 0) continue
    result.push(bucket)
    used.add(key)
  }
  for (const [key, bucket] of buckets) {
    if (!used.has(key)) result.push(bucket)
  }
  return result
}

/** label_check first, then other types, successful_submit last within a section. */
export function sortCasesWithinSection(cases) {
  const labelChecks = []
  const rest = []
  const submit = []
  for (const tc of Array.isArray(cases) ? cases : []) {
    const tt = String(tc?.test_type || '').trim()
    if (tt === 'label_check') labelChecks.push(tc)
    else if (tt === 'successful_submit') submit.push(tc)
    else rest.push(tc)
  }
  return [...labelChecks, ...rest, ...submit]
}

export function orderTestCasesBySection(testCases, formStructure) {
  const enriched = enrichTestCasesWithSections(testCases, formStructure)
  const sectionOrder = buildSectionOrder(enriched, formStructure)
  return groupTestCasesBySection(enriched, sectionOrder).flatMap(group =>
    sortCasesWithinSection(group.cases)
  )
}

/** Field label tokens stripped from standard QA test naming patterns. */
export function fieldLabelTokens(tc) {
  const name = String(tc?.name || '').trim()
  if (!name) return []

  let head = name
  head = head.replace(/^test\s+(required\s+field|format\s+validation|optional\s+field|conditional\s+(required|display)|widget\s+auto\s+fill|attachment|disabled\s+field)\s*:\s*/i, '').trim()
  head = head.replace(/^(required|format|optional|conditional|widget|attachment|disabled)\s+(field|validation|display|required|auto\s+fill)\s*:\s*/i, '').trim()
  if (/\s+format\s+/i.test(head)) {
    head = head.split(/\s+format\s+/i)[0].trim()
  }
  head = head.replace(/\s+(label check|required field|optional field|conditional display|format validation)\s+test\s*$/i, '').trim()
  head = head.replace(/\s+(age|format)\s+validation\s+test\s*$/i, '').trim()
  head = head.replace(/\s+when\s+.+/i, '').trim()
  head = head.replace(/\s+required\s+field\s+test(\s+for\s+[^\s.]+)?\s*$/i, '').trim()
  head = head.replace(/\s+optional\s+field\s+test(\s+for\s+[^\s.]+)?\s*$/i, '').trim()
  head = head.replace(/\s+conditional\s+display\s+test\s*$/i, '').trim()
  head = head.replace(/\s+wrong\s+format\s+test\s*$/i, '').trim()
  head = head.replace(/\s+display\s+test\s*$/i, '').trim()
  head = head.replace(/\s+field\s+test\s*$/i, '').trim()
  head = head.replace(/\s+test\s*$/i, '').trim()
  head = head.replace(/\s+required\s+field\s*$/i, '').trim()
  head = head.replace(/\s+optional\s+field\s*$/i, '').trim()

  const inferred = String(tc?.field_label || '').trim()
  const fromExpected = String(tc?.expected_result || '').split(';')[0].trim()
  const tokens = [head, inferred, fromExpected]
    .map(normalizeSectionName)
    .filter(token => token.length >= 2 && token.length <= 120)

  return [...new Set(tokens)]
}

function buildLabelSectionMapFromLabelChecks(cases) {
  const map = new Map()
  for (const tc of Array.isArray(cases) ? cases : []) {
    if (String(tc?.test_type || '').trim() !== 'label_check') continue
    const section = parseSectionFromExpectedResult(tc?.expected_result)
    if (!section) continue
    const label = normalizeSectionName(String(tc?.expected_result || '').split(';')[0])
    if (label) map.set(label.toLowerCase(), section)
    for (const token of fieldLabelTokens(tc)) {
      map.set(token.toLowerCase(), section)
    }
  }
  return map
}

function buildLabelSectionMapFromFormStructure(formStructure) {
  const parsed = parseFormStructure(formStructure)
  const fields = Array.isArray(parsed?.fields) ? parsed.fields : []
  const map = new Map()
  for (const field of fields) {
    const section = normalizeSectionName(field?.section)
    const label = normalizeSectionName(field?.label)
    if (!section || !label) continue
    map.set(label.toLowerCase(), section)
  }
  return map
}

function resolveSectionForTestCase(tc, labelSectionMaps) {
  let section = inferSectionFromTestCase(tc)
  if (!isUnsetSection(section)) return section

  for (const token of fieldLabelTokens(tc)) {
    for (const map of labelSectionMaps) {
      const mapped = map.get(token.toLowerCase())
      if (mapped) return mapped
    }
  }

  if (String(tc?.test_type || '').trim() === 'successful_submit') return SUBMIT_SECTION
  return GENERAL_SECTION
}

/** Resolve the best section for every test case (label checks, form JSON, field names). */
export function enrichTestCasesWithSections(testCases, formStructure) {
  const list = Array.isArray(testCases) ? testCases : []
  const labelSectionMaps = [
    buildLabelSectionMapFromLabelChecks(list),
    buildLabelSectionMapFromFormStructure(formStructure)
  ]

  const enriched = list.map(tc => {
    const section = resolveSectionForTestCase(tc, labelSectionMaps)
    return {
      ...tc,
      section: isUnsetSection(section) ? '' : section
    }
  })

  const labelMap = labelSectionMaps[0]
  return enriched.map(tc => {
    if (!isUnsetSection(tc.section) && String(tc.section || '').trim()) return tc
    for (const token of fieldLabelTokens(tc)) {
      const needle = token.toLowerCase()
      for (const [label, sec] of labelMap.entries()) {
        if (label === needle || label.includes(needle) || needle.includes(label)) {
          return { ...tc, section: sec }
        }
      }
    }
    for (const map of labelSectionMaps.slice(1)) {
      for (const token of fieldLabelTokens(tc)) {
        const mapped = map.get(token.toLowerCase())
        if (mapped) return { ...tc, section: mapped }
      }
    }
    return tc
  })
}

/** @deprecated Use enrichTestCasesWithSections */
export function assignSectionsFromFormStructure(cases, formStructure) {
  return enrichTestCasesWithSections(cases, formStructure)
}

export function buildExtensionSectionsPayload(testCases, formStructure) {
  const resolved = enrichTestCasesWithSections(testCases, formStructure)
  const sectionOrder = buildSectionOrder(resolved, formStructure).filter(name => !isUnsetSection(name))
  const groups = groupTestCasesBySection(resolved, sectionOrder)
  return {
    sectionOrder,
    sections: groups
      .filter(group => group.cases.length > 0)
      .map(group => ({
        name: isUnsetSection(group.section) ? GENERAL_SECTION : group.section,
        testCases: sortCasesWithinSection(group.cases)
      }))
  }
}
