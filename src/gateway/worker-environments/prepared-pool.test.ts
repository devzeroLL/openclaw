import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { CloudWorkerProfileConfig } from "../../config/types.cloud-workers.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { hashWorkerCredential } from "./credential.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import { createPreparedWorkerPool } from "./prepared-pool.js";
import { createWorkerEnvironmentService, type WorkerEnvironmentService } from "./service.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentRecord } from "./store.js";

const PROJECT_KEY = "a".repeat(64);
const PREPARATION_KEY = "b".repeat(64);
const BUNDLE_HASH = "c".repeat(64);
const IDLE_TIMEOUT_MS = 1_000;
const RECEIPT = { bundleHash: BUNDLE_HASH, openclawVersion: "2026.8.1", protocolFeatures: [] };
type PoolOptions = Parameters<typeof createPreparedWorkerPool>[0];

describe("prepared worker reserve lifecycle", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: ReturnType<typeof createWorkerEnvironmentStore>;
  let config: OpenClawConfig;
  let developmentProfile: CloudWorkerProfileConfig;
  let nowMs: number;
  let abort: AbortController;
  let provider: WorkerProvider;
  let service: WorkerEnvironmentService | undefined;
  let releases: Array<() => void>;
  let operations: Set<Promise<void>>;
  const openStore = () => {
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerEnvironmentStore({ database, now: () => nowMs });
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-prepared-pool-"));
    nowMs = 1_000;
    abort = new AbortController();
    releases = [];
    operations = new Set();
    service = undefined;
    developmentProfile = { provider: "test-provider", settings: {} };
    config = {
      cloudWorkers: { profiles: { development: developmentProfile } },
    };
    provider = {
      id: "test-provider",
      resolvePreparedIdleTimeoutMs: () => IDLE_TIMEOUT_MS,
      resolveAllocation: vi.fn(async () => ({ leaseId: "resolved-lease", sharedHost: false })),
      provision: vi.fn(async () => ({ leaseId: "new-lease", node: { deviceId: "new-node" } })),
      inspect: vi.fn(async () => ({ status: "active" as const })),
      destroy: vi.fn(async () => {}),
      notePreparedDemand: vi.fn(async () => {}),
    };
    openStore();
  });

  afterEach(async () => {
    abort.abort();
    for (const release of releases) {
      release();
    }
    await Promise.allSettled(operations);
    await service?.stop();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function profile(projectKey = PROJECT_KEY, preparationKey = PREPARATION_KEY): WorkerProfile {
    return {
      settings: {},
      executionMode: "worker-turn",
      project: {
        key: projectKey,
        root: path.join(root, projectKey),
        baseCommit: "d".repeat(40),
        preparation: {
          key: preparationKey,
          contractVersion: 1,
          target: { machineClass: "standard", platform: "linux", arch: "x64" },
          artifacts: {
            nodeBootstrapSha256: "e".repeat(64),
            enabledPluginIds: [],
            workerBundleHash: BUNDLE_HASH,
            workerArchiveSha256: "f".repeat(64),
            openclawVersion: "2026.8.1",
            protocolFeatures: [],
          },
        },
      },
    };
  }

  function seed(
    environmentId: string,
    options: { projectKey?: string; preparationKey?: string; reserve?: boolean } = {},
  ) {
    return store.createIntent({
      environmentId,
      providerId: provider.id,
      profileId: "development",
      provisionOperationId: `provision:${environmentId}`,
      profileSnapshot: profile(options.projectKey, options.preparationKey),
      ...(options.reserve
        ? {
            preparation: {
              key: options.preparationKey ?? PREPARATION_KEY,
              demandAtMs: nowMs,
              expiresAtMs: nowMs + IDLE_TIMEOUT_MS,
            },
          }
        : {}),
    });
  }

  function ready(record: WorkerEnvironmentRecord) {
    store.transition({
      environmentId: record.environmentId,
      from: "requested",
      to: "provisioning",
    });
    return store.transition({
      environmentId: record.environmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: `lease:${record.environmentId}`,
        nodeDeviceId: `node:${record.environmentId}`,
        sharedHost: false,
        bootstrapReceipt: RECEIPT,
        credential: {
          credentialHash: hashWorkerCredential(record.environmentId),
          sessionId: null,
          rpcSetVersion: 1,
          expiresAtMs: nowMs + 10_000,
        },
      },
    });
  }

  function attach(record: WorkerEnvironmentRecord) {
    const sessionId = `session:${record.environmentId}`;
    const identity = {
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      agentId: "main",
      executionMode: "worker-turn" as const,
    };
    let placementBinding;
    if (record.preparation) {
      const placements = createWorkerSessionPlacementStore({ database, now: () => nowMs });
      const requested = placements.startDispatch(identity);
      const assigned = placements.bindPreparedEnvironment({
        ...identity,
        expectedGeneration: requested.generation,
        environmentId: record.environmentId,
        ownerEpoch: record.ownerEpoch,
        providerId: record.providerId,
        profileId: record.profileId,
        preparationKey: record.preparation.key,
        nodeDeviceId: record.nodeDeviceId!,
        leaseId: record.leaseId!,
        bundleHash: BUNDLE_HASH,
        assertCurrent: () => {},
      })!;
      const syncing = placements.transition({
        sessionId,
        from: "provisioning",
        to: "syncing",
        expectedGeneration: assigned.generation,
        patch: { workerBundleHash: BUNDLE_HASH },
      });
      placementBinding = {
        ...identity,
        generation: syncing.generation,
        preparationKey: record.preparation.key,
        assertCurrent: () => {},
      };
    }
    return store.transition({
      environmentId: record.environmentId,
      from: "ready",
      to: "attached",
      placementBinding,
      patch: {
        attachedSessionIds: [sessionId],
        credential: {
          credentialHash: hashWorkerCredential(sessionId),
          sessionId,
          rpcSetVersion: 1,
          expiresAtMs: nowMs + 10_000,
        },
      },
    });
  }

  function pool(overrides: Partial<PoolOptions> = {}) {
    return createPreparedWorkerPool({
      store,
      getConfig: () => config,
      resolveProvider: () => provider,
      prepareIntent: async (_profileId, { projectPath }) => ({
        providerId: provider.id,
        profileSnapshot: profile(path.basename(projectPath)),
        preparationKey: PREPARATION_KEY,
      }),
      assertIntentCurrent: () => {},
      reconcile: async () => {},
      signal: abort.signal,
      now: () => nowMs,
      warn: vi.fn(),
      ...overrides,
    });
  }

  function schedule(owner: ReturnType<typeof pool>) {
    const operation = owner.schedule();
    operations.add(operation);
    const release = () => operations.delete(operation);
    void operation.then(release, release);
    return operation;
  }

  const reserves = () => store.list().filter((record) => record.preparation !== null);

  it("keeps expiry tied to originating demand across repeated maintenance and database reopen", async () => {
    attach(ready(seed("source")));
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    const owner = pool({ reconcile });
    await schedule(owner);
    const reserve = reserves()[0]!;
    expect(reserve.preparation).toMatchObject({ demandAtMs: 1_000, expiresAtMs: 2_000 });
    nowMs = 1_900;
    await schedule(owner);
    expect(reserves()).toEqual([reserve]);
    expect(provider.notePreparedDemand).not.toHaveBeenCalled();

    closeOpenClawStateDatabaseForTest();
    openStore();
    nowMs = 2_000;
    await schedule(pool({ reconcile }));
    expect(reserves()).toHaveLength(1);
    expect(store.get(reserve.environmentId)).toMatchObject({
      destroyRequestedAtMs: 2_000,
      preparation: reserve.preparation,
    });
    expect(reconcile.mock.lastCall?.[0]).toMatchObject({ destroyRequestedAtMs: 2_000 });
    nowMs = 2_100;
    await schedule(pool());
    expect(reserves()).toHaveLength(1);
  });

  it("records actual attachment demand and gives its replacement a new fixed deadline", async () => {
    const source = attach(ready(seed("source")));
    const owner = pool();
    await schedule(owner);
    const reserve = ready(reserves()[0]!);
    await owner.noteDemand(reserve.environmentId);
    expect(provider.notePreparedDemand).not.toHaveBeenCalled();
    nowMs = 1_500;
    await owner.noteDemand(source.environmentId);
    expect(provider.notePreparedDemand).toHaveBeenLastCalledWith(
      { leaseId: source.leaseId, profile: {} },
      { preparationKey: PREPARATION_KEY, demandAtMs: 1_000 },
    );
    const consumed = attach(reserve);
    await owner.noteDemand(consumed.environmentId);
    expect(provider.notePreparedDemand).toHaveBeenLastCalledWith(
      { leaseId: consumed.leaseId, profile: {} },
      { preparationKey: PREPARATION_KEY, demandAtMs: 1_500 },
    );
    await schedule(owner);
    expect(
      reserves().find((record) => record.preparation?.consumedAtMs === null)?.preparation,
    ).toMatchObject({ demandAtMs: 1_500, expiresAtMs: 2_500 });
    expect(store.get(consumed.environmentId)?.preparation).toMatchObject({
      consumedAtMs: 1_500,
      expiresAtMs: 2_000,
    });
  });

  it("starts a full idle window after a long first checkout without extending it on detach", async () => {
    const idleWindow = 15 * 60_000;
    provider.resolvePreparedIdleTimeoutMs = () => idleWindow;
    const allocated = ready(seed("slow-first-checkout"));
    nowMs += 16 * 60_000;
    const attached = attach(allocated);
    const owner = pool();
    await owner.noteDemand(attached.environmentId);
    await schedule(owner);
    const reserve = reserves()[0]!;
    expect(reserve.preparation).toMatchObject({
      demandAtMs: attached.stateChangedAtMs,
      expiresAtMs: attached.stateChangedAtMs + idleWindow,
    });
    expect(provider.notePreparedDemand).toHaveBeenCalledWith(
      { leaseId: attached.leaseId, profile: {} },
      { preparationKey: PREPARATION_KEY, demandAtMs: attached.stateChangedAtMs },
    );
    expect(attached.stateChangedAtMs - attached.createdAtMs).toBeGreaterThan(idleWindow);

    nowMs += 60_000;
    store.transition({ environmentId: attached.environmentId, from: "attached", to: "idle" });
    await owner.noteDemand(attached.environmentId);
    await schedule(owner);
    expect(provider.notePreparedDemand).toHaveBeenCalledOnce();
    expect(store.get(reserve.environmentId)?.preparation).toEqual(reserve.preparation);
    nowMs = attached.stateChangedAtMs + idleWindow;
    await schedule(owner);
    expect(reserves()).toHaveLength(1);
    expect(store.get(reserve.environmentId)?.destroyRequestedAtMs).toBe(nowMs);
  });

  it("does not allocate when source preparation finishes after its demand deadline", async () => {
    attach(ready(seed("source")));
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    await schedule(
      pool({
        prepareIntent: async () => {
          nowMs = 2_000;
          return {
            providerId: provider.id,
            profileSnapshot: profile(),
            preparationKey: PREPARATION_KEY,
          };
        },
        reconcile,
      }),
    );
    expect(reserves()).toEqual([]);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("counts pending and uncertain cleanup against the shared cap after restart", async () => {
    developmentProfile.readyWorkers = 2;
    config.cloudWorkers!.preparedPool = { maxTotal: 3 };
    attach(ready(seed("source-a")));
    attach(ready(seed("source-b", { projectKey: "1".repeat(64) })));
    await schedule(pool());
    const reserved = reserves();
    expect(reserved).toHaveLength(3);
    const uncertain = reserved[0]!;
    store.transition({
      environmentId: uncertain.environmentId,
      from: "requested",
      to: "provisioning",
    });
    store.adoptProvisionCleanupFailure({
      environmentId: uncertain.environmentId,
      leaseId: "uncertain-lease",
      lastError: "provider cleanup response lost",
    });
    closeOpenClawStateDatabaseForTest();
    openStore();
    const warn = vi.fn();
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async (record) => {
      if (record.environmentId === uncertain.environmentId) {
        throw new Error("provider cleanup remains unavailable");
      }
    });
    await schedule(pool({ reconcile, warn }));
    expect(
      reserves()
        .map((record) => record.environmentId)
        .toSorted(),
    ).toEqual(reserved.map((record) => record.environmentId).toSorted());
    expect(reconcile.mock.calls.map(([record]) => record.environmentId).toSorted()).toEqual(
      reserved.map((record) => record.environmentId).toSorted(),
    );
    expect(store.get(uncertain.environmentId)).toMatchObject({
      state: "destroying",
      leaseId: "uncertain-lease",
      provisionOperationId: uncertain.provisionOperationId,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("retryable"));
  });

  it.each(["profile", "gateway"] as const)(
    "retires excess then disabled %s capacity without touching an attached session",
    async (scope) => {
      developmentProfile.readyWorkers = 3;
      const source = attach(ready(seed("source")));
      await schedule(pool());
      expect(reserves()).toHaveLength(3);
      if (scope === "profile") {
        developmentProfile.readyWorkers = 1;
      } else {
        config.cloudWorkers!.preparedPool = { maxTotal: 1 };
      }
      nowMs = 1_100;
      await schedule(pool());
      expect(reserves().filter((record) => record.destroyRequestedAtMs === null)).toHaveLength(1);
      expect(reserves().filter((record) => record.destroyRequestedAtMs === 1_100)).toHaveLength(2);
      if (scope === "profile") {
        developmentProfile.readyWorkers = 0;
      } else {
        config.cloudWorkers!.preparedPool = { maxTotal: 0 };
      }
      nowMs = 1_200;
      await schedule(pool());
      expect(reserves()).toHaveLength(3);
      expect(reserves().every((record) => record.destroyRequestedAtMs !== null)).toBe(true);
      expect(store.get(source.environmentId)).toEqual(source);
    },
  );

  it("retires the previous fingerprint before admitting a new generation in the same project slot", async () => {
    attach(ready(seed("source-old")));
    await schedule(pool());
    const old = reserves()[0]!;
    const nextKey = "2".repeat(64);
    nowMs = 1_100;
    attach(ready(seed("source-new", { preparationKey: nextKey })));
    const owner = pool({
      prepareIntent: async () => ({
        providerId: provider.id,
        profileSnapshot: profile(PROJECT_KEY, nextKey),
        preparationKey: nextKey,
      }),
    });
    await schedule(owner);
    expect(reserves()).toHaveLength(1);
    expect(store.get(old.environmentId)?.destroyRequestedAtMs).toBe(1_100);
    // This intent never allocated; the ordinary lifecycle can terminalize it safely.
    store.transition({ environmentId: old.environmentId, from: "requested", to: "failed" });
    await schedule(owner);
    expect(reserves().filter((record) => record.state === "requested")).toEqual([
      expect.objectContaining({
        preparation: {
          key: nextKey,
          demandAtMs: 1_100,
          expiresAtMs: 2_100,
          consumedAtMs: null,
        },
      }),
    ]);
  });

  it("revalidates an earlier source when another awaited preparation changes admission authority", async () => {
    attach(ready(seed("source-a")));
    attach(ready(seed("source-b", { projectKey: "1".repeat(64) })));
    let generation = 0;
    let admittedAtHasFirst = false;
    const admittedAt = new WeakMap<WorkerProviderPreparedIntent, number>();
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    const owner = pool({
      prepareIntent: async (_profileId, { projectPath }) => {
        if (admittedAtHasFirst) {
          generation += 1;
        }
        admittedAtHasFirst = true;
        const intent = {
          providerId: provider.id,
          profileSnapshot: profile(path.basename(projectPath)),
          preparationKey: PREPARATION_KEY,
        };
        admittedAt.set(intent, generation);
        return intent;
      },
      assertIntentCurrent: (_profileId, intent) => {
        if (admittedAt.get(intent) !== generation) {
          throw new Error("preparation authority changed");
        }
      },
      reconcile,
    });
    await expect(schedule(owner)).rejects.toThrow("preparation authority changed");
    expect(reserves()).toEqual([]);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("runs only two preparations concurrently and drains admitted work after shutdown", async () => {
    developmentProfile.readyWorkers = 3;
    attach(ready(seed("source")));
    const entered = createDeferred();
    const release = createDeferred();
    releases.push(() => release.resolve());
    const reconcile = vi.fn(async (_record: WorkerEnvironmentRecord, signal: AbortSignal) => {
      if (reconcile.mock.calls.length === 2) {
        entered.resolve();
      }
      await release.promise;
      expect(signal.aborted).toBe(true);
    });
    const owner = pool({ reconcile });
    let settled = false;
    const running = schedule(owner).then(() => {
      settled = true;
    });
    await entered.promise;
    expect(reserves()).toHaveLength(3);
    expect(reconcile).toHaveBeenCalledTimes(2);
    abort.abort();
    await owner.schedule();
    expect(settled).toBe(false);
    release.resolve();
    await running;
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reserves().every((record) => record.state === "requested")).toBe(true);
  });

  it("retires queued capacity when disabled before its reconciliation lock is acquired", async () => {
    const reserve = seed("queued-reserve", { reserve: true });
    const entered = createDeferred();
    const release = createDeferred();
    releases.push(() => release.resolve());
    const provision = vi.fn();
    const cleanup = vi.fn();
    const owner = pool({
      reconcile: async (record, _signal, beforeReconcile) => {
        entered.resolve();
        await release.promise;
        // The runtime repeats this callback after acquiring its environment lock.
        beforeReconcile();
        const current = store.get(record.environmentId)!;
        if (current.destroyRequestedAtMs === null) {
          provision(current);
        } else {
          cleanup(current);
        }
      },
    });
    const running = schedule(owner);
    await entered.promise;
    expect(store.get(reserve.environmentId)?.destroyRequestedAtMs).toBeNull();
    developmentProfile.readyWorkers = 0;
    release.resolve();
    await running;
    expect(provision).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: reserve.environmentId,
        destroyRequestedAtMs: nowMs,
      }),
    );
    expect(reserves()).toHaveLength(1);
  });

  it("keeps actual service reserve cleanup outside the installed placement fence while stop drains it", async () => {
    const reserve = ready(seed("expired", { reserve: true }));
    nowMs = 2_000;
    const entered = createDeferred();
    const release = createDeferred();
    releases.push(() => release.resolve());
    provider.destroy = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    service = createWorkerEnvironmentService({
      store,
      getConfig: () => config,
      resolveProvider: () => provider,
      prepareInstallation: async () => ({
        install: "bundle",
        ...RECEIPT,
        tarballBytes: 1,
        tarballSha256: "e".repeat(64),
        tarballPath: path.join(root, "unused.tgz"),
      }),
      bootstrapWorker: async () => RECEIPT,
      executeInference: async () => ({ type: "error", reason: "cancelled", message: "unused" }),
      now: () => nowMs,
    });
    const guard = vi.fn<
      Parameters<WorkerEnvironmentService["installReconcileEnvironmentGuard"]>[0]
    >(async (_environmentId, reconcile) => {
      await reconcile();
    });
    service.installReconcileEnvironmentGuard(guard);
    await service.reconcileOnce();
    await entered.promise;
    expect(guard).not.toHaveBeenCalled();
    expect(provider.provision).not.toHaveBeenCalled();
    expect(provider.inspect).not.toHaveBeenCalled();
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await service.reconcileOnce();
    expect(stopped).toBe(false);
    release.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect(store.get(reserve.environmentId)?.state).toBe("destroyed");
    expect(provider.destroy).toHaveBeenCalledOnce();
  });
});
