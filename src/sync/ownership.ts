import { git, type Repository } from "../git/repository.js";
import type { Manifest } from "../manifest/manifest.js";
import { equal, type Snapshot } from "./state.js";

/** Decide when a checked-in output may be managed without confusing checkout changes with local edits. */
export class OutputOwnership {
  private constructor(
    private committed: boolean,
    private tracked: Set<string>,
    private dirty: Set<string>,
  ) {}

  static async inspect(
    repo: Repository,
    mode: Manifest["outputs"] = "local",
    externalDestination = false,
  ) {
    if (externalDestination)
      return new OutputOwnership(false, new Set(), new Set());
    const tracked = new Set(
      (await git(repo.root, ["ls-files", "-z"])).split("\0").filter(Boolean),
    );
    const dirty =
      repo.head === "unborn"
        ? new Set(tracked)
        : new Set(
            (await git(repo.root, ["diff", "--name-only", "-z", "HEAD", "--"]))
              .split("\0")
              .filter(Boolean),
          );
    return new OutputOwnership(mode === "committed", tracked, dirty);
  }

  migrationReason(path: string): string | undefined {
    if (this.dirty.has(path) && !this.tracked.has(path))
      return "Staged deletion preserved. Resolve the deletion before generating this output.";
    if (this.tracked.has(path) && !this.committed)
      return "This destination is tracked by Git. Choose committed outputs to keep it in Git, or untrack it for local outputs.";
  }

  retain(path: string, desired: Snapshot | undefined): boolean {
    // Git controls the lifetime of committed files, including on branches without a manifest.
    return this.tracked.has(path) && !desired;
  }

  conflict(
    path: string,
    actual: Snapshot | null,
    baseline: Snapshot | undefined,
    desired: Snapshot | undefined,
    replace: boolean,
  ): string | undefined {
    if (!actual && !desired) return;
    const reason = this.migrationReason(path);
    if (reason) return reason;
    if (this.tracked.has(path)) {
      // A fresh clone or checkout may establish a baseline only from a clean, exact generated file.
      if (!this.dirty.has(path) && equal(actual, desired)) return;
      if (!baseline)
        return "Committed output differs from the generated result or has local/staged edits. Commit matching sources and outputs together; use import for initial migration.";
    }
    if (!baseline && actual) return "Existing file is not owned by agent-sync";
    if (baseline && !equal(actual, baseline) && !replace)
      return "Local changes preserved (including deletion or executable-mode changes)";
  }
}
