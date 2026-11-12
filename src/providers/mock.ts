/**
 * Mock provider — the only provider that runs without credentials.
 *
 * It "publishes" by appending one JSON line per post to a local outbox
 * file (default ~/.social-automation/outbox.jsonl). Used by the test
 * suite, by `run-once --provider mock`, and by the demo in the README.
 * The core queue/scheduler logic is real; only this provider is fake.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Post, PublishResult } from "../types.ts";
import type { Provider } from "./base.ts";

export interface OutboxEntry {
  externalId: string;
  provider: "mock";
  postId: string;
  text: string;
  mediaUrl: string | null;
  scheduledAt: string;
  publishedAt: string;
}

export class MockProvider implements Provider {
  readonly name = "mock" as const;
  private outboxPath: string;

  constructor(outboxPath: string) {
    this.outboxPath = outboxPath;
  }

  async publish(post: Post): Promise<PublishResult> {
    const publishedAt = new Date().toISOString();
    const entry: OutboxEntry = {
      externalId: `mock-${randomUUID()}`,
      provider: "mock",
      postId: post.id,
      text: post.text,
      mediaUrl: post.mediaUrl,
      scheduledAt: post.scheduledAt,
      publishedAt,
    };
    mkdirSync(dirname(this.outboxPath), { recursive: true });
    appendFileSync(this.outboxPath, `${JSON.stringify(entry)}\n`, "utf8");
    return { externalId: entry.externalId, publishedAt };
  }
}

/** Read every entry the mock provider has written to an outbox file. */
export function readOutbox(outboxPath: string): OutboxEntry[] {
  if (!existsSync(outboxPath)) {
    return [];
  }
  return readFileSync(outboxPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as OutboxEntry);
}
