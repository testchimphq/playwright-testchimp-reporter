import type {
  Reporter,
  FullConfig,
  Suite,
  TestCase,
  TestResult,
  TestStep,
  FullResult
} from '@playwright/test/reporter';
import fs from 'fs';

import { TestChimpApiClient } from './api-client';
import {
  TestChimpReporterOptions,
  SmartTestExecutionReport,
  SmartTestExecutionStep,
  SmartTestExecutionStatus,
  StepExecutionStatus
} from './types';
import { derivePaths, generateStepId, generateUUID, getEnvVar } from './utils';

/**
 * Internal state for tracking a test execution
 */
interface TestExecutionState {
  testCase: TestCase;
  steps: SmartTestExecutionStep[];
  startedAt: number;
  attemptNumber: number;
}

/**
 * Retry tracking info for a test
 */
interface RetryInfo {
  maxRetries: number;
  currentAttempt: number;
}

/**
 * TestChimp Playwright Reporter
 *
 * Reports test execution data to the TestChimp backend for
 * coverage tracking and traceability.
 *
 * @example
 * // playwright.config.ts
 * export default defineConfig({
 *   reporter: [
 *     ['playwright-testchimp-reporter', {
 *       verbose: true,
 *       reportOnlyFinalAttempt: true
 *     }]
 *   ]
 * });
 */
export class TestChimpReporter implements Reporter {
  private config!: FullConfig;
  private options: Required<TestChimpReporterOptions>;
  private apiClient: TestChimpApiClient | null = null;
  private batchInvocationId: string = '';
  private testsFolder: string = '';

  // Track test executions (keyed by test ID + attempt)
  private testExecutions: Map<string, TestExecutionState> = new Map();

  // Track retry counts per test (to identify final attempt)
  private testRetryInfo: Map<string, RetryInfo> = new Map();

  // Flag to indicate if reporter is properly configured
  private isEnabled: boolean = false;

  constructor(options: TestChimpReporterOptions = {}) {
    this.options = {
      apiKey: options.apiKey || '',
      apiUrl: options.apiUrl || '',
      projectId: options.projectId || '',
      testsFolder: options.testsFolder || '',
      release: options.release || '',
      environment: options.environment || '',
      reportOnlyFinalAttempt: options.reportOnlyFinalAttempt ?? true,
      captureScreenshots: options.captureScreenshots ?? true,
      verbose: options.verbose ?? false
    };
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.config = config;
    this.batchInvocationId = generateUUID();

    // Initialize configuration from env vars (env vars take precedence)
    const apiKey = getEnvVar('TESTCHIMP_API_KEY', this.options.apiKey);
    const apiUrl = getEnvVar('TESTCHIMP_API_URL', this.options.apiUrl) || 'https://featureservice.testchimp.io';
    const projectId = getEnvVar('TESTCHIMP_PROJECT_ID', this.options.projectId);
    this.testsFolder = getEnvVar('TESTCHIMP_TESTS_FOLDER', this.options.testsFolder) || 'tests';

    // Update options with env var values for release/environment
    this.options.release = getEnvVar('TESTCHIMP_RELEASE', this.options.release) || '';
    this.options.environment = getEnvVar('TESTCHIMP_ENV', this.options.environment) || '';

    if (!apiKey || !projectId) {
      console.warn('[TestChimp] Missing TESTCHIMP_API_KEY or TESTCHIMP_PROJECT_ID. Reporting disabled.');
      this.isEnabled = false;
      return;
    }

    this.apiClient = new TestChimpApiClient(apiUrl, apiKey, projectId, this.options.verbose);
    this.isEnabled = true;

    if (this.options.verbose) {
      console.log(`[TestChimp] Reporter initialized. Batch ID: ${this.batchInvocationId}`);
      console.log(`[TestChimp] Tests folder: ${this.testsFolder || '(root)'}`);
    }

    // Scan suite to understand retry configuration
    this.scanTestRetries(suite);
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    console.log(`[TestChimp] onTestBegin called for test: ${test.title} (retry: ${result.retry})`);
    
    if (!this.isEnabled) {
      console.log(`[TestChimp] Reporter is not enabled, skipping test start tracking for: ${test.title}`);
      return;
    }

    const testKey = this.getTestKey(test, result.retry);

    this.testExecutions.set(testKey, {
      testCase: test,
      steps: [],
      startedAt: Date.now(),
      attemptNumber: result.retry + 1
    });
    
    console.log(`[TestChimp] Created execution state for test: ${test.title} (key: ${testKey})`);

    // Update retry tracking
    const retryKey = test.id;
    const retryInfo = this.testRetryInfo.get(retryKey);
    if (retryInfo) {
      retryInfo.currentAttempt = result.retry;
    }

    if (this.options.verbose) {
      console.log(`[TestChimp] Test started: ${test.title} (attempt ${result.retry + 1})`);
    }
  }

  onStepEnd(test: TestCase, result: TestResult, step: TestStep): void {
    if (!this.isEnabled) return;

    const testKey = this.getTestKey(test, result.retry);
    const execution = this.testExecutions.get(testKey);

    if (!execution) return;

    // Log all steps when verbose is enabled (for debugging)
    if (this.options.verbose) {
      console.log(`[TestChimp] Step seen: "${step.title}" (category: ${step.category})`);
    }

    // Capture test.step (user-defined steps), expect (assertions), and pw:api (Playwright API calls)
    // Exclude internal hooks, fixtures, and attachments
    if (step.category !== 'test.step' && step.category !== 'expect' && step.category !== 'pw:api') {
      if (this.options.verbose) {
        console.log(`[TestChimp] Step filtered out: "${step.title}" (category: ${step.category})`);
      }
      return;
    }

    const stepNumber = execution.steps.length + 1;
    const stepId = generateStepId(stepNumber);

    const executionStep: SmartTestExecutionStep = {
      stepId,
      description: step.title,
      status: step.error
        ? StepExecutionStatus.FAILURE_STEP_EXECUTION
        : StepExecutionStatus.SUCCESS_STEP_EXECUTION,
      error: step.error?.message,
      wasRepaired: false
    };

    execution.steps.push(executionStep);

    if (this.options.verbose) {
      console.log(`[TestChimp] Step captured: ${stepNumber} (${step.category}): ${step.title} - ${executionStep.status}`);
    }
  }

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    console.log(`[TestChimp] onTestEnd called for test: ${test.title} (status: ${result.status}, retry: ${result.retry})`);
    
    if (!this.isEnabled) {
      console.log(`[TestChimp] Reporter is not enabled, skipping report for: ${test.title}`);
      return;
    }
    
    if (!this.apiClient) {
      console.log(`[TestChimp] API client is not initialized, skipping report for: ${test.title}`);
      return;
    }

    const testKey = this.getTestKey(test, result.retry);
    const execution = this.testExecutions.get(testKey);

    if (!execution) {
      console.log(`[TestChimp] No execution state found for test: ${test.title} (key: ${testKey}), skipping report`);
      console.log(`[TestChimp] Available execution keys: ${Array.from(this.testExecutions.keys()).join(', ')}`);
      return;
    }

    // Check if this is the final attempt (for retry handling)
    // If test passed, it's always the final attempt (no retries will occur)
    // If test failed, check if we've reached max retries
    const retryKey = test.id;
    const retryInfo = this.testRetryInfo.get(retryKey);
    const testPassed = result.status === 'passed';
    const isFinalAttempt = testPassed || !retryInfo || result.retry >= retryInfo.maxRetries;

    console.log(`[TestChimp] Test status: ${result.status}, retry: ${result.retry}, maxRetries: ${retryInfo?.maxRetries ?? 'unknown'}, isFinalAttempt: ${isFinalAttempt}`);

    // Skip non-final attempts if configured
    if (this.options.reportOnlyFinalAttempt && !isFinalAttempt) {
      console.log(`[TestChimp] Skipping non-final attempt ${result.retry + 1} for: ${test.title}`);
      this.testExecutions.delete(testKey);
      return;
    }

    // Build the report
    const report = this.buildReport(test, result, execution);

    // Log report details
    console.log(`[TestChimp] Preparing to send report for test: ${test.title}`);
    console.log(`[TestChimp]   Status: ${report.jobDetail.status}`);
    console.log(`[TestChimp]   Steps: ${report.jobDetail.steps.length}`);
    const stepsWithScreenshots = report.jobDetail.steps.filter(s => s.screenshotBase64);
    if (stepsWithScreenshots.length > 0) {
      console.log(`[TestChimp]   Steps with screenshots: ${stepsWithScreenshots.length}`);
    }

    try {
      const response = await this.apiClient.ingestExecutionReport(report);

      if (this.options.verbose) {
        console.log(`[TestChimp] Reported: ${test.title} (jobId: ${response.jobId}, testFound: ${response.testFound})`);
        if (response.scenariosPopulated && response.scenariosPopulated > 0) {
          console.log(`[TestChimp] Auto-populated ${response.scenariosPopulated} scenario(s)`);
        }
      }
    } catch (error) {
      console.error(`[TestChimp] Failed to report test: ${test.title}`, error);
    }

    // Cleanup
    this.testExecutions.delete(testKey);
  }

  async onEnd(result: FullResult): Promise<void> {
    if (this.options.verbose) {
      console.log(`[TestChimp] Test run completed. Status: ${result.status}`);
      console.log(`[TestChimp] Batch invocation ID: ${this.batchInvocationId}`);
    }
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private getTestKey(test: TestCase, retry: number): string {
    return `${test.id}_attempt_${retry}`;
  }

  private scanTestRetries(suite: Suite): void {
    const scanSuite = (s: Suite) => {
      for (const test of s.tests) {
        this.testRetryInfo.set(test.id, {
          maxRetries: test.retries,
          currentAttempt: 0
        });
      }
      for (const child of s.suites) {
        scanSuite(child);
      }
    };
    scanSuite(suite);

    if (this.options.verbose) {
      console.log(`[TestChimp] Scanned ${this.testRetryInfo.size} test(s)`);
    }
  }

  private buildReport(
    test: TestCase,
    result: TestResult,
    execution: TestExecutionState
  ): SmartTestExecutionReport {
    // Derive paths from test location
    const paths = derivePaths(test, this.testsFolder, this.config.rootDir, this.options.verbose);

    // Map Playwright status to SmartTestExecutionStatus
    const status = this.mapStatus(result.status);

    // Attach screenshots to failing steps only
    if (this.options.captureScreenshots) {
      this.attachScreenshotsToFailingSteps(execution.steps, result.attachments);
    }

    return {
      folderPath: paths.folderPath,
      fileName: paths.fileName,
      suitePath: paths.suitePath,
      testName: paths.testName,
      release: this.options.release || undefined,
      environment: this.options.environment || undefined,
      batchInvocationId: this.batchInvocationId,
      jobDetail: {
        testName: paths.testName,
        steps: execution.steps,
        status,
        error: result.error?.message,
        scenarioCoverageResults: [] // Backend will populate if empty
      },
      startedAtMillis: execution.startedAt,
      completedAtMillis: Date.now()
    };
  }

  private mapStatus(playwrightStatus: string): SmartTestExecutionStatus {
    switch (playwrightStatus) {
      case 'passed':
        return SmartTestExecutionStatus.SMART_TEST_EXECUTION_COMPLETED;
      case 'failed':
      case 'timedOut':
        return SmartTestExecutionStatus.SMART_TEST_EXECUTION_FAILED;
      case 'skipped':
      case 'interrupted':
      default:
        return SmartTestExecutionStatus.UNKNOWN_SMART_TEST_EXECUTION_STATUS;
    }
  }

  /**
   * Attach screenshots as base64 to failing steps only
   */
  private attachScreenshotsToFailingSteps(
    steps: SmartTestExecutionStep[],
    attachments: TestResult['attachments']
  ): void {
    // Filter for image attachments with paths
    const screenshots = attachments.filter(
      (a) => a.contentType?.startsWith('image/') && a.path
    );

    console.log(`[TestChimp] Processing screenshots: ${screenshots.length} screenshot(s) found, ${steps.length} step(s) total`);

    if (screenshots.length === 0) {
      console.log(`[TestChimp] No screenshots found in attachments`);
      return;
    }

    // Find failing steps
    const failingSteps = steps.filter(
      (s) => s.status === StepExecutionStatus.FAILURE_STEP_EXECUTION && !s.screenshotBase64
    );

    console.log(`[TestChimp] Found ${failingSteps.length} failing step(s) without screenshots`);

    if (failingSteps.length === 0) {
      console.log(`[TestChimp] No failing steps to attach screenshots to`);
      return;
    }

    // Attach screenshots to failing steps
    for (let i = 0; i < Math.min(screenshots.length, failingSteps.length); i++) {
      const screenshot = screenshots[i];
      const step = failingSteps[i];

      if (screenshot.path) {
        try {
          const imageBuffer = fs.readFileSync(screenshot.path);
          const base64String = imageBuffer.toString('base64');
          step.screenshotBase64 = base64String;

          console.log(`[TestChimp] ✓ Attached screenshot (${base64String.length} bytes) to failing step: "${step.description}"`);
          console.log(`[TestChimp]   Screenshot path: ${screenshot.path}`);
        } catch (error) {
          console.error(`[TestChimp] ✗ Failed to read screenshot from ${screenshot.path}:`, error);
        }
      } else {
        console.warn(`[TestChimp] Screenshot at index ${i} has no path`);
      }
    }
  }
}
