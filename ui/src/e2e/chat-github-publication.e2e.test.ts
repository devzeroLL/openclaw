import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  personalAccount,
  personalGeneration,
  publicationMethods,
  publicationOptions,
  showPublicationBranch,
} from "./chat-github-publication.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const publicationProofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "github-publication",
);
const suite = createControlUiE2eSuite({ name: "Control UI personal GitHub publication" });

async function newPublicationContext() {
  if (captureUiProof) {
    await mkdir(publicationProofDir, { recursive: true });
  }
  return await suite.newBrowserContext({
    colorScheme: "light",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 800, width: 1180 },
    ...(captureUiProof
      ? { recordVideo: { dir: publicationProofDir, size: { width: 1180, height: 800 } } }
      : {}),
  });
}

suite.define(() => {
  it("freezes an explicitly selected personal account through a lost response and shows the server actor", async () => {
    const context = await newPublicationContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.read", "operator.write"],
      featureMethods: publicationMethods,
      presenceUsers: [
        { self: true, id: "alice", identity: { type: "profile", id: "alice" }, name: "Alice" },
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.github.options": publicationOptions,
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await showPublicationBranch(gateway);
    const chooser = page.getByRole("combobox", { name: "Publication account" });
    await expect.poll(() => chooser.inputValue()).toBe("shared");
    await chooser.selectOption("personal");
    await expect
      .poll(() => page.locator("[data-publication-account]").textContent())
      .toContain("Publish as @alice-tools");
    await gateway.deferNext("sessions.github.publish");
    await page.getByRole("button", { name: "Publish PR" }).click();
    const first = await gateway.waitForRequest("sessions.github.publish");
    expect(first.params).toEqual({
      sessionKey: "agent:main:main",
      idempotencyKey: expect.any(String),
      selection: { source: "personal", generation: personalGeneration, account: personalAccount },
    });
    await expect.poll(() => chooser.count()).toBe(0);
    await gateway.rejectDeferred("sessions.github.publish", {
      code: "UNAVAILABLE",
      message: "Response lost.",
    });
    await expect
      .poll(() => page.getByRole("button", { name: "Retry publication" }).count())
      .toBe(1);
    await expect.poll(() => chooser.count()).toBe(0);
    await gateway.setMethodResponse("sessions.github.options", {
      ...publicationOptions,
      personal: {
        ...publicationOptions.personal,
        generation: "other-generation",
        account: { accountId: 4, login: "replacement" },
      },
    });
    await page.getByRole("button", { name: "Refresh publication" }).click();
    await expect
      .poll(() => page.getByRole("button", { name: "Retry publication" }).isEnabled())
      .toBe(true);
    await expect.poll(() => chooser.count()).toBe(0);
    await expect
      .poll(() => page.locator("[data-publication-account]").textContent())
      .toContain("Publish as @alice-tools");
    expect(await page.locator(".chat-pr__publication-outcome").textContent()).not.toContain(
      "replacement",
    );
    await gateway.setMethodResponse("sessions.github.publish", {
      requestId: "8c698e8a-bdc7-4927-a0f2-73a842c2d7b2",
      status: "failed",
      code: "identity_changed",
      publisher: { source: "personal", ...personalAccount },
      message: "The selected connection changed.",
      nextAction: "Review the account and choose a new publication.",
    });
    await page.getByRole("button", { name: "Retry publication" }).click();
    const second = await gateway.waitForRequest("sessions.github.publish", { after: 1 });
    expect(second.params).toEqual(first.params);
    await expect
      .poll(() => page.getByRole("button", { name: "Choose a new publication" }).count())
      .toBe(1);
    await expect
      .poll(() => page.locator("[data-publication-account]").textContent())
      .toContain("Publish as @alice-tools");
    await expect
      .poll(() => page.locator(".chat-pr__publication-outcome").textContent())
      .toContain("My GitHub");
    expect(await gateway.getRequests("secrets.set")).toHaveLength(0);
    if (captureUiProof) {
      await mkdir(publicationProofDir, { recursive: true });
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(publicationProofDir, "05-personal-identity-changed.png"),
      });
    }
  });

  it("recovers the original personal request on reload and confirms its account, target, and snapshot", async () => {
    const context = await newPublicationContext();
    const page = await context.newPage();
    const requestId = "8c698e8a-bdc7-4927-a0f2-73a842c2d7b3";
    const confirmation = {
      requestDigest: "a".repeat(64),
      generation: personalGeneration,
      account: personalAccount,
      repository: "team/demo",
      pushRepository: "alice/demo",
      baseBranch: "main",
      branch: "feature/original",
      sourceHeadCommit: "1".repeat(40),
      sourceIndexTree: "2".repeat(40),
      workspaceTree: "3".repeat(40),
    };
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.read", "operator.write"],
      featureMethods: publicationMethods,
      presenceUsers: [
        { self: true, id: "alice", identity: { type: "profile", id: "alice" }, name: "Alice" },
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.github.options": {
          ...publicationOptions,
          pendingPersonal: {
            result: {
              requestId,
              status: "needs_confirmation",
              publisher: { source: "personal", ...personalAccount },
              message: "Review the original publication before continuing.",
              effect: { kind: "push", status: "dispatched", headCommit: "4".repeat(40) },
            },
            confirmation,
          },
        },
        "sessions.github.confirm": {
          requestId,
          status: "published",
          publisher: { source: "personal", ...personalAccount },
          url: "https://github.com/team/demo/pull/42",
          repository: "team/demo",
          branch: "feature/original",
          headCommit: "4".repeat(40),
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await showPublicationBranch(gateway);
    await page.getByRole("button", { name: "Confirm original publication" }).waitFor();
    expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
    expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
    await page.reload();
    await showPublicationBranch(gateway);
    const details = page.locator(".chat-pr__publication-outcome");
    await expect.poll(() => details.textContent()).toContain("Publish as @alice-tools");
    await expect.poll(() => details.textContent()).toContain("team/demo → main");
    await expect.poll(() => details.textContent()).toContain("alice/demo · feature/original");
    await details.getByText("Original accepted snapshot", { exact: true }).click();
    await expect
      .poll(() => details.locator("details").textContent())
      .toContain(confirmation.workspaceTree);
    await expect.poll(() => details.textContent()).toContain("remote outcome may still be unknown");
    expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
    expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
    if (captureUiProof) {
      await mkdir(publicationProofDir, { recursive: true });
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(publicationProofDir, "06-original-confirmation.png"),
      });
    }
    await page.getByRole("button", { name: "Confirm original publication" }).click();
    const confirmed = await gateway.waitForRequest("sessions.github.confirm");
    expect(confirmed.params).toEqual({
      sessionKey: "agent:main:main",
      requestId,
      requestDigest: confirmation.requestDigest,
      generation: personalGeneration,
      account: personalAccount,
    });
    await expect
      .poll(() => page.getByRole("link", { name: "Open PR" }).getAttribute("href"))
      .toBe("https://github.com/team/demo/pull/42");
    await expect
      .poll(() => page.locator("[data-publication-account]").textContent())
      .toContain("Publish as @alice-tools");
    expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
  });

  it("removes publication mutation controls when the connection becomes read-only", async () => {
    const context = await newPublicationContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.read", "operator.write"],
      featureMethods: publicationMethods,
      presenceUsers: [
        { self: true, id: "alice", identity: { type: "profile", id: "alice" }, name: "Alice" },
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.github.options": publicationOptions,
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await showPublicationBranch(gateway);
    await page.getByRole("combobox", { name: "Publication account" }).selectOption("personal");
    await gateway.deferNext("sessions.github.publish");
    await page.getByRole("button", { name: "Publish PR" }).click();
    await gateway.waitForRequest("sessions.github.publish");
    const previousConnects = (await gateway.getRequests("connect")).length;
    await gateway.setOperatorScopes(["operator.read"]);
    await gateway.closeLatest();
    await gateway.waitForRequest("connect", { after: previousConnects });
    await showPublicationBranch(gateway);
    await expect
      .poll(() => page.getByRole("combobox", { name: "Publication account" }).count())
      .toBe(0);
    await gateway.resolveDeferred("sessions.github.publish", {
      requestId: "stale",
      status: "published",
      publisher: { source: "personal", ...personalAccount },
      url: "https://github.com/team/demo/pull/99",
      repository: "team/demo",
      branch: "feature/old",
      headCommit: "a".repeat(40),
    });
    await expect.poll(() => page.getByRole("button", { name: "Publish PR" }).count()).toBe(0);
    expect(await page.getByRole("link", { name: "Open PR" }).count()).toBe(0);
    expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
  });
});
