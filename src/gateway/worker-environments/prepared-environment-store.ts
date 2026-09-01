import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB, WorkerEnvironments } from "../../state/openclaw-state-db.generated.js";
import type {
  WorkerSessionPlacementDispatchIdentity,
  WorkerSessionPlacementRecord,
} from "./placement-record.js";
import { find as findPlacement } from "./placement-row-codec.js";
import type { WorkerEnvironmentIntentInput, WorkerEnvironmentRecord } from "./store.js";

export type WorkerEnvironmentPreparation = {
  key: string;
  demandAtMs: number;
  expiresAtMs: number;
  consumedAtMs: number | null;
};
export type WorkerEnvironmentPreparationIntent = Omit<WorkerEnvironmentPreparation, "consumedAtMs">;
export type PreparedEnvironmentPlacementBinding = WorkerSessionPlacementDispatchIdentity & {
  generation: number;
  preparationKey: string;
  assertCurrent: () => void;
};
type PreparationRow = Pick<
  Selectable<WorkerEnvironments>,
  | "preparation_key"
  | "preparation_demand_at_ms"
  | "preparation_expires_at_ms"
  | "preparation_consumed_at_ms"
>;
const query = (db: DatabaseSync) =>
  getNodeSqliteKysely<Pick<DB, "worker_environments" | "worker_session_placements">>(db);

export function readWorkerEnvironmentPreparation(
  row: PreparationRow,
): WorkerEnvironmentPreparation | null {
  const {
    preparation_key: key,
    preparation_demand_at_ms: demandAtMs,
    preparation_expires_at_ms: expiresAtMs,
    preparation_consumed_at_ms: consumedAtMs,
  } = row;
  if (key === null && demandAtMs === null && expiresAtMs === null && consumedAtMs === null) {
    return null;
  }
  if (
    typeof key !== "string" ||
    !/^[a-f0-9]{64}$/u.test(key) ||
    demandAtMs === null ||
    !Number.isSafeInteger(demandAtMs) ||
    demandAtMs < 0 ||
    expiresAtMs === null ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= demandAtMs ||
    (consumedAtMs !== null &&
      (!Number.isSafeInteger(consumedAtMs) ||
        consumedAtMs < demandAtMs ||
        consumedAtMs >= expiresAtMs))
  ) {
    throw new Error("Worker environment preparation metadata is invalid");
  }
  return { key, demandAtMs, expiresAtMs, consumedAtMs };
}

export function workerEnvironmentPreparationColumns(
  preparation?: WorkerEnvironmentPreparationIntent,
): PreparationRow {
  const columns = {
    preparation_key: preparation?.key ?? null,
    preparation_demand_at_ms: preparation?.demandAtMs ?? null,
    preparation_expires_at_ms: preparation?.expiresAtMs ?? null,
    preparation_consumed_at_ms: null,
  };
  readWorkerEnvironmentPreparation(columns);
  return columns;
}

function hasPlacementReference(db: DatabaseSync, environmentId: string): boolean {
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      db,
      query(db)
        .selectFrom("worker_session_placements")
        .select("session_id")
        .where("environment_id", "=", environmentId)
        .limit(1),
    ),
  );
}

function snapshotProjectKey(snapshot: unknown): string {
  if (
    !isRecord(snapshot) ||
    !isRecord(snapshot.project) ||
    typeof snapshot.project.key !== "string" ||
    !/^[a-f0-9]{64}$/u.test(snapshot.project.key)
  ) {
    throw new Error("Prepared worker has an invalid project identity");
  }
  return snapshot.project.key;
}

export function createPreparedEnvironmentStoreOps(options: {
  now: () => number;
  write: <T>(operation: (db: DatabaseSync) => T) => T;
  createIntent: (db: DatabaseSync, input: WorkerEnvironmentIntentInput) => WorkerEnvironmentRecord;
  get: (db: DatabaseSync, environmentId: string) => WorkerEnvironmentRecord | undefined;
}) {
  return {
    ensurePreparedIntent(input: {
      intent: WorkerEnvironmentIntentInput & { preparation: WorkerEnvironmentPreparationIntent };
      projectKey: string;
      target: number;
      maxTotal: number;
      assertCurrent: () => void;
    }): WorkerEnvironmentRecord | undefined {
      if (
        !Number.isSafeInteger(input.target) ||
        input.target < 0 ||
        !Number.isSafeInteger(input.maxTotal) ||
        input.maxTotal < 0
      ) {
        throw new Error("Prepared worker capacity must be a non-negative safe integer");
      }
      workerEnvironmentPreparationColumns(input.intent.preparation);
      return options.write((db) => {
        input.assertCurrent();
        const existing = options.get(db, input.intent.environmentId);
        if (existing) {
          if (
            existing.providerId !== input.intent.providerId ||
            existing.profileId !== input.intent.profileId ||
            existing.provisionOperationId !== input.intent.provisionOperationId ||
            !isDeepStrictEqual(existing.profileSnapshot, input.intent.profileSnapshot) ||
            existing.preparation?.key !== input.intent.preparation.key ||
            existing.preparation.demandAtMs !== input.intent.preparation.demandAtMs ||
            existing.preparation.expiresAtMs !== input.intent.preparation.expiresAtMs
          ) {
            throw new Error("Prepared environment intent identity changed");
          }
          return existing;
        }
        const nowMs = options.now();
        if (
          input.target === 0 ||
          input.maxTotal === 0 ||
          input.intent.preparation.demandAtMs > nowMs ||
          input.intent.preparation.expiresAtMs <= nowMs
        ) {
          return undefined;
        }
        // Failed/destroyed rows have no remaining allocation obligation. An orphan or a
        // consumed worker awaiting physical cleanup still occupies reserve capacity.
        const reserved = executeSqliteQuerySync(
          db,
          query(db)
            .selectFrom("worker_environments")
            .select(["profile_id", "provider_id", "profile_snapshot_json"])
            .where("preparation_key", "is not", null)
            .where("state", "not in", ["failed", "destroyed"])
            .where((eb) =>
              eb.or([
                eb("preparation_consumed_at_ms", "is", null),
                eb("destroy_requested_at_ms", "is not", null),
              ]),
            ),
        ).rows;
        const projectCount = reserved.filter(
          (row) =>
            row.profile_id === input.intent.profileId &&
            row.provider_id === input.intent.providerId &&
            snapshotProjectKey(JSON.parse(row.profile_snapshot_json)) === input.projectKey,
        ).length;
        if (reserved.length >= input.maxTotal || projectCount >= input.target) {
          return undefined;
        }
        if (snapshotProjectKey(input.intent.profileSnapshot) !== input.projectKey) {
          throw new Error("Prepared worker capacity does not match the admitted project");
        }
        input.assertCurrent();
        return options.createIntent(db, input.intent);
      });
    },

    requestPreparedDestroy(input: {
      environmentId: string;
      ownerEpoch: number;
      preparationKey: string;
      reason: "expired" | "invalidated";
      assertCurrent: () => void;
    }): WorkerEnvironmentRecord | undefined {
      return options.write((db) => {
        input.assertCurrent();
        const current = options.get(db, input.environmentId);
        const preparation = current?.preparation;
        const nowMs = options.now();
        if (
          !current ||
          !preparation ||
          preparation.key !== input.preparationKey ||
          current.ownerEpoch !== input.ownerEpoch ||
          preparation.consumedAtMs !== null ||
          current.attachedSessionIds.length !== 0 ||
          current.state === "failed" ||
          current.state === "destroyed" ||
          (input.reason === "expired" && preparation.expiresAtMs > nowMs) ||
          hasPlacementReference(db, current.environmentId)
        ) {
          return undefined;
        }
        if (current.destroyRequestedAtMs !== null) {
          return current;
        }
        input.assertCurrent();
        executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_environments")
            .set({
              destroy_requested_at_ms: nowMs,
              teardown_terminal_state: "destroyed",
              updated_at_ms: nowMs,
            })
            .where("environment_id", "=", current.environmentId),
        );
        return options.get(db, current.environmentId);
      });
    },
  };
}

export type PreparedEnvironmentSelection = WorkerSessionPlacementDispatchIdentity & {
  expectedGeneration: number;
  environmentId: string;
  ownerEpoch: number;
  providerId: string;
  profileId: string;
  preparationKey: string;
  nodeDeviceId: string;
  leaseId: string;
  bundleHash: string;
  assertCurrent: () => void;
};

/** Placement and consumption commit together; dropping a placement never recreates a spare. */
export function consumePreparedEnvironment(
  db: DatabaseSync,
  input: PreparedEnvironmentSelection,
  nowMs: number,
): WorkerSessionPlacementRecord | undefined {
  input.assertCurrent();
  const placement = findPlacement(db, input.sessionId);
  if (
    !placement ||
    placement.state !== "requested" ||
    placement.generation !== input.expectedGeneration ||
    placement.agentId !== input.agentId ||
    placement.sessionKey !== input.sessionKey ||
    placement.executionMode !== input.executionMode ||
    placement.turnClaim !== null
  ) {
    return undefined;
  }
  const environment = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_environments")
      .selectAll()
      .where("environment_id", "=", input.environmentId),
  );
  if (!environment) {
    return undefined;
  }
  const preparation = readWorkerEnvironmentPreparation(environment);
  const profile: unknown = JSON.parse(environment.profile_snapshot_json);
  if (
    !preparation ||
    preparation.key !== input.preparationKey ||
    preparation.consumedAtMs !== null ||
    preparation.demandAtMs > nowMs ||
    preparation.expiresAtMs <= nowMs ||
    !isRecord(profile) ||
    profile.executionMode !== input.executionMode ||
    environment.state !== "ready" ||
    environment.owner_epoch !== input.ownerEpoch ||
    environment.provider_id !== input.providerId ||
    environment.profile_id !== input.profileId ||
    environment.node_device_id !== input.nodeDeviceId ||
    environment.lease_id !== input.leaseId ||
    environment.shared_host !== 0 ||
    environment.bootstrap_bundle_hash !== input.bundleHash ||
    environment.destroy_requested_at_ms !== null ||
    environment.attached_session_ids_json !== "[]" ||
    hasPlacementReference(db, input.environmentId)
  ) {
    return undefined;
  }
  input.assertCurrent();
  executeSqliteQuerySync(
    db,
    query(db)
      .updateTable("worker_environments")
      .set({ preparation_consumed_at_ms: nowMs, updated_at_ms: nowMs })
      .where("environment_id", "=", input.environmentId),
  );
  return placement;
}

export function assertPreparedEnvironmentAttachment(
  db: DatabaseSync,
  environment: WorkerEnvironmentRecord,
  sessionId: string,
  binding: PreparedEnvironmentPlacementBinding | undefined,
): void {
  if (!environment.preparation) {
    return;
  }
  // Consumption closes reserve expiry. Exact placement recovery may attach later,
  // including after a restart, without making the workspace available again.
  binding?.assertCurrent();
  const placement = findPlacement(db, sessionId);
  if (
    !binding ||
    binding.sessionId !== sessionId ||
    environment.profileSnapshot.executionMode !== binding.executionMode ||
    environment.state !== "ready" ||
    environment.preparation.key !== binding.preparationKey ||
    environment.preparation.consumedAtMs === null ||
    !placement ||
    placement.state !== "syncing" ||
    placement.generation !== binding.generation ||
    placement.sessionKey !== binding.sessionKey ||
    placement.agentId !== binding.agentId ||
    placement.executionMode !== binding.executionMode ||
    placement.environmentId !== environment.environmentId ||
    placement.turnClaim !== null
  ) {
    throw new Error("Prepared worker attachment lost its exact placement reservation");
  }
  binding.assertCurrent();
}
