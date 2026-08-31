import type { GitHubIdentityFacts } from "../../../../packages/gateway-protocol/src/schema/agents-models-skills.ts";
import type {
  PersonalGitHubStatus,
  UsersGitHubStatusResult,
} from "../../../../packages/gateway-protocol/src/schema/users.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ToolsGitHubStatusResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { resolveAgentConfig } from "../../lib/agents/display.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { GitHubDeviceAuthorizationController } from "./github-identity-controller-authorization.ts";
import {
  runGitHubIdentityConfigure,
  runGitHubIdentityInherit,
} from "./github-identity-controller-mutations.ts";
import {
  configFingerprint,
  githubConnectionOwnerKey,
  readGitHubIdentityDraft,
  type GitHubConnectionTarget,
  type GitHubIdentityDraft,
  type GitHubIdentityHost,
  type GitHubIdentityScope,
  type GitHubSharedScope,
  type RequestOwner,
  type SharedRequestOwner,
} from "./github-identity-controller-shared.ts";

export class GitHubIdentityController {
  status: ToolsGitHubStatusResult | null = null;
  personal: PersonalGitHubStatus | null = null;
  system: GitHubIdentityFacts | null = null;
  loading = false;
  busy = false;
  error: string | null = null;
  statusReadable = false;
  configurable = false;
  authorizable = false;
  tokenRevealed = false;
  patVisible = false;

  private target: GitHubConnectionTarget | null = null;
  private client: GatewayBrowserClient | null = null;
  private connected = false;
  private clientRevision = -1;
  private requestRevision = 0;
  private displayedIdentityFingerprint = "";
  private identityInitialized = false;
  private verificationQueued = false;
  private confirmationPending = false;
  private mutationOwner: RequestOwner | null = null;
  private mutationIdentityChanged = false;
  private readonly deviceAuthorization: GitHubDeviceAuthorizationController;
  private drafts: Record<GitHubSharedScope, GitHubIdentityDraft> = {
    system: readGitHubIdentityDraft(undefined),
    agent: readGitHubIdentityDraft(undefined),
  };
  private draftDirty = { system: false, agent: false };
  private configFingerprints = { system: "", agent: "" };

  constructor(private readonly host: GitHubIdentityHost) {
    this.deviceAuthorization = new GitHubDeviceAuthorizationController({
      ...host,
      isCurrent: (owner) => this.authorizable && this.isCurrent(owner),
      begin: (owner) => this.beginMutation(owner),
      finish: (owner, succeeded) => this.finishMutation(owner, succeeded),
      applySuccess: (owner, result, refreshError) => {
        if (owner.target.kind === "personal" && "personal" in result) {
          this.personal = result.personal;
        } else if (owner.target.kind === "shared" && "githubStatus" in result) {
          this.applyMutationStatus(
            { ...owner, target: owner.target },
            result.githubStatus,
            { ...this.drafts[owner.target.scope], token: "" },
            refreshError,
          );
        } else {
          throw new Error("Gateway returned GitHub authorization for a different target.");
        }
      },
    });
  }

  get scope(): GitHubIdentityScope {
    return this.target?.kind === "personal" ? "personal" : (this.target?.scope ?? "system");
  }
  get authorization() {
    return this.deviceAuthorization.state;
  }
  get authorizationActive(): boolean {
    return this.deviceAuthorization.active;
  }
  get connectionReady(): boolean {
    return this.connected && this.client !== null;
  }
  get draft(): GitHubIdentityDraft {
    return this.scope === "personal" ? readGitHubIdentityDraft(undefined) : this.drafts[this.scope];
  }

  private queueVerification() {
    if (
      this.verificationQueued ||
      this.confirmationPending ||
      !this.statusReadable ||
      !this.connectionReady ||
      !this.target ||
      this.authorizationActive
    ) {
      return;
    }
    this.verificationQueued = true;
    queueMicrotask(() => {
      this.verificationQueued = false;
      void this.verify();
    });
  }

  sync(params: {
    client: GatewayBrowserClient | null;
    connected: boolean;
    target: GitHubConnectionTarget | null;
    statusReadable: boolean;
    configurable: boolean;
    authorizable: boolean;
    clientRevision: number;
  }) {
    const clientChanged =
      this.client !== params.client ||
      this.connected !== params.connected ||
      this.clientRevision !== params.clientRevision;
    const ownerChanged =
      githubConnectionOwnerKey(this.target) !== githubConnectionOwnerKey(params.target);
    const nextScope =
      params.target?.kind === "personal" ? "personal" : (params.target?.scope ?? "system");
    const scopeChanged = this.scope !== nextScope;
    const configurable = params.target?.kind === "shared" && params.configurable;
    const capabilityChanged =
      this.statusReadable !== params.statusReadable ||
      this.configurable !== configurable ||
      this.authorizable !== params.authorizable;
    const contextChanged = clientChanged || ownerChanged || scopeChanged || capabilityChanged;
    if (contextChanged) {
      this.deviceAuthorization.retire(true);
      this.requestRevision += 1;
      this.mutationOwner = null;
      this.mutationIdentityChanged = false;
    }
    this.client = params.client;
    this.connected = params.connected;
    this.clientRevision = params.clientRevision;
    this.statusReadable = params.statusReadable;
    this.configurable = configurable;
    this.authorizable = params.authorizable;
    this.target = params.target ? { ...params.target } : null;
    const resolved =
      params.target?.kind === "shared"
        ? resolveAgentConfig(params.target.config, params.target.agentId)
        : null;
    const values = { system: resolved?.globalTools?.github, agent: resolved?.entry?.tools?.github };
    const fingerprint = configFingerprint(
      nextScope === "personal"
        ? null
        : {
            effective: values.agent ?? values.system,
            selectedScope: nextScope,
            selected: values[nextScope],
          },
    );
    const identityChanged =
      this.identityInitialized && this.displayedIdentityFingerprint !== fingerprint;
    this.displayedIdentityFingerprint = fingerprint;
    this.identityInitialized = true;
    const mutationOwner = this.mutationOwner;
    const mutationOwnsIdentityChange =
      identityChanged && mutationOwner !== null && this.busy && this.isCurrent(mutationOwner);
    if (mutationOwnsIdentityChange) {
      this.mutationIdentityChanged = true;
    } else if (identityChanged) {
      this.requestRevision += 1;
      this.deviceAuthorization.retire(true);
    }
    if (contextChanged || (identityChanged && !mutationOwnsIdentityChange)) {
      this.status = null;
      this.personal = null;
      this.system = null;
      this.error = null;
      this.loading = false;
      this.busy = false;
      this.tokenRevealed = false;
      this.patVisible = false;
      this.confirmationPending = false;
    }
    if (clientChanged || ownerChanged) {
      this.drafts = {
        system: readGitHubIdentityDraft(values.system),
        agent: readGitHubIdentityDraft(values.agent),
      };
      this.draftDirty = { system: false, agent: false };
      this.configFingerprints = {
        system: configFingerprint(values.system),
        agent: configFingerprint(values.agent),
      };
      return;
    }
    for (const scope of ["system", "agent"] as const) {
      const scopeFingerprint = configFingerprint(values[scope]);
      if (!this.draftDirty[scope] && this.configFingerprints[scope] !== scopeFingerprint) {
        this.drafts = { ...this.drafts, [scope]: readGitHubIdentityDraft(values[scope]) };
        this.configFingerprints = { ...this.configFingerprints, [scope]: scopeFingerprint };
      }
    }
    if (identityChanged && !mutationOwnsIdentityChange) {
      this.queueVerification();
    }
  }

  showPatFallback() {
    if (this.configurable && this.scope !== "personal" && !this.authorizationActive) {
      this.patVisible = true;
      this.host.requestUpdate();
    }
  }
  hidePatFallback() {
    if (this.busy) {
      return;
    }
    this.patVisible = false;
    this.tokenRevealed = false;
    this.host.requestUpdate();
  }
  toggleTokenVisibility() {
    if (!this.configurable || this.scope === "personal") {
      return;
    }
    this.tokenRevealed = !this.tokenRevealed;
    this.host.requestUpdate();
  }
  setDraft(field: keyof GitHubIdentityDraft, value: string) {
    if (this.scope === "personal") {
      return;
    }
    this.drafts = { ...this.drafts, [this.scope]: { ...this.drafts[this.scope], [field]: value } };
    this.draftDirty = { ...this.draftDirty, [this.scope]: true };
    this.host.requestUpdate();
  }

  dispose = () => {
    this.deviceAuthorization.retire(true);
    this.requestRevision += 1;
    this.client = null;
    this.target = null;
    this.connected = false;
    this.status = null;
    this.personal = null;
    this.system = null;
    this.loading = false;
    this.busy = false;
    this.mutationOwner = null;
    this.drafts = {
      system: readGitHubIdentityDraft(undefined),
      agent: readGitHubIdentityDraft(undefined),
    };
  };

  private captureRequest(): RequestOwner | null {
    if (!this.client || !this.connected || !this.target) {
      return null;
    }
    const target = this.target;
    return {
      client: this.client,
      target:
        target.kind === "personal"
          ? { ...target }
          : { kind: "shared", scope: target.scope, agentId: target.agentId },
      clientRevision: this.clientRevision,
      requestRevision: ++this.requestRevision,
    };
  }
  private isCurrent(owner: RequestOwner): boolean {
    return (
      this.client === owner.client &&
      this.connected &&
      this.clientRevision === owner.clientRevision &&
      this.requestRevision === owner.requestRevision
    );
  }

  async startAuthorization() {
    if (!this.authorizable || this.authorizationActive || this.busy || this.confirmationPending) {
      return;
    }
    const owner = this.captureRequest();
    if (!owner) {
      return;
    }
    this.loading = false;
    this.error = null;
    this.patVisible = false;
    await this.deviceAuthorization.start(owner);
  }
  cancelAuthorization() {
    return this.deviceAuthorization.cancel();
  }

  private beginMutation(owner: RequestOwner) {
    this.mutationOwner = owner;
    this.mutationIdentityChanged = false;
    this.loading = false;
    this.busy = true;
    this.error = null;
    this.host.requestUpdate();
  }
  private finishMutation(owner: RequestOwner, succeeded: boolean) {
    if (this.mutationOwner !== owner) {
      return;
    }
    const verifyAfterSettle = this.mutationIdentityChanged && !succeeded;
    this.mutationOwner = null;
    this.mutationIdentityChanged = false;
    if (!this.isCurrent(owner)) {
      return;
    }
    this.busy = false;
    this.host.requestUpdate();
    if (verifyAfterSettle) {
      this.queueVerification();
    }
  }

  private acceptSharedStatus(owner: SharedRequestOwner, status: ToolsGitHubStatusResult) {
    if (
      status.agentId !== owner.target.agentId ||
      status.selectedScope !== owner.target.scope ||
      status.selected.scope !== owner.target.scope
    ) {
      throw new Error("Gateway returned GitHub identity status for a different target.");
    }
    this.status = status;
    if (owner.target.scope === "system") {
      this.system = status.selected.identity;
    }
  }
  private applyMutationStatus(
    owner: SharedRequestOwner,
    status: ToolsGitHubStatusResult,
    nextDraft: GitHubIdentityDraft,
    refreshError: string | null,
  ) {
    if (!this.isCurrent(owner)) {
      return;
    }
    this.acceptSharedStatus(owner, status);
    const scope = owner.target.scope;
    this.drafts = { ...this.drafts, [scope]: nextDraft };
    this.draftDirty = { ...this.draftDirty, [scope]: false };
    this.tokenRevealed = false;
    this.patVisible = false;
    this.error = refreshError
      ? `GitHub identity was updated, but its configuration refresh failed: ${refreshError}`
      : null;
  }

  async verify() {
    if (
      !this.statusReadable ||
      this.loading ||
      this.busy ||
      this.confirmationPending ||
      this.authorizationActive
    ) {
      return;
    }
    const owner = this.captureRequest();
    if (!owner) {
      return;
    }
    this.loading = true;
    this.error = null;
    this.host.requestUpdate();
    try {
      if (owner.target.kind === "personal") {
        const status = await owner.client.request<UsersGitHubStatusResult>(
          "users.github.status",
          {},
        );
        // Status may restore a pending user code only while its exact profile and socket still own this view.
        if (!this.isCurrent(owner)) {
          return;
        }
        this.personal = status.personal;
        this.system = status.system;
        if (status.personal.pending && this.authorizable) {
          this.deviceAuthorization.restore(owner, status.personal.pending);
        }
      } else {
        const status = await owner.client.request<ToolsGitHubStatusResult>("tools.github.status", {
          agentId: owner.target.agentId,
          selectedScope: owner.target.scope,
        });
        if (this.isCurrent(owner)) {
          this.acceptSharedStatus({ ...owner, target: owner.target }, status);
        }
      }
    } catch (error) {
      if (this.isCurrent(owner)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.isCurrent(owner)) {
        this.loading = false;
        this.host.requestUpdate();
      }
    }
  }

  async disconnect() {
    if (
      this.target?.kind !== "personal" ||
      !this.authorizable ||
      this.busy ||
      this.authorizationActive
    ) {
      return;
    }
    const owner = this.captureRequest();
    if (!owner) {
      return;
    }
    this.beginMutation(owner);
    let succeeded = false;
    try {
      await owner.client.request("users.github.disconnect", {});
      if (!this.isCurrent(owner)) {
        return;
      }
      this.personal = null;
      succeeded = true;
    } catch (error) {
      if (this.isCurrent(owner)) {
        this.error = formatUiError(error);
      }
    } finally {
      this.finishMutation(owner, succeeded);
    }
    if (succeeded && this.isCurrent(owner)) {
      await this.verify();
    }
  }

  async configure() {
    if (
      this.target?.kind !== "shared" ||
      !this.configurable ||
      this.busy ||
      this.authorizationActive ||
      this.confirmationPending
    ) {
      return;
    }
    const draft = { ...this.draft };
    if (!draft.token.trim()) {
      this.error = t("agentTools.githubPasteToken");
      this.host.requestUpdate();
      return;
    }
    const mutation = this.createMutationOwner();
    if (mutation) {
      await runGitHubIdentityConfigure({ ...mutation, draft });
    }
  }
  async inherit() {
    if (
      this.target?.kind !== "shared" ||
      !this.configurable ||
      this.busy ||
      this.authorizationActive ||
      this.confirmationPending
    ) {
      return;
    }
    const mutation = this.createMutationOwner();
    if (!mutation) {
      return;
    }
    await runGitHubIdentityInherit({
      ...mutation,
      canContinue: () => this.configurable && !this.busy && !this.authorizationActive,
      setConfirmationPending: (pending) => {
        if (mutation.isCurrent()) {
          this.confirmationPending = pending;
        }
      },
    });
  }
  private createMutationOwner() {
    const owner = this.captureRequest();
    if (!owner || owner.target.kind !== "shared" || !this.host.runExternalMutation) {
      return null;
    }
    const sharedOwner = { ...owner, target: owner.target };
    return {
      owner: sharedOwner,
      scope: owner.target.scope,
      isCurrent: () => this.isCurrent(owner),
      isConfigurable: () => this.configurable,
      runExternalMutation: this.host.runExternalMutation,
      begin: () => this.beginMutation(sharedOwner),
      applyStatus: (
        status: ToolsGitHubStatusResult,
        draft: GitHubIdentityDraft,
        error: string | null,
      ) => this.applyMutationStatus(sharedOwner, status, draft, error),
      finish: (succeeded: boolean) => this.finishMutation(sharedOwner, succeeded),
      setError: (error: string) => {
        this.error = error;
      },
    };
  }
}
