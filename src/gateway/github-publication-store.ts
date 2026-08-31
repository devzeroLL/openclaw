import { createHash } from "node:crypto";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { ensureGitHubPublicationSchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as StateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";

type GitHubPublicationDatabase = Pick<
  StateDatabase,
  "github_publication_requests" | "worker_session_placements"
>;
export type GitHubPublicationRow = StateDatabase["github_publication_requests"];
export type GitHubPublicationExecutionRow = Omit<
  GitHubPublicationRow,
  "claim_id" | "run_id" | "environment_id" | "owner_epoch" | "placement_generation"
> & { last_effect?: string | null; effect_state?: string | null };
type PublicationFailureCode = Extract<SessionGitHubPublicationResult, { status: "failed" }>["code"];

const PUBLICATION_FAILURE_CODES = new Set<string>([
  "identity_changed",
  "identity_unavailable",
  "session_changed",
  "workspace_changed",
  "not_git",
  "not_github",
  "no_changes",
  "push_rejected",
  "github_rejected",
  "unavailable",
]);

function publicationFailureCode(value: string): PublicationFailureCode {
  // SAFETY: membership in the closed protocol vocabulary narrows this stored string.
  return PUBLICATION_FAILURE_CODES.has(value) ? (value as PublicationFailureCode) : "unavailable";
}

export const githubPublicationDatabase = (db: Parameters<typeof getNodeSqliteKysely>[0]) =>
  getNodeSqliteKysely<GitHubPublicationDatabase>(db);

export function ensureGitHubPublicationStore(): void {
  ensureGitHubPublicationSchema(openOpenClawStateDatabase().db);
}

export function hasGitHubPublicationStore(): boolean {
  return tableExists(openOpenClawStateDatabase().db, "github_publication_requests");
}

export function claimGitHubPublicationExecution(
  requestId: string,
  gatewayInstanceId: string,
): GitHubPublicationRow {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const query = githubPublicationDatabase(db);
      const current = executeSqliteQuerySync(
        db,
        query
          .selectFrom("github_publication_requests")
          .selectAll()
          .where("request_id", "=", requestId),
      ).rows[0];
      if (!current) {
        throw new Error("GitHub publication request disappeared.");
      }
      if (current.status === "published" || current.status === "failed") {
        return current;
      }
      let update = query
        .updateTable("github_publication_requests")
        .set({
          status: "publishing",
          gateway_instance_id: gatewayInstanceId,
          updated_at_ms: Date.now(),
        })
        .where("request_id", "=", current.request_id)
        .where("status", "=", current.status);
      update = current.gateway_instance_id
        ? update.where("gateway_instance_id", "=", current.gateway_instance_id)
        : update.where("gateway_instance_id", "is", null);
      const claimed = executeSqliteQuerySync(db, update);
      if (claimed.numAffectedRows !== 1n) {
        throw new Error("GitHub publication execution ownership changed.");
      }
      return executeSqliteQuerySync(
        db,
        query
          .selectFrom("github_publication_requests")
          .selectAll()
          .where("request_id", "=", requestId),
      ).rows[0]!;
    },
    undefined,
    { operationLabel: "github-publication.claim" },
  );
}

export function deferGitHubPublicationRequests(requestIds: string[]): void {
  if (requestIds.length === 0) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const query = githubPublicationDatabase(db);
      const updatedAtMs = Date.now();
      for (const requestId of requestIds) {
        executeSqliteQuerySync(
          db,
          query
            .updateTable("github_publication_requests")
            .set({
              claim_id: null,
              run_id: null,
              environment_id: null,
              owner_epoch: null,
              placement_generation: null,
              status: "requested",
              gateway_instance_id: null,
              updated_at_ms: updatedAtMs,
            })
            .where("request_id", "=", requestId)
            .where("status", "in", ["requested", "publishing"]),
        );
      }
    },
    undefined,
    { operationLabel: "github-publication.defer" },
  );
}

export function isGitHubPublicationExecutionOwner(
  requestId: string,
  gatewayInstanceId: string,
): boolean {
  ensureGitHubPublicationStore();
  const db = openOpenClawStateDatabase().db;
  const row = executeSqliteQuerySync(
    db,
    githubPublicationDatabase(db)
      .selectFrom("github_publication_requests")
      .select(["status", "gateway_instance_id"])
      .where("request_id", "=", requestId),
  ).rows[0];
  return row?.status === "publishing" && row.gateway_instance_id === gatewayInstanceId;
}

export function digestGitHubPublicationRequest(params: {
  sessionId: string;
  idempotencyKey: string;
  title?: string;
  body?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sessionId: params.sessionId,
        idempotencyKey: params.idempotencyKey,
        title: params.title ?? null,
        body: params.body ?? null,
      }),
    )
    .digest("hex");
}

export function projectGitHubPublicationResult(
  row: GitHubPublicationExecutionRow,
): SessionGitHubPublicationResult {
  const effect: Pick<SessionGitHubPublicationResult, "effect"> =
    (row.last_effect === "push" || row.last_effect === "pull_request") &&
    (row.effect_state === "dispatched" || row.effect_state === "observed")
      ? {
          effect: {
            kind: row.last_effect,
            status: row.effect_state,
            ...(row.head_commit ? { headCommit: row.head_commit } : {}),
            ...(row.pull_request_url ? { url: row.pull_request_url } : {}),
          },
        }
      : {};
  const publisher = {
    source:
      row.identity_source === "personal"
        ? ("personal" as const)
        : row.identity_source === "agent-override"
          ? ("agent-override" as const)
          : row.identity_source === "system-configured"
            ? ("system-configured" as const)
            : ("system-detected" as const),
    accountId: row.identity_account_id,
    login: row.identity_login,
  };
  if (row.status === "published" && row.pull_request_url && row.repository && row.branch) {
    return {
      requestId: row.request_id,
      publisher,
      ...effect,
      status: "published",
      url: row.pull_request_url,
      repository: row.repository,
      branch: row.branch,
      headCommit: row.head_commit ?? "unknown",
    };
  }
  if (row.status === "failed" && row.error_code && row.next_action) {
    return {
      requestId: row.request_id,
      publisher,
      ...effect,
      status: "failed",
      code: publicationFailureCode(row.error_code),
      message: "GitHub publication failed.",
      nextAction: row.next_action,
    };
  }
  if (row.status === "needs_confirmation") {
    return {
      requestId: row.request_id,
      publisher,
      ...effect,
      status: "needs_confirmation",
      message:
        "Confirm the original My GitHub account, target, and workspace to continue this interrupted publication. Already-dispatched GitHub effects may have completed; confirmation checks them before retrying.",
    };
  }
  return {
    requestId: row.request_id,
    publisher,
    ...effect,
    status: row.status === "publishing" ? "publishing" : "requested",
    message:
      row.status === "publishing"
        ? "The Gateway is publishing the reconciled workspace."
        : row.identity_source === "personal"
          ? "My GitHub publication was accepted for the selected account and workspace."
          : "Publication was accepted. Finish the turn so the Gateway can reconcile and publish the workspace.",
  };
}
