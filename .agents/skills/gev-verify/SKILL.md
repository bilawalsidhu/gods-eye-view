---
name: gev-verify
description: Run all God's Eye View quality gates — unit tests, boundary checks, format check, and a browser smoke test. Use when asked to verify the project or check that everything is green.
disable-model-invocation: false
---

# GEV Verify

Run the complete quality gate suite for God's Eye View and report results.

## Steps

1. **Unit tests**

   ```bash
   node scripts/run-unit-tests.mjs
   ```

   Report: `tests N, pass N, fail N`.

2. **Architectural boundaries**

   ```bash
   npm run check:boundaries
   ```

   Must exit 0 with no "unowned module" or "boundary" errors.

3. **Format check**

   ```bash
   npm run format:check
   ```

   Must report `Checked N source files.` with no "Needs formatting" lines.

4. **Production build**

   ```bash
   npm run build
   ```

   Must succeed with `✓ built in Ns`. Note any chunk-size warnings.

5. **Browser smoke test** (if dev server is running)
   Use Puppeteer to load the page and report any `pageerror` or failed `/api/` requests.

## Output

Report a table:

| Gate       | Status    | Details                 |
| ---------- | --------- | ----------------------- |
| Unit tests | PASS/FAIL | N tests, N pass, N fail |
| Boundaries | PASS/FAIL | N modules checked       |
| Format     | PASS/FAIL | N files checked         |
| Build      | PASS/FAIL | Ns, N warnings          |
| Browser    | PASS/FAIL | N errors                |

If any gate fails, list the specific failures with file paths.
