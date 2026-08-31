import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import { selectedGitHubPublisher, type GitHubPublicationView } from "../chat-github-publication.ts";

function sourceLabel(source: string): string {
  return t(
    source === "personal"
      ? "githubPublication.personal"
      : source === "agent-override"
        ? "githubPublication.agent"
        : "githubPublication.system",
  );
}

export function renderGitHubPublicationAction(publication: GitHubPublicationView) {
  const { result, selection, busy } = publication;
  if (result?.status === "published") {
    return html`<a
      class="chat-pr__create"
      href=${result.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      ${t("chat.pullRequests.openPublishedPr")}
    </a>`;
  }
  if (result?.status === "failed") {
    return publication.onNewAction
      ? html`<button
          class="chat-pr__create"
          type="button"
          ?disabled=${busy}
          @click=${publication.onNewAction}
        >
          ${t("githubPublication.newAction")}
        </button>`
      : nothing;
  }
  if (result?.status === "needs_confirmation") {
    return publication.onConfirm
      ? html`<button
          class="chat-pr__create"
          type="button"
          ?disabled=${busy || !publication.personalReady}
          @click=${publication.onConfirm}
        >
          ${t("githubPublication.confirm")}
        </button>`
      : nothing;
  }
  if (result?.status === "publishing" || result?.status === "requested") {
    return html`<button
      class="chat-pr__create"
      type="button"
      ?disabled=${busy}
      @click=${result.publisher?.source === "personal"
        ? publication.onRefresh
        : publication.onPublish}
    >
      ${busy ? t("chat.pullRequests.publishing") : t("githubPublication.check")}
    </button>`;
  }
  return publication.onPublish
    ? html`<button
        class="chat-pr__create"
        type="button"
        ?disabled=${busy ||
        !selection ||
        (selection.source === "personal" && !publication.personalReady)}
        @click=${publication.onPublish}
      >
        ${busy
          ? t("chat.pullRequests.publishing")
          : publication.locked
            ? t("chat.pullRequests.retryPublication")
            : t("chat.pullRequests.publishPr")}
      </button>`
    : nothing;
}

export function renderGitHubPublicationDetails(publication: GitHubPublicationView) {
  const { options, selection, result, confirmation, busy, locked, error } = publication;
  const publisher = result ? result.publisher : selectedGitHubPublisher(selection);
  const personal = options?.personal;
  const personalAccount =
    personal?.state === "connected" && personal.generation ? personal.account : null;
  return html`<div class="chat-pr__publication-outcome" data-state=${result?.status ?? "selection"}>
    ${publisher
      ? html`<span data-publication-account>
          ${t("githubPublication.publishAs", { account: publisher.login })} ·
          ${sourceLabel(publisher.source)}
        </span>`
      : nothing}
    ${publication.onSelect && options
      ? html`<label>
          <span class="sr-only">${t("githubPublication.account")}</span>
          <select
            class="settings-select"
            aria-label=${t("githubPublication.account")}
            .value=${selection?.source ?? ""}
            ?disabled=${busy || locked}
            @change=${(event: Event) => {
              if (!(event.currentTarget instanceof HTMLSelectElement)) {
                return;
              }
              const source = event.currentTarget.value;
              if (source === "shared" || source === "personal") {
                publication.onSelect?.(source);
              }
            }}
          >
            ${!selection
              ? html`<option value="" disabled>${t("githubPublication.choose")}</option>`
              : nothing}
            ${options.shared
              ? html`<option value="shared">
                  ${sourceLabel(options.shared.source)} · @${options.shared.login}
                </option>`
              : nothing}
            ${personalAccount
              ? html`<option value="personal">
                  ${t("githubPublication.personal")} · @${personalAccount.login}
                </option>`
              : nothing}
          </select>
        </label>`
      : nothing}
    ${result && result.status !== "published"
      ? html`<span role="status">${result.message}</span>`
      : nothing}
    ${result?.status === "failed" ? html`<span>${result.nextAction}</span>` : nothing}
    ${error ? html`<span role="alert">${error}</span>` : nothing}
    ${locked && !result && !busy ? html`<span>${t("githubPublication.unknown")}</span>` : nothing}
    ${confirmation
      ? html`<div>
          <div>
            ${t("githubPublication.target", {
              repository: confirmation.repository,
              base: confirmation.baseBranch,
            })}
          </div>
          <div>
            ${t("githubPublication.pushTarget", {
              repository: confirmation.pushRepository,
              branch: confirmation.branch,
            })}
          </div>
          <details>
            <summary>${t("githubPublication.snapshot")}</summary>
            <div>${t("githubPublication.head")}: <code>${confirmation.sourceHeadCommit}</code></div>
            <div>${t("githubPublication.index")}: <code>${confirmation.sourceIndexTree}</code></div>
            <div>
              ${t("githubPublication.workspace")}: <code>${confirmation.workspaceTree}</code>
            </div>
          </details>
        </div>`
      : nothing}
    ${result?.effect
      ? html`<span
          >${t(
            result.effect.status === "dispatched"
              ? "githubPublication.dispatched"
              : "githubPublication.observed",
            {
              kind: t(
                result.effect.kind === "push"
                  ? "githubPublication.effectPush"
                  : "githubPublication.effectPullRequest",
              ),
            },
          )}
          ${result.effect.headCommit ? html`<code>${result.effect.headCommit}</code>` : nothing}
          ${result.effect.url
            ? html`<a href=${result.effect.url} target="_blank" rel="noopener noreferrer"
                >${t("githubPublication.effectLink")}</a
              >`
            : nothing}
        </span>`
      : nothing}
    ${!publication.personalReady
      ? html`<span>${t("githubPublication.personalWorkspace")}</span>`
      : nothing}
    ${!result && options
      ? html`<span>${t("githubPublication.scopeHelp")}</span> ${!personalAccount
            ? html`<span
                >${t(
                  personal === null
                    ? "githubPublication.unidentified"
                    : "githubPublication.connectHelp",
                )}</span
              >`
            : nothing}`
      : nothing}
    ${!busy &&
    (error || !options || (result && !publication.onConfirm && result.status !== "published"))
      ? html`<button class="btn btn--sm" type="button" @click=${publication.onRefresh}>
          ${t("githubPublication.refresh")}
        </button>`
      : nothing}
  </div>`;
}
