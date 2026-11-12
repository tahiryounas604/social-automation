/**
 * LinkedIn provider — POST /v2/ugcPosts (authored UGC post).
 *
 * Auth: OAuth 2.0 access token with the `w_member_social` scope in
 * LINKEDIN_ACCESS_TOKEN, and the author's person URN in
 * LINKEDIN_AUTHOR_URN (e.g. `urn:li:person:AbCdEfGh`).
 * Setup: https://www.linkedin.com/developers — create an app, request
 * "Share on LinkedIn", complete OAuth, export both variables.
 * Live posting NOT tested (no credentials in this repo).
 */
import { ConfigError, ProviderError } from "../types.ts";
import type { Post, PublishResult } from "../types.ts";
import type { FetchImpl, Provider } from "./base.ts";
import { readErrorBody } from "./base.ts";

export class LinkedInProvider implements Provider {
  readonly name = "linkedin" as const;
  private accessToken: string | undefined;
  private authorUrn: string | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.accessToken = env.LINKEDIN_ACCESS_TOKEN;
    this.authorUrn = env.LINKEDIN_AUTHOR_URN;
  }

  async publish(post: Post, fetchImpl: FetchImpl = fetch): Promise<PublishResult> {
    if (this.accessToken === undefined || this.accessToken === "") {
      throw new ConfigError(
        "LINKEDIN_ACCESS_TOKEN is not set — see README 'Provider setup: LinkedIn'",
      );
    }
    if (this.authorUrn === undefined || this.authorUrn === "") {
      throw new ConfigError(
        "LINKEDIN_AUTHOR_URN is not set — see README 'Provider setup: LinkedIn'",
      );
    }
    const response = await fetchImpl("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        author: this.authorUrn,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: post.text },
            shareMediaCategory: "NONE",
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      }),
    });
    if (!response.ok) {
      throw new ProviderError(
        `LinkedIn API failed: ${await readErrorBody(response)}`,
        response.status,
      );
    }
    const id = response.headers.get("x-restli-id") ?? "";
    if (id === "") {
      throw new ProviderError("LinkedIn API returned no post id");
    }
    return { externalId: id, publishedAt: new Date().toISOString() };
  }
}
