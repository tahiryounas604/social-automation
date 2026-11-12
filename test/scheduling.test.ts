import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Scheduler } from "../src/scheduler.ts";
import { MockProvider } from "../src/providers/mock.ts";
import type { Provider } from "../src/providers/base.ts";
import { FUTURE, NOW, PAST, memoryStore, tempDir } from "./helpers.ts";

function mockScheduler(store: ReturnType<typeof memoryStore>, outbox: string) {
  const mock = new MockProvider(outbox);
  return new Scheduler(store, { resolveProvider: () => mock });
}

test("scheduler: runOnce publishes due posts and skips future ones", async () => {
  const store = memoryStore();
  const outbox = join(tempDir(), "outbox.jsonl");
  try {
    const due = store.add({ provider: "mock", text: "due", scheduledAt: PAST }, NOW);
    const future = store.add({ provider: "mock", text: "later", scheduledAt: FUTURE }, NOW);
    const scheduler = mockScheduler(store, outbox);
    const report = await scheduler.runOnce(NOW);
    assert.equal(report.processed, 1);
    assert.equal(report.published, 1);
    assert.equal(report.failed, 0);
    assert.equal(store.get(due.id)?.status, "published");
    assert.ok(store.get(due.id)?.externalId?.startsWith("mock-"));
    assert.equal(store.get(future.id)?.status, "queued");
  } finally {
    store.close();
  }
});

test("scheduler: runOnce is idempotent — published posts are never re-run", async () => {
  const store = memoryStore();
  const outbox = join(tempDir(), "outbox.jsonl");
  try {
    store.add({ provider: "mock", text: "once", scheduledAt: PAST }, NOW);
    const scheduler = mockScheduler(store, outbox);
    assert.equal((await scheduler.runOnce(NOW)).published, 1);
    const second = await scheduler.runOnce(NOW);
    assert.equal(second.processed, 0);
    assert.equal(second.published, 0);
  } finally {
    store.close();
  }
});

test("scheduler: a failing provider marks the post failed and the rest still publish", async () => {
  const store = memoryStore();
  try {
    const bad = store.add({ provider: "mock", text: "bad", scheduledAt: PAST }, NOW);
    const good = store.add({ provider: "mock", text: "good", scheduledAt: PAST }, NOW);
    const failing: Provider = {
      name: "mock",
      publish: async (post) => {
        if (post.id === bad.id) {
          throw new Error("simulated provider outage");
        }
        return { externalId: "mock-ok", publishedAt: NOW.toISOString() };
      },
    };
    const scheduler = new Scheduler(store, { resolveProvider: () => failing });
    const report = await scheduler.runOnce(NOW);
    assert.equal(report.processed, 2);
    assert.equal(report.published, 1);
    assert.equal(report.failed, 1);
    assert.equal(store.get(bad.id)?.status, "failed");
    assert.equal(store.get(bad.id)?.error, "simulated provider outage");
    assert.equal(store.get(good.id)?.status, "published");
  } finally {
    store.close();
  }
});

test("scheduler: failed post can be retried and then succeeds", async () => {
  const store = memoryStore();
  try {
    const post = store.add({ provider: "mock", text: "flaky", scheduledAt: PAST }, NOW);
    let calls = 0;
    const flaky: Provider = {
      name: "mock",
      publish: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("first attempt fails");
        }
        return { externalId: "mock-second-try", publishedAt: NOW.toISOString() };
      },
    };
    const scheduler = new Scheduler(store, { resolveProvider: () => flaky });
    assert.equal((await scheduler.runOnce(NOW)).failed, 1);
    assert.equal(store.retry(post.id), true);
    const second = await scheduler.runOnce(NOW);
    assert.equal(second.published, 1);
    assert.equal(store.get(post.id)?.status, "published");
    assert.equal(store.get(post.id)?.attempts, 2);
  } finally {
    store.close();
  }
});

test("scheduler: worker start/stop runs the loop and stops it", async () => {
  const store = memoryStore();
  const outbox = join(tempDir(), "outbox.jsonl");
  try {
    const post = store.add({ provider: "mock", text: "loop", scheduledAt: PAST }, NOW);
    const scheduler = mockScheduler(store, outbox);
    assert.equal(scheduler.isRunning(), false);
    scheduler.start();
    assert.equal(scheduler.isRunning(), true);
    scheduler.start(); // second start is a no-op
    await new Promise((resolve) => setTimeout(resolve, 50));
    scheduler.stop();
    assert.equal(scheduler.isRunning(), false);
    assert.equal(store.get(post.id)?.status, "published");
  } finally {
    store.close();
  }
});
