/**
 * Post queue backed by SQLite (Node 24 built-in `node:sqlite` — no extra
 * dependency). One database file holds the queue (`posts`) and the
 * analytics snapshots (`metrics`).
 *
 * All timestamps are ISO 8601 UTC strings so ordering by scheduled_at is
 * chronological ordering.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  NewPost,
  Post,
  PostMetrics,
  PostStatus,
  ProviderName,
} from "./types.ts";
import { isPostStatus, isProviderName } from "./types.ts";
import { ValidationError, validatePost } from "./validation.ts";

export interface ListFilter {
  status?: PostStatus;
  provider?: ProviderName;
}

function rowToPost(row: Record<string, unknown>): Post {
  const provider = String(row.provider);
  if (!isProviderName(provider)) {
    throw new Error(`corrupt database row: unknown provider ${provider}`);
  }
  const status = String(row.status);
  if (!isPostStatus(status)) {
    throw new Error(`corrupt database row: unknown status ${status}`);
  }
  return {
    id: String(row.id),
    provider,
    text: String(row.text),
    mediaUrl: row.media_url === null ? null : String(row.media_url),
    scheduledAt: String(row.scheduled_at),
    status,
    createdAt: String(row.created_at),
    publishedAt: row.published_at === null ? null : String(row.published_at),
    externalId: row.external_id === null ? null : String(row.external_id),
    error: row.error === null ? null : String(row.error),
    attempts: Number(row.attempts),
  };
}

function rowToMetrics(row: Record<string, unknown>): PostMetrics {
  const provider = String(row.provider);
  if (!isProviderName(provider)) {
    throw new Error(`corrupt database row: unknown provider ${provider}`);
  }
  return {
    postId: String(row.post_id),
    provider,
    likes: Number(row.likes),
    comments: Number(row.comments),
    shares: Number(row.shares),
    views: Number(row.views),
    collectedAt: String(row.collected_at),
  };
}

export class QueueStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        text TEXT NOT NULL,
        media_url TEXT,
        scheduled_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        published_at TEXT,
        external_id TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_posts_due
        ON posts (status, scheduled_at);
      CREATE TABLE IF NOT EXISTS metrics (
        post_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        likes INTEGER NOT NULL DEFAULT 0,
        comments INTEGER NOT NULL DEFAULT 0,
        shares INTEGER NOT NULL DEFAULT 0,
        views INTEGER NOT NULL DEFAULT 0,
        collected_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Insert a post after validation. Defaults scheduledAt to now. */
  add(input: NewPost, now = new Date()): Post {
    const problems = validatePost(input);
    if (problems.length > 0) {
      throw new ValidationError(problems);
    }
    const post: Post = {
      id: randomUUID(),
      provider: input.provider,
      text: input.text,
      mediaUrl: input.mediaUrl ?? null,
      scheduledAt: input.scheduledAt ?? now.toISOString(),
      status: "queued",
      createdAt: now.toISOString(),
      publishedAt: null,
      externalId: null,
      error: null,
      attempts: 0,
    };
    this.db
      .prepare(
        `INSERT INTO posts
           (id, provider, text, media_url, scheduled_at, status, created_at,
            published_at, external_id, error, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        post.id,
        post.provider,
        post.text,
        post.mediaUrl,
        post.scheduledAt,
        post.status,
        post.createdAt,
        post.publishedAt,
        post.externalId,
        post.error,
        post.attempts,
      );
    return post;
  }

  get(id: string): Post | null {
    const row = this.db
      .prepare("SELECT * FROM posts WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToPost(row);
  }

  list(filter: ListFilter = {}): Post[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.status !== undefined) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    if (filter.provider !== undefined) {
      conditions.push("provider = ?");
      params.push(filter.provider);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM posts ${where} ORDER BY scheduled_at ASC, created_at ASC`,
      )
      .all(...params) as Record<string, unknown>[];
    return rows.map(rowToPost);
  }

  /** Queued posts whose scheduled time has arrived, oldest first. */
  due(now: Date): Post[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM posts
          WHERE status = 'queued' AND scheduled_at <= ?
          ORDER BY scheduled_at ASC, created_at ASC`,
      )
      .all(now.toISOString()) as Record<string, unknown>[];
    return rows.map(rowToPost);
  }

  count(filter: ListFilter = {}): number {
    return this.list(filter).length;
  }

  /** Move a queued post to a new scheduled time. Returns false if not found / not queued. */
  reschedule(id: string, scheduledAt: string): boolean {
    const when = new Date(scheduledAt);
    if (Number.isNaN(when.getTime())) {
      throw new ValidationError([`scheduledAt is not a valid ISO 8601 date: ${scheduledAt}`]);
    }
    const result = this.db
      .prepare(
        "UPDATE posts SET scheduled_at = ? WHERE id = ? AND status = 'queued'",
      )
      .run(when.toISOString(), id);
    return result.changes > 0;
  }

  cancel(id: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE posts SET status = 'cancelled' WHERE id = ? AND status = 'queued'",
      )
      .run(id);
    return result.changes > 0;
  }

  markPublished(id: string, externalId: string, publishedAt: string): void {
    this.db
      .prepare(
        `UPDATE posts
            SET status = 'published', external_id = ?, published_at = ?,
                error = NULL, attempts = attempts + 1
          WHERE id = ?`,
      )
      .run(externalId, publishedAt, id);
  }

  markFailed(id: string, error: string): void {
    this.db
      .prepare(
        `UPDATE posts
            SET status = 'failed', error = ?, attempts = attempts + 1
          WHERE id = ?`,
      )
      .run(error.slice(0, 1000), id);
  }

  /** Re-queue a failed post so the scheduler will retry it. */
  retry(id: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE posts SET status = 'queued', error = NULL WHERE id = ? AND status = 'failed'",
      )
      .run(id);
    return result.changes > 0;
  }

  /** Upsert one metrics snapshot per post (latest snapshot wins). */
  importMetrics(metrics: PostMetrics): void {
    for (const field of ["likes", "comments", "shares", "views"] as const) {
      const value = metrics[field];
      if (!Number.isInteger(value) || value < 0) {
        throw new ValidationError([
          `metrics.${field} must be a non-negative integer, got ${String(value)}`,
        ]);
      }
    }
    this.db
      .prepare(
        `INSERT INTO metrics
           (post_id, provider, likes, comments, shares, views, collected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(post_id) DO UPDATE SET
           provider = excluded.provider,
           likes = excluded.likes,
           comments = excluded.comments,
           shares = excluded.shares,
           views = excluded.views,
           collected_at = excluded.collected_at`,
      )
      .run(
        metrics.postId,
        metrics.provider,
        metrics.likes,
        metrics.comments,
        metrics.shares,
        metrics.views,
        metrics.collectedAt,
      );
  }

  importMetricsBatch(batch: PostMetrics[]): void {
    for (const metrics of batch) {
      this.importMetrics(metrics);
    }
  }

  getMetrics(postId: string): PostMetrics | null {
    const row = this.db
      .prepare("SELECT * FROM metrics WHERE post_id = ?")
      .get(postId) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToMetrics(row);
  }

  allMetrics(): PostMetrics[] {
    const rows = this.db.prepare("SELECT * FROM metrics").all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToMetrics);
  }
}
