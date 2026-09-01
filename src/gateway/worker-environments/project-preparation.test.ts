import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import {
  createWorkerProjectPreparation,
  readWorkerProjectSetupRecipe,
} from "./project-preparation.js";
import { prepareWorkerProjectSnapshot, workerProjectSeedKey } from "./workspace-git-base.js";
import { parseWorkerWorkspaceManifest } from "./workspace-manifest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture(setup?: string, symlink = false) {
  const root = await fs.realpath(tempDirs.make("project-preparation-"));
  const repository = path.join(root, "repository");
  const home = path.join(root, "worker-home");
  await fs.mkdir(repository);
  await fs.mkdir(home);
  await requireGit(repository, ["init", "--quiet"]);
  await requireGit(repository, ["config", "user.name", "Project Test"]);
  await requireGit(repository, ["config", "user.email", "project@example.invalid"]);
  await fs.writeFile(path.join(repository, "input.txt"), "prepared base\n");
  if (symlink) {
    await fs.symlink("input.txt", path.join(repository, "linked-input"));
  }
  if (setup) {
    await fs.mkdir(path.join(repository, ".openclaw"));
    await fs.writeFile(path.join(repository, ".openclaw", "worktree-setup.sh"), setup, {
      mode: 0o755,
    });
    await fs.writeFile(path.join(repository, ".gitignore"), "build/\n");
  }
  await requireGit(repository, ["add", "."]);
  await requireGit(repository, ["commit", "--quiet", "-m", "base"]);
  const project = (await prepareWorkerProjectSnapshot({
    localPath: repository,
    namespace: "gateway",
  }))!;
  const runScript = vi.fn(async (script: string) =>
    execFileSync("sh", ["-c", script], {
      env: { ...process.env, HOME: home, PREPARATION_UNRELATED_ENV: "must-not-forward" },
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const upload = vi.fn(async (source: string, destination: string) => {
    await fs.copyFile(source, destination);
  });
  const operation = (requireCurrent = () => {}) =>
    createWorkerProjectPreparation({ project, namespace: "gateway", requireCurrent });
  const seed = path.join(
    home,
    ".openclaw-worker",
    "git-seeds",
    "gateway",
    workerProjectSeedKey(project),
  );
  const preparedOperation = async (requireCurrent = () => {}) =>
    createWorkerProjectPreparation({
      project,
      namespace: "gateway",
      preparation: {
        key: "a".repeat(64),
        demandAtMs: 1,
        setupRecipe: await readWorkerProjectSetupRecipe(project),
      },
      setupAuthorized: true,
      requireCurrent,
    });
  return { repository, home, project, seed, operation, preparedOperation, runScript, upload };
}

describe("project checkout preparation", () => {
  it("bounds retained checkouts and abandoned staging while preserving the current project", async () => {
    const f = await fixture();
    const namespace = path.dirname(f.seed);
    await fs.mkdir(namespace, { recursive: true });
    for (let index = 0; index < 8; index++) {
      const sibling = path.join(namespace, index.toString(16).repeat(64));
      await fs.mkdir(sibling);
      const future = new Date(Date.now() + (index + 1) * 60_000);
      await fs.utimes(sibling, future, future);
    }
    const stale = path.join(namespace, `.tmp-${"a".repeat(64)}-stale`);
    const fresh = path.join(namespace, `.tmp-${"b".repeat(64)}-fresh`);
    await fs.mkdir(stale);
    await fs.mkdir(fresh);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await fs.utimes(stale, old, old);
    const operation = f.operation();
    await operation.project.prepare(f);
    operation.close();
    const retained = await fs.readdir(namespace);
    expect(retained.filter((name) => /^[a-f0-9]{64}$/u.test(name))).toHaveLength(6);
    expect(retained).toContain(path.basename(f.seed));
    expect(retained).toContain(path.basename(fresh));
    expect(retained).not.toContain(path.basename(stale));
  });

  it.each([".openclaw-worker", ".openclaw-worker/git-seeds"])(
    "rejects a symlinked %s parent before writing outside the worker cache",
    async (relative) => {
      const f = await fixture();
      const outside = path.join(f.home, "outside");
      await fs.mkdir(outside);
      const link = path.join(f.home, relative);
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.symlink(outside, link);
      const operation = f.operation();
      await expect(operation.project.prepare(f)).rejects.toThrow(
        "Project seed directory escaped its owner",
      );
      operation.close();
      expect(await fs.readdir(outside)).toEqual([]);
      expect(f.upload).not.toHaveBeenCalled();
    },
  );

  it("captures the pinned clean base and reuses it without another Git pack upload", async () => {
    const f = await fixture();
    await requireGit(f.repository, [
      "remote",
      "add",
      "origin",
      "https://example.invalid/private.git",
    ]);
    await fs.writeFile(path.join(f.repository, "input.txt"), "later commit\n");
    await requireGit(f.repository, ["commit", "--quiet", "-am", "later"]);
    await fs.writeFile(path.join(f.repository, "private.txt"), "session-only input\n");
    const first = f.operation();
    expect(await first.project.prepare(f)).toEqual({
      seedKey: workerProjectSeedKey(f.project),
      cacheHit: false,
    });
    first.close();
    expect(await fs.readFile(path.join(f.seed, "input.txt"), "utf8")).toBe("prepared base\n");
    expect(await fs.readdir(f.seed)).toEqual(expect.arrayContaining([".git", "input.txt"]));
    expect(await fs.stat(path.join(f.seed, "private.txt")).catch(() => undefined)).toBeUndefined();
    expect(await requireGit(f.seed, ["remote"])).toBe("");
    expect(await requireGit(f.seed, ["status", "--porcelain"])).toBe("");
    expect(f.upload).toHaveBeenCalledTimes(1);
    const second = f.operation();
    expect(await second.project.prepare(f)).toEqual({
      seedKey: workerProjectSeedKey(f.project),
      cacheHit: true,
    });
    expect(f.upload).toHaveBeenCalledTimes(1);
    second.close();
  });

  it("rejects modified pack bytes before publishing a reusable checkout", async () => {
    const f = await fixture();
    const operation = f.operation();
    await expect(
      operation.project.prepare({
        runScript: f.runScript,
        upload: async (source, destination) => {
          const bytes = await fs.readFile(source);
          bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1);
          await fs.writeFile(destination, bytes);
        },
      }),
    ).rejects.toThrow("Project pack digest does not match");
    operation.close();
    expect(await fs.readdir(path.dirname(f.seed))).toEqual([]);
  });

  it("revokes retained callbacks when the provision owner changes during preparation", async () => {
    const f = await fixture();
    let current = true;
    const operation = f.operation(() => {
      if (!current) {
        throw new Error("owner replaced");
      }
    });
    await expect(
      operation.project.prepare({
        runScript: async (script) => {
          const result = await f.runScript(script);
          current = false;
          return result;
        },
        upload: f.upload,
      }),
    ).rejects.toThrow("owner replaced");
    expect(operation.project.signal.aborted).toBe(true);
    expect(f.upload).not.toHaveBeenCalled();
    expect(() => operation.project.prepare(f)).toThrow("owner replaced");
    operation.close();
  });

  it("runs the committed recipe once at stable workspace and HOME paths before reusing its source manifest", async () => {
    const f = await fixture(
      `#!/bin/sh
set -eu
test -z "\${PREPARATION_UNRELATED_ENV:-}"
test "$PWD" = "$OPENCLAW_SOURCE_TREE_PATH"
test "$PWD" = "$OPENCLAW_WORKTREE_PATH"
mkdir build
printf '%s\\n' "$HOME" > build/home
printf '#!/bin/sh\\ncat %s/input.txt\\n' "$PWD" > build/read-source
chmod +x build/read-source
printf 'setup\\n' >> "$HOME/count"
`,
      true,
    );
    const first = await f.preparedOperation();
    // Mutable local script bytes are never admitted into the pristine generation.
    await fs.writeFile(path.join(f.repository, ".openclaw", "worktree-setup.sh"), "exit 99\n");
    const result = await first.project.prepare(f);
    first.close();
    const prepared = result.preparedWorkspace!;
    expect(first.getPreparedWorkspace()).toEqual(prepared);
    const directory = path.join(f.home, ".openclaw-worker", "prepared", "gateway", "a".repeat(64));
    expect(prepared).toMatchObject({
      preparationKey: "a".repeat(64),
      workspaceDir: path.join(directory, "workspace"),
      homeDir: path.join(directory, "home"),
    });
    expect(await fs.readFile(path.join(prepared.homeDir, "count"), "utf8")).toBe("setup\n");
    expect(await fs.readlink(path.join(prepared.workspaceDir, "linked-input"))).toBe("input.txt");
    expect(await fs.readFile(path.join(prepared.workspaceDir, "build", "home"), "utf8")).toBe(
      `${prepared.homeDir}\n`,
    );
    expect(
      execFileSync(path.join(prepared.workspaceDir, "build", "read-source"), { encoding: "utf8" }),
    ).toBe("prepared base\n");
    const raw = await fs.readFile(
      path.join(
        prepared.homeDir,
        ".openclaw-worker",
        "manifests",
        `${prepared.sourceManifestRef.slice(7)}.json`,
      ),
      "utf8",
    );
    const manifest = parseWorkerWorkspaceManifest(raw, prepared.sourceManifestRef);
    expect(manifest.baseCommit).toBe(f.project.baseCommit);
    expect(manifest.entries.some((entry) => entry.path.startsWith("build/"))).toBe(false);
    const second = await f.preparedOperation();
    expect(await second.project.prepare(f)).toEqual({ ...result, cacheHit: true });
    second.close();
    expect(await fs.readFile(path.join(prepared.homeDir, "count"), "utf8")).toBe("setup\n");
    expect(f.upload).toHaveBeenCalledTimes(1);
    await fs.writeFile(path.join(prepared.workspaceDir, "linked-input"), "session edit\n");
    expect(await fs.readFile(path.join(f.seed, "input.txt"), "utf8")).toBe("prepared base\n");
  });

  it("settles successful setup descendants before publishing the prepared workspace", async () => {
    const f = await fixture(`#!/bin/sh
sleep 300 &
printf '%s' "$!" > "$HOME/setup-child"
`);
    const operation = await f.preparedOperation();
    const childFile = path.join(
      f.home,
      ".openclaw-worker",
      "prepared",
      "gateway",
      "a".repeat(64),
      "home",
      "setup-child",
    );
    try {
      expect((await operation.project.prepare(f)).preparedWorkspace).toBeDefined();
      const pid = Number(await fs.readFile(childFile, "utf8"));
      let state: string;
      try {
        state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
      } catch {
        state = "";
      }
      expect(state === "" || state.startsWith("Z")).toBe(true);
    } finally {
      operation.close();
      const pid = Number(await fs.readFile(childFile, "utf8").catch(() => ""));
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already reaped. */
        }
      }
    }
  });

  it("prepares a recipe-free project without inventing setup authority", async () => {
    const f = await fixture();
    expect(await readWorkerProjectSetupRecipe(f.project)).toBeUndefined();
    const operation = createWorkerProjectPreparation({
      project: f.project,
      namespace: "gateway",
      preparation: { key: "a".repeat(64), demandAtMs: 1 },
      requireCurrent: () => {},
    });
    expect(operation.getPreparedWorkspace()).toBeUndefined();
    const result = await operation.project.prepare(f);
    operation.close();
    expect(result.preparedWorkspace?.sourceManifestRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(
      await fs.readFile(path.join(result.preparedWorkspace!.workspaceDir, "input.txt"), "utf8"),
    ).toBe("prepared base\n");
  });

  it.each(["failed recipe", "modified source"])(
    "does not rerun or publish an incomplete preparation after %s",
    async (failure) => {
      const f = await fixture(`#!/bin/sh
printf 'setup\\n' >> "$HOME/count"
${failure === "failed recipe" ? "exit 17" : "printf changed > input.txt"}
`);
      const first = await f.preparedOperation();
      await expect(first.project.prepare(f)).rejects.toThrow(
        failure === "failed recipe"
          ? "Prepared project setup failed"
          : "modified its source manifest",
      );
      first.close();
      const second = await f.preparedOperation();
      await expect(second.project.prepare(f)).rejects.toThrow();
      second.close();
      const home = path.join(
        f.home,
        ".openclaw-worker",
        "prepared",
        "gateway",
        "a".repeat(64),
        "home",
      );
      expect(await fs.readFile(path.join(home, "count"), "utf8")).toBe("setup\n");
      expect(await fs.readdir(path.join(home, ".openclaw-worker", "manifests"))).toEqual([]);
    },
  );

  it("requires administrator authority for a pinned setup and rechecks the owner after seed installation", async () => {
    const f = await fixture('#!/bin/sh\nprintf setup > "$HOME/count"\n');
    const setupRecipe = await readWorkerProjectSetupRecipe(f.project);
    expect(setupRecipe).toMatch(/^[a-f0-9]{40}$/u);
    expect(() =>
      createWorkerProjectPreparation({
        project: f.project,
        namespace: "gateway",
        preparation: { key: "a".repeat(64), demandAtMs: 1, setupRecipe },
        requireCurrent: () => {},
      }),
    ).toThrow("operator.admin");
    const seed = f.operation();
    await seed.project.prepare(f);
    seed.close();
    let current = true;
    const prepared = await f.preparedOperation(() => {
      if (!current) {
        throw new Error("owner replaced");
      }
    });
    await expect(
      prepared.project.prepare({
        upload: f.upload,
        runScript: async (script) => {
          const output = await f.runScript(script);
          current = false;
          return output;
        },
      }),
    ).rejects.toThrow("owner replaced");
    prepared.close();
    expect(
      await fs.stat(path.join(f.home, ".openclaw-worker", "prepared")).catch(() => undefined),
    ).toBeUndefined();
  });
});
