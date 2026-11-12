/**
 * Shared types for social-automation.
 *
 * A Post is one piece of content destined for one provider. It lives in the
 * SQLite queue until the scheduler picks it up (scheduledAt <= now and
 * status === 'queued'), then moves to 'published' or 'failed'.
 */

export type ProviderName = "x" | "linkedin" | "instagram" | "tiktok" | "mock";

export const PROVIDERS: readonly ProviderName[] = [
  "x",
  "linkedin",
  "instagram",
  "tiktok",
  "mock",
] as const;

export type PostStatus = "queued" | "published" | "failed" | "cancelled";

export interface Post {
  id: string;
  provider: ProviderName;
  text: string;
  /** Optional media URL. Required by Instagram and TikTok, optional elsewhere. */
  mediaUrl: string | null;
  /** ISO 8601 timestamp the post becomes due. */
  scheduledAt: string;
  status: PostStatus;
  createdAt: string;
  publishedAt: string | null;
  /** Provider-side id returned on successful publish (e.g. tweet id). */
  externalId: string | null;
  /** Last publish error, if any. */
  error: string | null;
  attempts: number;
}

export interface NewPost {
  provider: ProviderName;
  text: string;
  mediaUrl?: string | null;
  /** ISO 8601 timestamp. Defaults to "now" (publish on next run). */
  scheduledAt?: string;
}

/** One snapshot of engagement numbers for a post. Imported manually (JSON). */
export interface PostMetrics {
  postId: string;
  provider: ProviderName;
  likes: number;
  comments: number;
  shares: number;
  /** Views / impressions, when the platform reports them. */
  views: number;
  collectedAt: string;
}

export interface PublishResult {
  externalId: string;
  /** Public URL of the published post, when the provider returns one. */
  url?: string;
  publishedAt: string;
}

/** Error raised when a real provider cannot run because credentials/config are missing. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Error raised when a provider API call fails (non-2xx, network error, ...). */
export class ProviderError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDERS as readonly string[]).includes(value);
}

export function isPostStatus(value: string): value is PostStatus {
  return (
    value === "queued" ||
    value === "published" ||
    value === "failed" ||
    value === "cancelled"
  );
}
