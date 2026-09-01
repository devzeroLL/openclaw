import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import type { WorkerPlacementExecutionMode } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import * as support from "./service.test-support.js";

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: () => ({
    gateway: { nodes: { commands: { allow: ["codex.exec-server.stdio.v1"] } } },
  }),
}));

const PREPARATION_KEY = "c".repeat(64);
const FEATURES = [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE];

function preparedHarness(
  options: {
    reserve?: boolean;
    executionMode?: WorkerPlacementExecutionMode;
    liveBindingFails?: boolean;
  } = {},
) {
  const executionMode = options.executionMode ?? "worker-turn";
  const reserve = options.reserve !== false;
  let nodeCurrent = true;
  const placements = createWorkerSessionPlacementStore({
    database: support.testState.stateDb,
    now: () => support.testState.nowMs,
  });
  const harness = createHarness(placements, { isCurrentNodePlacement: () => nodeCurrent });
  const environmentId = reserve ? "prepared-spare" : harness.ready.environmentId;
  const intent: WorkerProviderPreparedIntent = {
    providerId: "fake",
    preparationKey: PREPARATION_KEY,
    profileSnapshot: {
      settings: { region: "test" },
      executionMode,
      project: {
        key: "d".repeat(64),
        baseCommit: "e".repeat(40),
        root: "/gateway/workspace",
        preparation: {
          key: PREPARATION_KEY,
          contractVersion: 1,
          target: { machineClass: "standard", platform: "linux", arch: "x64" },
          artifacts: {
            nodeBootstrapSha256: "f".repeat(64),
            enabledPluginIds: [],
            workerBundleHash: support.BUNDLE_HASH,
            workerArchiveSha256: "b".repeat(64),
            openclawVersion: support.BOOTSTRAP_RECEIPT.openclawVersion,
            protocolFeatures: FEATURES,
          },
        },
      },
    },
  };
  const store = support.testState.store;
  store.createIntent({
    environmentId,
    profileId: REQUEST.profileId,
    providerId: intent.providerId,
    profileSnapshot: intent.profileSnapshot,
    provisionOperationId: `provision:${environmentId}`,
    ...(reserve
      ? { preparation: { key: PREPARATION_KEY, demandAtMs: 900, expiresAtMs: 10_000 } }
      : {}),
  });
  store.transition({ environmentId, from: "requested", to: "provisioning" });
  const ready = store.transition({
    environmentId,
    from: "provisioning",
    to: "ready",
    patch: {
      leaseId: `lease:${environmentId}`,
      nodeDeviceId: "prepared-node",
      sharedHost: false,
      ...support.readyPatch(environmentId, {
        ...support.BOOTSTRAP_RECEIPT,
        protocolFeatures: FEATURES,
      }),
    },
  });
  vi.mocked(support.testState.prepareInstallation).mockResolvedValue({
    ...support.BUNDLE_ARTIFACT,
    protocolFeatures: FEATURES,
  });
  const liveEvents = support.createLiveEvents({
    bindSession: vi.fn(() => !options.liveBindingFails),
  });
  const workerService = support.createService(support.createProvider(), { liveEvents });
  const projected = workerService.get(environmentId)!;
  const ordinaryGet = vi.mocked(harness.environments.get).getMockImplementation()!;
  vi.mocked(harness.environments.get).mockImplementation(
    (id) => workerService.get(id) ?? ordinaryGet(id),
  );
  vi.mocked(harness.environments.prepareProjectIntent).mockResolvedValue(intent);
  vi.mocked(harness.environments.getPreparedCandidates).mockReturnValue(reserve ? [projected] : []);
  const ordinaryAttach = vi.mocked(harness.environments.attachSession).getMockImplementation()!;
  vi.mocked(harness.environments.attachSession).mockImplementation(async (request) => {
    const credential =
      request.environmentId === environmentId
        ? await workerService.attachSession(request)
        : undefined;
    const ordinary = await ordinaryAttach(request);
    return credential ?? ordinary;
  });
  const ordinaryDestroy = vi.mocked(harness.environments.destroy).getMockImplementation()!;
  vi.mocked(harness.environments.destroy).mockImplementation(async (id) =>
    id === environmentId ? await workerService.destroy(id) : await ordinaryDestroy(id),
  );
  const ordinaryTunnel = vi.mocked(harness.environments.startTunnel).getMockImplementation()!;
  vi.mocked(harness.environments.startTunnel).mockImplementation(async (request) => ({
    ...(await ordinaryTunnel(request)),
    environmentId: request.environmentId,
  }));
  vi.mocked(harness.environments.bindPreparedWorkspace).mockImplementation(async (request) => {
    request.assertCurrent();
    harness.log.push("workspace:bind-prepared");
  });
  if (!reserve) {
    vi.mocked(harness.environments.create).mockResolvedValue(projected);
  }
  const node: NodeWorkerSupervisorNodeProof = {
    nodeId: "prepared-node",
    connId: "prepared-connection",
    pairingIdentity: "prepared-identity",
    pairingGeneration: "prepared-generation",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: { enabled: true, capacity: { total: 1, available: 1 } },
    commands: ["codex.exec-server.stdio.v1"],
  };
  bindDeviceWorkerAvailability(harness.environments, async () => ({ available: true, node }));
  const request = {
    ...REQUEST,
    executionMode,
    setupAuthorized: true,
    devicePlacement: {
      requiredNodeCommands: executionMode === "remote-exec" ? ["codex.exec-server.stdio.v1"] : [],
      consumesWorkerSlot: executionMode === "worker-turn",
    },
  };
  return {
    harness,
    placements,
    store,
    workerService,
    ready,
    intent,
    request,
    liveEvents,
    revokeNode: () => {
      nodeCurrent = false;
    },
  };
}

describe("prepared worker dispatch", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["worker-turn", "remote-exec"] as const)(
    "consumes the existing environment and binds its workspace for %s",
    async (executionMode) => {
      const { harness, placements, store, ready, request } = preparedHarness({ executionMode });
      vi.mocked(harness.environments.schedulePreparedRefill).mockImplementation(() => {
        expect(placements.get(request.sessionId)?.state).toBe("active");
        throw new Error("refill scheduling failed");
      });

      const active = await harness.service.dispatch(request);

      expect(active).toMatchObject({
        state: "active",
        environmentId: ready.environmentId,
        executionMode,
      });
      expect(harness.environments.create).not.toHaveBeenCalled();
      expect(harness.environments.createFromProfileSnapshot).not.toHaveBeenCalled();
      expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
      expect(store.getCredential(ready.environmentId)).toMatchObject({
        sessionId: request.sessionId,
        ownerEpoch: active.activeOwnerEpoch,
      });
      expect(harness.log.indexOf("workspace:bind-prepared")).toBeLessThan(
        harness.log.indexOf("sync"),
      );
      expect(harness.environments.schedulePreparedRefill).toHaveBeenCalledWith(ready.environmentId);
      const tunnel = await vi.mocked(harness.environments.startTunnel).mock.results[0]?.value;
      expect(tunnel?.syncWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: request.sessionKey }),
      );
    },
  );

  it("binds a freshly prepared cold workspace without turning its ordinary row into a reserve", async () => {
    const { harness, store, ready, intent, request } = preparedHarness({ reserve: false });

    const active = await harness.service.dispatch(request);

    expect(active.environmentId).toBe(ready.environmentId);
    expect(harness.environments.create).toHaveBeenCalledWith(
      request.profileId,
      expect.any(String),
      undefined,
      request.executionMode,
      "/gateway/workspace",
      undefined,
      intent,
    );
    expect(store.get(ready.environmentId)?.preparation).toBeNull();
    expect(harness.environments.bindPreparedWorkspace).toHaveBeenCalledOnce();
    expect(harness.log.indexOf("workspace:bind-prepared")).toBeLessThan(
      harness.log.indexOf("sync"),
    );
  });

  it.each(["build", "node"] as const)(
    "uses the cold path when a candidate's %s proof is stale",
    async (stale) => {
      const { harness, store, ready, request, revokeNode } = preparedHarness();
      if (stale === "build") {
        const environment = harness.environments.get(ready.environmentId)!;
        vi.mocked(harness.environments.getPreparedCandidates).mockReturnValue([
          {
            ...environment,
            bootstrapReceipt: { ...ready.bootstrapReceipt!, bundleHash: "9".repeat(64) },
          },
        ]);
      } else {
        revokeNode();
      }

      const active = await harness.service.dispatch(request);

      expect(active.environmentId).toBe(harness.ready.environmentId);
      expect(active.environmentId).not.toBe(ready.environmentId);
      expect(harness.environments.create).toHaveBeenCalledOnce();
      expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
      expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
    },
  );

  it("does not mint attachment authority after request revocation during build validation", async () => {
    const { harness, store, ready, request, liveEvents } = preparedHarness();
    let authorized = true;
    vi.mocked(support.testState.prepareInstallation).mockImplementation(async () => {
      authorized = false;
      return { ...support.BUNDLE_ARTIFACT, protocolFeatures: FEATURES };
    });

    await expect(
      harness.service.dispatch(request, undefined, () => {
        if (!authorized) {
          throw new Error("request revoked");
        }
      }),
    ).rejects.toThrow("request revoked");

    expect(liveEvents.bindSession).not.toHaveBeenCalled();
    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledWith(ready.environmentId);
  });

  it("uses the cold path when pool policy removes a candidate during node admission", async () => {
    const { harness, store, ready, request } = preparedHarness();
    const candidates = vi.mocked(harness.environments.getPreparedCandidates);
    const selected = candidates.getMockImplementation()!;
    candidates.mockImplementationOnce(selected).mockReturnValue([]);

    const active = await harness.service.dispatch(request);

    expect(active.environmentId).toBe(harness.ready.environmentId);
    expect(harness.environments.create).toHaveBeenCalledOnce();
    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
    expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
  });

  it("rejects direct attachment without the prepared placement reservation", async () => {
    const { store, workerService, ready, request, liveEvents } = preparedHarness();

    await expect(
      workerService.attachSession({
        environmentId: ready.environmentId,
        ownerEpoch: ready.ownerEpoch,
        sessionId: request.sessionId,
      }),
    ).rejects.toThrow("placement reservation");

    expect(store.get(ready.environmentId)).toMatchObject({
      state: "ready",
      preparation: { consumedAtMs: null },
    });
    expect(store.getCredential(ready.environmentId)?.sessionId).toBeNull();
    expect(liveEvents.bindSession).not.toHaveBeenCalled();
  });

  it("fences a profile change after node eligibility before consuming its reserve", async () => {
    const { harness, store, ready, request } = preparedHarness();
    vi.mocked(harness.environments.assertPreparedIntentCurrent)
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("profile changed");
      });

    await expect(harness.service.dispatch(request)).rejects.toThrow("profile changed");

    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.create).not.toHaveBeenCalled();
  });

  it("cannot recycle a consumed environment after live attachment rollback", async () => {
    const { harness, store, ready, request, workerService } = preparedHarness({
      liveBindingFails: true,
    });

    await expect(harness.service.dispatch(request)).rejects.toThrow(
      "Attached session target is unavailable",
    );

    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
    expect(
      workerService.getPreparedCandidates({
        providerId: ready.providerId,
        profileSnapshot: ready.profileSnapshot,
        preparationKey: PREPARATION_KEY,
      }),
    ).toEqual([]);
    expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
  });

  it("fences workspace upload when node authority closes during prepared binding", async () => {
    const { harness, store, ready, request, revokeNode } = preparedHarness();
    vi.mocked(harness.environments.bindPreparedWorkspace).mockImplementation(async () => {
      revokeNode();
    });

    await expect(harness.service.dispatch(request)).rejects.toThrow("node authority");

    expect(harness.log).not.toContain("sync");
    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
    expect(harness.environments.destroy).toHaveBeenCalledWith(ready.environmentId);
    expect(harness.environments.schedulePreparedRefill).not.toHaveBeenCalled();
  });
});
