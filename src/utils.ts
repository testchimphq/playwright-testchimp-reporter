import path from 'path';
import type { TestCase, Suite } from '@playwright/test/reporter';

/**
 * Derived path components for test identification
 */
export interface DerivedPaths {
  folderPath: string;
  fileName: string;
  suitePath: string[];
  testName: string;
}

/**
 * Derive path components from a Playwright TestCase
 *
 * @param test The Playwright TestCase
 * @param testsFolder Base folder for relative path calculation (optional)
 * @param rootDir Playwright root directory
 * @returns Derived path components for test identification
 */
export function derivePaths(
  test: TestCase,
  testsFolder: string,
  rootDir: string
): DerivedPaths {
  // Get the file path relative to testsFolder (or rootDir if not specified)
  const basePath = testsFolder ? path.resolve(rootDir, testsFolder) : rootDir;
  const absolutePath = test.location.file;
  const relativePath = path.relative(basePath, absolutePath);

  const folderPath = path.dirname(relativePath);
  const fileName = path.basename(relativePath);

  // Build suite path from parent suites (describe blocks)
  // Walk up the parent chain, collecting suite titles
  const suitePath: string[] = [];
  let parent: Suite | undefined = test.parent;

  while (parent) {
    // Skip if title is empty or matches the file name (file-level suite)
    if (parent.title &&
        !parent.title.endsWith('.spec.ts') &&
        !parent.title.endsWith('.test.ts') &&
        !parent.title.endsWith('.spec.js') &&
        !parent.title.endsWith('.test.js')) {
      // Only add non-file-level, non-project-level suites
      // Project suites have no parent with a title
      if (parent.parent) {
        suitePath.unshift(parent.title);
      }
    }
    parent = parent.parent;
  }

  return {
    folderPath: folderPath === '.' ? '' : folderPath,
    fileName,
    suitePath,
    testName: test.title
  };
}

/**
 * Generate a simple unique ID for steps
 */
export function generateStepId(stepNumber: number): string {
  return `step_${stepNumber}_${Date.now()}`;
}

/**
 * Safely get an environment variable with optional default
 */
export function getEnvVar(name: string, defaultValue?: string): string | undefined {
  return process.env[name] || defaultValue;
}

/**
 * Generate a UUID v4
 * Simple implementation without external dependency
 */
export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
