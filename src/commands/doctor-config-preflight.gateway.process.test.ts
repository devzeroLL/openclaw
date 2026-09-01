// Real Gateway cron upgrade proof; the test invocation owns the runtime build.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BUILD_STAMP_FILE,
  resolveGitHead,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata.mts";
import { testing as openclawTestInstanceTesting } from "../../test/helpers/openclaw-test-instance.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadCronJobsStoreWithConfigJobsReadOnly, loadCronQuarantinedJobs } from "../cron/store.js";
import { getFreePort } from "../test-utils/ports.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe("Gateway cron startup migration", () => {
  it("quarantines every invalid legacy automation before Gateway readiness", async () => {
    const root = await fs.promises.realpath(tempDirs.make("openclaw-cron-upgrade-ready-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const storePath = path.join(stateDir, "cron", "jobs.json");
    const port = await getFreePort();
    const runtimeRoot = process.cwd();
    const head = resolveGitHead({ cwd: runtimeRoot });
    expect(head).toMatch(/^[0-9a-f]{40}$/u);
    // The invocation prepares current runtime artifacts before admitting workers.
    // Refuse stale output here; this proof must never build or fall back to source.
    for (const [file, field] of [
      [BUILD_STAMP_FILE, "head"],
      [RUNTIME_POSTBUILD_STAMP_FILE, "head"],
      ["build-info.json", "commit"],
    ] as const) {
      const metadata = JSON.parse(
        await fs.promises.readFile(path.join(runtimeRoot, "dist", file), "utf8"),
      ) as Record<string, unknown>;
      expect(metadata[field], file).toBe(head);
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
      NO_COLOR: "1",
    };
    delete env.NODE_ENV;
    delete env.OPENCLAW_HOME;
    delete env.VITEST;

    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { mode: "local", auth: { mode: "none" } } }),
    );
    const job = {
      name: "Legacy automation",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    };
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        jobs: [
          { ...job, id: "valid-job" },
          { ...job, id: "invalid-state-job", state: { nextRunAtMs: -1 } },
          { ...job, id: "invalid-trigger-job", trigger: { script: [] } },
        ],
      }),
    );
    const stdout = openclawTestInstanceTesting.createBoundedStringLog();
    const stderr = openclawTestInstanceTesting.createBoundedStringLog();
    const gateway = spawn(
      process.execPath,
      [
        path.join(runtimeRoot, "dist", "index.js"),
        "gateway",
        "run",
        "--allow-unconfigured",
        "--port",
        String(port),
      ],
      { cwd: runtimeRoot, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    gateway.stdout.setEncoding("utf8");
    gateway.stderr.setEncoding("utf8");
    gateway.stdout.on("data", (chunk) => openclawTestInstanceTesting.appendLogChunk(stdout, chunk));
    gateway.stderr.on("data", (chunk) => openclawTestInstanceTesting.appendLogChunk(stderr, chunk));

    try {
      await openclawTestInstanceTesting.waitForGatewayReady(gateway, stdout, stderr, port, 30_000);
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      await expect(response.json()).resolves.toMatchObject({ ready: true, failing: [] });
    } finally {
      expect(
        await openclawTestInstanceTesting.stopGatewayProcess(gateway, Date.now() + 5_000, 1_500, {
          forceWindowsTree: true,
        }),
      ).toBe(true);
    }

    const loaded = await loadCronJobsStoreWithConfigJobsReadOnly(storePath, env);
    expect(loaded.store.jobs.map((entry) => entry.id)).toContain("valid-job");
    expect(
      loadCronQuarantinedJobs(storePath, env).map((entry) => ({
        sourceIndex: entry.sourceIndex,
        reason: entry.reason,
        id: entry.job?.id,
      })),
    ).toEqual([
      { sourceIndex: 1, reason: "invalid-state", id: "invalid-state-job" },
      { sourceIndex: 2, reason: "invalid-trigger", id: "invalid-trigger-job" },
    ]);
    expect(fs.existsSync(storePath)).toBe(false);
    expect(fs.existsSync(`${storePath}.migrated`)).toBe(true);
  }, 45_000);
});
