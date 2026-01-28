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
 * @param verbose Whether to log path resolution details
 * @returns Derived path components for test identification
 */
export function derivePaths(
  test: TestCase,
  testsFolder: string,
  rootDir: string,
  verbose: boolean = false
): DerivedPaths {
  // Calculate path relative to testsFolder (or rootDir if not specified)
  const basePath = testsFolder ? path.resolve(rootDir, testsFolder) : rootDir;
  const filePath = test.location.file;
  const isRelativePath = !path.isAbsolute(filePath);
  
  if (verbose) {
    console.log(`[TestChimp] Path derivation for test: ${test.title}`);
    console.log(`[TestChimp]   rootDir: ${rootDir}`);
    console.log(`[TestChimp]   testsFolder: ${testsFolder || '(not set)'}`);
    console.log(`[TestChimp]   basePath: ${basePath}`);
    console.log(`[TestChimp]   test.location.file (original): ${filePath}`);
    console.log(`[TestChimp]   isRelativePath: ${isRelativePath}`);
  }
  
  // Always normalize to absolute path first for deterministic behavior
  // This ensures consistent behavior regardless of whether Playwright returns
  // absolute or relative paths (which can vary between CI and local runs)
  const absoluteFilePath = isRelativePath 
    ? path.resolve(rootDir, filePath)
    : filePath;
  
  if (verbose) {
    console.log(`[TestChimp]   absoluteFilePath: ${absoluteFilePath}`);
  }
  
  // Calculate relative path from basePath to absolute file path
  let relativePath = path.relative(basePath, absoluteFilePath);
  relativePath = path.normalize(relativePath);
  
  if (verbose) {
    console.log(`[TestChimp]   relativePath (after path.relative): ${relativePath}`);
  }
  
  // If the path still starts with ".." after normalization, remove those components
  // This handles edge cases where the path goes outside the expected base
  if (relativePath.startsWith('..')) {
    if (verbose) {
      console.log(`[TestChimp]   WARNING: Path starts with "..", removing parent directory references`);
    }
    const parts = relativePath.split(path.sep);
    const filteredParts = parts.filter(p => p !== '..' && p !== '.');
    relativePath = filteredParts.join(path.sep);
    if (verbose) {
      console.log(`[TestChimp]   relativePath (after removing ".."): ${relativePath}`);
    }
  }

  const folderPath = path.dirname(relativePath);
  const fileName = path.basename(relativePath);
  
  if (verbose) {
    console.log(`[TestChimp]   Final folderPath: "${folderPath}"`);
    console.log(`[TestChimp]   Final fileName: "${fileName}"`);
  }

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
