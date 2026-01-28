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
    if (!this.isEnabled) return;

    const testKey = this.getTestKey(test, result.retry);

    this.testExecutions.set(testKey, {
      testCase: test,
      steps: [],
      startedAt: Date.now(),
      attemptNumber: result.retry + 1
    });

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

    // Only capture test.step category (user-defined steps), not internal hooks
    // Also capture 'expect' category for assertions
    if (step.category !== 'test.step' && step.category !== 'expect') {
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

    if (this.options.verbose && step.error) {
      console.log(`[TestChimp] Step failed: ${step.title}`);
    }
  }

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    if (!this.isEnabled || !this.apiClient) return;

    const testKey = this.getTestKey(test, result.retry);
    const execution = this.testExecutions.get(testKey);

    if (!execution) return;

    // Check if this is the final attempt (for retry handling)
    const retryKey = test.id;
    const retryInfo = this.testRetryInfo.get(retryKey);
    const isFinalAttempt = !retryInfo || result.retry >= retryInfo.maxRetries;

    // Skip non-final attempts if configured
    if (this.options.reportOnlyFinalAttempt && !isFinalAttempt) {
      if (this.options.verbose) {
        console.log(`[TestChimp] Skipping non-final attempt ${result.retry + 1} for: ${test.title}`);
      }
      this.testExecutions.delete(testKey);
      return;
    }

    // Build the report
    const report = this.buildReport(test, result, execution);

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

    if (screenshots.length === 0) return;

    // Find failing steps
    const failingSteps = steps.filter(
      (s) => s.status === StepExecutionStatus.FAILURE_STEP_EXECUTION && !s.screenshotBase64
    );

    if (failingSteps.length === 0) return;

    // Attach screenshots to failing steps
    for (let i = 0; i < Math.min(screenshots.length, failingSteps.length); i++) {
      const screenshot = screenshots[i];
      const step = failingSteps[i];

      if (screenshot.path) {
        try {
          const imageBuffer = fs.readFileSync(screenshot.path);
          step.screenshotBase64 = imageBuffer.toString('base64');

          if (this.options.verbose) {
            console.log(`[TestChimp] Attached screenshot to failing step: ${step.description}`);
          }
        } catch (error) {
          if (this.options.verbose) {
            console.warn(`[TestChimp] Failed to read screenshot: ${screenshot.path}`, error);
          }
        }
      }
    }
  }
}
