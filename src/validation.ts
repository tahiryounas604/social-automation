/**
 * Per-provider validation rules.
 *
 * Limits are the platforms' documented text limits (conservative where the
 * platform varies by account type). Instagram and TikTok cannot publish
 * text-only posts through their official APIs — they need media.
 */
import type { NewPost, ProviderName } from "./types.ts";

export const TEXT_LIMITS: Readonly<Record<ProviderName, number>> = {
  x: 280,
  linkedin: 3000,
  instagram: 2200,
  tiktok: 2200,
  mock: 10000,
};

export const MEDIA_REQUIRED: Readonly<Record<ProviderName, boolean>> = {
  x: false,
  linkedin: false,
  instagram: true,
  tiktok: true,
  mock: false,
};

/**
 * Validate a new post for a provider. Returns a list of problems; empty
 * means the post is acceptable. Throws nothing — callers decide how to
 * surface the problems (CLI prints them, the store throws ValidationError).
 */
export function validatePost(input: NewPost): string[] {
  const errors: string[] = [];
  const text = input.text ?? "";

  if (text.trim().length === 0) {
    errors.push("text must not be empty");
  }
  const limit = TEXT_LIMITS[input.provider];
  if (text.length > limit) {
    errors.push(
      `text is ${text.length} characters, over the ${input.provider} limit of ${limit}`,
    );
  }
  if (MEDIA_REQUIRED[input.provider] && !input.mediaUrl) {
    errors.push(
      `${input.provider} requires a mediaUrl (text-only posts are not supported by its API)`,
    );
  }
  if (input.mediaUrl !== undefined && input.mediaUrl !== null) {
    let url: URL;
    try {
      url = new URL(input.mediaUrl);
    } catch {
      errors.push(`mediaUrl is not a valid URL: ${input.mediaUrl}`);
      return errors;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      errors.push(`mediaUrl must be http(s): ${input.mediaUrl}`);
    }
  }
  if (input.scheduledAt !== undefined) {
    const when = new Date(input.scheduledAt);
    if (Number.isNaN(when.getTime())) {
      errors.push(`scheduledAt is not a valid ISO 8601 date: ${input.scheduledAt}`);
    }
  }
  return errors;
}

export class ValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid post: ${problems.join("; ")}`);
    this.name = "ValidationError";
    this.problems = problems;
  }
}
