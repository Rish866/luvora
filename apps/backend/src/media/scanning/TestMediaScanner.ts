import type { MediaScanner, ScanResult } from "./MediaScanner";

/**
 * Deterministic DEV/TEST scanner. NOT real malware protection.
 *
 * It recognizes a harmless signature so tests can exercise INFECTED/UNKNOWN
 * paths without any real malware:
 *  - Contains the EICAR-style test marker "LUVORA-TEST-INFECTED"  -> INFECTED
 *  - Contains "LUVORA-TEST-UNKNOWN"                               -> UNKNOWN
 *  - Everything else                                             -> CLEAN
 *
 * Production MUST replace this with a real MediaScanner (e.g. ClamAV).
 */
export class TestMediaScanner implements MediaScanner {
  async scan(data: Buffer): Promise<ScanResult> {
    const head = data.subarray(0, 4096).toString("latin1");
    if (head.includes("LUVORA-TEST-INFECTED")) {
      return { status: "INFECTED", reason: "test-signature" };
    }
    if (head.includes("LUVORA-TEST-UNKNOWN")) {
      return { status: "UNKNOWN", reason: "test-unknown" };
    }
    return { status: "CLEAN" };
  }
}

/** A scanner that is explicitly disabled: always UNKNOWN. The media pipeline's
 *  configured UNKNOWN policy then decides whether to quarantine. */
export class DisabledMediaScanner implements MediaScanner {
  async scan(): Promise<ScanResult> {
    return { status: "UNKNOWN", reason: "scanning-disabled" };
  }
}
