/**
 * Provider-independent malware scanner abstraction.
 *
 * Production can plug in ClamAV or an external scanning service WITHOUT
 * changing media business logic. The bundled TestMediaScanner is a deterministic
 * development stub — it is NOT real malware protection and must never be
 * presented as such.
 */
export type ScanStatus = "CLEAN" | "INFECTED" | "UNKNOWN";

export interface ScanResult {
  status: ScanStatus;
  reason?: string;
}

export interface MediaScanner {
  scan(data: Buffer): Promise<ScanResult>;
}
