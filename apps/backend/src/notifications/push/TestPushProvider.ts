import { PushProviderKind, PushFailureKind, type PushPayload } from "@luvora/shared";
import type { PushProvider, PushTarget, PushSendResult } from "./PushProvider";

/**
 * Deterministic in-process push provider for tests/dev. Performs NO external
 * network I/O. It records every send so tests can assert exactly what would be
 * delivered, and lets tests force permanent/temporary failures by token
 * convention so retry + revocation paths are exercised without a real provider.
 *
 * Token conventions (test-only):
 *   - a token containing "invalid"      → PERMANENT failure (device revoked)
 *   - a token containing "temp-fail"    → TEMPORARY failure (bounded retry)
 *   - anything else                      → success
 */
export interface RecordedPush {
  payload: PushPayload;
  target: PushTarget;
  result: PushSendResult;
}

export class TestPushProvider implements PushProvider {
  readonly kind = PushProviderKind.TEST;
  readonly sent: RecordedPush[] = [];
  private counter = 0;

  async send(payload: PushPayload, target: PushTarget): Promise<PushSendResult> {
    let result: PushSendResult;
    if (target.token.includes("invalid")) {
      result = {
        ok: false,
        failure: PushFailureKind.PERMANENT,
        errorCode: "INVALID_TOKEN",
      };
    } else if (target.token.includes("temp-fail")) {
      result = {
        ok: false,
        failure: PushFailureKind.TEMPORARY,
        errorCode: "PROVIDER_UNAVAILABLE",
      };
    } else {
      this.counter += 1;
      result = { ok: true, providerMessageId: `test-msg-${this.counter}` };
    }
    this.sent.push({ payload, target, result });
    return result;
  }

  /** Test helper: clear recorded sends. */
  reset(): void {
    this.sent.length = 0;
    this.counter = 0;
  }
}
