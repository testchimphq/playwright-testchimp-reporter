import axios, { AxiosInstance, AxiosError } from 'axios';
import {
  IngestSmartTestExecutionReportResponse,
  SmartTestExecutionReport
} from './types';

/**
 * Convert camelCase keys to snake_case recursively
 */
function toSnakeCase(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(toSnakeCase);
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      result[snakeKey] = toSnakeCase(value);
    }
    return result;
  }

  return obj;
}

/**
 * Convert snake_case keys to camelCase recursively
 */
function toCamelCase(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(toCamelCase);
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      result[camelKey] = toCamelCase(value);
    }
    return result;
  }

  return obj;
}

/**
 * HTTP client for communicating with the TestChimp backend API
 */
export class TestChimpApiClient {
  private client: AxiosInstance;
  private projectId: string;
  private verbose: boolean;

  constructor(apiUrl: string, apiKey: string, projectId: string, verbose: boolean = false) {
    this.projectId = projectId;
    this.verbose = verbose;

    this.client = axios.create({
      baseURL: apiUrl,
      headers: {
        'Content-Type': 'application/json',
        'testchimp-api-key': apiKey,
        'testchimp-project-id': projectId
      },
      timeout: 30000
    });
  }

  /**
   * Send a test execution report to the TestChimp backend
   */
  async ingestExecutionReport(
    report: SmartTestExecutionReport
  ): Promise<IngestSmartTestExecutionReportResponse> {
    // Convert camelCase to snake_case for the API
    const snakeCaseReport = toSnakeCase({ report });

    try {
      if (this.verbose) {
        console.log('[TestChimp] Sending report for test:', report.testName);
      }

      const response = await this.client.post(
        '/api/ingest_smarttest_execution_report',
        snakeCaseReport
      );

      // Convert response from snake_case to camelCase
      return toCamelCase(response.data) as IngestSmartTestExecutionReportResponse;
    } catch (error) {
      if (error instanceof AxiosError) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;

        console.error(`[TestChimp] API error (${status}): ${message}`);

        if (status === 401 || status === 403) {
          throw new Error(`[TestChimp] Authentication failed. Check TESTCHIMP_API_KEY and TESTCHIMP_PROJECT_ID.`);
        }
      }

      throw error;
    }
  }

  /**
   * Check if the client is properly configured
   */
  isConfigured(): boolean {
    return !!this.projectId;
  }
}
