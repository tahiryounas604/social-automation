import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.ts";
import { QueueStore } from "../src/db.ts";
import { readOutbox } from "../src/providers/mock.ts";
import { FUTURE, PAST, tempDir } from "./helpers.ts";

interface Captured {
  out: string[];
  err: string[];
}

function capture(): Captured & {
  outFn: (line: string) => void;
  errFn: (line: string) => void;
} {
  const captured: Captured = { out: [], err: [] };
  return {
    ...captured,
    outFn: (line: string) => captured.out.push(line),
    errFn: (line: string) => captured.err.push(line),
  };
}

function setup() {
  const dir = tempDir();
  const store = new QueueStore(":memory:");
  const config = {
    dbPath: ":memory:",
    outboxPath: join(dir, "outbox.jsonl"),
  };
  return { dir, store, config };
}

test("cli: add + list round-trip, and list --json", async () => {
  const { store, config } = setup();
  try {
    const c = capture();
    assert.equal(
      await runCli(["add", "--provider", "x", "--text", "hello cli"], {
        store,
        config,
        out: c.outFn,
        errOut: c.errFn,
      }),
      0,
    );
    assert.match(c.out[0] ?? "", /^queued \S+ \[x\] due=/);

    const c2 = capture();
    assert.equal(
      await runCli(["list"], { store, config, out: c2.outFn, errOut: c2.errFn }),
      0,
    );
    assert.match(c2.out.join("\n"), /hello cli/);

    const c3 = capture();
    await runCli(["list", "--json"], { store, config, out: c3.outFn, errOut: c3.errFn });
    const parsed = JSON.parse(c3.out.join("\n")) as { text: string }[];
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.text, "hello cli");
  } finally {
    store.close();
  }
});

test("cli: add validates provider, text and limits (exit 1, nothing queued)", async () => {
  const { store, config } = setup();
  try {
    const c = capture();
    assert.equal(
      await runCli(["add", "--provider", "nope", "--text", "x"], {
        store,
        config,
        out: c.outFn,
        errOut: c.errFn,
      }),
      1,
    );
    assert.equal(
      await runCli(["add", "--provider", "x", "--text", "a".repeat(281)], {
        store,
        config,
        out: c.outFn,
        errOut: c.errFn,
      }),
      1,
    );
    assert.match(c.err.join("\n"), /over the x limit/);
    assert.equal(store.count(), 0);
  } finally {
    store.close();
  }
});

test("cli: schedule moves a post; unknown id and bad date fail", async () => {
  const { store, config } = setup();
  try {
    const post = store.add({ provider: "x", text: "t", scheduledAt: PAST });
    const c = capture();
    assert.equal(
      await runCli(["schedule", post.id, "--at", FUTURE], {
        store,
        config,
        out: c.outFn,
        errOut: c.errFn,
      }),
      0,
    );
    assert.equal(store.get(post.id)?.scheduledAt, new Date(FUTURE).toISOString());
    assert.equal(
      await runCli(["schedule", "missing-id", "--at", FUTURE], {
        store,
        config,
        out: c.outFn,
        errOut: c.errFn,
      }),
      1,
    );
    assert.equal(
      await runCli(["schedule", post.id, "--at", "not-a-date"], {
        store,
        config,
        out: c.outFn,
        errOut: c.errFn,
      }),
      1,
    );
  } finally {
    store.close();
  }
});

test("cli: cancel + retry flow", async () => {
  const { store, config } = setup();
  try {
    const post = store.add({ provider: "x", text: "t", scheduledAt: PAST });
    const c = capture();
    assert.equal(
      await runCli(["cancel", post.id], { store, config, out: c.outFn, errOut: c.errFn }),
      0,
    );
    assert.equal(store.get(post.id)?.status, "cancelled");
    assert.equal(
      await runCli(["retry", post.id], { store, config, out: c.outFn, errOut: c.errFn }),
      1,
    );
  } finally {
    store.close();
  }
});

test("cli: run-once publishes due mock posts to the outbox (exit 0)", async () => {
  const { store, config } = setup();
  try {
    const post = store.add({ provider: "mock", text: "ship it", scheduledAt: PAST });
    store.add({ provider: "mock", text: "not yet", scheduledAt: FUTURE });
    const c = capture();
    const code = await runCli(["run-once"], {
      store,
      config,
      out: c.outFn,
      errOut: c.errFn,
    });
    assert.equal(code, 0);
    assert.equal(store.get(post.id)?.status, "published");
    assert.match(c.out.join("\n"), /processed=1 published=1 failed=0/);
    assert.equal(readOutbox(config.outboxPath).length, 1);
    assert.equal(readOutbox(config.outboxPath)[0]?.text, "ship it");
  } finally {
    store.close();
  }
});

test("cli: run-once --provider mock overrides a real provider (demo mode)", async () => {
  const { store, config } = setup();
  try {
    const post = store.add({ provider: "x", text: "demo override", scheduledAt: PAST });
    const c = capture();
    const code = await runCli(["run-once", "--provider", "mock"], {
      store,
      config,
      out: c.outFn,
      errOut: c.errFn,
    });
    assert.equal(code, 0);
    assert.equal(store.get(post.id)?.status, "published");
    assert.equal(readOutbox(config.outboxPath)[0]?.text, "demo override");
  } finally {
    store.close();
  }
});

test("cli: run-once without credentials fails the post and exits 2", async () => {
  const { store, config } = setup();
  try {
    const post = store.add({ provider: "x", text: "no creds", scheduledAt: PAST });
    const c = capture();
    const code = await runCli(["run-once"], {
      store,
      config,
      out: c.outFn,
      errOut: c.errFn,
    });
    assert.equal(code, 2);
    assert.equal(store.get(post.id)?.status, "failed");
    assert.match(c.err.join("\n"), /X_BEARER_TOKEN is not set/);
    assert.match(c.out.join("\n"), /failed=1/);
  } finally {
    store.close();
  }
});

test("cli: metrics import + report show imported numbers", async () => {
  const { dir, store, config } = setup();
  try {
    const post = store.add({ provider: "x", text: "measured", scheduledAt: PAST });
    const file = join(dir, "metrics.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          postId: post.id,
          provider: "x",
          likes: 20,
          comments: 4,
          shares: 6,
          views: 200,
          collectedAt: "2026-11-12T05:00:00.000Z",
        },
      ]),
    );
    const c = capture();
    assert.equal(
      await runCli(["metrics", "import", "--file", file], {
        store,
        config,
        out: c.outFn,
        errOut: c.errFn,
      }),
      0,
    );
    assert.match(c.out.join("\n"), /imported 1 metrics snapshot/);

    const c2 = capture();
    assert.equal(
      await runCli(["report"], { store, config, out: c2.outFn, errOut: c2.errFn }),
      0,
    );
    const text = c2.out.join("\n");
    assert.match(text, /Engagement: 30 total/);
    assert.match(text, /Views: 200/);

    const c3 = capture();
    await runCli(["report", "--json"], { store, config, out: c3.outFn, errOut: c3.errFn });
    const parsed = JSON.parse(c3.out.join("\n")) as { totalEngagement: number };
    assert.equal(parsed.totalEngagement, 30);
  } finally {
    store.close();
  }
});

test("cli: providers lists all five; unknown command and --help behave", async () => {
  const { store, config } = setup();
  try {
    const c = capture();
    assert.equal(
      await runCli(["providers"], { store, config, out: c.outFn, errOut: c.errFn }),
      0,
    );
    assert.deepEqual(c.out, ["x", "linkedin", "instagram", "tiktok", "mock"]);
    assert.equal(
      await runCli(["bogus"], { store, config, out: c.outFn, errOut: c.errFn }),
      1,
    );
    const c2 = capture();
    assert.equal(
      await runCli(["--help"], { store, config, out: c2.outFn, errOut: c2.errFn }),
      0,
    );
    assert.match(c2.out.join("\n"), /social-automation 0\.1\.0/);
  } finally {
    store.close();
  }
});

test("cli: entry point executes as a subprocess (add + run-once end to end)", async () => {
  // Regression test: the CLI file must actually run when executed directly,
  // not just export runCli. Exercises the real binary path end to end.
  const execFileAsync = promisify(execFile);
  const dir = tempDir();
  const env = {
    ...process.env,
    SOCIAL_AUTOMATION_DIR: join(dir, "data"),
  };
  // Works both from source (test/ -> src/cli.ts) and from the built output
  // (dist/test/ -> dist/src/cli.js).
  const testDir = dirname(fileURLToPath(import.meta.url));
  const sourceCli = join(testDir, "..", "src", "cli.ts");
  const builtCli = join(testDir, "..", "src", "cli.js");
  const cli = existsSync(sourceCli) ? sourceCli : builtCli;
  const help = await execFileAsync(process.execPath, [cli, "--help"], { env });
  assert.match(help.stdout, /social-automation 0\.1\.0/);

  const added = await execFileAsync(
    process.execPath,
    [cli, "add", "--provider", "mock", "--text", "subprocess smoke"],
    { env },
  );
  assert.match(added.stdout, /^queued \S+ \[mock\] due=/);

  const ran = await execFileAsync(process.execPath, [cli, "run-once"], { env });
  assert.match(ran.stdout, /processed=1 published=1 failed=0/);
  assert.equal(readOutbox(join(dir, "data", "outbox.jsonl")).length, 1);

  const reported = await execFileAsync(process.execPath, [cli, "report"], { env });
  assert.match(reported.stdout, /Posts: 1/);
});
