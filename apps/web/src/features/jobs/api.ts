import type {
  CreateJobRequest,
  DuplicateJobRequest,
  EstimateJobRequest,
  EstimateJobResponse,
  Job,
  JobList,
  JobLogsResponse,
  JobRunList,
  JobView,
  UpdateJobRequest,
} from '@storage-io/contracts';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { queryKeys } from '@/lib/query/keys';

/**
 * Bulk jobs: `GET /jobs` per view, the lifecycle commands, the estimate the wizard
 * asks for, and the log stream the sheet tails.
 *
 * Nothing here polls. The API pushes `job.progress` and `job.status` on the SSE
 * stream and `useEventStream` invalidates the whole `jobs` scope for both, so a
 * running card's progress, the tab counts *and* an open log sheet all refresh from
 * the server's own events — which is also what makes the log sheet a live tail.
 */

export function useJobs(view: JobView): UseQueryResult<JobList> {
  return useQuery({
    queryKey: queryKeys.jobs.list({ view }),
    queryFn: ({ signal }) => api.get<JobList>('/jobs', { view }, signal),
  });
}

export function useJob(jobId: string | null): UseQueryResult<Job> {
  return useQuery({
    queryKey: queryKeys.jobs.detail(jobId ?? ''),
    queryFn: ({ signal }) => api.get<Job>(`/jobs/${encodeURIComponent(jobId ?? '')}`, undefined, signal),
    enabled: jobId !== null,
  });
}

export function useJobLogs(
  jobId: string | null,
  level: 'all' | 'error',
): UseQueryResult<JobLogsResponse> {
  return useQuery({
    queryKey: queryKeys.jobs.logs(jobId ?? '', level),
    queryFn: ({ signal }) =>
      api.get<JobLogsResponse>(`/jobs/${encodeURIComponent(jobId ?? '')}/logs`, { level }, signal),
    enabled: jobId !== null,
  });
}

export function useJobRuns(jobId: string | null, page: number): UseQueryResult<JobRunList> {
  return useQuery({
    queryKey: queryKeys.jobs.runs(jobId ?? '', page),
    queryFn: ({ signal }) =>
      api.get<JobRunList>(`/jobs/${encodeURIComponent(jobId ?? '')}/runs`, { page }, signal),
    enabled: jobId !== null,
  });
}

/* ------------------------------ mutations ------------------------- */

function useJobScopeInvalidation(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
  };
}

export function useCreateJob(): UseMutationResult<Job, Error, CreateJobRequest> {
  const invalidate = useJobScopeInvalidation();
  return useMutation({
    mutationFn: (body) => api.post<Job>('/jobs', body),
    onSuccess: invalidate,
  });
}

export function useEstimateJob(): UseMutationResult<
  EstimateJobResponse,
  Error,
  EstimateJobRequest
> {
  return useMutation({
    mutationFn: (body) => api.post<EstimateJobResponse>('/jobs/estimate', body),
  });
}

export type JobCommand = 'pause' | 'resume' | 'cancel' | 'run-now';

export interface JobCommandVariables {
  readonly jobId: string;
  readonly command: JobCommand;
}

export function useJobCommand(): UseMutationResult<Job, Error, JobCommandVariables> {
  const invalidate = useJobScopeInvalidation();
  return useMutation({
    mutationFn: ({ jobId, command }) =>
      api.post<Job>(`/jobs/${encodeURIComponent(jobId)}/${command}`),
    onSuccess: invalidate,
  });
}

export interface UpdateJobVariables extends UpdateJobRequest {
  readonly jobId: string;
}

export function useUpdateJob(): UseMutationResult<Job, Error, UpdateJobVariables> {
  const invalidate = useJobScopeInvalidation();
  return useMutation({
    mutationFn: ({ jobId, ...body }) => api.patch<Job>(`/jobs/${encodeURIComponent(jobId)}`, body),
    onSuccess: invalidate,
  });
}

export function useDeleteJob(): UseMutationResult<void, Error, string> {
  const invalidate = useJobScopeInvalidation();
  return useMutation({
    mutationFn: (jobId) => api.delete<void>(`/jobs/${encodeURIComponent(jobId)}`),
    onSuccess: invalidate,
  });
}

export interface DuplicateJobVariables extends DuplicateJobRequest {
  readonly jobId: string;
}

export function useDuplicateJob(): UseMutationResult<Job, Error, DuplicateJobVariables> {
  const invalidate = useJobScopeInvalidation();
  return useMutation({
    mutationFn: ({ jobId, ...body }) =>
      api.post<Job>(`/jobs/${encodeURIComponent(jobId)}/duplicate`, body),
    onSuccess: invalidate,
  });
}
