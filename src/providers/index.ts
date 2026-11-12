/**
 * Provider factory: one place that maps a provider name to its client.
 * The mock provider needs the outbox path; real providers read their
 * credentials from the environment at construction time.
 */
import type { ProviderName } from "../types.ts";
import { ConfigError } from "../types.ts";
import type { Provider } from "./base.ts";
import { InstagramProvider } from "./instagram.ts";
import { LinkedInProvider } from "./linkedin.ts";
import { MockProvider } from "./mock.ts";
import { TikTokProvider } from "./tiktok.ts";
import { XProvider } from "./x.ts";

export { InstagramProvider, LinkedInProvider, MockProvider, TikTokProvider, XProvider };
export type { Provider } from "./base.ts";

export interface ProviderFactoryOptions {
  outboxPath: string;
  env?: NodeJS.ProcessEnv;
}

export function createProvider(
  name: ProviderName,
  options: ProviderFactoryOptions,
): Provider {
  const env = options.env ?? process.env;
  switch (name) {
    case "mock":
      return new MockProvider(options.outboxPath);
    case "x":
      return new XProvider(env);
    case "linkedin":
      return new LinkedInProvider(env);
    case "instagram":
      return new InstagramProvider(env);
    case "tiktok":
      return new TikTokProvider(env);
    default:
      throw new ConfigError(`unknown provider: ${String(name)}`);
  }
}
