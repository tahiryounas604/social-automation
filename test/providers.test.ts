import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ConfigError, ProviderError } from "../src/types.ts";
import { createProvider } from "../src/providers/index.ts";
import { XProvider } from "../src/providers/x.ts";
import { LinkedInProvider } from "../src/providers/linkedin.ts";
import { InstagramProvider } from "../src/providers/instagram.ts";
import { TikTokProvider } from "../src/providers/tiktok.ts";
import { MockProvider } from "../src/providers/mock.ts";
import type { FetchImpl } from "../src/providers/base.ts";
import type { Post } from "../src/types.ts";
import { NOW, PAST, memoryStore, tempDir } from "./helpers.ts";

function fakePost(provider: Post["provider"], text = "test post"): Post {
  return {
    id: "post-1",
    provider,
    text,
    mediaUrl: "https://example.com/media.jpg",
    scheduledAt: PAST,
    status: "queued",
    createdAt: NOW.toISOString(),
    publishedAt: null,
    externalId: null,
    error: null,
    attempts: 0,
  };
}

/** Build a stub fetch that records calls and returns a canned response. */
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response,
): { fetchImpl: FetchImpl; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

test("providers: factory creates every provider; unknown name rejected", () => {
  const outbox = join(tempDir(), "outbox.jsonl");
  assert.ok(createProvider("mock", { outboxPath: outbox }) instanceof MockProvider);
  assert.ok(createProvider("x", { outboxPath: outbox, env: {} }) instanceof XProvider);
  assert.ok(createProvider("linkedin", { outboxPath: outbox, env: {} }) instanceof LinkedInProvider);
  assert.ok(createProvider("instagram", { outboxPath: outbox, env: {} }) instanceof InstagramProvider);
  assert.ok(createProvider("tiktok", { outboxPath: outbox, env: {} }) instanceof TikTokProvider);
  assert.throws(
    () => createProvider("facebook" as never, { outboxPath: outbox }),
    ConfigError,
  );
});

test("providers: every real provider refuses to run without credentials", async () => {
  const emptyEnv = {};
  await assert.rejects(new XProvider(emptyEnv).publish(fakePost("x")), ConfigError);
  await assert.rejects(
    new LinkedInProvider(emptyEnv).publish(fakePost("linkedin")),
    ConfigError,
  );
  await assert.rejects(
    new InstagramProvider(emptyEnv).publish(fakePost("instagram")),
    ConfigError,
  );
  await assert.rejects(
    new TikTokProvider(emptyEnv).publish(fakePost("tiktok")),
    ConfigError,
  );
  // LinkedIn with a token but no author URN is still a config error.
  await assert.rejects(
    new LinkedInProvider({ LINKEDIN_ACCESS_TOKEN: "tok" }).publish(fakePost("linkedin")),
    /LINKEDIN_AUTHOR_URN/,
  );
});

test("providers: X posts to /2/tweets with bearer auth and returns the tweet id", async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse({ data: { id: "123" } }));
  const result = await new XProvider({ X_BEARER_TOKEN: "tok" }).publish(
    fakePost("x"),
    fetchImpl,
  );
  assert.equal(result.externalId, "123");
  assert.equal(result.url, "https://x.com/i/status/123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.x.com/2/tweets");
  assert.equal((calls[0]?.init?.headers as Record<string, string>)?.Authorization, "Bearer tok");
  const body = JSON.parse(String(calls[0]?.init?.body)) as { text: string };
  assert.equal(body.text, "test post");
});

test("providers: X surfaces API errors as ProviderError with status", async () => {
  const { fetchImpl } = stubFetch(
    () => new Response("forbidden", { status: 403 }),
  );
  await assert.rejects(
    new XProvider({ X_BEARER_TOKEN: "tok" }).publish(fakePost("x"), fetchImpl),
    (error: unknown) => error instanceof ProviderError && error.status === 403,
  );
});

test("providers: LinkedIn posts a UGC share with the author URN", async () => {
  const { fetchImpl, calls } = stubFetch(() =>
    jsonResponse({}, 201, { "x-restli-id": "urn:li:share:999" }),
  );
  const result = await new LinkedInProvider({
    LINKEDIN_ACCESS_TOKEN: "tok",
    LINKEDIN_AUTHOR_URN: "urn:li:person:abc",
  }).publish(fakePost("linkedin"), fetchImpl);
  assert.equal(result.externalId, "urn:li:share:999");
  assert.equal(calls[0]?.url, "https://api.linkedin.com/v2/ugcPosts");
  const body = JSON.parse(String(calls[0]?.init?.body)) as { author: string };
  assert.equal(body.author, "urn:li:person:abc");
});

test("providers: Instagram does the two-step container then publish flow", async () => {
  const seen: string[] = [];
  const { fetchImpl } = stubFetch((url) => {
    seen.push(url);
    if (url.endsWith("/media")) {
      return jsonResponse({ id: "container-1" });
    }
    return jsonResponse({ id: "media-1" });
  });
  const result = await new InstagramProvider({
    INSTAGRAM_ACCESS_TOKEN: "tok",
    INSTAGRAM_ACCOUNT_ID: "ig-42",
  }).publish(fakePost("instagram"), fetchImpl);
  assert.equal(result.externalId, "media-1");
  assert.deepEqual(seen, [
    "https://graph.instagram.com/v21.0/ig-42/media",
    "https://graph.instagram.com/v21.0/ig-42/media_publish",
  ]);
});

test("providers: Instagram refuses a text-only post even with credentials", async () => {
  const post = fakePost("instagram");
  post.mediaUrl = null;
  const { fetchImpl, calls } = stubFetch(() => jsonResponse({ id: "x" }));
  await assert.rejects(
    new InstagramProvider({
      INSTAGRAM_ACCESS_TOKEN: "tok",
      INSTAGRAM_ACCOUNT_ID: "ig-42",
    }).publish(post, fetchImpl),
    /requires a mediaUrl/,
  );
  assert.equal(calls.length, 0); // no network call was made
});

test("providers: TikTok inits a pull-from-URL video publish and returns publish_id", async () => {
  const { fetchImpl, calls } = stubFetch(() =>
    jsonResponse({ data: { publish_id: "pub-7" } }),
  );
  const result = await new TikTokProvider({ TIKTOK_ACCESS_TOKEN: "tok" }).publish(
    fakePost("tiktok"),
    fetchImpl,
  );
  assert.equal(result.externalId, "pub-7");
  assert.equal(calls[0]?.url, "https://open.tiktokapis.com/v2/post/publish/video/init/");
  const body = JSON.parse(String(calls[0]?.init?.body)) as {
    post_info: { title: string; privacy_level: string };
    source_info: { source: string; video_url: string };
  };
  assert.equal(body.post_info.title, "test post");
  assert.equal(body.post_info.privacy_level, "PUBLIC_TO_EVERYONE");
  assert.equal(body.source_info.source, "PULL_FROM_URL");
  assert.equal(body.source_info.video_url, "https://example.com/media.jpg");
});

test("providers: TikTok honours TIKTOK_PRIVACY_LEVEL and ignores invalid values", async () => {
  const { fetchImpl, calls } = stubFetch(() =>
    jsonResponse({ data: { publish_id: "p" } }),
  );
  await new TikTokProvider({
    TIKTOK_ACCESS_TOKEN: "tok",
    TIKTOK_PRIVACY_LEVEL: "SELF_ONLY",
  }).publish(fakePost("tiktok"), fetchImpl);
  const body = JSON.parse(String(calls[0]?.init?.body)) as {
    post_info: { privacy_level: string };
  };
  assert.equal(body.post_info.privacy_level, "SELF_ONLY");

  const second = stubFetch(() => jsonResponse({ data: { publish_id: "p" } }));
  await new TikTokProvider({
    TIKTOK_ACCESS_TOKEN: "tok",
    TIKTOK_PRIVACY_LEVEL: "BOGUS",
  }).publish(fakePost("tiktok"), second.fetchImpl);
  const body2 = JSON.parse(String(second.calls[0]?.init?.body)) as {
    post_info: { privacy_level: string };
  };
  assert.equal(body2.post_info.privacy_level, "PUBLIC_TO_EVERYONE");
});

test("providers: store is unused here — sanity that memoryStore helper works", () => {
  const store = memoryStore();
  try {
    assert.equal(store.count(), 0);
  } finally {
    store.close();
  }
});
