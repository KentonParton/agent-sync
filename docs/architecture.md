# Architecture

The public boundary is a manifest of owned resources, a synchronization result, and explicit commands for local conflict resolution and upstream contribution. The program does not choose an IDE as its source of truth.

- `manifest` owns the versioned configuration contract and safe resource names/paths.
- `sources` resolves declared local/Git sources, caches exact source/ref combinations, reads complete binary file trees without executing them, and supplies provenance.
- `instructions`, `skills`, `mcp`, and `plugins` own composition, validation, naming, and target-specific interpretation for their resource domain. Plugin packages are retained intact; portable projection is explicitly selected.
- `sync` owns output collision detection, file ownership, change classification, whole-plan conflict checks, atomic file replacement, rollback journals, and worktree-local baselines. The output ownership policy separates local and committed outputs. Committed files can establish a baseline on a fresh clone only when clean and identical to the generated result; a tracked file removed from the desired environment remains under Git’s control.
- `onboarding` routes init to import, existing-manifest setup, or starter creation. Recovery recognizes only the exact untouched starter, archives it before migration, and protects custom source material.
- `git` owns repository/worktree discovery and hook installation. Hooks call the same CLI/library synchronization path.
- `import` owns discovery, exact consolidation, conflict selection, review identifiers, and the complete onboarding migration. It validates proposed sources and destinations through the environment planner before writing. The terminal command guides source choices and confirmation, then internally revalidates the reviewed plan, backs up originals, creates sources, records management of the selected destinations, and generates the tool files under one lock. Mixed-purpose destinations block migration, and local-output mode also blocks tracked destinations; unrelated configuration is never captured. The library keeps preview and apply explicit for callers.
- `contributions` routes edited outputs back to source revisions, reconciles three-way merges, and prepares isolated contribution branches. Publication is a separate explicit option.
- `plugins/activation` uses native host registration and a separate installation ledger. Native activation is an opt-in user-scoped side effect; it is not equivalent to writing repository files.

## Important tradeoffs

Whole-file ownership is conservative. It makes existing mixed-purpose host configuration a migration requirement, but avoids claiming or deleting settings the synchronizer did not create. A future key-level configuration editor must have its own per-entry provenance and conflict model; it must not bypass whole-file checks.

Source content is data. No dependency installation or plugin hook executes during resolution. Native hosts remain responsible for trust and runtime policy. SSH authentication is inherited from Git; interactive terminal prompts are disabled and network commands are bounded.

The output transaction is journaled, not a cross-filesystem database transaction. Caught write failures roll back only if the output still matches the just-written version. A surviving journal blocks further automatic writes until inspected. Native host installation occurs after this transaction and can fail separately.

Worktree state is resolved through Git rather than assuming `.git` is a directory. Source caches and instruction baselines cannot leak between branches through a single branch-independent “last source” value. The active baseline records the prior output regardless of current branch; that is what distinguishes branch changes from developer edits.

Plugin portability is limited by the underlying host. Agent Plugins 1.0 covers skills and MCP. Native hooks, agents, approval policy, and discovery remain host-specific. A package lacking a selected target's manifest or the portable manifest fails clearly instead of silently losing its behavior.
