# Onboarding verification

The default suite tests onboarding through the public CLI and library APIs using disposable Git repositories. It needs no private checkout, credentials, database, host application, or network connection.

```sh
npm run test:onboarding
```

## Covered scenarios

| Scenario                                  | Expected behavior                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| Existing tracked instructions             | Import preserves the index and instruction content; later source edits propagate.          |
| Different instructions by tool            | Separate fragments preserve their original tool scope.                                     |
| Skills in one tool                        | Complete skills, binary assets, and executable modes reach each selected tool.             |
| Cursor rules and commands                 | Existing behavior stays intact, with an explicit portability notice.                       |
| Equivalent MCP definitions                | JSON and TOML configurations become one shared server definition.                          |
| Partial setup                             | An untouched starter is backed up and replaced; edited sources are protected.              |
| Empty source directory                    | Import reuses the directory without replacing it.                                          |
| Empty state from an earlier checkout hook | Onboarding proceeds when the ledger owns no files or plugins.                              |
| Teammate clone                            | Clean committed outputs initialize without another checkout's private state.               |
| Local edits                               | Staged edits, unstaged edits, and staged deletions survive sync.                           |
| Branch checkout                           | The hook regenerates outputs from the selected branch and forwards the previous hook once. |
| Branch without a manifest                 | Tracked instructions stay under Git's control.                                             |
| Linked worktree                           | Each worktree has an independent baseline.                                                 |
| Hook manager reset                        | Reinstallation reconnects the existing manager without editing its scripts.                |
| Cancellation and review changes           | Cancellation writes nothing; changed inputs invalidate a reviewed plan.                    |

The suite also checks JSON output, hook readiness, removed resources, and repeated setup. Subprocess time limits turn recursive-hook regressions into failures rather than hangs.

## Optional repository acceptance

`test/repository-onboarding.test.ts` accepts a local repository with existing `AGENTS.md` instructions, importable tool configuration, and a `scripts/git-hooks/pre-commit` hook. Use a repository that has not completed Agent Sync migration, or one containing only its untouched starter:

```sh
AGENT_SYNC_TEST_REPO=/absolute/path/to/example-project npm test
```

This test makes disposable clones and checks migration, file preservation, teammate setup, checkout hooks, linked worktrees, and local-edit protection. It does not migrate the original checkout, install application dependencies, execute MCP servers, or run the supplied pre-commit script.

## Validation limits

These checks validate filesystem and Git behavior. They do not establish that every supported host version discovers and executes native plugins correctly. Native Codex integration is a separate opt-in test (`AGENT_SYNC_TEST_CODEX=1 npm test`) that changes the installed host's plugin state. Interactive host acceptance and Windows behavior remain outside the default suite.
