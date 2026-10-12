import type { ViewerContext } from "../storage/types";

// Keeps the server told what the user is looking at (open page, selection,
// visible area), so Claude can follow "this" and "here" (MCP get_context).
// Excalidraw reports every pointer move and scroll step, so changes are
// debounced and only sent when something Claude would see has changed.

export interface ContextReporterOptions {
  send: (context: ViewerContext) => Promise<void>;
  delayMs?: number;
  /** While the tab is in front, the context is re-sent this often, so Claude can tell an idle user from a closed tab. */
  heartbeatMs?: number;
}

export class ContextReporter {
  private readonly send: (context: ViewerContext) => Promise<void>;
  private readonly delayMs: number;
  private readonly heartbeatMs: number;
  private state: ViewerContext = { pageId: null, selectedIds: [], viewport: null, visible: true };
  private sentKey: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ContextReporterOptions) {
    this.send = options.send;
    this.delayMs = options.delayMs ?? 300;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
  }

  /** Starts the heartbeat. Returns a function that stops it and drops any unsent change. */
  start(): () => void {
    const heartbeat = setInterval(() => this.state.visible && this.flush(true), this.heartbeatMs);
    return () => {
      clearInterval(heartbeat);
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    };
  }

  update(patch: Partial<ViewerContext>): void {
    this.state = { ...this.state, ...patch };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  /** Sends now if anything changed since the last send, or regardless with `force`. */
  flush(force = false): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const key = JSON.stringify(this.state);
    if (!force && key === this.sentKey) return;
    this.sentKey = key;
    this.send(this.state).catch((err: unknown) => {
      console.error("Couldn't tell Claude what's on screen", err);
      this.sentKey = null; // try again on the next change or heartbeat
    });
  }
}
