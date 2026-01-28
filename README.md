# playwright-testchimp-reporter

Playwright reporter for TestChimp test execution tracking and requirement traceability. Automatically reports test execution results to TestChimp backend, enabling continuous requirement coverage tracking in your CI/CD pipelines.

## Features

- ✅ **Automatic test execution tracking**: Reports test results to TestChimp backend
- ✅ **Requirement traceability**: Links test executions to scenarios via `// @Scenario:` comments
- ✅ **CI/CD integration**: Works with any CI/CD platform (GitHub Actions, GitLab CI, Jenkins, etc.)
- ✅ **Flexible configuration**: Configure via environment variables or Playwright config
- ✅ **Screenshot capture**: Automatically captures screenshots for failing steps
- ✅ **Retry handling**: Configurable retry attempt reporting
- ✅ **Verbose logging**: Optional detailed logging for debugging

## Installation

```bash
npm install --save-dev playwright-testchimp-reporter
```

Or with yarn:

```bash
yarn add -D playwright-testchimp-reporter
```

## Quick Start

### 1. Install the package

```bash
npm install --save-dev playwright-testchimp-reporter
```

### 2. Configure in `playwright.config.ts`

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['list'], // Standard list reporter
    ['playwright-testchimp-reporter', {
      // Credentials from environment variables (recommended)
      // See Configuration section for all options
    }]
  ],
  // ... rest of your config
});
```

### 3. Set environment variables

```bash
export TESTCHIMP_API_KEY=your_api_key
export TESTCHIMP_PROJECT_ID=your_project_id
```

### 4. Run your tests

```bash
npx playwright test
```

Test execution results will be automatically reported to TestChimp!

## Configuration

### Required Configuration

You must provide API credentials either via environment variables (recommended) or in the config:

**Environment Variables (Recommended)**:
```bash
TESTCHIMP_API_KEY=your_api_key
TESTCHIMP_PROJECT_ID=your_project_id
```

**Config Options**:
```typescript
{
  apiKey: 'your_api_key',
  projectId: 'your_project_id',
}
```

### Optional Configuration

All configuration options can be provided via environment variables or in the config:

| Option | Environment Variable | Default | Description |
|--------|---------------------|---------|-------------|
| `apiUrl` | `TESTCHIMP_API_URL` | `https://featureservice.testchimp.io` | TestChimp API URL |
| `testsFolder` | `TESTCHIMP_TESTS_FOLDER` | `tests` | Base folder for relative path calculation |
| `release` | `TESTCHIMP_RELEASE` | - | Release/version identifier |
| `environment` | `TESTCHIMP_ENV` | - | Environment name (e.g., staging, production) |
| `reportOnlyFinalAttempt` | - | `true` | Only report final retry attempt |
| `captureScreenshots` | - | `true` | Capture screenshots for failing steps |
| `verbose` | - | `false` | Enable verbose logging |

### Complete Configuration Example

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  reporter: [
    ['list'],
    ['playwright-testchimp-reporter', {
      // Credentials from environment variables (recommended)
      // Optional: override defaults
      reportOnlyFinalAttempt: true,
      captureScreenshots: true,
      verbose: process.env.CI === 'true', // Verbose in CI
    }]
  ],
  use: {
    baseURL: 'https://example.com',
  },
});
```

## Linking Tests to Scenarios

To enable requirement traceability, add scenario comments to your tests:

```javascript
// @Scenario: User can log in with valid credentials
test('login test', async ({ page }) => {
  await page.goto('https://example.com/login');
  await page.fill('#username', 'testuser');
  await page.fill('#password', 'password123');
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('https://example.com/dashboard');
});
```

The reporter automatically extracts these comments and links test executions to scenarios. Scenario titles must match exactly (case-sensitive).

### Multiple Scenarios

You can link a single test to multiple scenarios:

```javascript
// @Scenario: User can log in with valid credentials
// @Scenario: User session persists after login
test('login and session test', async ({ page }) => {
  // ... test code
});
```

## CI/CD Integration

### GitHub Actions

```yaml
name: Run Tests

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main ]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Install Playwright browsers
        run: npx playwright install --with-deps
      
      - name: Run tests
        env:
          TESTCHIMP_API_KEY: ${{ secrets.TESTCHIMP_API_KEY }}
          TESTCHIMP_PROJECT_ID: ${{ secrets.TESTCHIMP_PROJECT_ID }}
          TESTCHIMP_ENV: staging
          TESTCHIMP_RELEASE: ${{ github.ref_name }}
        run: npx playwright test
```

### GitLab CI

```yaml
test:
  image: node:18
  before_script:
    - npm ci
    - npx playwright install --with-deps
  script:
    - npx playwright test
  variables:
    TESTCHIMP_API_KEY: $TESTCHIMP_API_KEY
    TESTCHIMP_PROJECT_ID: $TESTCHIMP_PROJECT_ID
    TESTCHIMP_ENV: staging
    TESTCHIMP_RELEASE: $CI_COMMIT_REF_NAME
```

### Jenkins

```groovy
pipeline {
  agent any
  environment {
    TESTCHIMP_API_KEY = credentials('testchimp-api-key')
    TESTCHIMP_PROJECT_ID = credentials('testchimp-project-id')
    TESTCHIMP_ENV = 'staging'
    TESTCHIMP_RELEASE = env.BUILD_NUMBER
  }
  stages {
    stage('Test') {
      steps {
        sh 'npm ci'
        sh 'npx playwright install --with-deps'
        sh 'npx playwright test'
      }
    }
  }
}
```

## How It Works

1. **Test execution**: Tests run normally using the standard Playwright runner
2. **Automatic reporting**: The reporter captures:
   - Test name, file path, and suite structure
   - Step-by-step execution results
   - Pass/fail status
   - Error messages (if any)
   - Screenshots for failing steps (if enabled)
3. **Backend ingestion**: Execution data is sent to TestChimp backend
4. **Coverage tracking**: Test executions are automatically linked to scenarios based on `// @Scenario:` comments
5. **Traceability updates**: Coverage information is updated in real-time in the TestChimp platform

## Configuration Options Reference

### `apiKey` / `TESTCHIMP_API_KEY`
- **Type**: `string`
- **Required**: Yes
- **Description**: API key for TestChimp authentication

### `projectId` / `TESTCHIMP_PROJECT_ID`
- **Type**: `string`
- **Required**: Yes
- **Description**: TestChimp project identifier

### `apiUrl` / `TESTCHIMP_API_URL`
- **Type**: `string`
- **Default**: `https://featureservice.testchimp.io`
- **Description**: TestChimp API URL

### `testsFolder` / `TESTCHIMP_TESTS_FOLDER`
- **Type**: `string`
- **Default**: `tests`
- **Description**: Base folder for relative path calculation. Used to derive test file paths relative to this folder.

### `release` / `TESTCHIMP_RELEASE`
- **Type**: `string`
- **Default**: `''`
- **Description**: Release/version identifier. Useful for tracking test executions by release.

### `environment` / `TESTCHIMP_ENV`
- **Type**: `string`
- **Default**: `''`
- **Description**: Environment name (e.g., `staging`, `production`). Useful for tracking coverage separately by environment.

### `reportOnlyFinalAttempt`
- **Type**: `boolean`
- **Default**: `true`
- **Description**: When `true`, only the final retry attempt is reported. When `false`, all retry attempts are reported.

### `captureScreenshots`
- **Type**: `boolean`
- **Default**: `true`
- **Description**: When `true`, screenshots are captured and attached to failing steps as base64-encoded images.

### `verbose`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: When `true`, enables detailed logging for debugging. Useful for troubleshooting configuration issues.

## Troubleshooting

### Reporter Not Sending Data

**Check credentials**:
- Verify `TESTCHIMP_API_KEY` and `TESTCHIMP_PROJECT_ID` are set correctly
- Ensure credentials are valid and have access to the project

**Enable verbose logging**:
```typescript
{
  verbose: true
}
```

**Check network connectivity**:
- Ensure your CI environment can reach the TestChimp API
- Check firewall rules if running in a restricted network

### Tests Not Linked to Scenarios

**Verify scenario comments**:
- Ensure `// @Scenario:` comments are present in your tests
- Check that comments are placed before the test function

**Check scenario titles**:
- Scenario titles must match exactly (case-sensitive)
- Verify the scenario exists in your TestChimp project

**Review test file paths**:
- Ensure test files are in the expected location
- Check that `testsFolder` configuration matches your project structure

### Missing Screenshots

**Enable screenshot capture**:
```typescript
{
  captureScreenshots: true
}
```

**Check Playwright config**:
- Ensure Playwright is configured to capture screenshots on failure
- Verify screenshot settings in your `playwright.config.ts`

### Authentication Errors

If you see authentication errors:
- Verify your API key is correct
- Check that your project ID matches your TestChimp project
- Ensure credentials are properly set as environment variables or in config

## Requirements

- **Playwright**: `>=1.40.0`
- **Node.js**: `>=16.0.0`

## License

MIT

## Links

- **GitHub Repository**: [https://github.com/testchimphq/playwright-testchimp-reporter](https://github.com/testchimphq/playwright-testchimp-reporter)
- **TestChimp Documentation**: [https://docs.testchimp.io](https://docs.testchimp.io)
- **Playwright Documentation**: [https://playwright.dev](https://playwright.dev)

## Support

For issues, questions, or contributions, please visit the [GitHub repository](https://github.com/testchimphq/playwright-testchimp-reporter).
