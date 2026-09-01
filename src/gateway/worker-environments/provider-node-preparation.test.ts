import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { bindCloudWorkerSetupCompletion } from "../../infra/device-pairing-cloud-worker.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createWorkerNodeProvisioning } from "./provider-node-provisioning.js";
import { createWorkerEnvironmentService } from "./service.js";
import * as support from "./service.test-support.js";

describe("prepared node registration ownership", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("retains both reserve slots after foreground timeouts until their raw provider calls settle", async () => {
    const { store, config, root } = support.testState;
    support.getDevelopmentProfile().readyWorkers = 3;
    const repository = path.join(root, "source");
    await fs.mkdir(repository);
    await requireGit(repository, ["init", "--quiet"]);
    await requireGit(repository, ["config", "user.name", "Preparation Test"]);
    await requireGit(repository, ["config", "user.email", "preparation@example.invalid"]);
    await fs.writeFile(path.join(repository, "input.txt"), "committed source\n");
    await requireGit(repository, ["add", "."]);
    await requireGit(repository, ["commit", "--quiet", "-m", "source"]);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let active = 0;
    let maximumActive = 0;
    const target = { machineClass: "small", platform: "linux", arch: "x64" };
    const provision = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (provision.mock.calls.length === 2) {
        entered.resolve();
      }
      try {
        await release.promise;
        throw new Error("provider fixture settled without returning a lease");
      } finally {
        active -= 1;
      }
    });
    const provider = support.createProvider({
      supportedExecutionModes: ["worker-turn"],
      requiresNodeEnrollment: true,
      provisionBeforeInstallation: true,
      supportsProjectPreparation: () => true,
      resolvePreparationTarget: () => target,
      resolvePreparedIdleTimeoutMs: () => 60_000,
      provision,
    });
    const service = createWorkerEnvironmentService({
      store,
      getConfig: () => config,
      resolveProvider: () => provider,
      projectNamespace: "gateway",
      prepareInstallation: async () => support.BUNDLE_ARTIFACT,
      bootstrapWorker: support.testState.bootstrapWorker,
      prepareNodeArtifacts: async () => ({
        artifacts: {
          nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
          enabledPluginIds: [...support.NODE_BOOTSTRAP.enabledPluginIds],
          workerBundleHash: support.BUNDLE_HASH,
          workerArchiveSha256: support.BUNDLE_ARTIFACT.tarballSha256,
          openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
          protocolFeatures: [],
        },
        assertCurrent: () => {},
      }),
      prepareNodeEnrollment: async () => {
        throw new Error("fixture never enrolls");
      },
      executeInference: async () => ({ type: "error", reason: "cancelled", message: "unused" }),
      now: () => support.testState.nowMs,
      providerCallTimeoutMs: 20,
    });
    support.testState.service = service;
    const intent = await service.prepareProjectIntent("development", {
      projectPath: repository,
      executionMode: "worker-turn",
    });
    store.createIntent({
      environmentId: "source",
      providerId: provider.id,
      profileId: "development",
      profileSnapshot: intent.profileSnapshot,
      provisionOperationId: "source-operation",
    });
    store.transition({ environmentId: "source", from: "requested", to: "provisioning" });
    store.transition({
      environmentId: "source",
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: "source-lease",
        nodeDeviceId: "source-node",
        sharedHost: false,
        ...support.readyPatch("source"),
      },
    });
    store.transition({
      environmentId: "source",
      from: "ready",
      to: "attached",
      patch: support.attachedPatch("source", "source-session"),
    });
    service.schedulePreparedRefill();
    try {
      await entered.promise;
      expect(provision).toHaveBeenCalledTimes(2);
      await support.waitForFast(() => {
        expect(
          store
            .list()
            .filter((record) => record.preparation && record.lastError?.includes("timed out"))
            .length,
        ).toBeGreaterThanOrEqual(2);
      });
      await setImmediate();
      expect(active).toBe(2);
      expect(provision).toHaveBeenCalledTimes(2);
      expect(
        store.list().filter((record) => record.preparation && record.state === "requested"),
      ).toHaveLength(1);
      release.resolve();
      await support.waitForFast(() => expect(provision).toHaveBeenCalledTimes(3));
      expect(maximumActive).toBe(2);
      expect(active).toBe(0);
    } finally {
      release.resolve();
      await service.stop();
    }
  });

  it.each(["before-registration", "during-registration", "after-ready"] as const)(
    "does not recreate a prepared binding when its owner closes %s",
    async (phase) => {
      const store = support.testState.store;
      const key = "a".repeat(64);
      const deviceId = "fresh-prepared-node";
      const environmentId = "prepared-registration";
      store.createIntent({
        environmentId,
        providerId: "fake",
        profileId: "development",
        provisionOperationId: "prepare-registration",
        profileSnapshot: {
          settings: { region: "test" },
          project: {
            key,
            root: support.testState.root,
            baseCommit: "b".repeat(40),
            preparation: {
              key,
              contractVersion: 1,
              target: { machineClass: "small", platform: "linux", arch: "x64" },
              artifacts: {
                nodeBootstrapSha256: "c".repeat(64),
                enabledPluginIds: [],
                workerBundleHash: support.BUNDLE_HASH,
                workerArchiveSha256: support.BUNDLE_ARTIFACT.tarballSha256,
                openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
                protocolFeatures: [],
              },
            },
          },
        },
      });
      store.transition({ environmentId, from: "requested", to: "provisioning" });
      const enrolled = store.ensureNodeEnrollment(environmentId);
      if (!enrolled.nodeSetupId) {
        throw new Error("Missing enrollment setup");
      }
      bindCloudWorkerSetupCompletion({
        db: support.testState.stateDb.db,
        completion: {
          setupId: enrolled.nodeSetupId,
          deviceId,
          completedAtMs: support.testState.nowMs,
        },
      });
      const record = store.ensureNodeEnrollment(environmentId);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let retainedAssert: (() => void) | undefined;
      const registerPreparedWorkspace = vi.fn(async (params: { assertCurrent: () => void }) => {
        retainedAssert = params.assertCurrent;
        params.assertCurrent();
        if (phase === "during-registration") {
          entered.resolve();
          await release.promise;
          params.assertCurrent();
        }
      });
      const patch = { leaseId: "prepared-lease", sharedHost: false, desktop: null };
      const commitReady = vi.fn(() =>
        store.transition({
          environmentId,
          from: "provisioning",
          to: "ready",
          patch: { ...patch, nodeDeviceId: deviceId, ...support.readyPatch(environmentId) },
        }),
      );
      const provisioning = createWorkerNodeProvisioning({
        store,
        isStopping: () => false,
        prepareInstallation: async () => support.BUNDLE_ARTIFACT,
        ensureNodeWorkerBundle: async () => {
          if (phase === "before-registration") {
            entered.resolve();
            await release.promise;
          }
          return support.BOOTSTRAP_RECEIPT;
        },
        registerPreparedWorkspace,
        commitReady,
        failBootstrap: async (_record, _lease, _provider, error) => {
          throw error;
        },
        move: (current, to, transitionPatch) =>
          store.transition({ environmentId, from: current.state, to, patch: transitionPatch }),
        serviceError: (_code, message) => new Error(message),
      });
      const completion = provisioning.finish(
        record,
        { leaseId: patch.leaseId, sharedHost: false, node: { deviceId } },
        support.createProvider(),
        patch,
        support.BUNDLE_ARTIFACT,
        undefined,
        {
          preparationKey: key,
          workspaceDir: "/prepared/workspace",
          homeDir: "/prepared/home",
          sourceManifestRef: `sha256:${"d".repeat(64)}`,
        },
      );
      const settled = completion.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        if (phase !== "after-ready") {
          await Promise.race([entered.promise, settled]);
          if (phase === "during-registration") {
            expect(registerPreparedWorkspace).toHaveBeenCalledOnce();
          }
          // A ready owner with no node binding row is still used; missing state
          // cannot authorize registration under a retained provisioning callback.
          store.transition({
            environmentId,
            from: "provisioning",
            to: "ready",
            patch: { ...patch, nodeDeviceId: deviceId, ...support.readyPatch(environmentId) },
          });
          release.resolve();
          expect(await settled).toMatchObject({ error: { name: "AbortError" } });
          expect(commitReady).not.toHaveBeenCalled();
        } else {
          expect(await settled).toMatchObject({ value: { state: "ready" } });
          expect(commitReady).toHaveBeenCalledOnce();
        }
        expect(registerPreparedWorkspace).toHaveBeenCalledTimes(
          phase === "before-registration" ? 0 : 1,
        );
        if (phase !== "before-registration") {
          expect(retainedAssert).toBeTypeOf("function");
          expect(() => retainedAssert!()).toThrow("Worker provisioning operation is closed");
        }
      } finally {
        release.resolve();
        await settled;
      }
    },
  );
});
