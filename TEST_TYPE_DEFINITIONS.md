# QA Helper — Agreed Test Type Definitions

_The authoritative behavior spec for each of the 7 test types. Code should match these; where code and this file disagree, this file wins (update code, not the spec, unless the spec is revised here first)._

---

## 1. label_check
- Find the field, read the **visible label**.
- Strip **asterisks and whitespace only** (nothing else).
- **Exact, case-sensitive** match against the SRD label.
- On mismatch, fail with the exact **expected vs got** message.
- **Conditional / cascading fields:** set the parent to the trigger value, **wait for the field to appear**, read the label, then **reset the parent after**.
- **Skip** if the field is not visible.

## 2. required_field
- Leave **only that field** empty, click **Continue**, check the error appears.
- Match is **case-insensitive contains**.
- **Pass** if the correct error appears.
- **Optional fields** (expected = `"No error message"`): **pass** if no error appears, **fail** if an error appears.
- **Conditional:** set the parent first, then the same flow.

## 3. format_validation
- Enter a value that breaks the **specific SRD rule** — **no hardcodes**, derived from the rule.
- Click **Continue**.
- Read the error that appears **directly below that field only** — **ignore page-wide errors**.
- **Case-insensitive contains** match.
- **Skip** if the field is a dropdown.

## 4. conditional_field
- **Each trigger value tested separately.**
- Set the parent to the trigger value, then:
  - **Display check:** the field appears.
  - **Required check:** leave it empty and check the error.
- Also test that the **opposite trigger hides** the field.
- **Reset the parent between triggers.**

## 5. successful_submit
- **Section by section.**
- Fill **all visible required fields only** (skip optional, skip hidden).
- **Cascading dropdowns** filled in order.
- **Conditional fields:** pick any trigger value and fill what appears.
- Click **Continue per section**.
- **Pass** if the form reaches the success screen.
- **Fail** with errors listed if errors appear.
- **Fail** if the form didn't advance and there are no errors.

## 6. widget_auto_fill
- Enter a **valid ID** (provided by the tester in the extension) into the trigger field.
- Wait for the **thumbs-up signal**.
- Check **all SRD-specified fields are populated**.
- **Pass** if all are filled.
- **Partial fail** naming the missing fields.
- **Fail** if the thumbs-up never appeared.

## 7. attachment
- **Pause the run.**
- Show the message: **"Please upload file for [field name] manually then click Resume"**.
- Wait for the **Resume** click.
- If Resume is clicked: click **Continue**, check the form accepted the file.
- If **2 minutes** pass with no Resume: mark **skipped**.
- **Pass** if accepted. **Fail** with an error message if rejected.

---

## Open questions (need answers before implementation)

1. **Order of test types after label_check** — does it matter?
2. **Do all test types run section by section**, or just successful_submit?
3. **On failure** — continue to the next test or stop?
4. **How is the form reset to a clean state** between tests?
5. **Is the reusable ID the same one** used for widget_auto_fill?
