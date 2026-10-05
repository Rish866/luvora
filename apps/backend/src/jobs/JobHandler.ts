import { JobType, JobFailureKind } from "@luvora/shared";

/**
 * Job handler contract (Increment 9). Each job type has exactly one handler.
 * Handlers MUST be idempotent (a job may execute more than once under
 * at-least-once semantics + lease reclaim). A handler returns a JobResult; it
 * must NOT throw for expected failures — throwing is treated as an unknown,
 * retryable error by the worker.
 */

export interface JobHandlerContext {
  jobId: string;
  workerId: string;
  attempt: number;
  /** Correlation id for structured logging (server-generated; never trusted
   *  from a client). */
  correlationId: string;
}

export type JobResult =
  | { outcome: "success" }
  | {
      outcome: "failure";
      kind: JobFailureKind;
      errorCode: string;
      errorMessage: string;
    };

export interface JobHandler<TPayload = Record<string, unknown>> {
  readonly type: JobType;
  handle(payload: TPayload, ctx: JobHandlerContext): Promise<JobResult>;
}

/** Convenience constructors for handler results. */
export const JobResults = {
  success(): JobResult {
    return { outcome: "success" };
  },
  retry(errorCode: string, errorMessage = ""): JobResult {
    return {
      outcome: "failure",
      kind: JobFailureKind.TEMPORARY,
      errorCode,
      errorMessage,
    };
  },
  permanent(errorCode: string, errorMessage = ""): JobResult {
    return {
      outcome: "failure",
      kind: JobFailureKind.PERMANENT,
      errorCode,
      errorMessage,
    };
  },
};
