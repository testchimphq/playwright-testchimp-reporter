/**
 * playwright-testchimp-reporter
 *
 * Playwright reporter for TestChimp test execution tracking and coverage reporting.
 *
 * @example
 * // playwright.config.ts
 * import { defineConfig } from '@playwright/test';
 *
 * export default defineConfig({
 *   reporter: [
 *     ['list'],
 *     ['playwright-testchimp-reporter', {
 *       verbose: true,
 *       reportOnlyFinalAttempt: true,
 *       captureScreenshots: true
 *     }]
 *   ]
 * });
 *
 * Environment Variables:
 * - TESTCHIMP_API_KEY (required): API key for authentication
 * - TESTCHIMP_PROJECT_ID (required): Project identifier
 * - TESTCHIMP_API_URL (optional): API URL (default: https://api.testchimp.io)
 * - TESTCHIMP_TESTS_FOLDER (optional): Base folder for relative path calculation
 * - TESTCHIMP_RELEASE (optional): Release/version identifier
 * - TESTCHIMP_ENV (optional): Environment name (e.g., staging, prod)
 */

export { TestChimpReporter } from './testchimp-reporter';
export { TestChimpApiClient } from './api-client';
export * from './types';
export * from './utils';

// Default export for Playwright reporter configuration
import { TestChimpReporter } from './testchimp-reporter';
export default TestChimpReporter;
