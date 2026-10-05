import { JobType } from "@luvora/shared";
import type { JobHandler, JobHandlerContext, JobResult } from "../JobHandler";
import { JobResults } from "../JobHandler";
import * as jobRepo from "../jobRepository";
import { config } from "../../config";
import { logger } from "../../logger";

/**
 * Handler for BACKGROUND_JOB_CLEANUP — keeps the `background_jobs` table bounded
 * by deleting TERMINAL jobs past their retention window: SUCCEEDED/CANCELLED
 * after JOB_SUCCESS_RETENTION_DAYS, DEAD after JOB_DEAD_RETENTION_DAYS (kept
 * longer for investigation). Never deletes active (non-terminal) jobs; never
 * touches audit logs. Idempotent.
 */
export class BackgroundJobCleanupHandler implements JobHandler {
  readonly type = JobType.BACKGROUND_JOB_CLEANUP;

  async handle(_payload: Record<string, unknown>, ctx: JobHandlerContext): Promise<JobResult> {
    try {
      const now = Date.now();
      const succeededCutoff = new Date(now - config.jobs.successRetentionDays * 24 * 3600 * 1000);
      const deadCutoff = new Date(now - config.jobs.deadRetentionDays * 24 * 3600 * 1000);
      const removed = await jobRepo.deleteTerminalBefore(succeededCutoff, deadCutoff);
      if (removed > 0) {
        logger.info({ jobId: ctx.jobId, removed }, "background job cleanup complete");
      }
      return JobResults.success();
    } catch (err) {
      return JobResults.retry("JOB_CLEANUP_FAILED", (err as Error).message);
    }
  }
}
