/**
 * Instagram provider — Instagram Graph API, two-step media publish.
 *
 * Step 1: POST /{ig-user-id}/media {caption, image_url} -> container id.
 * Step 2: POST /{ig-user-id}/media_publish {creation_id} -> media id.
 * Auth: long-lived user access token in INSTAGRAM_ACCESS_TOKEN, and the
 * Instagram Business/Creator account id in INSTAGRAM_ACCOUNT_ID.
 * Text-only posts are NOT supported by the Graph API — a mediaUrl is
 * required (enforced by validation before the post reaches here).
 * Setup: Meta developers (developers.facebook.com) — Instagram Graph API.
 * Live posting NOT tested (no credentials in this repo).
 */
import { ConfigError, ProviderError } from "../types.ts";
import type { Post, PublishResult } from "../types.ts";
import type { FetchImpl, Provider } from "./base.ts";
import { readErrorBody } from "./base.ts";

export class InstagramProvider implements Provider {
  readonly name = "instagram" as const;
  private accessToken: string | undefined;
  private accountId: string | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.accessToken = env.INSTAGRAM_ACCESS_TOKEN;
    this.accountId = env.INSTAGRAM_ACCOUNT_ID;
  }

  async publish(post: Post, fetchImpl: FetchImpl = fetch): Promise<PublishResult> {
    if (this.accessToken === undefined || this.accessToken === "") {
      throw new ConfigError(
        "INSTAGRAM_ACCESS_TOKEN is not set — see README 'Provider setup: Instagram'",
      );
    }
    if (this.accountId === undefined || this.accountId === "") {
      throw new ConfigError(
        "INSTAGRAM_ACCOUNT_ID is not set — see README 'Provider setup: Instagram'",
      );
    }
    if (post.mediaUrl === null) {
      throw new ProviderError("Instagram requires a mediaUrl");
    }
    const base = `https://graph.instagram.com/v21.0/${this.accountId}`;
    const create = await fetchImpl(`${base}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        caption: post.text,
        image_url: post.mediaUrl,
        access_token: this.accessToken,
      }),
    });
    if (!create.ok) {
      throw new ProviderError(
        `Instagram API (create container) failed: ${await readErrorBody(create)}`,
        create.status,
      );
    }
    const created = (await create.json()) as { id?: string };
    if (typeof created.id !== "string" || created.id === "") {
      throw new ProviderError("Instagram API returned no media container id");
    }
    const publish = await fetchImpl(`${base}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        creation_id: created.id,
        access_token: this.accessToken,
      }),
    });
    if (!publish.ok) {
      throw new ProviderError(
        `Instagram API (publish) failed: ${await readErrorBody(publish)}`,
        publish.status,
      );
    }
    const published = (await publish.json()) as { id?: string };
    if (typeof published.id !== "string" || published.id === "") {
      throw new ProviderError("Instagram API returned no media id");
    }
    return { externalId: published.id, publishedAt: new Date().toISOString() };
  }
}
