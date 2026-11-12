/**
 * social-automation — public API + CLI entry point.
 *
 * Library users import the queue, scheduler, providers and analytics
 * from here; the CLI (`social-automation` bin) is src/cli.ts.
 */
export * from "./types.ts";
export * from "./validation.ts";
export * from "./config.ts";
export * from "./db.ts";
export * from "./scheduler.ts";
export * from "./analytics.ts";
export * from "./providers/index.ts";
export { readOutbox } from "./providers/mock.ts";
export type { OutboxEntry } from "./providers/mock.ts";
export { runCli } from "./cli.ts";
