import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Clean up the DOM between tests.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

// jsdom lacks these; stub so components that touch them don't crash in tests.
if (!globalThis.URL.createObjectURL) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis.URL as any).createObjectURL = () => "blob:mock";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis.URL as any).revokeObjectURL = () => undefined;
}

if (!window.matchMedia) {
  window.matchMedia = (q: string) =>
    ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// jsdom does not implement scrollIntoView; stub it so chat auto-scroll is a no-op.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    /* no-op in tests */
  };
}
