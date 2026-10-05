import type { JobType } from "@luvora/shared";
import type { JobHandler } from "./JobHandler";

/**
 * Registry mapping each JobType to its handler. Avoids a giant switch in the
 * worker and keeps handlers independently testable. One handler per type.
 */
export class JobRegistry {
  private readonly handlers = new Map<JobType, JobHandler>();

  register(handler: JobHandler): void {
    if (this.handlers.has(handler.type)) {
      throw new Error(`duplicate job handler for type ${handler.type}`);
    }
    this.handlers.set(handler.type, handler);
  }

  get(type: JobType): JobHandler | undefined {
    return this.handlers.get(type);
  }

  registeredTypes(): JobType[] {
    return [...this.handlers.keys()];
  }
}
