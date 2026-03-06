/**
 * TrueCoverage runtime: injects CITestInfo into the browser so testchimp-rum-js can
 * send the ci-test-info header on RUM ingest requests.
 * Import once in playwright.config.js: import 'playwright-testchimp-reporter/runtime';
 */

import * as fs from 'fs';
import * as path from 'path';
import { test } from '@playwright/test';
import { derivePathsFromTestInfo, deriveTestsFolder, getBranchName } from './utils';

const BATCH_ID_FILENAME = '.testchimp-batch-invocation-id';

function readBatchInvocationId(projectRootDir: string): string | undefined {
  const fromEnv = process.env.TESTCHIMP_BATCH_INVOCATION_ID;
  if (fromEnv) return fromEnv;
  const filePath =
    process.env.TESTCHIMP_BATCH_ID_FILE ||
    path.join(projectRootDir, BATCH_ID_FILENAME);
  try {
    return fs.readFileSync(filePath, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

test.beforeEach(async ({ page }, testInfo) => {
  const project = testInfo.project as { rootDir?: string };
  const projectRootDir = project.rootDir ?? process.cwd();
  const testsFolder = deriveTestsFolder(projectRootDir);
  const paths = derivePathsFromTestInfo(
    testInfo as unknown as Parameters<typeof derivePathsFromTestInfo>[0],
    testsFolder,
    projectRootDir,
    false
  );

  const ciTestInfo: Record<string, unknown> = {
    folderPath: paths.folderPath,
    fileName: paths.fileName,
    suitePath: paths.suitePath,
    testName: paths.testName,
  };
  const branchName = getBranchName();
  if (branchName) ciTestInfo.branchName = branchName;
  const env =
    process.env.TESTCHIMP_ENV ||
    process.env.CI_ENVIRONMENT_NAME ||
    process.env.NODE_ENV;
  if (env) ciTestInfo.environment = env;
  const release = process.env.TESTCHIMP_RELEASE;
  if (release) ciTestInfo.release = release;
  const batchInvocationId = readBatchInvocationId(projectRootDir);
  if (batchInvocationId) ciTestInfo.batchInvocationId = batchInvocationId;

  const jsonString = JSON.stringify(ciTestInfo);
  await page.addInitScript(
    (info: string) => {
      (globalThis as unknown as { __TC_CI_TEST_INFO?: string }).__TC_CI_TEST_INFO =
        info;
    },
    jsonString
  );
});
