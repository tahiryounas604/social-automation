import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "../src/db.ts";
import { ValidationError } from "../src/validation.ts";
import { FUTURE, NOW, PAST, memoryStore } from "./helpers.ts";

test("queue: add returns a queued post with generated id and defaults", () => {
  const store = memoryStore();
  try {
    const post = store.add({ provider: "x", text: "hello" }, NOW);
    assert.equal(post.status, "queued");
    assert.equal(post.provider, "x");
    assert.equal(post.text, "hello");
    assert.equal(post.mediaUrl, null);
    assert.equal(post.scheduledAt, NOW.toISOString());
    assert.equal(post.attempts, 0);
    assert.equal(post.publishedAt, null);
    assert.equal(post.externalId, null);
    assert.ok(post.id.length > 0);
    assert.equal(store.get(post.id)?.id, post.id);
  } finally {
    store.close();
  }
});

test("queue: add rejects empty text and over-limit text", () => {
  const store = memoryStore();
  try {
    assert.throws(
      () => store.add({ provider: "x", text: "   " }, NOW),
      ValidationError,
    );
    assert.throws(
      () => store.add({ provider: "x", text: "a".repeat(281) }, NOW),
      ValidationError,
    );
    // 280 chars is exactly at the X limit and must pass.
    assert.equal(store.add({ provider: "x", text: "a".repeat(280) }, NOW).status, "queued");
    // LinkedIn allows 3000.
    assert.equal(store.add({ provider: "linkedin", text: "a".repeat(3000) }, NOW).status, "queued");
    assert.throws(
      () => store.add({ provider: "linkedin", text: "a".repeat(3001) }, NOW),
      ValidationError,
    );
  } finally {
    store.close();
  }
});

test("queue: instagram and tiktok require a mediaUrl; bad mediaUrl rejected", () => {
  const store = memoryStore();
  try {
    assert.throws(
      () => store.add({ provider: "instagram", text: "pic" }, NOW),
      /requires a mediaUrl/,
    );
    assert.throws(
      () => store.add({ provider: "tiktok", text: "clip" }, NOW),
      /requires a mediaUrl/,
    );
    assert.throws(
      () => store.add({ provider: "x", text: "hi", mediaUrl: "not-a-url" }, NOW),
      /not a valid URL/,
    );
    const ok = store.add(
      { provider: "instagram", text: "pic", mediaUrl: "https://example.com/pic.jpg" },
      NOW,
    );
    assert.equal(ok.mediaUrl, "https://example.com/pic.jpg");
  } finally {
    store.close();
  }
});

test("queue: list filters by status and provider, ordered by scheduled time", () => {
  const store = memoryStore();
  try {
    const a = store.add({ provider: "x", text: "first", scheduledAt: FUTURE }, NOW);
    const b = store.add({ provider: "linkedin", text: "second", scheduledAt: PAST }, NOW);
    store.add({ provider: "x", text: "third", scheduledAt: PAST }, NOW);
    const all = store.list();
    assert.deepEqual(
      all.map((p) => p.id),
      [b.id, store.list()[1]?.id, a.id].filter(Boolean),
    );
    assert.equal(all[0]?.provider, "linkedin"); // earliest scheduled first
    assert.equal(store.list({ provider: "x" }).length, 2);
    assert.equal(store.list({ status: "published" }).length, 0);
    assert.equal(store.count(), 3);
    assert.equal(store.count({ provider: "linkedin" }), 1);
  } finally {
    store.close();
  }
});

test("queue: due returns only queued posts whose time has arrived", () => {
  const store = memoryStore();
  try {
    const duePost = store.add({ provider: "x", text: "due", scheduledAt: PAST }, NOW);
    store.add({ provider: "x", text: "later", scheduledAt: FUTURE }, NOW);
    const due = store.due(NOW);
    assert.deepEqual(due.map((p) => p.id), [duePost.id]);
  } finally {
    store.close();
  }
});

test("queue: reschedule / cancel / retry enforce status transitions", () => {
  const store = memoryStore();
  try {
    const post = store.add({ provider: "x", text: "t", scheduledAt: PAST }, NOW);
    assert.equal(store.reschedule(post.id, FUTURE), true);
    assert.equal(store.get(post.id)?.scheduledAt, new Date(FUTURE).toISOString());
    assert.equal(store.due(NOW).length, 0); // no longer due
    assert.equal(store.cancel(post.id), true);
    assert.equal(store.get(post.id)?.status, "cancelled");
    assert.equal(store.cancel(post.id), false); // already cancelled
    assert.equal(store.reschedule(post.id, PAST), false); // not queued
    assert.equal(store.retry(post.id), false); // not failed

    const failed = store.add({ provider: "x", text: "f", scheduledAt: PAST }, NOW);
    store.markFailed(failed.id, "boom");
    assert.equal(store.get(failed.id)?.status, "failed");
    assert.equal(store.get(failed.id)?.error, "boom");
    assert.equal(store.get(failed.id)?.attempts, 1);
    assert.equal(store.retry(failed.id), true);
    assert.equal(store.get(failed.id)?.status, "queued");
    assert.equal(store.get(failed.id)?.error, null);

    assert.equal(store.reschedule("no-such-id", FUTURE), false);
    assert.equal(store.get("no-such-id"), null);
    assert.throws(
      () => store.reschedule(post.id, "not-a-date"),
      ValidationError,
    );
  } finally {
    store.close();
  }
});

test("queue: markPublished records external id and timestamp", () => {
  const store = memoryStore();
  try {
    const post = store.add({ provider: "x", text: "t", scheduledAt: PAST }, NOW);
    store.markPublished(post.id, "12345", "2026-11-12T04:05:00.000Z");
    const got = store.get(post.id);
    assert.equal(got?.status, "published");
    assert.equal(got?.externalId, "12345");
    assert.equal(got?.publishedAt, "2026-11-12T04:05:00.000Z");
    assert.equal(got?.attempts, 1);
    assert.equal(store.due(NOW).length, 0); // published posts are never due again
  } finally {
    store.close();
  }
});

test("queue: file-backed store persists across reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "social-automation-persist-"));
  const dbPath = join(dir, "q.db");
  const first = new QueueStore(dbPath);
  const post = first.add({ provider: "mock", text: "persist me", scheduledAt: PAST }, NOW);
  first.close();
  const second = new QueueStore(dbPath);
  try {
    assert.equal(second.get(post.id)?.text, "persist me");
    assert.equal(second.count(), 1);
  } finally {
    second.close();
  }
});
