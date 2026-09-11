import type { SessionSnapshot } from "@stack-stats/protocol";
import type { LocalSessionStore } from "./local-store.js";

export interface LocalConfig { token: string; port: number }

export class SessionDelivery {
  private readonly queue = new Map<string, SessionSnapshot>();
  private running?: Promise<void>;
  private retryAt = 0;
  private delay = 15_000;
  state = "Local history only";

  constructor(private readonly store: LocalSessionStore, private readonly config?: LocalConfig) {
    if (config) this.state = "Daemon configured; waiting for delivery";
  }

  enqueue(sessions: readonly SessionSnapshot[]): void {
    for (const session of sessions) {
      if ((this.queue.get(session.sessionId)?.revision ?? 0) < session.revision) this.queue.set(session.sessionId, session);
    }
  }

  get pendingCount(): number { return this.queue.size; }

  sync(force = false): Promise<void> {
    if (this.running) return this.running;
    if (!this.config || (!force && Date.now() < this.retryAt)) return Promise.resolve();
    this.running = this.deliver().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async deliver(): Promise<void> {
    // Bound each pass so offline recovery cannot monopolize the host or shutdown.
    for (const session of [...this.queue.values()].slice(0, 20)) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.config!.port}/v1/events`, {
          method: "POST", headers: { authorization: `Bearer ${this.config!.token}`, "content-type": "application/json" },
          body: JSON.stringify(session), signal: AbortSignal.timeout(3_000)
        });
        if (!response.ok) {
          this.state = response.status === 503 ? "Daemon paused; local tracking continues" : `Daemon returned ${response.status}; history retained locally`;
          this.backoff();
          return;
        }
        const result = await response.json() as { accepted?: boolean };
        if (result.accepted !== true) throw new Error("Unexpected acknowledgement");
        await this.store.acknowledge(session);
        if (this.queue.get(session.sessionId)?.revision === session.revision) this.queue.delete(session.sessionId);
        this.delay = 15_000;
        this.retryAt = 0;
        this.state = "Connected to local daemon";
      } catch {
        this.state = "Daemon offline; history retained locally";
        this.backoff();
        return;
      }
    }
  }

  private backoff(): void {
    this.retryAt = Date.now() + this.delay;
    this.delay = Math.min(this.delay * 2, 5 * 60_000);
  }
}
