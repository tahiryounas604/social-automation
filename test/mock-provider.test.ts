import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MockProvider, readOutbox } from "../src/providers/mock.ts";
import { NOW, PAST, memoryStore, tempDir } from "./helpers.ts";

test("mock provider: publishes to the outbox log with a mock id", async () => {
  const dir = tempDir();
  const outbox = join(dir, "outbox.jsonl");
  const provider = new MockProvider(outbox);
  const store = memoryStore();
  try {
    const post = store.add({ provider: "mock", text: "hello mock", scheduledAt: PAST }, NOW);
    const result = await provider.publish(post);
    assert.match(result.externalId, /^mock-/);
    assert.ok(result.publishedAt.length > 0);

    const entries = readOutbox(outbox);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.postId, post.id);
    assert.equal(entries[0]?.text, "hello mock");
    assert.equal(entries[0]?.provider, "mock");
    assert.equal(entries[0]?.externalId, result.externalId);
  } finally {
    store.close();
  }
});

test("mock provider: appends multiple posts in order", async () => {
  const dir = tempDir();
  const outbox = join(dir, "nested", "outbox.jsonl"); // parent dir must be created
  const provider = new MockProvider(outbox);
  const store = memoryStore();
  try {
    const a = store.add({ provider: "mock", text: "one", scheduledAt: PAST }, NOW);
    const b = store.add({ provider: "mock", text: "two", scheduledAt: PAST }, NOW);
    await provider.publish(a);
    await provider.publish(b);
    const entries = readOutbox(outbox);
    assert.deepEqual(
      entries.map((e) => e.text),
      ["one", "two"],
    );
  } finally {
    store.close();
  }
});

test("mock provider: readOutbox returns [] for a missing file", () => {
  assert.deepEqual(readOutbox(join(tempDir(), "does-not-exist.jsonl")), []);
});
