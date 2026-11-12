/**
 * Analytics: pure summary math over the queue + imported metrics.
 *
 * Metrics arrive by manual JSON import (`metrics import`) or from the
 * mock provider's demo data — v0.1 does not scrape any platform, because
 * every platform's analytics API needs the same OAuth credentials as
 * publishing and its own approval. The summary is computed from whatever
 * snapshots are in the database; a post with no snapshot counts as
 * "without metrics" rather than zero engagement.
 */
import type { QueueStore } from "./db.ts";
import type { PostMetrics, ProviderName } from "./types.ts";

export interface ProviderSummary {
  posts: number;
  withMetrics: number;
  likes: number;
  comments: number;
  shares: number;
  views: number;
  engagement: number;
}

export interface AnalyticsSummary {
  generatedAt: string;
  totalPosts: number;
  byStatus: Record<string, number>;
  byProvider: Record<ProviderName, ProviderSummary>;
  postsWithMetrics: number;
  postsWithoutMetrics: number;
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  totalViews: number;
  totalEngagement: number;
  /** Mean engagement (likes + comments + shares) per post that has metrics. */
  avgEngagementPerPost: number;
  /** totalEngagement / totalViews, 0 when there are no views. */
  engagementRate: number;
  /** Post id with the highest engagement, null when no metrics exist. */
  bestPostId: string | null;
  bestPostEngagement: number;
}

function emptyProviderSummary(): ProviderSummary {
  return {
    posts: 0,
    withMetrics: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    views: 0,
    engagement: 0,
  };
}

export function engagementOf(metrics: PostMetrics): number {
  return metrics.likes + metrics.comments + metrics.shares;
}

/** Build a summary from posts + metrics already loaded from the store. */
export function summarize(
  posts: ReturnType<QueueStore["list"]>,
  metrics: PostMetrics[],
  now = new Date(),
): AnalyticsSummary {
  const byStatus: Record<string, number> = {};
  const byProvider = {} as Record<ProviderName, ProviderSummary>;
  for (const post of posts) {
    byStatus[post.status] = (byStatus[post.status] ?? 0) + 1;
    const slot = (byProvider[post.provider] ??= emptyProviderSummary());
    slot.posts += 1;
  }

  let totalLikes = 0;
  let totalComments = 0;
  let totalShares = 0;
  let totalViews = 0;
  let bestPostId: string | null = null;
  let bestPostEngagement = 0;

  for (const m of metrics) {
    const engagement = engagementOf(m);
    totalLikes += m.likes;
    totalComments += m.comments;
    totalShares += m.shares;
    totalViews += m.views;
    const slot = (byProvider[m.provider] ??= emptyProviderSummary());
    slot.withMetrics += 1;
    slot.likes += m.likes;
    slot.comments += m.comments;
    slot.shares += m.shares;
    slot.views += m.views;
    slot.engagement += engagement;
    if (engagement > bestPostEngagement) {
      bestPostEngagement = engagement;
      bestPostId = m.postId;
    }
  }

  const totalEngagement = totalLikes + totalComments + totalShares;
  const postsWithMetrics = metrics.length;
  return {
    generatedAt: now.toISOString(),
    totalPosts: posts.length,
    byStatus,
    byProvider,
    postsWithMetrics,
    postsWithoutMetrics: Math.max(0, posts.length - postsWithMetrics),
    totalLikes,
    totalComments,
    totalShares,
    totalViews,
    totalEngagement,
    avgEngagementPerPost:
      postsWithMetrics === 0 ? 0 : totalEngagement / postsWithMetrics,
    engagementRate: totalViews === 0 ? 0 : totalEngagement / totalViews,
    bestPostId,
    bestPostEngagement,
  };
}

/** Convenience wrapper: load from the store and summarize. */
export function summarizeStore(store: QueueStore, now = new Date()): AnalyticsSummary {
  return summarize(store.list(), store.allMetrics(), now);
}

/** One-line-per-provider text rendering of a summary (CLI `report`). */
export function renderSummaryText(summary: AnalyticsSummary): string {
  const lines: string[] = [
    `Social Automation — analytics report (${summary.generatedAt})`,
    `Posts: ${summary.totalPosts} (${summary.postsWithMetrics} with metrics, ${summary.postsWithoutMetrics} without)`,
    `Status: ${Object.entries(summary.byStatus)
      .map(([status, count]) => `${status}=${count}`)
      .join(", ") || "—"}`,
    `Engagement: ${summary.totalEngagement} total ` +
      `(likes ${summary.totalLikes}, comments ${summary.totalComments}, shares ${summary.totalShares})`,
    `Views: ${summary.totalViews} | avg engagement/post: ${summary.avgEngagementPerPost.toFixed(2)} | engagement rate: ${(summary.engagementRate * 100).toFixed(2)}%`,
    `Best post: ${summary.bestPostId ?? "—"} (${summary.bestPostEngagement} engagement)`,
    "",
    "By provider:",
  ];
  for (const [provider, slot] of Object.entries(summary.byProvider)) {
    lines.push(
      `  ${provider}: ${slot.posts} posts, ${slot.withMetrics} with metrics, ` +
        `engagement ${slot.engagement} (likes ${slot.likes}, comments ${slot.comments}, shares ${slot.shares}), views ${slot.views}`,
    );
  }
  return lines.join("\n");
}
