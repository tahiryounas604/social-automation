/**
 * TikTok provider — TikTok Content Posting API (video init step).
 *
 * POST /v2/post/publish/video/init/ with a pull-from-URL video source
 * returns a publish_id; the video then uploads/encodes on TikTok's side.
 * Auth: OAuth 2.0 access token with the `video.upload` scope in
 * TIKTOK_ACCESS_TOKEN. Privacy defaults to PUBLIC_TO_EVERYONE and can be
 * lowered with TIKTOK_PRIVACY_LEVEL (SELF_ONLY | MUTUAL_FOLLOW_FRIENDS |
 * FOLLOWER_OF_CREATOR | PUBLIC_TO_EVERYONE).
 * A mediaUrl (public video URL) is required — enforced by validation.
 * Setup: https://developers.tiktok.com — Content Posting API.
 * Live posting NOT tested (no credentials in this repo).
 */
import { ConfigError, ProviderError } from "../types.ts";
import type { Post, PublishResult } from "../types.ts";
import type { FetchImpl, Provider } from "./base.ts";
import { readErrorBody } from "./base.ts";

const VALID_PRIVACY = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
] as const;

export class TikTokProvider implements Provider {
  readonly name = "tiktok" as const;
  private accessToken: string | undefined;
  private privacyLevel: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.accessToken = env.TIKTOK_ACCESS_TOKEN;
    const requested = env.TIKTOK_PRIVACY_LEVEL ?? "PUBLIC_TO_EVERYONE";
    this.privacyLevel = (
      VALID_PRIVACY as readonly string[]
    ).includes(requested)
      ? requested
      : "PUBLIC_TO_EVERYONE";
  }

  async publish(post: Post, fetchImpl: FetchImpl = fetch): Promise<PublishResult> {
    if (this.accessToken === undefined || this.accessToken === "") {
      throw new ConfigError(
        "TIKTOK_ACCESS_TOKEN is not set — see README 'Provider setup: TikTok'",
      );
    }
    if (post.mediaUrl === null) {
      throw new ProviderError("TikTok requires a mediaUrl (public video URL)");
    }
    const response = await fetchImpl(
      "https://open.tiktokapis.com/v2/post/publish/video/init/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({
          post_info: {
            title: post.text,
            privacy_level: this.privacyLevel,
            disable_duet: false,
            disable_comment: false,
            disable_stitch: false,
            video_cover_timestamp_ms: 1000,
          },
          source_info: {
            source: "PULL_FROM_URL",
            video_url: post.mediaUrl,
          },
        }),
      },
    );
    if (!response.ok) {
      throw new ProviderError(
        `TikTok API failed: ${await readErrorBody(response)}`,
        response.status,
      );
    }
    const body = (await response.json()) as {
      data?: { publish_id?: string };
      error?: { code?: string; message?: string };
    };
    const publishId = body.data?.publish_id;
    if (typeof publishId !== "string" || publishId === "") {
      const detail = body.error?.message ?? "no publish_id returned";
      throw new ProviderError(`TikTok API failed: ${detail}`);
    }
    return { externalId: publishId, publishedAt: new Date().toISOString() };
  }
}
