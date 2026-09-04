import type {
  Reporter,
  FullConfig,
  Suite,
  TestCase,
  TestResult,
  TestStep,
  FullResult,
  TestError
} from '@playwright/test/reporter';
import fs from 'fs';
import sharp from 'sharp';

import { TestChimpApiClient } from './api-client';
import {
  TestChimpReporterOptions,
  SmartTestExecutionReport,
  SmartTestExecutionStep,
  SmartTestExecutionStatus,
  StepExecutionStatus,
  SmartTestExecutionJobDetail,
  RetryAttemptLog,
  JobManifestEntry,
  BatchInvocationStatus,
} from './types';
import { buildExecutionDeviceContext } from './execution-context';
import { collectPlaywrightAnnotations } from './annotations';
import {
  derivePaths,
  generateStepId,
  generateUUID,
  getBranchName,
  getRunCommitSha,
  DEFAULT_FEATURESERVICE_URL,
  getEnvVar,
  getTestChimpBatchInvocationFilePath,
  isPlaywrightFinalAttempt,
  normalizeManifestFolderPath,
  resolveCiIngestBaseUrl,
  resolveExecutionSource,
  resolveManifestEntryFromRuntime,
  stableExploreChimpAnalyticsStepId,
  stableJourneyExecutionId,
} from './utils';
import { isExploreChimpEnabled } from './explorechimp/index';
import { consumeExploreChimpAnalyticsStepScreenState } from './explorechimp/analytics-step-screen-state-registry';
import {
  API_COVERAGE_ATTACHMENT_NAME,
  ApiOperationTestMode,
  parseApiCoverageAttachment,
  type ApiOperationInteraction,
} from './api-coverage/capture';
import {
  collectSuiteCandidates,
  findPlansRoot,
  fromWireLocator,
  getSmartSmokeSelectionFilePath,
  loadRelatedTests,
  readSmartSmokeUseFromConfig,
  resolveSkipReasonFromAnnotations,
  resolveSmartSmokeConfig,
  toWireLocator,
  unionLocators,
  unlinkSmartSmokeSelectionFile,
  writeSmartSmokeSelectionFile,
  type TestLocatorJson,
} from './smart-smoke';
import path from 'path';

/**
 * Internal state for tracking a test execution
 */
interface TestExecutionState {
  testCase: TestCase;
  steps: SmartTestExecutionStep[];
  startedAt: number;
  attemptNumber: number;
}

function resolveDurationMs(
  reportedDurationMs: number | undefined,
  startedAtMillis: number,
  completedAtMillis: number,
): number {
  if (
    typeof reportedDurationMs === 'number' &&
    Number.isFinite(reportedDurationMs) &&
    reportedDurationMs >= 0
  ) {
    return Math.round(reportedDurationMs);
  }
  return Math.max(0, Math.round(completedAtMillis - startedAtMillis));
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
 *     ['@testchimp/playwright/reporter', {
 *       verbose: true,
 *       reportOnlyFinalAttempt: true
 *     }]
 *   ]
 * });
 */
export class TestChimpReporter implements Reporter {
  /**
   * Max Playwright trace .zip size we'll POST as multipart to featureservice `/api/upload_attachment`.
   * Must stay below the server's Commons multipart limit (see featureservice `FeatureServiceApplication`).
   * Failure screenshots use the same endpoint but are re-encoded to JPEG first (~viewport KB range).
   */
  private static readonly DEFAULT_TRACE_MAX_BYTES = 25 * 1024 * 1024;
  private static readonly DEFAULT_TRACE_UPLOAD_TIMEOUT_MS = 120_000;
  private static readonly DEFAULT_TRACE_UPLOAD_RETRIES = 2;
  private config!: FullConfig;
  private options: Required<TestChimpReporterOptions>;
  private apiClient: TestChimpApiClient | null = null;
  private batchInvocationId: string = '';
  /** Path we wrote for this run; unlinked in onEnd when write succeeded. */
  private batchInvocationFileWrittenPath: string | null = null;
  private shouldUnlinkBatchInvocationFile: boolean = false;
  /** Smart-smoke selection sidecar written in onBegin; unlinked in onEnd. */
  private smartSmokeSelectionFilePath: string | null = null;
  private testsFolder: string = '';

  // Track test executions (keyed by test ID + attempt, e.g. "testId_attempt_0", "testId_attempt_1").
  // In platform mode we keep all attempts until test_end so the job detail we send includes full retryAttemptLogs.
  private testExecutions: Map<string, TestExecutionState> = new Map();

  // Track retry counts per test (to identify final attempt)
  private testRetryInfo: Map<string, RetryInfo> = new Map();

  // Platform mode: manifest (test identity -> jobId), loaded once in onBegin
  private jobManifest: JobManifestEntry[] = [];
  private platformStepEndEnabled: boolean = false;

  // Flag to indicate if reporter is properly configured
  private isEnabled: boolean = false;
  /**
   * Fire-and-forget HTTP tails keyed by scriptservice job id (manifest jobId for platform/step_end,
   * TESTCHIMP_REPAIR_JOB_ID for repair_step_end). Drains in onTestEnd only await that job's bucket so
   * parallel tests in the same worker do not block each other. onEnd drains every bucket.
   */
  private pendingOperationsByJobId: Map<string, Promise<any>[]> = new Map();
  /**
   * In-flight `onTestEnd` work (CI ingest + screenshot/trace upload, platform test_end, ExploreChimp
   * journey end). Playwright's V2 reporter wrapper does **not** await `onTestEnd`, so `onEnd` must
   * drain this set for both **ci** and **platform** before `completeBatchInvocation` / process exit.
   */
  private inFlightTestEndWork: Set<Promise<void>> = new Set();
  /** Idempotency: same journey execution id must not POST journey_execution_end twice (CI + platform + finally). */
  private exploreChimpJourneyEndSentIds = new Set<string>();

  constructor(options: TestChimpReporterOptions = {}) {
    // Env wins over playwright.config reporter options so repair/platform runs can
    // force ingest path (e.g. scriptservice sets TESTCHIMP_EXECUTION_MODE=repair; customer
    // configs often hard-code executionMode: 'ci', which would otherwise hit FeatureService).
    // This is not UI run source — that is TESTCHIMP_EXECUTION_SOURCE / report.executionSource.
    const envMode = getEnvVar('TESTCHIMP_EXECUTION_MODE')?.trim();
    const executionMode: 'ci' | 'platform' | 'repair' =
      envMode === 'repair' || envMode === 'platform' || envMode === 'ci'
        ? envMode
        : (options.executionMode || 'ci');

    this.options = {
      apiKey: options.apiKey || '',
      backendUrl: options.backendUrl || '',
      ingressUrl: options.ingressUrl || '',
      platformBackendUrl: options.platformBackendUrl || '',
      batchInvocationId: options.batchInvocationId || '',
      projectId: options.projectId || '',
      testsFolder: options.testsFolder || '',
      release: options.release || '',
      environment: options.environment || '',
      reportOnlyFinalAttempt: options.reportOnlyFinalAttempt ?? true,
      captureScreenshots: options.captureScreenshots ?? true,
      verbose: options.verbose ?? false,
      executionMode
    };
  }

  async onBegin(config: FullConfig, suite: Suite): Promise<void> {
    this.config = config;
    this.batchInvocationId = getEnvVar('TESTCHIMP_BATCH_INVOCATION_ID', this.options.batchInvocationId) || generateUUID();
    this.writeSuiteBatchInvocationFileForExploreChimp();

    // Initialize configuration from env vars (env vars take precedence)
    const apiKey = getEnvVar('TESTCHIMP_API_KEY', this.options.apiKey);
    const projectId = getEnvVar('TESTCHIMP_PROJECT_ID', this.options.projectId);
    this.testsFolder = getEnvVar('TESTCHIMP_TESTS_FOLDER', this.options.testsFolder) || 'tests';
    // Platform/repair: scriptservice via TESTCHIMP_PLATFORM_BACKEND_URL (TESTCHIMP_BACKEND_URL = featureservice for ai-wright).
    // CI: ingest host via TESTCHIMP_INGRESS_URL, or SaaS featureservice→ingress rewrite, else ingress default.
    const backendUrl =
      this.options.executionMode === 'platform' || this.options.executionMode === 'repair'
        ? String(
            getEnvVar('TESTCHIMP_PLATFORM_BACKEND_URL', this.options.platformBackendUrl) ||
              getEnvVar('TESTCHIMP_BACKEND_URL', this.options.backendUrl) ||
              DEFAULT_FEATURESERVICE_URL
          ).trim() || DEFAULT_FEATURESERVICE_URL
        : resolveCiIngestBaseUrl({
            ingressUrl: this.options.ingressUrl,
            backendUrl: this.options.backendUrl,
          });

    // Update options with env var values for release/environment
    this.options.release = getEnvVar('TESTCHIMP_RELEASE', this.options.release) || '';
    this.options.environment = getEnvVar('TESTCHIMP_ENV', this.options.environment) || '';

    // In repair mode we allow reporting to scriptservice localhost without an API key.
    // (API client still requires a header value, so we pass a dummy string.)
    if (!apiKey && this.options.executionMode !== 'repair') {
      console.warn('[TestChimp] Missing TESTCHIMP_API_KEY. Reporting disabled.');
      this.isEnabled = false;
      await this.maybeRunSmartSmokeSelection(suite, null);
      return;
    }

    this.apiClient = new TestChimpApiClient(backendUrl, apiKey || 'local-repair', projectId || '', this.options.verbose);
    this.isEnabled = true;

    const envTcBackend = process.env.TESTCHIMP_BACKEND_URL;
    const envTcIngress = process.env.TESTCHIMP_INGRESS_URL;
    const envEc = process.env.EXPLORECHIMP_ENABLED;
    console.log(
      `[TestChimp] ingest_diag onBegin pid=${process.pid} executionMode=${this.options.executionMode} ` +
        `executionSource=${resolveExecutionSource()} ` +
        `env_TESTCHIMP_BACKEND_URL=${envTcBackend === undefined ? '(undefined)' : JSON.stringify(envTcBackend)} ` +
        `env_TESTCHIMP_INGRESS_URL=${envTcIngress === undefined ? '(undefined)' : JSON.stringify(envTcIngress)} ` +
        `resolvedReporterBackendUrl=${JSON.stringify(backendUrl)} ` +
        `axiosBaseURL=${JSON.stringify(this.apiClient.getBaseUrl())} ` +
        `EXPLORECHIMP_ENABLED=${envEc === undefined ? '(undefined)' : JSON.stringify(envEc)} ` +
        `isExploreChimpEnabled=${isExploreChimpEnabled()} ` +
        `apiKeySet=${Boolean(apiKey?.trim())}`
    );

    if (this.options.executionMode === 'platform') {
      this.jobManifest = this.loadJobManifest();
      this.platformStepEndEnabled =
        (getEnvVar('TESTCHIMP_PLATFORM_STEP_END_ENABLED', 'false') || '').trim().toLowerCase() === 'true';
      const manifestPath =
        getEnvVar('TESTCHIMP_JOB_MANIFEST_PATH') ||
        (this.testsFolder ? path.join(this.testsFolder, '.testchimp-job-manifest.json') : '.testchimp-job-manifest.json');
      const rootDir = this.config?.rootDir || process.cwd();
      const resolvedPath = path.isAbsolute(manifestPath) ? manifestPath : path.join(rootDir, manifestPath);
      const sample =
        this.jobManifest.length > 0
          ? ` (sample: ${JSON.stringify(this.jobManifest.slice(0, 2).map((e) => ({ fileId: e.fileId, testId: e.testId, folderPath: e.folderPath, fileName: e.fileName, suitePath: e.suitePath ?? [], testName: e.testName })))}`
          : '';
      console.log(
        `[TestChimp] Platform mode: manifest from ${resolvedPath} → ${this.jobManifest.length} entries${sample} (backend for step_end/test_end: ${backendUrl})`
      );
      console.log(
        `[TestChimp] Platform mode: incremental platform/step_end is ${this.platformStepEndEnabled ? 'enabled' : 'disabled'} (TESTCHIMP_PLATFORM_STEP_END_ENABLED=${this.platformStepEndEnabled ? 'true' : 'false'})`
      );
    }

    if (this.options.verbose) {
      console.log(`[TestChimp] Reporter initialized. Batch ID: ${this.batchInvocationId}`);
      console.log(`[TestChimp] Tests folder: ${this.testsFolder || '(root)'}`);
      console.log(`[TestChimp] Execution mode: ${this.options.executionMode}`);
    }

    // Scan suite to understand retry configuration
    this.scanTestRetries(suite);

    await this.maybeRunSmartSmokeSelection(suite, this.apiClient);
  }

  private loadJobManifest(): JobManifestEntry[] {
    const manifestPath =
      getEnvVar('TESTCHIMP_JOB_MANIFEST_PATH') ||
      (this.testsFolder ? path.join(this.testsFolder, '.testchimp-job-manifest.json') : '.testchimp-job-manifest.json');
    const rootDir = this.config?.rootDir || process.cwd();
    const resolvedPath = path.isAbsolute(manifestPath) ? manifestPath : path.join(rootDir, manifestPath);
    try {
      const content = fs.readFileSync(resolvedPath, 'utf8');
      const parsed = JSON.parse(content) as JobManifestEntry[];
      const entries = Array.isArray(parsed) ? parsed : [];
      if (entries.length === 0 && this.options.executionMode === 'platform') {
        console.warn(`[TestChimp] Platform mode: manifest at ${resolvedPath} is empty or not an array (step_end/test_end will be skipped).`);
      }
      return entries;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[TestChimp] Could not load job manifest from ${resolvedPath}: ${msg}`);
      return [];
    }
  }

  /**
   * Resolve jobId from the platform manifest.
   * - No describe block: both parser and Playwright use suitePath [] → exact match.
   * - Global describe(): parser only sees test.describe() so manifest has []; Playwright reports e.g. ["Suite"] → fallback with [].
   */
  private getJobFromManifest(
    folderPath: string,
    fileName: string,
    suitePath: string[],
    testName: string
  ): { jobId: string; testId?: string; strategy: string } | undefined {
    const resolved = resolveManifestEntryFromRuntime(this.jobManifest, { folderPath, fileName, suitePath, testName });
    if (!resolved?.entry?.jobId) return undefined;
    return {
      jobId: resolved.entry.jobId,
      testId: resolved.entry.testId,
      strategy: resolved.strategy,
    };
  }

  private getManifestDebugCandidates(fileName: string, testName: string, limit: number = 3): string {
    const candidates = this.jobManifest
      .filter((e) => e.fileName === fileName || e.testName === testName)
      .slice(0, limit)
      .map((e) => ({
        folderPath: normalizeManifestFolderPath(e.folderPath),
        fileName: e.fileName,
        suitePath: e.suitePath || [],
        testName: e.testName
      }));
    return JSON.stringify(candidates);
  }

  /**
   * Build full job detail from all attempts for this test (from in-memory testExecutions).
   * For step_end: currentAttemptIsFinal=false (current attempt in progress).
   * For test_end: currentAttemptIsFinal=true, finalStatus/error from result.
   * Past attempts are marked FAILED (retry implies they did not succeed).
   */
  private buildJobDetailFromAttempts(
    testId: string,
    testName: string,
    upToRetryInclusive: number,
    currentAttemptIsFinal: boolean,
    finalStatus?: SmartTestExecutionStatus,
    finalError?: string
  ): SmartTestExecutionJobDetail {
    // Only prior attempts go in retryAttemptLogs; last run is in jobDetail.steps (no duplication when 1 run).
    const retryAttemptLogs: RetryAttemptLog[] = [];
    for (let r = 0; r < upToRetryInclusive; r++) {
      const key = `${testId}_attempt_${r}`;
      const exec = this.testExecutions.get(key);
      if (!exec) continue;
      retryAttemptLogs.push({
        retryCount: r,
        steps: [...exec.steps],
        status: SmartTestExecutionStatus.SMART_TEST_EXECUTION_FAILED,
        error: undefined
      });
    }
    const currentExec = this.testExecutions.get(`${testId}_attempt_${upToRetryInclusive}`);
    const steps = currentExec?.steps ?? [];
    return {
      testName,
      steps,
      status: currentAttemptIsFinal && finalStatus !== undefined ? finalStatus : SmartTestExecutionStatus.SMART_TEST_EXECUTION_IN_PROGRESS,
      error: currentAttemptIsFinal ? finalError : undefined,
      scenarioCoverageResults: [],
      retryAttemptLogs
    };
  }

  /** Build current job detail for platform step_end (all attempts so far, current still in progress) */
  private buildCurrentJobDetailForPlatform(test: TestCase, currentRetry: number, testName: string): SmartTestExecutionJobDetail {
    return this.buildJobDetailFromAttempts(test.id, testName, currentRetry, false);
  }

  /** Build final job detail for platform test_end (all attempts with final status) */
  private buildFinalJobDetailForPlatform(
    test: TestCase,
    result: TestResult,
    testName: string,
    currentSteps: SmartTestExecutionStep[]
  ): SmartTestExecutionJobDetail {
    const status = this.mapStatus(result.status);
    const jobDetail = this.buildJobDetailFromAttempts(test.id, testName, result.retry, true, status, result.error?.message);
    const annotations = collectPlaywrightAnnotations(test, result);
    const skipReason =
      status === SmartTestExecutionStatus.SMART_TEST_EXECUTION_SKIPPED
        ? resolveSkipReasonFromAnnotations(annotations, result.error?.message)
        : undefined;
    return {
      ...jobDetail,
      steps: [...currentSteps],
      pwError: this.toPlaywrightError(result.error),
      annotations,
      skipReason,
    };
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
    // Repair mode: emit lightweight progress events (multiple healer reruns are grouped by run index).
    if (this.options.executionMode === 'repair' && this.apiClient) {
      const jobId = getEnvVar('TESTCHIMP_REPAIR_JOB_ID', '') || '';
      if (jobId) {
        const runIndexRaw = getEnvVar('TESTCHIMP_REPAIR_RUN_INDEX', '0') || '0';
        const runIndex = Number(runIndexRaw) || 0;
        const event = {
          runIndex,
          timestampMillis: Date.now(),
          message: `[${step.category}] ${step.title}${step.error?.message ? ` (error: ${step.error.message})` : ''}`,
          phase: 'RUNNING_HEALER',
          rawPayloadJson: JSON.stringify({
            testTitle: test.title,
            retry: result.retry,
            step: { title: step.title, category: step.category, duration: step.duration },
            error: step.error ? { message: step.error.message, stack: (step.error as any).stack } : undefined,
          }),
        };
        const p = this.apiClient.repairStepEnd(jobId, event).catch((err) => {
          console.error(`[TestChimp] repair_step_end failed jobId=${jobId}:`, err instanceof Error ? err.message : err);
        });
        this.pushPendingForJob(jobId, p);
      }
      // Continue capturing steps locally for consistency (no-op for repair UI today).
    }

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

    // ExploreChimp wraps analyze calls in test.step; axe/page.content emit many nested pw:api steps. Do not
    // record them (avoids duplicate descriptions in ingestion + smaller payloads / platform step_end traffic).
    if (step.category === 'pw:api' && this.hasExploreChimpSyntheticWrapperAncestor(step)) {
      if (this.options.verbose) {
        console.log(`[TestChimp] Step suppressed (pw:api inside ExploreChimp wrapper): "${step.title}"`);
      }
      return;
    }

    const stepNumber = execution.steps.length + 1;
    const desc = this.getStepDescription(step);
    let stepId = generateStepId(stepNumber);
    if (step.category === 'test.step' && this.isExploreChimpAnalyticsStepTitle(step.title)) {
      stepId = stableExploreChimpAnalyticsStepId(test.id, result.retry, step.title);
    }

    const exploreChimpScreenState =
      step.category === 'test.step' && this.isExploreChimpAnalyticsStepTitle(step.title)
        ? consumeExploreChimpAnalyticsStepScreenState(stepId)
        : undefined;

    const executionStep: SmartTestExecutionStep = {
      stepId,
      description: desc,
      status: step.error
        ? StepExecutionStatus.FAILURE_STEP_EXECUTION
        : StepExecutionStatus.SUCCESS_STEP_EXECUTION,
      error: step.error?.message,
      pwStepCategory: step.category,
      durationMs: step.duration,
      pwError: this.toPlaywrightError(step.error),
      wasRepaired: false,
      ...(exploreChimpScreenState ? { screenState: exploreChimpScreenState } : {})
    };

    execution.steps.push(executionStep);

    if (this.options.verbose) {
      console.log(
        `[TestChimp] Step captured: ${stepNumber} (${step.category}): "${executionStep.description}" (raw: "${step.title}") - ${executionStep.status}`
      );
    }

    // Platform mode (optional): after each step, send full job detail to scriptservice (blind upsert).
    // Default is disabled to keep platform behavior close to local/CI and avoid step_end/test_end races.
    if (this.options.executionMode === 'platform' && this.apiClient && this.platformStepEndEnabled) {
      const paths = derivePaths(test, this.testsFolder, this.config.rootDir, false);
      const resolved = this.getJobFromManifest(paths.folderPath, paths.fileName, paths.suitePath, paths.testName);
      if (resolved?.jobId) {
        const jobId = resolved.jobId;
        console.log(
          `[TestChimp] platform/step_end resolve strategy=${resolved.strategy} jobId=${jobId} fileName="${paths.fileName}" suitePath=${JSON.stringify(paths.suitePath)} testName="${paths.testName}"`
        );
        const jobDetail = this.buildCurrentJobDetailForPlatform(test, result.retry, paths.testName);
        const p = this.apiClient.platformStepEnd(jobId, jobDetail).then(
          () => {
            if (this.options.verbose) {
              console.log(`[TestChimp] platform/step_end ok jobId=${jobId} steps=${jobDetail.steps?.length ?? 0}`);
            }
          },
          (err) => {
            console.error(`[TestChimp] platform/step_end failed jobId=${jobId}:`, err instanceof Error ? err.message : err);
            }
          );
          this.pushPendingForJob(jobId, p);
      } else {
        console.warn(
          `[TestChimp] platform/step_end skipped: no jobId in manifest for folderPath="${paths.folderPath}" normalizedFolderPath="${normalizeManifestFolderPath(paths.folderPath)}" fileName="${paths.fileName}" suitePath=${JSON.stringify(paths.suitePath)} testName="${paths.testName}" candidates=${this.getManifestDebugCandidates(paths.fileName, paths.testName)}`
        );
      }
    }
  }

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    // Playwright does not await onTestEnd; register so onEnd can drain before exit.
    const work = this.runTrackedOnTestEnd(test, result);
    this.inFlightTestEndWork.add(work);
    try {
      await work;
    } finally {
      this.inFlightTestEndWork.delete(work);
    }
  }

  private async runTrackedOnTestEnd(test: TestCase, result: TestResult): Promise<void> {
    const testKey = this.getTestKey(test, result.retry);
    const executionSnapshot = this.testExecutions.get(testKey) ?? null;
    try {
      await this._onTestEndInner(test, result);
    } finally {
      if (this.options.executionMode !== 'repair') {
        try {
          await this.ensureExploreChimpJourneyExecutionEnd(test, result, executionSnapshot);
        } catch (e) {
          console.error('[TestChimp] ExploreChimp journey_execution_end (onTestEnd finally guard) failed:', e);
        }
      }
    }
  }

  /**
   * US-185: read the buffered API operation interactions attached by the `page` fixture
   * (see runtime.ts `extendWebTrueCoveragePage`) and forward them for ingest, filling in
   * whatever test/execution identity is available at the call site. Best-effort — never
   * throws, and no-ops when the attachment is absent (e.g. TESTCHIMP_ENABLE_API_CAPTURE unset,
   * no page fixture used, or no matching traffic observed).
   */
  private async ingestApiCoverageIfPresent(
    result: TestResult,
    ids: { testId?: string; executionId?: string }
  ): Promise<void> {
    if (!this.apiClient) return;
    const attachment = result.attachments.find((a) => a.name === API_COVERAGE_ATTACHMENT_NAME);
    if (!attachment) return;
    try {
      let raw: Buffer | string | undefined = attachment.body;
      if (!raw && attachment.path) {
        raw = fs.readFileSync(attachment.path);
      }
      if (!raw) return;
      const interactions = parseApiCoverageAttachment(raw);
      if (interactions.length === 0) return;

      const enriched: ApiOperationInteraction[] = interactions.map((interaction) => ({
        ...interaction,
        testId: interaction.testId ?? ids.testId,
        executionId: interaction.executionId ?? ids.executionId,
        batchInvocationId: interaction.batchInvocationId ?? this.batchInvocationId,
        environment: interaction.environment ?? this.options.environment,
        testMode: interaction.testMode ?? ApiOperationTestMode.AUTOMATION,
      }));
      await this.apiClient.ingestApiOperationInteractions(enriched);
    } catch (err) {
      console.error('[TestChimp] Failed to ingest API operation interactions (non-fatal):', err);
    }
  }

  private async _onTestEndInner(test: TestCase, result: TestResult): Promise<void> {
    console.log(`[TestChimp] onTestEnd called for test: ${test.title} (status: ${result.status}, retry: ${result.retry})`);
    
    if (!this.isEnabled) {
      console.log(`[TestChimp] Reporter is not enabled, skipping report for: ${test.title}`);
      return;
    }
    
    if (!this.apiClient) {
      console.log(`[TestChimp] API client is not initialized, skipping report for: ${test.title}`);
      return;
    }

    // Repair mode: emit end-of-run marker and stop (no CI/platform ingest report).
    if (this.options.executionMode === 'repair') {
      const jobId = getEnvVar('TESTCHIMP_REPAIR_JOB_ID', '') || '';
      if (jobId) {
        const runIndexRaw = getEnvVar('TESTCHIMP_REPAIR_RUN_INDEX', '0') || '0';
        const runIndex = Number(runIndexRaw) || 0;
        const summary = {
          runIndex,
          timestampMillis: Date.now(),
          status: result.status,
          message: `Repair run completed with status=${result.status} retry=${result.retry}`,
          errorMessage: result.error?.message,
        };
        try {
          await this.apiClient.repairTestEnd(jobId, summary);
        } catch (e) {
          console.error(`[TestChimp] repair_test_end failed jobId=${jobId}:`, e);
        }
      }
      await this.ingestApiCoverageIfPresent(result, {});
      return;
    }

    const testKey = this.getTestKey(test, result.retry);
    const execution = this.testExecutions.get(testKey);

    if (!execution) {
      console.log(`[TestChimp] No execution state found for test: ${test.title} (key: ${testKey}), skipping report`);
      console.log(`[TestChimp] Available execution keys: ${Array.from(this.testExecutions.keys()).join(', ')}`);
      return;
    }

    // Check if this is the final attempt (for retry handling).
    // Playwright does not retry skipped/interrupted — treat those as final or they never ingest
    // (smart-smoke skips with retries>0 were dropped as "non_final_attempt").
    const retryKey = test.id;
    const retryInfo = this.testRetryInfo.get(retryKey);
    const isFinalAttempt = isPlaywrightFinalAttempt(
      result.status,
      result.retry,
      retryInfo?.maxRetries
    );

    console.log(`[TestChimp] Test status: ${result.status}, retry: ${result.retry}, maxRetries: ${retryInfo?.maxRetries ?? 'unknown'}, isFinalAttempt: ${isFinalAttempt}`);

    // Platform mode: we keep all retry attempts in testExecutions until test_end. Only send test_end on final attempt (with full retryAttemptLogs), then cleanup.
    if (this.options.executionMode === 'platform') {
      const paths = derivePaths(test, this.testsFolder, this.config.rootDir, false);
      const manifestHit = this.getJobFromManifest(paths.folderPath, paths.fileName, paths.suitePath, paths.testName);
      if (isFinalAttempt && this.apiClient) {
        const finalizePromise = this.platformFinalizeTestEnd(test, result, execution);
        this.inFlightTestEndWork.add(finalizePromise);
        try {
          await finalizePromise;
        } finally {
          this.inFlightTestEndWork.delete(finalizePromise);
        }
      }
      // Coverage denorm requires testId; resolve from platform job manifest (not empty {}).
      await this.ingestApiCoverageIfPresent(result, {
        testId: manifestHit?.testId,
        executionId: manifestHit?.jobId,
      });
      console.log(
        `[TestChimp] ingest_diag skip_ingest reason=platform_mode test=${JSON.stringify(test.title)} isFinalAttempt=${isFinalAttempt}`
      );
      return;
    }

    // CI mode: skip non-final attempts if configured (journey_execution_end runs in onTestEnd finally).
    if (this.options.reportOnlyFinalAttempt && !isFinalAttempt) {
      console.log(
        `[TestChimp] ingest_diag skip_ingest reason=non_final_attempt test=${JSON.stringify(test.title)} retry=${result.retry}`
      );
      console.log(`[TestChimp] Skipping non-final attempt ${result.retry + 1} for: ${test.title}`);
      this.testExecutions.delete(testKey);
      return;
    }

    // Attach screenshots (CI mode) before building the report
    if (this.options.captureScreenshots) {
      await this.attachScreenshotsToFailingSteps(execution.steps, result.attachments);
    }

    // Build the report
    const report = this.buildReport(test, result, execution);
    const traceGcsPath = await this.uploadTraceAttachmentIfPresent(result.attachments);
    if (traceGcsPath) {
      report.jobDetail.traceGcsPath = traceGcsPath;
    }

    // Log report details
    console.log(`[TestChimp] Preparing to send report for test: ${test.title}`);
    console.log(`[TestChimp]   Status: ${report.jobDetail.status}`);
    console.log(`[TestChimp]   Steps: ${report.jobDetail.steps.length}`);
    const stepsWithScreenshots = report.jobDetail.steps.filter(s => s.screenshotBase64);
    if (stepsWithScreenshots.length > 0) {
      console.log(`[TestChimp]   Steps with screenshots: ${stepsWithScreenshots.length}`);
    }

    console.log(
      `[TestChimp] ingest_diag before_ingest pid=${process.pid} test=${JSON.stringify(test.title)} ` +
        `executionMode=${this.options.executionMode} executionSource=${report.executionSource} ` +
        `axiosBaseURL=${JSON.stringify(this.apiClient.getBaseUrl())} ` +
        `isExploreChimpEnabled=${isExploreChimpEnabled()} env_EXPLORECHIMP=${process.env.EXPLORECHIMP_ENABLED === undefined ? '(undefined)' : JSON.stringify(process.env.EXPLORECHIMP_ENABLED)}`
    );

    try {
      const response = await this.apiClient.ingestExecutionReport(report);
      console.log(
        `[TestChimp] ingest_diag after_ingest_ok jobId=${response.jobId} testFound=${response.testFound} ` +
          `baseUrl=${JSON.stringify(this.apiClient.getBaseUrl())}`
      );

      if (this.options.verbose) {
        console.log(`[TestChimp] Reported: ${test.title} (jobId: ${response.jobId}, testFound: ${response.testFound})`);
        if (response.scenariosPopulated && response.scenariosPopulated > 0) {
          console.log(`[TestChimp] Auto-populated ${response.scenariosPopulated} scenario(s)`);
        }
      }
      await this.ingestApiCoverageIfPresent(result, { testId: response.testId, executionId: response.jobId });
    } catch (error) {
      console.error(
        `[TestChimp] ingest_diag after_ingest_error baseUrl=${JSON.stringify(this.apiClient.getBaseUrl())} test=${JSON.stringify(test.title)}`,
        error
      );
      // Best-effort: still forward coverage even when the smarttest execution report failed to ingest.
      await this.ingestApiCoverageIfPresent(result, {});
    }

    // Cleanup (ExploreChimp journey_execution_end is invoked from onTestEnd finally).
    this.testExecutions.delete(testKey);
  }

  async onEnd(result: FullResult): Promise<void> {
    try {
      const pendingStart = this.countTotalPendingOperations();
      if (this.inFlightTestEndWork.size > 0) {
        await Promise.allSettled([...this.inFlightTestEndWork]);
      }
      if (pendingStart > 0) {
        console.log(`[TestChimp] Waiting for ${pendingStart} pending operations to complete...`);
      }
      await this.drainAllPendingBuckets();
      if (
        this.isEnabled &&
        this.apiClient &&
        this.options.executionMode === 'ci' &&
        this.batchInvocationId?.trim()
      ) {
        const batchStatus = mapPlaywrightSuiteStatusToBatchStatus(result.status);
        try {
          const completeResponse = await this.apiClient.completeBatchInvocation({
            batchInvocationId: this.batchInvocationId,
            status: batchStatus,
          });
          const batchViewUrl = completeResponse.batchViewUrl?.trim();
          if (batchViewUrl) {
            console.log(`[TestChimp] Batch invocation view: ${batchViewUrl}`);
          }
          if (this.options.verbose) {
            console.log(
              `[TestChimp] complete_batch_invocation materialized=${completeResponse.materialized ?? false} status=${result.status}`
            );
          }
        } catch (e) {
          console.error('[TestChimp] complete_batch_invocation failed:', e);
        }
      }
      // Best-effort: if a test never ran onTestEnd's finally (worker/process edge cases), still close open ExploreChimp journeys.
      if (this.isEnabled && this.apiClient && isExploreChimpEnabled() && this.options.executionMode !== 'repair') {
        const leftovers = [...this.testExecutions.entries()];
        const marker = '_attempt_';
        for (const [testKey, execution] of leftovers) {
          const i = testKey.lastIndexOf(marker);
          if (i <= 0) continue;
          const retry = parseInt(testKey.slice(i + marker.length), 10);
          if (!Number.isFinite(retry)) continue;
          const baseId = testKey.slice(0, i);
          if (baseId !== execution.testCase.id) continue;
          const syntheticResult = {
            duration: 0,
            status: 'interrupted',
            errors: [],
            error: undefined,
            retry,
            startTime: new Date(),
            annotations: [],
            steps: [],
            attachments: [],
            stdout: [],
            stderr: [],
            retryErrors: [],
            parallelIndex: 0,
            workerIndex: 0,
          } as TestResult;
          try {
            await this.ensureExploreChimpJourneyExecutionEnd(execution.testCase, syntheticResult, execution);
          } catch (e) {
            console.error(
              `[TestChimp] onEnd: ExploreChimp journey_execution_end safety net failed for ${execution.testCase.title}:`,
              e
            );
          }
        }
      }
      const suppressExplorationEnd = getEnvVar('TESTCHIMP_SUPPRESS_EXPLORECHIMP_EXPLORATION_END', '') === 'true';
      if (this.isEnabled && this.apiClient && isExploreChimpEnabled()) {
        const explorationId = this.batchInvocationId?.trim();
        if (explorationId && !suppressExplorationEnd) {
          try {
            await this.apiClient.explorechimpExplorationEnd({ explorationId });
          } catch (e) {
            console.error('[TestChimp] explorechimp/exploration_end failed:', e);
          }
        } else if (explorationId && suppressExplorationEnd) {
          console.log('[TestChimp] ExploreChimp exploration_end suppressed by TESTCHIMP_SUPPRESS_EXPLORECHIMP_EXPLORATION_END=true');
        }
      }
      if (this.options.verbose) {
        console.log(`[TestChimp] Test run completed. Status: ${result.status}`);
        console.log(`[TestChimp] Batch invocation ID: ${this.batchInvocationId}`);
      }
    } finally {
      this.unlinkSuiteBatchInvocationFileIfWritten();
      unlinkSmartSmokeSelectionFile(this.smartSmokeSelectionFilePath);
      this.smartSmokeSelectionFilePath = null;
    }
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  /** Align ExploreChimp workers with suite batch id (env then file); same path as {@link readTestChimpBatchInvocationId}. */
  private writeSuiteBatchInvocationFileForExploreChimp(): void {
    const rootDir = this.config?.rootDir || process.cwd();
    const filePath = getTestChimpBatchInvocationFilePath(rootDir);
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, this.batchInvocationId, 'utf8');
      this.batchInvocationFileWrittenPath = filePath;
      this.shouldUnlinkBatchInvocationFile = true;
    } catch (e) {
      console.warn('[TestChimp] Could not write batch invocation id file:', e);
      this.batchInvocationFileWrittenPath = null;
      this.shouldUnlinkBatchInvocationFile = false;
    }
  }

  /**
   * When TESTCHIMP_SMART_SMOKE_ENABLED, select a subset and write a sidecar for workers.
   * When disabled, remove any leftover sidecar so a prior crashed run cannot skip the suite.
   */
  private async maybeRunSmartSmokeSelection(
    suite: Suite,
    apiClient: TestChimpApiClient | null
  ): Promise<void> {
    const rootDir = this.config?.rootDir || process.cwd();
    const useOpts = readSmartSmokeUseFromConfig(this.config);
    const smoke = resolveSmartSmokeConfig(useOpts);
    if (!smoke.enabled) {
      unlinkSmartSmokeSelectionFile(getSmartSmokeSelectionFilePath(rootDir));
      return;
    }
    if (smoke.usedDefaultSuitePercentage) {
      console.warn(
        '[TestChimp] Smart-smoke: no size constraint from env or use.testchimpSmartSmoke — defaulting to suitePercentage=20'
      );
    }

    const branchName = getBranchName();
    const plansRoot = findPlansRoot(rootDir);
    if (!plansRoot) {
      console.warn(
        `[TestChimp] Smart-smoke: could not find plans root (.testchimp-plans or plans/) under ${rootDir}; related-tests.json will be empty`
      );
    } else if (!branchName) {
      console.warn(
        '[TestChimp] Smart-smoke: branch name unresolved (set TESTCHIMP_BRANCH_NAME); related-tests.json will be empty'
      );
    }
    const relatedTests = loadRelatedTests(plansRoot, branchName);
    const { suiteCandidates, taggedTests } = collectSuiteCandidates(
      suite,
      this.testsFolder,
      rootDir,
      smoke.includeTags
    );
    const mustInclude = unionLocators(relatedTests, taggedTests);

    let selected: TestLocatorJson[];
    if (smoke.relatedTestsOnly) {
      selected = unionLocators(relatedTests);
      console.log(
        `[TestChimp] Smart-smoke related-tests-only: ${selected.length} test(s) from related-tests.json (branch=${branchName || '(unknown)'})`
      );
    } else if (apiClient) {
      try {
        const resp = await apiClient.selectSmartSmokeTests({
          related_tests: relatedTests.map(toWireLocator),
          include_tags: smoke.includeTags,
          tagged_tests: taggedTests.map(toWireLocator),
          // Platform inventory is the packing universe — do not send suite_candidates.
          max_time_budget_mins: smoke.maxTimeBudgetMins,
          max_tests: smoke.maxTests,
          suite_percentage: smoke.suitePercentage,
          branch_name: branchName,
          environment: this.options.environment || undefined,
        });
        selected = (resp.selectedTests || []).map((r) => fromWireLocator(r));
        const diag = [
          `localSuite=${suiteCandidates.length}`,
          `related=${relatedTests.length}`,
          `tagged=${taggedTests.length}`,
          resp.candidateUniverseSize != null ? `universe=${resp.candidateUniverseSize}` : null,
          resp.seedsCount != null ? `seeds=${resp.seedsCount}` : null,
          resp.stopReason ? `stop=${resp.stopReason}` : null,
          resp.estimatedSelectedTimeSecs != null
            ? `estSecs=${Math.round(resp.estimatedSelectedTimeSecs)}`
            : null,
        ]
          .filter(Boolean)
          .join(', ');
        console.log(
          `[TestChimp] Smart-smoke selection API returned ${selected.length} test(s) (${diag})`
        );
      } catch (e) {
        selected = mustInclude;
        console.warn(
          `[TestChimp] Smart-smoke selection API failed; falling back to related∪tagged (${selected.length}):`,
          e
        );
        if (selected.length === 0 && suiteCandidates.length > 0) {
          selected = this.naiveLocalSuiteSlice(suiteCandidates, smoke);
          console.warn(`[TestChimp] Smart-smoke local naive slice: ${selected.length} of ${suiteCandidates.length}`);
        }
      }
    } else {
      selected = mustInclude;
      if (selected.length === 0 && suiteCandidates.length > 0) {
        selected = this.naiveLocalSuiteSlice(suiteCandidates, smoke);
      }
      console.warn(
        `[TestChimp] Smart-smoke: no API client; local selection ${selected.length} test(s)`
      );
    }

    if (selected.length === 0) {
      console.warn(
        '[TestChimp] Smart-smoke: selection is empty — all tests will be skipped. Check related-tests.json / tags / budget.'
      );
    }

    try {
      this.smartSmokeSelectionFilePath = writeSmartSmokeSelectionFile(rootDir, {
        enabled: true,
        selectedTests: selected,
        relatedTestsOnly: smoke.relatedTestsOnly,
        branchName,
      });
      console.log(
        `[TestChimp] Smart-smoke selection written: ${this.smartSmokeSelectionFilePath} (${selected.length} test(s))`
      );
    } catch (e) {
      console.error('[TestChimp] Smart-smoke: failed to write selection file:', e);
      // Still try to write an empty enabled sidecar so workers fail-closed quickly
      // instead of polling for 90s each.
      try {
        this.smartSmokeSelectionFilePath = writeSmartSmokeSelectionFile(rootDir, {
          enabled: true,
          selectedTests: [],
          relatedTestsOnly: smoke.relatedTestsOnly,
          branchName,
        });
      } catch {
        this.smartSmokeSelectionFilePath = null;
      }
    }
  }

  private naiveLocalSuiteSlice(
    suiteCandidates: TestLocatorJson[],
    smoke: { suitePercentage?: number; maxTests?: number; maxTimeBudgetMins?: number }
  ): TestLocatorJson[] {
    // Time-only budget with no count cap: run the local suite (server inventory unavailable).
    if (
      smoke.maxTimeBudgetMins != null &&
      smoke.maxTimeBudgetMins > 0 &&
      smoke.suitePercentage == null &&
      (smoke.maxTests == null || smoke.maxTests <= 0)
    ) {
      return suiteCandidates.slice();
    }
    const pct = smoke.suitePercentage ?? 20;
    let n = Math.max(1, Math.ceil(suiteCandidates.length * (pct / 100)));
    if (smoke.maxTests != null && smoke.maxTests > 0) {
      n = Math.min(n, smoke.maxTests);
    }
    return suiteCandidates.slice(0, n);
  }

  private unlinkSuiteBatchInvocationFileIfWritten(): void {
    if (!this.shouldUnlinkBatchInvocationFile || !this.batchInvocationFileWrittenPath) return;
    try {
      fs.unlinkSync(this.batchInvocationFileWrittenPath);
    } catch (e) {
      console.warn('[TestChimp] Could not remove batch invocation id file:', e);
    } finally {
      this.shouldUnlinkBatchInvocationFile = false;
      this.batchInvocationFileWrittenPath = null;
    }
  }

  private getTestKey(test: TestCase, retry: number): string {
    return `${test.id}_attempt_${retry}`;
  }

  private async platformFinalizeTestEnd(test: TestCase, result: TestResult, execution: TestExecutionState): Promise<void> {
    const paths = derivePaths(test, this.testsFolder, this.config.rootDir, false);
    const resolved = this.getJobFromManifest(paths.folderPath, paths.fileName, paths.suitePath, paths.testName);
    const platformJobId = resolved?.jobId?.trim() || undefined;
    if (platformJobId) {
      const jobId = platformJobId;
      console.log(
        `[TestChimp] platform/test_end resolve strategy=${resolved?.strategy} jobId=${jobId} fileName="${paths.fileName}" suitePath=${JSON.stringify(paths.suitePath)} testName="${paths.testName}"`
      );
      let jobDetail = this.buildFinalJobDetailForPlatform(test, result, paths.testName, execution.steps);
      try {
        if (this.options.captureScreenshots) {
          console.log(`[TestChimp] platform/test_end pre-send: attaching screenshots jobId=${jobId} steps=${execution.steps.length} attachments=${result.attachments.length}`);
          try {
            await this.attachScreenshotsToFailingSteps(execution.steps, result.attachments);
            console.log(`[TestChimp] platform/test_end pre-send: screenshot attach done jobId=${jobId}`);
          } catch (e) {
            console.error(`[TestChimp] platform/test_end pre-send: screenshot attach failed jobId=${jobId}:`, e);
          }
        }
        jobDetail = this.buildFinalJobDetailForPlatform(test, result, paths.testName, execution.steps);
        console.log(
          `[TestChimp] platform/test_end pre-send: built final jobDetail jobId=${jobId} status=${jobDetail.status} steps=${jobDetail.steps?.length ?? 0} retryAttemptLogs=${jobDetail.retryAttemptLogs?.length ?? 0}`
        );
        console.log(`[TestChimp] platform/test_end pre-send: uploading trace (if present) jobId=${jobId}`);
        const traceGcsPath = await this.uploadTraceAttachmentIfPresent(result.attachments);
        if (traceGcsPath) {
          jobDetail.traceGcsPath = traceGcsPath;
          console.log(`[TestChimp] platform/test_end pre-send: trace upload done jobId=${jobId} traceGcsPath=${traceGcsPath}`);
        } else {
          console.log(`[TestChimp] platform/test_end pre-send: no trace uploaded jobId=${jobId}`);
        }
      } catch (prepError) {
        console.error(`[TestChimp] platform/test_end pre-send failed; continuing with fallback payload jobId=${jobId}:`, prepError);
      }
      if (this.platformStepEndEnabled) {
        await this.drainPendingForJob(jobId);
      }
      console.log(`[TestChimp] platform/test_end sending: ${test.title} jobId=${jobId}`);
      const durationMs = resolveDurationMs(result.duration, execution.startedAt, Date.now());
      const platformTestEndPromise = this.apiClient!.platformTestEnd(jobId, jobDetail, durationMs);
      if (this.platformStepEndEnabled) {
        this.pushPendingForJob(jobId, platformTestEndPromise);
      }
      try {
        await platformTestEndPromise;
        console.log(`[TestChimp] platform/test_end sent: ${test.title} jobId=${jobId} retryAttemptLogs=${jobDetail.retryAttemptLogs?.length ?? 0}`);
      } catch (error) {
        console.error(`[TestChimp] platform/test_end failed for ${test.title}:`, error);
      }
    }

    if (platformJobId && this.platformStepEndEnabled) {
      await this.drainPendingForJob(platformJobId);
    }
    for (let r = 0; r <= result.retry; r++) {
      this.testExecutions.delete(this.getTestKey(test, r));
    }
  }

  /**
   * ExploreChimp execution job id: platform manifest job id when resolved, else stable hash of test id + batch + retry.
   * Must match {@link ensureExploreChimpJourneyExecutionEnd} and the id used for smart test execution ingest.
   */
  private exploreChimpJourneyExecutionJobId(
    test: TestCase,
    result: TestResult,
    paths: ReturnType<typeof derivePaths>
  ): string | undefined {
    if (!isExploreChimpEnabled()) {
      return undefined;
    }
    const explorationId = this.batchInvocationId?.trim();
    if (!explorationId) {
      return undefined;
    }
    if (this.options.executionMode === 'platform') {
      const resolved = this.getJobFromManifest(paths.folderPath, paths.fileName, paths.suitePath, paths.testName);
      const fromManifest = resolved?.jobId?.trim();
      if (fromManifest) {
        return fromManifest;
      }
    }
    return stableJourneyExecutionId(test.id, explorationId, result.retry);
  }

  /**
   * Local ExploreChimp: persist step timeline and mark the journey execution completed.
   * Only when {@link isExploreChimpEnabled} is true. Idempotent per journeyExecutionId.
   */
  private async ensureExploreChimpJourneyExecutionEnd(
    test: TestCase,
    result: TestResult,
    execution: TestExecutionState | null,
    pathsInput?: ReturnType<typeof derivePaths>
  ): Promise<void> {
    if (!this.apiClient || !this.isEnabled || this.options.executionMode === 'repair' || !isExploreChimpEnabled()) {
      return;
    }
    const explorationId = this.batchInvocationId?.trim();
    if (!explorationId) {
      console.warn(
        '[TestChimp] ExploreChimp: skipping journey end — batch invocation id is empty (set TESTCHIMP_BATCH_INVOCATION_ID)'
      );
      return;
    }
    const paths = pathsInput ?? derivePaths(test, this.testsFolder, this.config.rootDir, false);
    const journeyExecutionId = this.exploreChimpJourneyExecutionJobId(test, result, paths);
    if (!journeyExecutionId) {
      return;
    }
    if (this.exploreChimpJourneyEndSentIds.has(journeyExecutionId)) {
      if (this.options.verbose) {
        console.log(
          `[TestChimp] ExploreChimp: journey_execution_end already sent for journeyExecutionId=${journeyExecutionId}, skipping duplicate`
        );
      }
      return;
    }
    const steps = execution?.steps ?? [];
    try {
      await this.apiClient.explorechimpJourneyExecutionEnd({
        journeyId: test.id,
        journeyExecutionId,
        explorationId,
        steps,
        smartTestStatus: this.mapStatus(result.status),
        errorMessage: result.error?.message,
      });
      this.exploreChimpJourneyEndSentIds.add(journeyExecutionId);
    } catch (e) {
      console.error(
        `[TestChimp] journey_execution_end FAILED journeyExecutionId=${journeyExecutionId} explorationId=${explorationId} test="${test.title}" retry=${result.retry}:`,
        e
      );
    }
  }

  private pushPendingForJob(jobId: string, p: Promise<any>): void {
    const id = jobId.trim();
    if (!id) return;
    let bucket = this.pendingOperationsByJobId.get(id);
    if (!bucket) {
      bucket = [];
      this.pendingOperationsByJobId.set(id, bucket);
    }
    bucket.push(p);
  }

  /**
   * Await in-flight HTTP for a single platform/repair job id. Work pushed while draining is picked up
   * in subsequent loop iterations for the same bucket.
   */
  private async drainPendingForJob(jobId: string): Promise<void> {
    const id = jobId.trim();
    if (!id) return;
    while (true) {
      const bucket = this.pendingOperationsByJobId.get(id);
      if (!bucket || bucket.length === 0) {
        if (bucket) {
          this.pendingOperationsByJobId.delete(id);
        }
        break;
      }
      const batch = bucket.splice(0, bucket.length);
      await Promise.allSettled(batch);
    }
  }

  private countTotalPendingOperations(): number {
    let n = 0;
    for (const arr of this.pendingOperationsByJobId.values()) {
      n += arr.length;
    }
    return n;
  }

  /** Run shutdown: wait for every job bucket (parallel tests may each have their own jobId). */
  private async drainAllPendingBuckets(): Promise<void> {
    while (this.pendingOperationsByJobId.size > 0) {
      const keys = [...this.pendingOperationsByJobId.keys()];
      await Promise.allSettled(keys.map((k) => this.drainPendingForJob(k)));
    }
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
    /** Align with ExploreChimp analyze payloads (`getBranchName` in explorechimp/index): TESTCHIMP_BRANCH_NAME first. */
    const branchName = getBranchName();
    const gitCommitSha = getRunCommitSha();
    // Platform run: scriptservice sets TESTCHIMP_BRANCH_ID (our entity id) for unique test resolution; CI does not have it
    const branchIdRaw = getEnvVar('TESTCHIMP_BRANCH_ID', '');
    const branchId = branchIdRaw ? parseInt(branchIdRaw, 10) : undefined;
    const branchIdValid = branchId !== undefined && !Number.isNaN(branchId) ? branchId : undefined;

    // Map Playwright status to SmartTestExecutionStatus
    const status = this.mapStatus(result.status);

    const executionContext = buildExecutionDeviceContext(test);
    const completedAtMillis = Date.now();
    const annotations = collectPlaywrightAnnotations(test, result);
    const skipReason =
      status === SmartTestExecutionStatus.SMART_TEST_EXECUTION_SKIPPED
        ? resolveSkipReasonFromAnnotations(annotations, result.error?.message)
        : undefined;
    const report: SmartTestExecutionReport = {
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
        pwError: this.toPlaywrightError(result.error),
        scenarioCoverageResults: [], // Backend will populate if empty
        executionContext,
        gitCommitSha,
        annotations,
        skipReason,
      },
      startedAtMillis: execution.startedAt,
      completedAtMillis,
      durationMs: resolveDurationMs(result.duration, execution.startedAt, completedAtMillis),
      branchName,
      branchId: branchIdValid,
      gitCommitSha,
      executionContext,
      annotations,
      executionSource: resolveExecutionSource(),
    };
    const exploreChimpJobId = this.exploreChimpJourneyExecutionJobId(test, result, paths);
    if (exploreChimpJobId) {
      report.journeyExecutionId = exploreChimpJobId;
    }
    return report;
  }

  private mapStatus(playwrightStatus: string): SmartTestExecutionStatus {
    switch (playwrightStatus) {
      case 'passed':
        return SmartTestExecutionStatus.SMART_TEST_EXECUTION_COMPLETED;
      case 'failed':
      case 'timedOut':
        return SmartTestExecutionStatus.SMART_TEST_EXECUTION_FAILED;
      case 'skipped':
        return SmartTestExecutionStatus.SMART_TEST_EXECUTION_SKIPPED;
      case 'interrupted':
        return SmartTestExecutionStatus.SMART_TEST_EXECUTION_INTERRUPTED;
      default:
        if (playwrightStatus) {
          console.warn(
            `[TestChimp] mapStatus: unknown Playwright result.status "${playwrightStatus}" — storing UNKNOWN_SMART_TEST_EXECUTION_STATUS`
          );
        }
        return SmartTestExecutionStatus.UNKNOWN_SMART_TEST_EXECUTION_STATUS;
    }
  }

  /**
   * Attach failure screenshots: failing steps first; if none, attach to last step (test-level failures e.g. ai.act).
   */
  private async attachScreenshotsToFailingSteps(
    steps: SmartTestExecutionStep[],
    attachments: TestResult['attachments']
  ): Promise<void> {
    // Log all attachments for debugging
    console.log(`[TestChimp] Processing screenshots: ${attachments.length} total attachment(s), ${steps.length} step(s) total`);
    if (attachments.length > 0) {
      attachments.forEach((att, idx) => {
        console.log(`[TestChimp]   Attachment ${idx + 1}: name="${att.name}", contentType="${att.contentType}", path="${att.path || 'none'}", body=${att.body ? `present (${att.body.length} bytes)` : 'none'}`);
      });
    }

    // Filter for image attachments (with either path or body)
    const screenshots = attachments.filter(
      (a) => a.contentType?.startsWith('image/') && (a.path || a.body)
    );

    console.log(`[TestChimp] Found ${screenshots.length} screenshot(s) (with path or body)`);

    if (screenshots.length === 0) {
      console.log(`[TestChimp] No screenshots found in attachments - Playwright may not be configured to capture screenshots on failure`);
      console.log(`[TestChimp] To enable screenshots, add 'screenshot: "only-on-failure"' to your Playwright config`);
      return;
    }

    const failingWithoutScreenshot = steps.filter(
      (s) => s.status === StepExecutionStatus.FAILURE_STEP_EXECUTION && !s.screenshotPath
    );

    let targetSteps: SmartTestExecutionStep[];

    if (failingWithoutScreenshot.length > 0) {
      targetSteps = failingWithoutScreenshot;
      console.log(
        `[TestChimp] Found ${targetSteps.length} failing step(s) without screenshots; stepIds=${targetSteps
          .map((s) => s.stepId || 'unknown')
          .join(', ')}`
      );
    } else if (steps.length > 0) {
      const last = steps[steps.length - 1];
      if (last && !last.screenshotPath) {
        targetSteps = [last];
        console.log(
          `[TestChimp] No failing steps without screenshot; attaching failure screenshot to last step (fallback): "${last.description}" (${last.stepId})`
        );
      } else {
        console.log(
          `[TestChimp] No failing steps to attach screenshots to${last?.screenshotPath ? ' (last step already has screenshot)' : ''}`
        );
        return;
      }
    } else {
      console.log(`[TestChimp] No failing steps to attach screenshots to (no steps recorded)`);
      return;
    }

    // Use the last screenshot (most recent, likely from test failure)
    const screenshot = screenshots[screenshots.length - 1];

    let imageBuffer: Buffer | null = null;
    try {
      if (screenshot.path) {
        imageBuffer = fs.readFileSync(screenshot.path);
      } else if (screenshot.body) {
        imageBuffer = Buffer.from(screenshot.body);
      }
    } catch (error) {
      console.error(`[TestChimp] ✗ Failed to read screenshot:`, error);
      imageBuffer = null;
    }

    if (!imageBuffer) {
      console.warn('[TestChimp] Screenshot has neither readable path nor body; skipping upload');
      return;
    }
    console.log(`[TestChimp] Read screenshot buffer: ${imageBuffer.length} bytes`);

    if (!this.apiClient) {
      console.warn('[TestChimp] API client not initialized; cannot upload attachment');
      return;
    }

    try {
      // Convert to JPEG (quality 50) to reduce size
      const jpegBuffer = await sharp(imageBuffer)
        .jpeg({ quality: 50 })
        .toBuffer();
      console.log(`[TestChimp] Converted to JPEG: ${jpegBuffer.length} bytes, calling uploadAttachment`);
      const uploadResp = await this.apiClient.uploadAttachment(jpegBuffer, 'image/jpeg', {
        filename: 'screenshot.jpeg'
      });
      const gcpPath = uploadResp.gcpPath;
      if (!gcpPath) {
        console.error('[TestChimp] uploadAttachment response missing gcpPath; cannot attach to steps');
        return;
      }
      console.log(`[TestChimp] uploadAttachment succeeded: ${gcpPath}`);

      for (let stepIdx = 0; stepIdx < targetSteps.length; stepIdx++) {
        const step = targetSteps[stepIdx];
        step.screenshotPath = gcpPath;
        if (step.screenshotBase64) {
          delete step.screenshotBase64;
        }
        console.log(
          `[TestChimp] ✓ Attached screenshot path to step ${stepIdx + 1}: "${step.description}" -> ${gcpPath}`
        );
      }
    } catch (error) {
      console.error('[TestChimp] ✗ Failed to upload screenshot attachment:', error);
    }
  }

  private getTraceMaxBytes(): number {
    const raw = getEnvVar('TESTCHIMP_TRACE_MAX_BYTES', '') || '';
    const parsed = raw ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return TestChimpReporter.DEFAULT_TRACE_MAX_BYTES;
  }

  private isTraceAttachment(attachment: TestResult['attachments'][number]): boolean {
    const name = (attachment.name || '').toLowerCase();
    const contentType = (attachment.contentType || '').toLowerCase();
    const filePath = (attachment.path || '').toLowerCase();
    return (
      contentType.includes('zip') ||
      name.includes('trace') ||
      filePath.endsWith('.zip')
    );
  }

  private async uploadTraceAttachmentIfPresent(attachments: TestResult['attachments']): Promise<string | undefined> {
    if (!this.apiClient) {
      return undefined;
    }

    const traceAttachment = [...attachments].reverse().find((a) => this.isTraceAttachment(a));
    if (!traceAttachment) {
      return undefined;
    }

    let traceBuffer: Buffer | null = null;
    try {
      if (traceAttachment.path) {
        traceBuffer = fs.readFileSync(traceAttachment.path);
      } else if (traceAttachment.body) {
        traceBuffer = Buffer.from(traceAttachment.body);
      }
    } catch (error) {
      console.error('[TestChimp] Failed to read trace attachment:', error);
      return undefined;
    }

    if (!traceBuffer || traceBuffer.length === 0) {
      console.warn('[TestChimp] Trace attachment is empty; skipping upload');
      return undefined;
    }

    const maxBytes = this.getTraceMaxBytes();
    if (traceBuffer.length > maxBytes) {
      console.warn(`[TestChimp] Trace attachment too large (${traceBuffer.length} bytes > ${maxBytes} bytes); skipping upload`);
      return undefined;
    }

    const contentType = traceAttachment.contentType || 'application/zip';
    const filename = traceAttachment.path
      ? path.basename(traceAttachment.path)
      : `${(traceAttachment.name || 'trace').replace(/[^a-zA-Z0-9._-]/g, '_')}.zip`;
    try {
      const uploadResp = await this.apiClient.uploadAttachment(traceBuffer, contentType, {
        filename,
        timeoutMs: TestChimpReporter.DEFAULT_TRACE_UPLOAD_TIMEOUT_MS,
        maxRetries: TestChimpReporter.DEFAULT_TRACE_UPLOAD_RETRIES
      });
      if (this.options.verbose) {
        console.log(`[TestChimp] Trace uploaded (${traceBuffer.length} bytes): ${uploadResp.gcpPath}`);
      }
      return uploadResp.gcpPath;
    } catch (error) {
      // Non-blocking by design: test execution should still be reported.
      console.error('[TestChimp] Trace upload failed (continuing without trace):', error);
      return undefined;
    }
  }

  /**
   * Generic Playwright pw:api leaf titles; use innermost enclosing test.step title instead.
   */
  private static readonly GENERIC_PW_API_TITLES = new Set(
    [
      'evaluate',
      'screenshot',
      'navigate',
      'wait',
      'click',
      'fill',
      'select',
      'check',
      'press',
      'hover',
      'drag',
      'tap',
      'type',
      'reload',
      'go to url',
      'get attribute',
      'inner text',
      'text content',
      'viewport',
      'close context',
      'close page',
      'new page',
      'keyboard',
      'mouse',
      'wait for event',
      'wait for timeout',
      'wait for load state',
      'wait for selector',
      'wait for function',
      'focus',
      'blur',
      'dispatch event',
      'emulate media',
      'add init script',
      'expose binding',
      'route',
      'unroute',
      'set content',
      'set extra http headers',
      'add cookies',
      'clear cookies',
      'grant permissions',
      'clear permissions'
    ]
  );

  private isGenericPwApiTitle(title: string): boolean {
    return TestChimpReporter.GENERIC_PW_API_TITLES.has(title.trim().toLowerCase());
  }

  /** Single-line description: test.step / expect use title; generic pw:api uses enclosing test.step title when present. */
  /** Must match ExploreChimp `test.step` titles in `explorechimp/index.ts` (stable step id alignment). */
  private isExploreChimpAnalyticsStepTitle(title: string): boolean {
    return (
      title.startsWith('Analyzing Console for Screen-state') ||
      title.startsWith('Analyzing Network for Screen-state') ||
      title.startsWith('Analyzing Metrics for Screen-state') ||
      title.startsWith('Analyzing Screenshot for Screen-state') ||
      title.startsWith('Analyzing DOM for Screen-state')
    );
  }

  /**
   * Playwright `test.step` wrappers used by ExploreChimp / markScreenState. Nested `pw:api` calls (e.g. axe
   * internals) must not inherit these titles for ingestion — that produced dozens of duplicate step rows per
   * checkpoint. Those wrappers are also omitted as "enclosing" steps for generic pw:api description folding.
   */
  private isExploreChimpSyntheticWrapperTitle(title: string): boolean {
    return this.isExploreChimpAnalyticsStepTitle(title) || title.startsWith('ScreenState:');
  }

  /** Nearest enclosing `test.step` that is not an ExploreChimp synthetic wrapper. */
  private getInnermostEnclosingTestStepTitle(step: TestStep): string | undefined {
    let p: TestStep | undefined = step.parent;
    while (p) {
      if (p.category === 'test.step' && !this.isExploreChimpSyntheticWrapperTitle(p.title)) {
        return p.title;
      }
      p = p.parent;
    }
    return undefined;
  }

  /** True if any ancestor `test.step` is ExploreChimp DOM/screenshot/etc. or ScreenState wait — suppress child pw:api rows. */
  private hasExploreChimpSyntheticWrapperAncestor(step: TestStep): boolean {
    let p: TestStep | undefined = step.parent;
    while (p) {
      if (p.category === 'test.step' && this.isExploreChimpSyntheticWrapperTitle(p.title)) {
        return true;
      }
      p = p.parent;
    }
    return false;
  }

  private getStepDescription(step: TestStep): string {
    if (step.category === 'test.step' || step.category === 'expect') {
      return step.title;
    }
    if (step.category === 'pw:api' && this.isGenericPwApiTitle(step.title)) {
      const enclosing = this.getInnermostEnclosingTestStepTitle(step);
      if (enclosing) {
        return enclosing;
      }
    }
    return step.title;
  }

  private toPlaywrightError(error: TestError | undefined, depth: number = 0, maxDepth: number = 3) {
    if (!error || depth >= maxDepth) {
      return undefined;
    }
    const mapped: any = {
      message: error.message,
      stack: error.stack,
      snippet: (error as any).snippet,
      value: (error as any).value,
    };
    if (error.location) {
      mapped.location = {
        file: error.location.file,
        line: error.location.line,
        column: error.location.column,
      };
    }
    if (error.cause) {
      mapped.cause = this.toPlaywrightError(error.cause, depth + 1, maxDepth);
    }
    return mapped;
  }
}

function mapPlaywrightSuiteStatusToBatchStatus(status: FullResult['status']): BatchInvocationStatus {
  switch (status) {
    case 'passed':
      return BatchInvocationStatus.BATCH_INVOCATION_COMPLETE;
    case 'timedout':
      return BatchInvocationStatus.BATCH_INVOCATION_EXCEPTION;
    case 'interrupted':
      // Preserve Playwright suite abort as its own terminal status — do not fold into FAILED.
      return BatchInvocationStatus.BATCH_INVOCATION_INTERRUPTED;
    case 'failed':
    default:
      return BatchInvocationStatus.BATCH_INVOCATION_FAILED;
  }
}
