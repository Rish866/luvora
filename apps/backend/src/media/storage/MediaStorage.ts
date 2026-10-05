/**
 * Provider-independent media storage abstraction.
 *
 * The application depends ONLY on this interface — never on a specific vendor
 * (S3/R2/GCS/Azure/Supabase). A future S3MediaStorage / R2MediaStorage adapter
 * can be dropped in without changing any media business logic.
 *
 * Storage keys are opaque, server-generated strings. They are never derived
 * from untrusted filenames and never exposed to clients.
 */
export interface MediaStorage {
  /** Store bytes under an opaque key (overwrites if the key already exists). */
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  /** Read bytes for a key. Rejects if the key does not exist. */
  get(key: string): Promise<Buffer>;
  /** Delete the object for a key. No-op if it does not exist. */
  delete(key: string): Promise<void>;
  /** Whether an object exists for the key. */
  exists(key: string): Promise<boolean>;
  /**
   * Produce an access reference for a key. For the local provider this is an
   * internal marker; production object-storage adapters can return a
   * short-lived signed URL. The application always prefers its own authenticated
   * endpoint (/api/media/:id) over raw storage URLs, so this exists mainly to
   * keep the future signed-URL path in the interface.
   */
  getAccessUrl(key: string, ttlSeconds: number): Promise<string>;
}
