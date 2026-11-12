/**
 * X (Twitter) provider — X API v2, POST /2/tweets.
 *
 * Auth: OAuth 2.0 user token or app bearer token in X_BEARER_TOKEN.
 * Needs the `tweet.write` scope / write permission on the app.
 * Setup: https://developer.x.com — create an app, generate a token, export
 * X_BEARER_TOKEN. Live posting NOT tested (no credentials in this repo).
 */
import { ConfigError, ProviderError } from "../types.ts";
import type { Post, PublishResult } from "../types.ts";
import type { FetchImpl, Provider } from "./base.ts";
import { readErrorBody } from "./base.ts";

export class XProvider implements Provider {
  readonly name = "x" as const;
  private bearerToken: string | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.bearerToken = env.X_BEARER_TOKEN;
  }

  async publish(post: Post, fetchImpl: FetchImpl = fetch): Promise<PublishResult> {
    if (this.bearerToken === undefined || this.bearerToken === "") {
      throw new ConfigError(
        "X_BEARER_TOKEN is not set — see README 'Provider setup: X'",
      );
    }
    const response = await fetchImpl("https://api.x.com/2/tweets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: post.text }),
    });
    if (!response.ok) {
      throw new ProviderError(
        `X API failed: ${await readErrorBody(response)}`,
        response.status,
      );
    }
    const body = (await response.json()) as {
      data?: { id?: string };
    };
    const id = body.data?.id;
    if (typeof id !== "string" || id === "") {
      throw new ProviderError("X API returned no tweet id");
    }
    return {
      externalId: id,
      url: `https://x.com/i/status/${id}`,
      publishedAt: new Date().toISOString(),
    };
  }
}
