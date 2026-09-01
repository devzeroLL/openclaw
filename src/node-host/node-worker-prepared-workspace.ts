import fsp from "node:fs/promises";
import path from "node:path";
import { parseWorkerWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest.js";
import type {
  NodeWorkerPreparedWorkspaceInput,
  NodeWorkerPreparedWorkspaceResult,
} from "../worker/node-workspace-prepared-protocol.js";
import type {
  NodeWorkerPreparedWorkspaceRow,
  NodeWorkerPreparedWorkspaceStore,
} from "./node-worker-prepared-workspace-store.js";
import { captureManifest } from "./node-worker-workspace-commands.js";
import { assertNodePreparedWorkspacePaths } from "./node-worker-workspace-identity.js";

export async function prepareNodeWorkerWorkspace(
  root: string,
  store: NodeWorkerPreparedWorkspaceStore,
  input: NodeWorkerPreparedWorkspaceInput,
  signal?: AbortSignal,
): Promise<NodeWorkerPreparedWorkspaceResult> {
  signal?.throwIfAborted();
  let row: NodeWorkerPreparedWorkspaceRow;
  if (input.action === "register") {
    assertNodePreparedWorkspacePaths(root, input);
    const manifestPath = path.join(
      input.homeDir,
      ".openclaw-worker",
      "manifests",
      `${input.sourceManifestRef.slice(7)}.json`,
    );
    const source = parseWorkerWorkspaceManifest(
      await fsp.readFile(manifestPath, "utf8"),
      input.sourceManifestRef,
    );
    if (
      !source.baseCommit ||
      (await captureManifest({
        workspaceDir: input.workspaceDir,
        manifestHome: input.homeDir,
        baseCommit: source.baseCommit,
        referenceManifestRef: input.sourceManifestRef,
        signal,
      })) !== input.sourceManifestRef
    ) {
      throw new Error("INVALID_REQUEST: prepared workspace source does not match its manifest");
    }
    signal?.throwIfAborted();
    assertNodePreparedWorkspacePaths(root, input);
    row = store.register(input);
  } else {
    const existing = store.find(input.environmentId);
    if (!existing) {
      throw new Error("INVALID_REQUEST: prepared workspace registration is missing");
    }
    assertNodePreparedWorkspacePaths(root, {
      gatewayNamespace: existing.gateway_namespace,
      preparationKey: existing.preparation_key,
      workspaceDir: existing.workspace_dir,
      homeDir: existing.home_dir,
    });
    row = store.bind(input);
  }
  return {
    preparationKey: row.preparation_key,
    environmentId: row.environment_id,
    gatewayNamespace: row.gateway_namespace,
    workspaceDir: row.workspace_dir,
    homeDir: row.home_dir,
    sourceManifestRef: row.source_manifest_ref,
  };
}
