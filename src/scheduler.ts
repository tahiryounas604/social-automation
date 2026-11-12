/**
 * Scheduler: picks up due posts from the queue and publishes them.
 *
 * `runOnce` is the core primitive — it is what the worker loop calls and
 * what `social-automation run-once` runs. Each due post is published
 * through its own provider; success marks it published (with the
 * provider's external id), failure marks it failed with the error kept
 * on the row so `retry` / inspection can follow. A failure in one post
 * never stops the rest of the batch.
 */
import type { QueueStore } from "./db.ts";
import type { Provider } from "./providers/base.ts";
import { createProvider } from "./providers/index.ts";
import type { Post, ProviderName } from "./types.ts";

export interface PublishAttempt {
  post: Post;
  ok: boolean;
  externalId?: string;
  error?: string;
}

export interface RunReport {
  startedAt: string;
  processed: number;
  published: number;
  failed: number;
  attempts: PublishAttempt[];
}

export type ProviderResolver = (name: ProviderName) => Provider;

export function defaultResolver(outboxPath: string): ProviderResolver {
  return (name) => createProvider(name, { outboxPath });
}

export class Scheduler {
  private store: QueueStore;
  private resolveProvider: ProviderResolver;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    store: QueueStore,
    options: {
      resolveProvider: ProviderResolver;
      intervalMs?: number;
    },
  ) {
    this.store = store;
    this.resolveProvider = options.resolveProvider;
    this.intervalMs = options.intervalMs ?? 60_000;
  }

  /**
   * Publish every due post once. `now` is injectable so tests can control
   * time without waiting. Returns a report; never throws for per-post
   * failures (they land in the report and on the post row).
   */
  async runOnce(now = new Date()): Promise<RunReport> {
    const startedAt = now.toISOString();
    const due = this.store.due(now);
    const attempts: PublishAttempt[] = [];
    let published = 0;
    let failed = 0;

    for (const post of due) {
      try {
        const provider = this.resolveProvider(post.provider);
        const result = await provider.publish(post);
        this.store.markPublished(post.id, result.externalId, result.publishedAt);
        published += 1;
        attempts.push({ post, ok: true, externalId: result.externalId });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        this.store.markFailed(post.id, message);
        failed += 1;
        attempts.push({ post, ok: false, error: message });
      }
    }

    return {
      startedAt,
      processed: due.length,
      published,
      failed,
      attempts,
    };
  }

  /**
   * Start the worker loop: run once immediately, then every intervalMs.
   * Safe to call twice (second call is a no-op). `onError` receives
   * unexpected loop errors (per-post failures never reach it).
   */
  start(onError?: (error: unknown) => void): void {
    if (this.running) {
      return;
    }
    this.running = true;
    const tick = (): void => {
      void this.runOnce().catch((error: unknown) => {
        if (onError !== undefined) {
          onError(error);
        }
      });
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }
}
