# playwright-testchimp-reporter

A [Playwright](https://playwright.dev/) reporter that sends test execution results to the [TestChimp](https://testchimp.io) platform. It powers **QA intelligence insights**, surfaces **AI-native steps** (e.g. `ai.act`, `ai.verify`) from the standard Playwright runner into TestChimp for CI, and **augments RUM events** from [testchimp-rum-js](https://www.npmjs.com/package/testchimp-rum-js) so test runs align with real user events for **TrueCoverage**.

---

## Purpose

### 1. Report execution results to TestChimp for QA intelligence

The reporter collects test runs (pass/fail, steps, errors, timing) and sends them to the TestChimp backend. TestChimp uses this data to:

- Track which tests ran, when, and their outcome
- Drive dashboards, trends, and QA intelligence
- Correlate failures with steps and screenshots for faster debugging
- Support traceability between tests, scenarios, and coverage

You run tests with the normal Playwright CLI or via your CI (GitHub Actions etc.); the reporter runs in process and posts results to TestChimp without changing how you execute tests.

### 2. Pipe AI-native steps through TestChimp so they work wherever you run tests

The reporter plugin pipes AI-native step calls (`ai.act`, `ai.verify`, etc.) via TestChimp backends, so that those steps work seamlessly—wherever you run your tests (local, CI, or any environment).

### 3. Augment testchimp-rum-js events for TrueCoverage (test ↔ real user alignment)

[testchimp-rum-js](https://www.npmjs.com/package/testchimp-rum-js) emits real user events from the browser to TestChimp. When the same app is exercised **in CI by Playwright**, you want those events to be tagged with **which test** produced them so TestChimp can:

- Align test runs with real user sessions (TrueCoverage)
- See which tests generated which events
- Compare test coverage to production usage to drive better QA strategy.

Read more about TestChimps' TrueCoverage feature [here](https://docs.testchimp.io/truecoverage/intro).

---

## Installation

```bash
npm install playwright-testchimp-reporter
```

Peer dependency: `@playwright/test` (e.g. `>=1.40.0`).

---

## Quick start

### 1. Playwright config

Configure the reporter in your playwright.config.js like below:

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

// Optional: import runtime so CI test info is injected for testchimp-rum-js (TrueCoverage)


export default defineConfig({
  reporter: [
    ['list'],
    ['playwright-testchimp-reporter', {
      verbose: true,
      reportOnlyFinalAttempt: true,
      captureScreenshots: true,
    }],
  ],
});
```

For TrueCoverage, add the following import in your tests:

```
import 'playwright-testchimp-reporter/runtime';
```

### 2. Environment variables

Set these so the reporter can talk to TestChimp (env vars override programmatic options):

| Variable | Required | Description |
|----------|----------|-------------|
| `TESTCHIMP_API_KEY` | Yes | API key for TestChimp. |
| `TESTCHIMP_PROJECT_ID` | Yes | TestChimp project ID. |
| `TESTCHIMP_TESTS_FOLDER` | No | Base folder for relative paths (default: `tests`). |
| `TESTCHIMP_RELEASE` | No | Release/version identifier. |
| `TESTCHIMP_ENV` | No | Environment (e.g. `staging`, `prod`). |

If `TESTCHIMP_API_KEY` or `TESTCHIMP_PROJECT_ID` is missing, the reporter logs a warning and disables reporting (no request is sent).

### 3. Run tests

```bash
export TESTCHIMP_API_KEY=your-api-key
export TESTCHIMP_PROJECT_ID=your-project-id
npx playwright test
```

Results are reported to TestChimp after each test (or after the final attempt when using retries and `reportOnlyFinalAttempt: true`).

---

## Reporter options

You can pass options in `playwright.config.ts`:

```ts
['playwright-testchimp-reporter', {
  apiKey: '...',           // override env (not recommended in CI)
  backendUrl: '...',       // override TESTCHIMP_BACKEND_URL
  projectId: '...',       // override env
  testsFolder: 'tests',   // base dir for relative path calculation
  release: '1.0.0',
  environment: 'staging',
  reportOnlyFinalAttempt: true,  // only send report for last retry (default: true)
  captureScreenshots: true,      // attach screenshots to failing steps (default: true)
  verbose: false,               // extra logging (default: false)
}]
```

Environment variables take precedence over these options.

---

## What gets reported

For each test (or its final attempt when using retries), the reporter sends a **Smart Test Execution Report** that includes:

- **Identity**: `folderPath`, `fileName`, `suitePath`, `testName` (derived from test file and describe blocks).
- **Run context**: `batchInvocationId`, `branchName` (from env when available), `release`, `environment`.
- **Job detail**:
  - **Steps**: Every Playwright step with category `test.step`, `expect`, or `pw:api` (including AI-native steps).
  - **Status**: Completed, Failed, or Unknown (mapped from Playwright status).
  - **Error**: Top-level test error message if failed.
  - **Screenshots**: For failing steps, when `captureScreenshots` is true and Playwright has attached screenshots (e.g. `screenshot: 'only-on-failure'`).

Retries are tracked; with `reportOnlyFinalAttempt: true` only the last attempt is reported.


---

## Exports

- **Default**: `TestChimpReporter` (for use in `reporter` array).
- **Named**: `TestChimpReporter`, `TestChimpApiClient`, and types/utilities from `./types` and `./utils`.
- **Subpath**: `playwright-testchimp-reporter/runtime` — side-effect import only; registers `test.beforeEach` to inject CI test info.

---

## Troubleshooting

- **“Reporting disabled”**  
  Set `TESTCHIMP_API_KEY` and `TESTCHIMP_PROJECT_ID` (or pass them in reporter options). The reporter will skip sending if either is missing.

- **No steps or only some steps**  
  Only steps with category `test.step`, `expect`, or `pw:api` are reported. Internal/hook steps are excluded.

- **No screenshots on failure**  
  Enable screenshot capture in Playwright (e.g. `use: { screenshot: 'only-on-failure' }`). The reporter only attaches existing attachments to failing steps.

- **RUM events not linked to tests**  
  Ensure you `import 'playwright-testchimp-reporter/runtime'` in the test files.

- **Verbose logging**  
  Set `verbose: true` in reporter options or use it during setup to see which steps are captured and when reports are sent.

---

## License

MIT.
