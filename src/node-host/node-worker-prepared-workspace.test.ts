import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
} from "../gateway/worker-environments/workspace-manifest.js";
import { runExec } from "../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { NodeWorkerPreparedWorkspaceBinding } from "../worker/node-workspace-prepared-protocol.js";
import { NodeWorkerPreparedWorkspaceStore } from "./node-worker-prepared-workspace-store.js";
import { waitForNodeWorkerTerminal } from "./node-worker-supervisor.fixture.test-support.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_ENDPOINT,
  TEST_WORKER_SOURCE,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";
import { listen } from "./node-worker-transfer-client.test-support.js";
import { captureManifest } from "./node-worker-workspace-commands.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
const preparationKey = "a".repeat(64);
const binding: NodeWorkerPreparedWorkspaceBinding = {
  action: "bind",
  gatewayNamespace: "gateway-prepared",
  environmentId: "environment-prepared",
  preparationKey,
  sessionId: "session-prepared",
  sessionKey: "agent:main:prepared",
  ownerEpoch: 2,
};

async function fixture() {
  const root = fs.realpathSync.native(tempDirs.make("node-prepared-workspace-"));
  const ownerRoot = path.join(
    root,
    ".openclaw-worker",
    "prepared",
    binding.gatewayNamespace,
    preparationKey,
  );
  const workspaceDir = path.join(ownerRoot, "workspace");
  const homeDir = path.join(ownerRoot, "home");
  await Promise.all([
    fsp.mkdir(workspaceDir, { recursive: true }),
    fsp.mkdir(homeDir, { recursive: true }),
  ]);
  const git = async (...args: string[]) =>
    (await runExec("git", ["-C", workspaceDir, ...args], { timeoutMs: 10_000 })).stdout.trim();
  await git("init", "--quiet");
  await fsp.writeFile(path.join(workspaceDir, ".gitignore"), ".venv/\n");
  await fsp.writeFile(path.join(workspaceDir, "source.txt"), "prepared source\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Prepared Test",
    "-c",
    "user.email=prepared@example.test",
    "commit",
    "--quiet",
    "-m",
    "prepared source",
  );
  const baseCommit = await git("rev-parse", "HEAD");
  await fsp.mkdir(path.join(workspaceDir, ".venv"));
  await fsp.writeFile(
    path.join(workspaceDir, ".venv", "absolute-path"),
    `${workspaceDir}\n${homeDir}`,
  );
  const sourceManifestRef = await captureManifest({
    workspaceDir,
    manifestHome: homeDir,
    baseCommit,
    referenceManifestRef: `sha256:${"0".repeat(64)}`,
  });
  const env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const options = { env, ephemeral: true };
  const runtime = new NodeWorkerWorkspaceRuntime(options);
  const registration = {
    action: "register" as const,
    gatewayNamespace: binding.gatewayNamespace,
    environmentId: binding.environmentId,
    preparationKey,
    workspaceDir,
    homeDir,
    sourceManifestRef,
  };
  const request = {
    workspaceDir,
    environmentId: binding.environmentId,
    sessionId: binding.sessionId,
    sessionKey: binding.sessionKey,
    ownerEpoch: binding.ownerEpoch,
  };
  const command = {
    gatewayNamespace: binding.gatewayNamespace,
    environmentId: binding.environmentId,
    sessionId: binding.sessionId,
    sessionKey: binding.sessionKey,
    preparationKey,
    generation: binding.ownerEpoch,
    argv: ["node", "-e", "process.stdout.write(process.cwd() + '\\n' + process.env.HOME)"],
  };
  return {
    root,
    ownerRoot,
    workspaceDir,
    homeDir,
    env,
    options,
    runtime,
    registration,
    request,
    command,
    baseCommit,
  };
}

describe("prepared node workspace ownership", () => {
  it("requires the bound host session key before launching a worker with prepared HOME", async () => {
    const f = await fixture();
    await f.runtime.prepare(f.registration);
    await f.runtime.prepare(binding);
    const input = testWorkerLaunchInput(f.workspaceDir, "prepared-turn", "env");
    input.gatewayNamespace = binding.gatewayNamespace;
    input.descriptor.admission.environmentId = binding.environmentId;
    input.descriptor.admission.sessionId = binding.sessionId;
    input.descriptor.admission.ownerEpoch = binding.ownerEpoch;
    const bundleRoot = path.join(f.root, "bundles");
    const bundleDir = path.join(
      bundleRoot,
      binding.gatewayNamespace,
      "bundles",
      input.expectedBundleHash,
    );
    await fsp.mkdir(bundleDir, { recursive: true });
    await fsp.writeFile(path.join(bundleDir, "worker.mjs"), TEST_WORKER_SOURCE);
    const supervisor = createNodeWorkerSupervisor({
      bundleRoot,
      env: f.env,
      workspace: f.runtime,
    });
    try {
      await expect(supervisor.launch(input, TEST_WORKER_ENDPOINT)).rejects.toThrow("bound session");
      await expect(
        supervisor.launch({ ...input, sessionKey: "agent:test:other" }, TEST_WORKER_ENDPOINT),
      ).rejects.toThrow("does not own");
      await expect(
        fsp.stat(path.join(f.workspaceDir, "prepared-turn.started.json")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await supervisor.launch({ ...input, sessionKey: binding.sessionKey }, TEST_WORKER_ENDPOINT);
      expect((await waitForNodeWorkerTerminal(supervisor, input.launchId)).state).toBe("completed");
      const childEnv = JSON.parse(
        await fsp.readFile(path.join(f.workspaceDir, "prepared-turn.env.json"), "utf8"),
      );
      expect(childEnv.HOME).toBe(f.homeDir);
    } finally {
      await supervisor.close();
    }
  });

  it("rejects a prepared command without its registration instead of creating a generation workspace", async () => {
    const f = await fixture();
    await expect(f.runtime.exec(f.command)).rejects.toThrow("registration is missing or changed");
    await expect(
      fsp.stat(path.join(f.root, "state", "node-host", binding.gatewayNamespace)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await f.runtime.prepare(f.registration);
    await f.runtime.prepare(binding);
    await expect(f.runtime.exec({ ...f.command, preparationKey: "b".repeat(64) })).rejects.toThrow(
      "registration is missing or changed",
    );
  });

  it("keeps fixed paths and HOME through exact bind replay and restart, rejecting other owners", async () => {
    const f = await fixture();
    const registered = await f.runtime.prepare(f.registration);
    await expect(f.runtime.prepare(f.registration)).resolves.toEqual(registered);
    expect(() => f.runtime.acquireManagedWorkspace(f.request)).toThrow("does not own");
    const bound = await f.runtime.prepare(binding);
    await expect(f.runtime.prepare(binding)).resolves.toEqual(bound);
    const restarted = new NodeWorkerWorkspaceRuntime(f.options);
    const result = await restarted.exec(f.command);
    expect(result).toMatchObject({
      workspaceDir: f.workspaceDir,
      code: 0,
      stdout: `${f.workspaceDir}\n${f.homeDir}`,
    });
    const acquired = restarted.acquireManagedWorkspace(f.request);
    expect(acquired.homeDir).toBe(f.homeDir);
    acquired.release();
    for (const changed of [
      { sessionId: "other-session" },
      { sessionKey: "other-key" },
      { ownerEpoch: 3 },
      { environmentId: "other-environment" },
      { workspaceDir: f.homeDir },
    ]) {
      expect(() => restarted.acquireManagedWorkspace({ ...f.request, ...changed })).toThrow(
        "INVALID_REQUEST:",
      );
    }
    await expect(restarted.prepare({ ...binding, sessionId: "second-session" })).rejects.toThrow(
      "consumed",
    );
    await expect(restarted.prepare(f.registration)).rejects.toThrow("already owns");
    await expect(restarted.exec({ ...f.command, resetWorkspace: true })).rejects.toThrow(
      "cannot be reset",
    );
    await expect(restarted.exec({ ...f.command, sessionKey: undefined })).rejects.toThrow(
      "bound session",
    );
  });

  it("keeps shared nodes unregistered and rejects alias paths before registration", async () => {
    const f = await fixture();
    const shared = new NodeWorkerWorkspaceRuntime({ env: f.env });
    await expect(shared.prepare(f.registration)).rejects.toThrow("dedicated ephemeral");
    const outside = path.join(f.root, "outside");
    await fsp.rename(f.workspaceDir, outside);
    await fsp.symlink(outside, f.workspaceDir, "dir");
    await expect(f.runtime.prepare(f.registration)).rejects.toThrow("escaped");
    expect(
      new NodeWorkerPreparedWorkspaceStore({ env: f.env }).find(binding.environmentId),
    ).toBeUndefined();
    expect(await fsp.readFile(path.join(outside, "source.txt"), "utf8")).toBe("prepared source\n");
  });

  it("retains active bindings and leaves a permanent tombstone after retirement", async () => {
    const f = await fixture();
    await f.runtime.prepare(f.registration);
    await f.runtime.prepare(binding);
    const retain = {
      version: 1 as const,
      gatewayNamespace: binding.gatewayNamespace,
      controllerId: "retention-owner",
      sequence: 1,
      retain: [],
    };
    const acquired = f.runtime.acquireManagedWorkspace(f.request);
    await expect(f.runtime.applyRetainSnapshot(retain, () => [])).resolves.toMatchObject({
      deleted: 0,
    });
    acquired.release();
    await expect(
      f.runtime.applyRetainSnapshot({ ...retain, sequence: 2 }, () => []),
    ).resolves.toMatchObject({ deleted: 1 });
    expect(
      new NodeWorkerPreparedWorkspaceStore({ env: f.env }).find(binding.environmentId),
    ).toMatchObject({
      state: "retired",
      session_id: binding.sessionId,
      session_key: binding.sessionKey,
      owner_epoch: binding.ownerEpoch,
    });
    await expect(fsp.stat(f.ownerRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const restarted = new NodeWorkerWorkspaceRuntime(f.options);
    expect(() => restarted.acquireManagedWorkspace(f.request)).toThrow("does not own");
    await expect(restarted.exec(f.command)).rejects.toThrow("does not own");
  });

  it("leaves an interrupted in-place mutation unusable after restart", async () => {
    const f = await fixture();
    await f.runtime.prepare(f.registration);
    await f.runtime.prepare(binding);
    const store = new NodeWorkerPreparedWorkspaceStore({ env: f.env });
    const row = store.find(binding.environmentId)!;
    const mutation = store.beginMutation(row);
    mutation.close();
    const restarted = new NodeWorkerWorkspaceRuntime(f.options);
    expect(() => restarted.acquireManagedWorkspace(f.request)).toThrow("does not own");
    await expect(restarted.prepare(binding)).rejects.toThrow("consumed");
    expect(() => mutation.complete()).toThrow("closed");
    expect(store.find(binding.environmentId)).toMatchObject({
      state: "retiring",
      session_id: binding.sessionId,
    });
  });

  it("downloads only an eligible overlay and preserves ignored prepared outputs at the same paths", async () => {
    const f = await fixture();
    await f.runtime.prepare(f.registration);
    await f.runtime.prepare(binding);
    const original: WorkerWorkspaceManifest = JSON.parse(
      await fsp.readFile(
        path.join(
          f.homeDir,
          ".openclaw-worker",
          "manifests",
          `${f.registration.sourceManifestRef.slice(7)}.json`,
        ),
        "utf8",
      ),
    );
    const body = Buffer.from("session overlay\n");
    const digest = createHash("sha256").update(body).digest("hex");
    const raw = serializeWorkerWorkspaceManifest({
      ...original,
      entries: original.entries.map((entry) =>
        entry.path === "source.txt"
          ? { path: entry.path, type: "file", mode: 0o644, size: body.length, sha256: digest }
          : entry,
      ),
    });
    const manifestRef = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      if (req.url?.endsWith("/manifest")) {
        res.writeHead(200).end(raw);
      } else if (req.url?.endsWith(`/blobs/${digest}`)) {
        res.writeHead(200).end(body);
      } else {
        res.writeHead(404).end();
      }
    });
    const url = await listen(server);
    try {
      const transferred = await f.runtime.exec(
        {
          ...f.command,
          argv: ["openclaw-internal-workspace-transfer"],
          transfer: { direction: "download", token: "test-transfer", manifestRef },
        },
        undefined,
        { url },
      );
      expect(transferred).toMatchObject({
        workspaceDir: f.workspaceDir,
        code: 0,
        stdout: `${manifestRef}\n`,
      });
      expect(await fsp.readFile(path.join(f.workspaceDir, "source.txt"), "utf8")).toBe(
        body.toString(),
      );
      expect(await fsp.readFile(path.join(f.workspaceDir, ".venv", "absolute-path"), "utf8")).toBe(
        `${f.workspaceDir}\n${f.homeDir}`,
      );
      expect(requests).toHaveLength(2);
      expect(
        new NodeWorkerPreparedWorkspaceStore({ env: f.env }).find(binding.environmentId),
      ).toMatchObject({ state: "bound", session_id: binding.sessionId });
      const acquired = f.runtime.acquirePreparedWorkspace(f.request);
      expect(acquired?.workspaceDir).toBe(f.workspaceDir);
      acquired?.release();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
