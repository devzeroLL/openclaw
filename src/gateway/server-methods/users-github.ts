import {
  ErrorCodes,
  errorShape,
  validateUsersGitHubStatusParams,
  validateUsersGitHubAuthorizeStartParams,
  validateUsersGitHubAuthorizePollParams,
  validateUsersGitHubAuthorizeCancelParams,
  validateUsersGitHubDisconnectParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveGitHubToolIdentityStatus } from "../../agents/github-tool-identity.js";
import { preparePersonalGitHubAction } from "./github-personal-authorization.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const usersGitHubHandlers: GatewayRequestHandlers = {
  "users.github.status": async (options) => {
    const { params, respond, context } = options;
    if (
      !assertValidParams(params, validateUsersGitHubStatusParams, "users.github.status", respond)
    ) {
      return;
    }
    try {
      const action = preparePersonalGitHubAction(options);
      const service = context.githubOAuthService?.personal;
      if (!service) {
        throw new Error("GitHub connections are unavailable; retry after Gateway startup.");
      }
      const config = context.getRuntimeConfig();
      const system = await resolveGitHubToolIdentityStatus({
        config,
        agentId: resolveDefaultAgentId(config),
        selectedScope: "system",
      });
      const personal = await service.status(action);
      action.assertCurrent();
      respond(true, { personal, system: system.selected.identity });
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          error instanceof Error ? error.message : "My GitHub is unavailable.",
        ),
      );
    }
  },
  "users.github.authorize.start": async (options) => {
    if (
      !assertValidParams(
        options.params,
        validateUsersGitHubAuthorizeStartParams,
        "users.github.authorize.start",
        options.respond,
      )
    ) {
      return;
    }
    try {
      const action = preparePersonalGitHubAction(options);
      const service = options.context.githubOAuthService?.personal;
      if (!service) {
        throw new Error("GitHub connections are unavailable; retry after Gateway startup.");
      }
      const result = await service.startAuthorization(action);
      action.assertCurrent();
      options.respond(true, result);
    } catch (error) {
      options.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          error instanceof Error ? error.message : "My GitHub authorization failed.",
        ),
      );
    }
  },
  "users.github.authorize.poll": async (options) => {
    if (
      !assertValidParams(
        options.params,
        validateUsersGitHubAuthorizePollParams,
        "users.github.authorize.poll",
        options.respond,
      )
    ) {
      return;
    }
    try {
      const action = preparePersonalGitHubAction(options);
      const service = options.context.githubOAuthService?.personal;
      if (!service) {
        throw new Error("GitHub connections are unavailable; retry after Gateway startup.");
      }
      const result = await service.pollAuthorization(action, options.params.requestId);
      action.assertCurrent();
      options.respond(true, result);
    } catch (error) {
      options.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          error instanceof Error ? error.message : "My GitHub authorization failed.",
        ),
      );
    }
  },
  "users.github.authorize.cancel": (options) => {
    if (
      !assertValidParams(
        options.params,
        validateUsersGitHubAuthorizeCancelParams,
        "users.github.authorize.cancel",
        options.respond,
      )
    ) {
      return;
    }
    try {
      const action = preparePersonalGitHubAction(options);
      const service = options.context.githubOAuthService?.personal;
      if (!service) {
        throw new Error("GitHub connections are unavailable; retry after Gateway startup.");
      }
      options.respond(true, {
        cancelled: service.cancelAuthorization(action, options.params.requestId),
      });
    } catch (error) {
      options.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          error instanceof Error ? error.message : "My GitHub authorization failed.",
        ),
      );
    }
  },
  "users.github.disconnect": (options) => {
    if (
      !assertValidParams(
        options.params,
        validateUsersGitHubDisconnectParams,
        "users.github.disconnect",
        options.respond,
      )
    ) {
      return;
    }
    try {
      const action = preparePersonalGitHubAction(options);
      const service = options.context.githubOAuthService?.personal;
      if (!service) {
        throw new Error("GitHub connections are unavailable; retry after Gateway startup.");
      }
      service.disconnect(action);
      options.respond(true, { disconnected: true });
    } catch (error) {
      options.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          error instanceof Error ? error.message : "My GitHub disconnect failed.",
        ),
      );
    }
  },
};
