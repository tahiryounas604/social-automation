#!/usr/bin/env node
/**
 * CLI: add / list / schedule / cancel / retry / run-once / worker /
 * metrics import / report / providers.
 *
 * Usage examples (see README for the full guide):
 *   social-automation add --provider x --text "Hello world"
 *   social-automation add --provider mock --text "Demo" --at 2026-11-12T18:00:00Z
 *   social-automation list --status queued
 *   social-automation schedule <id> --at 2026-11-12T18:00:00Z
 *   social-automation run-once
 *   social-automation report
 *
 * Exit codes: 0 ok, 1 usage/validation error, 2 run-once had failures.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, type AppConfig } from "./config.ts";
import { QueueStore } from "./db.ts";
import { summarizeStore, renderSummaryText } from "./analytics.ts";
import { defaultResolver, type ProviderResolver } from "./scheduler.ts";
import { Scheduler } from "./scheduler.ts";
import { createProvider } from "./providers/index.ts";
import { PROVIDERS, isPostStatus, isProviderName } from "./types.ts";
import type { PostMetrics, PostStatus, ProviderName } from "./types.ts";
import { ValidationError } from "./validation.ts";

export interface CliOptions {
  store?: QueueStore;
  config?: AppConfig;
  /** Override the provider used by run-once (demo mode). */
  runOnceProvider?: ProviderName;
  out?: (line: string) => void;
  errOut?: (line: string) => void;
}

interface Flags {
  positional: string[];
  values: Record<string, string>;
  booleans: Set<string>;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { positional: [], values: {}, booleans: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      break;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags.booleans.add(key);
      } else {
        flags.values[key] = next;
        i += 1;
      }
    } else {
      flags.positional.push(arg);
    }
  }
  return flags;
}

const HELP = `social-automation 0.1.0 — schedule + publish social posts

Usage:
  social-automation <command> [options]

Commands:
  providers                                  List supported providers
  add --provider <name> --text <text> [--media-url <url>] [--at <ISO time>]
                                             Queue a post (default: due now)
  list [--status <queued|published|failed|cancelled>] [--provider <name>] [--json]
                                             List queued/published posts
  schedule <id> --at <ISO time>              Move a queued post to a new time
  cancel <id>                                Cancel a queued post
  retry <id>                                 Re-queue a failed post
  run-once [--provider <name>]               Publish every due post now
                                             (--provider overrides each post's
                                              provider — demo mode, e.g. mock)
  worker [--interval-ms <n>]                 Run the scheduler loop (default 60s)
  metrics import --file <metrics.json>       Import engagement metrics (JSON)
  report [--json]                            Analytics summary report

Providers: ${PROVIDERS.join(", ")}
Config: SOCIAL_AUTOMATION_DIR (default ~/.social-automation),
        SOCIAL_AUTOMATION_DB / SOCIAL_AUTOMATION_OUTBOX to override paths.
Real providers need API credentials — see README "Provider setup".
`;

function printPost(
  out: (line: string) => void,
  post: {
    id: string;
    provider: string;
    status: string;
    scheduledAt: string;
    text: string;
    externalId: string | null;
    error: string | null;
  },
): void {
  const extra =
    post.status === "published" && post.externalId !== null
      ? ` external=${post.externalId}`
      : post.status === "failed" && post.error !== null
        ? ` error=${post.error}`
        : "";
  out(
    `${post.id} [${post.provider}] ${post.status} due=${post.scheduledAt}${extra} :: ${post.text}`,
  );
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line));
  const errOut = options.errOut ?? ((line: string) => console.error(line));
  const config = options.config ?? loadConfig();
  const store = options.store ?? new QueueStore(config.dbPath);
  const ownStore = options.store === undefined;

  try {
    const [command, ...rest] = argv;
    const flags = parseFlags(rest);

    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      out(HELP);
      return 0;
    }

    switch (command) {
      case "providers": {
        for (const name of PROVIDERS) {
          out(name);
        }
        return 0;
      }

      case "add": {
        const providerRaw = flags.values["provider"];
        const text = flags.values["text"];
        if (providerRaw === undefined || !isProviderName(providerRaw)) {
          errOut(`add: --provider is required (one of: ${PROVIDERS.join(", ")})`);
          return 1;
        }
        if (text === undefined) {
          errOut("add: --text is required");
          return 1;
        }
        const at = flags.values["at"] ?? flags.values["scheduled-at"];
        const mediaUrl = flags.values["media-url"];
        const post = store.add({
          provider: providerRaw,
          text,
          ...(mediaUrl !== undefined ? { mediaUrl } : {}),
          ...(at !== undefined ? { scheduledAt: at } : {}),
        });
        out(`queued ${post.id} [${post.provider}] due=${post.scheduledAt}`);
        return 0;
      }

      case "list": {
        const statusRaw = flags.values["status"];
        if (statusRaw !== undefined && !isPostStatus(statusRaw)) {
          errOut(`list: unknown --status ${statusRaw}`);
          return 1;
        }
        const providerRaw = flags.values["provider"];
        if (providerRaw !== undefined && !isProviderName(providerRaw)) {
          errOut(`list: unknown --provider ${providerRaw}`);
          return 1;
        }
        const posts = store.list({
          ...(statusRaw !== undefined
            ? { status: statusRaw as PostStatus }
            : {}),
          ...(providerRaw !== undefined
            ? { provider: providerRaw as ProviderName }
            : {}),
        });
        if (flags.booleans.has("json")) {
          out(JSON.stringify(posts, null, 2));
        } else if (posts.length === 0) {
          out("no posts");
        } else {
          for (const post of posts) {
            printPost(out, post);
          }
        }
        return 0;
      }

      case "schedule": {
        const id = flags.positional[0];
        const at = flags.values["at"] ?? flags.values["scheduled-at"];
        if (id === undefined || at === undefined) {
          errOut("schedule: usage: schedule <id> --at <ISO time>");
          return 1;
        }
        const ok = store.reschedule(id, at);
        if (!ok) {
          errOut(`schedule: no queued post with id ${id}`);
          return 1;
        }
        out(`rescheduled ${id} to ${new Date(at).toISOString()}`);
        return 0;
      }

      case "cancel": {
        const id = flags.positional[0];
        if (id === undefined) {
          errOut("cancel: usage: cancel <id>");
          return 1;
        }
        if (!store.cancel(id)) {
          errOut(`cancel: no queued post with id ${id}`);
          return 1;
        }
        out(`cancelled ${id}`);
        return 0;
      }

      case "retry": {
        const id = flags.positional[0];
        if (id === undefined) {
          errOut("retry: usage: retry <id>");
          return 1;
        }
        if (!store.retry(id)) {
          errOut(`retry: no failed post with id ${id}`);
          return 1;
        }
        out(`re-queued ${id}`);
        return 0;
      }

      case "run-once": {
        const overrideRaw = flags.values["provider"] ?? options.runOnceProvider;
        let resolver: ProviderResolver;
        if (overrideRaw !== undefined) {
          if (!isProviderName(overrideRaw)) {
            errOut(`run-once: unknown --provider ${overrideRaw}`);
            return 1;
          }
          const forced = createProvider(overrideRaw, {
            outboxPath: config.outboxPath,
          });
          resolver = () => forced;
        } else {
          resolver = defaultResolver(config.outboxPath);
        }
        const scheduler = new Scheduler(store, { resolveProvider: resolver });
        const report = await scheduler.runOnce();
        for (const attempt of report.attempts) {
          if (attempt.ok) {
            out(`published ${attempt.post.id} [${attempt.post.provider}] external=${attempt.externalId ?? ""}`);
          } else {
            errOut(`failed ${attempt.post.id} [${attempt.post.provider}]: ${attempt.error ?? "unknown error"}`);
          }
        }
        out(
          `run-once: processed=${report.processed} published=${report.published} failed=${report.failed}`,
        );
        return report.failed > 0 ? 2 : 0;
      }

      case "worker": {
        const intervalRaw = flags.values["interval-ms"];
        const intervalMs =
          intervalRaw === undefined ? 60_000 : Number.parseInt(intervalRaw, 10);
        if (!Number.isInteger(intervalMs) || intervalMs < 1000) {
          errOut("worker: --interval-ms must be an integer >= 1000");
          return 1;
        }
        const scheduler = new Scheduler(store, {
          resolveProvider: defaultResolver(config.outboxPath),
          intervalMs,
        });
        out(`worker running every ${intervalMs}ms (Ctrl+C to stop)`);
        scheduler.start((error) => {
          errOut(`worker error: ${error instanceof Error ? error.message : String(error)}`);
        });
        await new Promise<void>((resolve) => {
          const stop = (): void => {
            scheduler.stop();
            resolve();
          };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
        out("worker stopped");
        return 0;
      }

      case "metrics": {
        const sub = flags.positional[0];
        if (sub !== "import") {
          errOut("metrics: usage: metrics import --file <metrics.json>");
          return 1;
        }
        const file = flags.values["file"];
        if (file === undefined) {
          errOut("metrics import: --file is required");
          return 1;
        }
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        const batch: PostMetrics[] = Array.isArray(parsed) ? parsed : [parsed];
        store.importMetricsBatch(batch as PostMetrics[]);
        out(`imported ${batch.length} metrics snapshot(s)`);
        return 0;
      }

      case "report": {
        const summary = summarizeStore(store);
        if (flags.booleans.has("json")) {
          out(JSON.stringify(summary, null, 2));
        } else {
          out(renderSummaryText(summary));
        }
        return 0;
      }

      default: {
        errOut(`unknown command: ${command}\n${HELP}`);
        return 1;
      }
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      errOut(`error: ${error.message}`);
      return 1;
    }
    if (error instanceof SyntaxError) {
      errOut(`error: invalid JSON — ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    if (ownStore) {
      store.close();
    }
  }
}

/* Entry point: run the CLI when this file is executed directly
 * (node dist/src/cli.js ... or via the `social-automation` bin). */
const entryArg = process.argv[1];
let isMain = false;
if (entryArg !== undefined) {
  try {
    isMain = realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entryArg);
  } catch {
    isMain = false;
  }
}
if (isMain) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
