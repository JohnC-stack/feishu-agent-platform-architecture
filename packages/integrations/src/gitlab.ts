import { ExactResourceAllowlist } from './access-control.js';
import { RetryingHttpClient, type RetryingHttpClientOptions } from './http-client.js';
import { boundIntegrationResult } from './redaction.js';
import type { BoundedIntegrationResult } from './types.js';

export interface GitLabReadonlyClientOptions {
  baseUrl: string;
  token: string;
  allowedProjects: readonly string[];
  maxOutputCharacters?: number;
  http?: Omit<RetryingHttpClientOptions, 'baseUrl' | 'defaultHeaders'>;
}

export class GitLabReadonlyClient {
  private readonly projects: ExactResourceAllowlist;
  private readonly http: RetryingHttpClient;
  private readonly maxOutputCharacters: number;

  public constructor(options: GitLabReadonlyClientOptions) {
    if (!options.token.trim()) {
      throw new Error('GitLab read-only token is required.');
    }
    this.projects = new ExactResourceAllowlist(options.allowedProjects, 'GitLab project');
    this.maxOutputCharacters = options.maxOutputCharacters ?? 20_000;
    this.http = new RetryingHttpClient({
      ...options.http,
      baseUrl: `${options.baseUrl.replace(/\/$/, '')}/api/v4/`,
      defaultHeaders: { 'PRIVATE-TOKEN': options.token },
    });
  }

  public async getProject(project: string, signal: AbortSignal): Promise<BoundedIntegrationResult> {
    const projectId = this.projectPath(project);
    const response = await this.http.request(`projects/${projectId}`, {}, signal);
    return this.bound(response.data);
  }

  public async getMergeRequest(
    project: string,
    mergeRequestIid: number,
    signal: AbortSignal,
  ): Promise<BoundedIntegrationResult> {
    const projectId = this.projectPath(project);
    const iid = positiveInteger(mergeRequestIid, 'merge request IID');
    const response = await this.http.request(
      `projects/${projectId}/merge_requests/${iid}`,
      {},
      signal,
    );
    return this.bound(response.data);
  }

  public async listMergeRequestDiffs(
    project: string,
    mergeRequestIid: number,
    signal: AbortSignal,
    page = 1,
    perPage = 20,
  ): Promise<BoundedIntegrationResult> {
    const projectId = this.projectPath(project);
    const iid = positiveInteger(mergeRequestIid, 'merge request IID');
    const response = await this.http.request(
      `projects/${projectId}/merge_requests/${iid}/diffs`,
      {
        query: {
          page: boundedInteger(page, 1, 10_000, 'page'),
          per_page: boundedInteger(perPage, 1, 100, 'perPage'),
        },
      },
      signal,
    );
    return this.bound(response.data);
  }

  public async getPipeline(
    project: string,
    pipelineId: number,
    signal: AbortSignal,
  ): Promise<BoundedIntegrationResult> {
    const projectId = this.projectPath(project);
    const id = positiveInteger(pipelineId, 'pipeline ID');
    const response = await this.http.request(`projects/${projectId}/pipelines/${id}`, {}, signal);
    return this.bound(response.data);
  }

  public async getJobTrace(
    project: string,
    jobId: number,
    signal: AbortSignal,
  ): Promise<BoundedIntegrationResult> {
    const projectId = this.projectPath(project);
    const id = positiveInteger(jobId, 'job ID');
    const response = await this.http.request<string>(
      `projects/${projectId}/jobs/${id}/trace`,
      { responseType: 'text' },
      signal,
    );
    return this.bound({ jobId: id, trace: response.data });
  }

  private projectPath(project: string): string {
    const approved = this.projects.assertAllowed(project);
    return encodeURIComponent(approved);
  }

  private bound(value: unknown): BoundedIntegrationResult {
    return boundIntegrationResult(value, this.maxOutputCharacters);
  }
}

function positiveInteger(value: number, name: string): number {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, name);
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
