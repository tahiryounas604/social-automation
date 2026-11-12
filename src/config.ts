/**
 * Configuration: paths and provider credentials, all from the environment.
 *
 * No credentials are ever stored in the repo. Real providers read their
 * tokens from environment variables at publish time; the mock provider
 * needs none.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  /** SQLite database file for the post queue. */
  dbPath: string;
  /** JSONL file the mock provider appends published posts to. */
  outboxPath: string;
}

export function defaultDataDir(): string {
  return join(homedir(), ".social-automation");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dir = env.SOCIAL_AUTOMATION_DIR ?? defaultDataDir();
  return {
    dbPath: env.SOCIAL_AUTOMATION_DB ?? join(dir, "social-automation.db"),
    outboxPath:
      env.SOCIAL_AUTOMATION_OUTBOX ?? join(dir, "outbox.jsonl"),
  };
}

/** Read a required env var, or throw ConfigError naming the variable. */
export function requiredEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    // Imported lazily to keep this module free of provider concerns.
    throw new Error(
      `missing required environment variable ${name} — see README "Provider setup"`,
    );
  }
  return value;
}
