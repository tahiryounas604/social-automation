/** Shared test helpers: temp dirs + in-memory stores. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "../src/db.ts";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "social-automation-test-"));
}

export function memoryStore(): QueueStore {
  return new QueueStore(":memory:");
}

export const PAST = "2026-01-01T00:00:00.000Z";
export const FUTURE = "2999-01-01T00:00:00.000Z";
export const NOW = new Date("2026-11-12T04:00:00.000Z");
