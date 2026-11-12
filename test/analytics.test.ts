import test from "node:test";
import assert from "node:assert/strict";
import { summarize, summarizeStore, renderSummaryText, engagementOf } from "../src/analytics.ts";
import type { PostMetrics } from "../src/types.ts";
import { ValidationError } from "../src/validation.ts";
import { NOW, PAST, memoryStore } from "./helpers.ts";

function metrics(postId: string, overrides: Partial<PostMetrics> = {}): PostMetrics {
  return {
    postId,
    provider: "x",
    likes: 10,
    comments: 2,
    shares: 3,
    views: 100,
    collectedAt: NOW.toISOString(),
    ...overrides,
  };
}

test("analytics: empty store gives a zeroed summary without crashing", () => {
  const store = memoryStore();
  try {
    const summary = summarizeStore(store, NOW);
    assert.equal(summary.totalPosts, 0);
    assert.equal(summary.totalEngagement, 0);
    assert.equal(summary.avgEngagementPerPost, 0);
    assert.equal(summary.engagementRate, 0);
    assert.equal(summary.bestPostId, null);
    assert.equal(summary.postsWithoutMetrics, 0);
    assert.match(renderSummaryText(summary), /Posts: 0/);
  } finally {
    store.close();
  }
});

test("analytics: totals, averages, engagement rate and best post are exact", () => {
  const store = memoryStore();
  try {
    const a = store.add({ provider: "x", text: "a", scheduledAt: PAST }, NOW);
    const b = store.add({ provider: "linkedin", text: "b", scheduledAt: PAST }, NOW);
    store.add({ provider: "mock", text: "c — no metrics", scheduledAt: PAST }, NOW);
    store.importMetrics(metrics(a.id, { likes: 10, comments: 2, shares: 3, views: 100 }));
    store.importMetrics(
      metrics(b.id, { provider: "linkedin", likes: 40, comments: 5, shares: 5, views: 400 }),
    );
    const summary = summarizeStore(store, NOW);
    assert.equal(summary.totalPosts, 3);
    assert.equal(summary.postsWithMetrics, 2);
    assert.equal(summary.postsWithoutMetrics, 1);
    assert.equal(summary.totalLikes, 50);
    assert.equal(summary.totalComments, 7);
    assert.equal(summary.totalShares, 8);
    assert.equal(summary.totalViews, 500);
    assert.equal(summary.totalEngagement, 65); // 15 + 50
    assert.equal(summary.avgEngagementPerPost, 32.5);
    assert.equal(summary.engagementRate, 65 / 500);
    assert.equal(summary.bestPostId, b.id);
    assert.equal(summary.bestPostEngagement, 50);
    assert.equal(summary.byStatus["queued"], 3);
    assert.equal(summary.byProvider["x"]?.engagement, 15);
    assert.equal(summary.byProvider["linkedin"]?.engagement, 50);
    assert.equal(summary.byProvider["mock"]?.posts, 1);
    assert.equal(summary.byProvider["mock"]?.engagement, 0);
  } finally {
    store.close();
  }
});

test("analytics: engagementOf sums likes + comments + shares only (not views)", () => {
  assert.equal(engagementOf(metrics("p", { likes: 1, comments: 2, shares: 3, views: 999 })), 6);
});

test("analytics: import upserts — latest snapshot wins, no duplicates", () => {
  const store = memoryStore();
  try {
    const post = store.add({ provider: "x", text: "a", scheduledAt: PAST }, NOW);
    store.importMetrics(metrics(post.id, { likes: 5 }));
    store.importMetrics(metrics(post.id, { likes: 50 }));
    assert.equal(store.allMetrics().length, 1);
    assert.equal(store.getMetrics(post.id)?.likes, 50);
    assert.equal(summarizeStore(store, NOW).totalLikes, 50);
  } finally {
    store.close();
  }
});

test("analytics: negative or non-integer metrics are rejected", () => {
  const store = memoryStore();
  try {
    const post = store.add({ provider: "x", text: "a", scheduledAt: PAST }, NOW);
    assert.throws(
      () => store.importMetrics(metrics(post.id, { likes: -1 })),
      ValidationError,
    );
    assert.throws(
      () => store.importMetrics(metrics(post.id, { views: 1.5 })),
      ValidationError,
    );
    assert.equal(store.allMetrics().length, 0);
  } finally {
    store.close();
  }
});

test("analytics: zero views means engagement rate 0 (no division by zero)", () => {
  const summary = summarize([], [metrics("p", { views: 0 })], NOW);
  assert.equal(summary.engagementRate, 0);
  assert.equal(summary.totalEngagement, 15);
});

test("analytics: text report contains the key numbers", () => {
  const summary = summarize([], [metrics("p1", { likes: 10, comments: 2, shares: 3, views: 100 })], NOW);
  const text = renderSummaryText(summary);
  assert.match(text, /Engagement: 15 total/);
  assert.match(text, /Views: 100/);
  assert.match(text, /Best post: p1 \(15 engagement\)/);
  assert.match(text, /x: 0 posts, 1 with metrics/);
});
