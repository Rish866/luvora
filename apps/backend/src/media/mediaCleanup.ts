import { logger } from "../logger";
import * as mediaRepo from "./mediaRepository";
import { getMediaProviders } from "./mediaProviders";

/**
 * Orphan cleanup for abandoned uploads: media assets stuck in UPLOADING past a
 * grace period (an intent was created but content never completed). Removes the
 * bytes via the storage abstraction and the DB row.
 *
 * This is a plain function a future scheduler/worker can call periodically; it
 * requires no cron infrastructure and is safe to run repeatedly.
 */
export async function cleanupAbandonedUploads(
  olderThanMs = 24 * 60 * 60 * 1000, // default: 24h
): Promise<{ removed: number }> {
  const abandoned = await mediaRepo.findAbandonedUploads(olderThanMs);
  const { storage } = getMediaProviders();
  let removed = 0;
  for (const row of abandoned) {
    // Best-effort byte removal (the intent may never have stored bytes).
    await storage.delete(row.storage_key).catch(() => undefined);
    await mediaRepo.hardDelete(row.id);
    removed += 1;
  }
  if (removed > 0) {
    logger.info({ removed }, "cleaned up abandoned media uploads");
  }
  return { removed };
}

// Allow running as a one-off job: `node -r ts-node/register src/media/mediaCleanup.ts`
if (require.main === module) {
  cleanupAbandonedUploads()
    .then((r) => {
      // eslint-disable-next-line no-console
      console.log(`Removed ${r.removed} abandoned uploads.`);
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, "media cleanup failed");
      process.exit(1);
    });
}
