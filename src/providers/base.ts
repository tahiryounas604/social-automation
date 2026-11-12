/**
 * Provider interface: one shape every platform implements.
 *
 * `fetchImpl` is injectable so tests can stub the network without touching
 * the real APIs. Production code passes nothing and the global fetch is used.
 */
import type { Post, ProviderName, PublishResult } from "../types.ts";

export type FetchImpl = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface Provider {
  readonly name: ProviderName;
  /** Publish one post. Throws ConfigError (missing credentials) or ProviderError (API failure). */
  publish(post: Post, fetchImpl?: FetchImpl): Promise<PublishResult>;
}

/** Parse a provider error body into a short message (never leaks tokens). */
export async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  const trimmed = text.trim().slice(0, 500);
  return trimmed === "" ? `HTTP ${response.status}` : `HTTP ${response.status}: ${trimmed}`;
}
