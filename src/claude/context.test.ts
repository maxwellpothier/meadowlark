import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerContext } from "../storage/types";
import { ContextReporter } from "./context";

let stop: () => void;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  stop();
  vi.useRealTimers();
});

function makeReporter() {
  const sent: ViewerContext[] = [];
  const send = vi.fn(async (c: ViewerContext) => void sent.push(c));
  const reporter = new ContextReporter({ send, delayMs: 300, heartbeatMs: 30_000 });
  stop = reporter.start();
  return { reporter, sent, send };
}

describe("ContextReporter", () => {
  it("sends the latest state once changes settle", () => {
    const { reporter, sent } = makeReporter();
    reporter.update({ pageId: "p1" });
    reporter.update({ selectedIds: ["a"] });
    vi.advanceTimersByTime(299);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ pageId: "p1", selectedIds: ["a"], viewport: null, visible: true }]);
  });

  it("doesn't resend an unchanged state, except as a heartbeat while visible", () => {
    const { reporter, sent } = makeReporter();
    reporter.update({ pageId: "p1" });
    vi.advanceTimersByTime(300);
    reporter.update({ pageId: "p1" });
    vi.advanceTimersByTime(300);
    expect(sent).toHaveLength(1);

    vi.advanceTimersByTime(30_000);
    expect(sent).toHaveLength(2);

    reporter.update({ visible: false });
    vi.advanceTimersByTime(300);
    expect(sent).toHaveLength(3);
    vi.advanceTimersByTime(60_000);
    expect(sent).toHaveLength(3); // no heartbeat from a hidden tab
  });

  it("flushes right away when asked, and retries after a failed send", async () => {
    const { reporter, send } = makeReporter();
    send.mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    reporter.update({ pageId: "p1" });
    reporter.flush();
    expect(send).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    reporter.update({ pageId: "p1" });
    vi.advanceTimersByTime(300);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
