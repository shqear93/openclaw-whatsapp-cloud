import { describe, expect, it, vi } from "vitest";
import { withDeadline } from "./timeout.js";

describe("withDeadline", () => {
  it("resolves with the wrapped promise's value when it settles before the deadline", async () => {
    await expect(withDeadline(Promise.resolve("ok"), 1000, "test")).resolves.toBe("ok");
  });

  it("propagates the wrapped promise's rejection when it rejects before the deadline", async () => {
    const failure = new Error("boom");
    await expect(withDeadline(Promise.reject(failure), 1000, "test")).rejects.toBe(failure);
  });

  it("rejects with a labeled timeout error once the deadline elapses on a promise that never settles", async () => {
    vi.useFakeTimers();
    try {
      const hung = new Promise(() => {});
      const resultPromise = withDeadline(hung, 5000, "hung operation");
      const assertion = expect(resultPromise).rejects.toThrow("hung operation timed out after 5000ms");

      await vi.advanceTimersByTimeAsync(5000);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire the timeout once the wrapped promise has already resolved", async () => {
    vi.useFakeTimers();
    try {
      const resultPromise = withDeadline(Promise.resolve("fast"), 5000, "test");
      await expect(resultPromise).resolves.toBe("fast");

      // Advancing past the deadline afterward must not cause an unhandled
      // rejection or any other observable effect -- the timer should already
      // be cleared.
      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
