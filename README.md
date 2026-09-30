# Agent Sync

A TypeScript library and CLI that synchronizes a Git repository's agent instructions, skills, MCP servers, and complete plugin packages across Codex, Claude Code, and Cursor. A checked-in manifest selects the environment; a Git `post-checkout` hook updates it when branches change.

Agent Sync preserves local edits, requires an explicit import before managing existing files, and can prepare changes for contribution back to their owning Git repositories. This is an early preview, not a published npm release. APIs and configuration may change before 1.0.

## Quick start

Requires Node.js 22+ and Git. Native Codex activation additionally requires a Codex CLI with `plugin marketplace add` and `plugin add`. Publishing draft pull requests requires an authenticated GitHub CLI and Git commit identity.

In this library's checkout, install dependencies, build the CLI, and make `agent-sync` available in your terminal:

```sh
npm ci
npm run build
npm link
```

Then, in your application repository:

```sh
agent-sync init
```

`init` detects what is already there. Existing tool configuration starts guided import; an existing Agent Sync manifest sets up this checkout from its shared sources. An empty project gets starter instructions to edit before its first sync. After successful setup, the interactive command offers checkout automation.

For a new project, edit `.agent/instructions.md`, then run:

```sh
agent-sync sync
agent-sync install-hooks
```

New setups use `outputs: committed`. Review and commit `.agent-sync.yaml`, `.agent/`, and the generated tool files together. Existing tracked instructions and skills can stay in Git. Teammates can clone the repository and run `agent-sync init`; a clean generated file that matches the shared sources establishes that checkout's local baseline. Staged or unstaged output edits are preserved.

Prefer generated files outside Git? Start with `agent-sync init --outputs local`, then ignore the generated paths your manifest uses:

```gitignore
/AGENTS.md
/CLAUDE.md
/.agents/skills/
/.agents/plugins/marketplace.json
/.claude/skills/
/.cursor/skills/
/.cursor/mcp.json
/.codex/config.toml
/.mcp.json
/.agent-sync/
```

Agent Sync does not stage, commit, untrack files, or edit `.gitignore`. In local mode, tracked destinations still block migration and sync. Existing mixed-purpose MCP/settings files need deliberate migration; Agent Sync owns whole output files, not individual keys.

Run `agent-sync sync --dry-run` to preview changes. `--offline` uses only the verified cache for the exact Git source and ref. If an online fetch fails after a previous successful fetch, sync uses that cache and reports a warning. Pin a commit SHA for reproducible environments.

## Import an existing environment

The commands follow the direction of the data:

| Command  | What it does                                                                                                        | When to use it                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `import` | Collects existing tool configuration into shared `.agent/` sources, then updates the tool files from those sources. | Once, when setting up an existing environment.                  |
| `sync`   | Reads `.agent-sync.yaml` and its declared sources, then updates each tool's configuration.                          | After changing shared sources, or automatically after checkout. |
| `init`   | Detects existing configuration and guides setup, imports, or sets up an existing manifest.                          | The starting point for a project or a teammate’s new checkout.  |

Use `init` to choose the appropriate setup flow, or invoke migration directly:

```sh
agent-sync import
```

After setup, edit the sources in `.agent/` and run `agent-sync sync` to update the tools.

In a terminal, `import` shows what it found, asks you to choose between conflicting definitions, and previews the shared sources and tool files. After confirmation, it backs up existing destinations, creates `.agent-sync.yaml` and the needed sources under `.agent/`, and generates the consolidated environment. There is no separate ownership command or plan ID to copy. Cancelling before confirmation changes nothing. Native plugins still use the activation steps described below.

Import is an onboarding operation. An existing manifest, nonempty `.agent` directory, or active sync state is protected. An empty `.agent/` directory can be reused. The exact, untouched starter from an earlier `init` is recognized, backed up, and replaced after confirmation; edited starters and additional source files are left untouched. Once setup is complete, edit the shared sources and use `sync`; sync does not collect edits back from tool files. Use `diff` and `promote` for those edits.

```sh
agent-sync import --dry-run
agent-sync import --yes
agent-sync import --dry-run --json
```

`--dry-run` previews without prompts or changes; `--yes` completes setup without prompting. These options also work with `init`. Without an interactive terminal, import previews only. `--yes` allows scripts to apply a valid migration; unresolved conflicts still stop it. `--json` returns one JSON result and previews only unless combined with `--yes`. The guided command automatically checks that the reviewed inputs have not changed before writing. Advanced scripts may pass `--expect` with the `id` from a previous JSON preview to require that exact plan; it is optional.

The plan lists resource origins, duplicates, conflicts, differently named equivalents, files to create, and retained originals. It omits resource contents and literal secret values. Literal MCP environment/header values are preserved in the new source with a warning; review them before committing, especially when including personal configuration.

- **Instructions:** byte-identical files become one fragment. Different project `AGENTS.md` and `CLAUDE.md` files keep their respective tool scopes, avoiding duplicated or conflicting policy. A pure Claude `@AGENTS.md` adapter is recognized. Other Markdown imports need deliberate migration. Cursor rules and commands stay in place with their original behavior; the preview lists them as retained, not translated.
- **MCP:** supported JSON/TOML settings normalize into the same canonical representation, including Claude/Cursor environment references and Codex variable forwarding. Equivalent same-name servers collapse; argument order and variable identities remain significant. Unsupported settings are explicit issues.
- **Skills:** deduplication compares the full directory, binary assets, and executable modes. Matching `SKILL.md` alone is insufficient.
- **Plugins:** entire packages remain native packages, with their supported targets. Bundled skills are not separately imported. Host-specific manifests must agree on the package name.

Same-name differences need a source choice. The guided command offers numbered choices; scripts can use the exact keys and source IDs from the preview:

```sh
agent-sync import --yes --select 'mcp:api=project:.cursor/mcp.json#api'
agent-sync import --exclude 'project:.codex/config.toml#unsupported-server'
```

`--select` and `--exclude` are repeatable. Use the same options when previewing and applying from separate script invocations. Differently named equivalents are suggestions only; import keeps their names because other resources may reference them. Unknown selections and exclusions are reported. Excluding an unsupported resource leaves the original in place, not silently removed.

Discovery covers project `AGENTS.md`, `CLAUDE.md`, legacy `.cursorrules`, the three MCP locations above, current skill directories plus legacy `.codex/skills`, local plugin catalogs, and plugin directories/caches under `.codex`, `.claude`, and `.cursor`. Catalogs resolve local entries only; import does not fetch or execute anything. Plugin recursion is bounded and symlinks are rejected. JSON configuration must be valid JSON; JSONC comments are not currently supported.

User configuration is opt-in:

```sh
agent-sync import --user
agent-sync import --user --home /path/to/a/home-directory
agent-sync import --target claude --target cursor
```

`--user` adds standard locations under the given home (default: the OS home), including `.codex/AGENTS.md`, `.claude/CLAUDE.md`, `.claude.json` MCP entries, shared skills, and plugin caches. Custom host-home environment variables are not resolved; `--home` selects a complete home layout. User caches can contain inactive packages or multiple versions, so review the selection. Home files are never modified or deleted. Project instruction fragments precede user fragments in the manifest; review their order in the shared sources.

Import checks destinations before creating sources. Committed output mode keeps tracked destinations in Git, backs up their current contents, and records their baseline as part of the confirmed migration. A file containing unrelated or excluded settings cannot be replaced: migrate those settings separately, or leave that tool out with `--target`. Existing files are managed only when their complete contents were included in the reviewed migration. Later syncs preserve local changes and report conflicts.

The completion message prints the backup path under the worktree's Git state directory. Backups preserve original destination contents and executable modes. Originals listed under `retained`, including legacy locations and catalog-owned packages, stay in place and remain unmanaged; review them to avoid duplicate host discovery.

The library exposes the same workflow:

```ts
import { importResources } from "@agent-sync/core";

const preview = await importResources({ cwd: "/repos/service" });
if (!preview.conflicts.length && !preview.issues.length) {
  // After reviewing the preview, complete the whole migration.
  await importResources({
    cwd: "/repos/service",
    apply: true,
    expect: preview.id,
  });
}
```

## Manifest

`.agent-sync.yaml` is the only source-selection configuration. Paths are relative to the selected repository. Omit `source` for application-repository files. Instructions compose in array order; resource names must be unique. An instruction entry can set `targets: [claude]` or `targets: [codex, cursor]` to preserve tool-specific policy. Codex and Cursor share `AGENTS.md`. Entries without targets apply to all tools. Older manifests without `outputs` retain local-output behavior.

```yaml
version: 1
targets: [codex, claude, cursor]
outputs: committed

instructions:
  - source: git@github.com:your-org/agent-policy.git
    ref: main
    path: instructions/company.md
  - path: .agent/instructions.md

skills:
  - source: https://github.com/your-org/agent-policy.git
    ref: main
    path: skills
    include: [review, testing]
  - path: .agent/skills

mcp:
  - path: .agent/mcp.json

plugins:
  # Complete native plugin package. Native is the default mode.
  - path: .agent/plugins/team-tools

  # Select plugins from an existing Claude/Codex/Cursor-style local catalog.
  - source: git@github.com:your-org/plugins.git
    ref: main
    catalog: .claude-plugin/marketplace.json
    include: [backend]
    targets: [claude]

  # Explicit compatibility mode: preserve the whole package, expose skills/MCP
  # through project files, and report host-specific extensions.
  - path: .agent/plugins/portable-tools
    mode: portable
```

`skills.path` contains child directories with `SKILL.md`. Each skill needs YAML `name` and `description` frontmatter; supporting files and executable bits are preserved. `plugins.path` accepts a single plugin or a collection of plugin directories. Catalog sources must be relative paths within the selected repository, either strings or `{ source: local, path: ... }`; nested remote catalog entries are deliberately rejected. Select an external repository using the manifest's `source` instead. Catalog names and package manifest names should match.

Paths cannot escape a repository or enter `.git`. Symlinks, submodules, nonregular files, duplicate destinations, and unsupported configuration fields are rejected before generated outputs are changed. Fetching source repositories never runs package install scripts or plugin hooks.

## MCP configuration

MCP sources use an explicit portable representation. Secrets remain environment references; Agent Sync never reads their values.

```json
{
  "mcpServers": {
    "local-tools": {
      "command": "node",
      "args": ["tools/server.js"],
      "env": { "LOG_LEVEL": "info" },
      "envFrom": { "API_TOKEN": "API_TOKEN" }
    },
    "remote-tools": {
      "url": "https://example.com/mcp",
      "bearerTokenEnv": "SERVICE_TOKEN",
      "headersFrom": { "X-Tenant": "TENANT_ID" }
    }
  }
}
```

Stdio and streamable HTTP are supported. Codex receives TOML `mcp_servers`, `env_vars`, `env_http_headers`, and `bearer_token_env_var`. Claude receives `.mcp.json`; Cursor receives `.cursor/mcp.json`. `envFrom` keys must equal their variable names when Codex is selected, because Codex's forwarding setting cannot rename variables. Unknown settings and untranslatable interpolation fail explicitly. Authentication and host approval remain the host's responsibility.

## Plugins and host support

Agent Sync consumes existing manifests; it does not introduce a plugin authoring format or flatten native plugins into standalone skills.

| Resource          | Codex                                              | Claude Code                              | Cursor                                                |
| ----------------- | -------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| Instructions      | `AGENTS.md`                                        | `CLAUDE.md` imports `AGENTS.md`          | `AGENTS.md`                                           |
| Standalone skills | `.agents/skills/`                                  | `.claude/skills/`                        | `.cursor/skills/`                                     |
| MCP               | `.codex/config.toml`                               | `.mcp.json`                              | `.cursor/mcp.json`                                    |
| Native plugins    | Repository marketplace + official CLI installation | Whole plugin in `.claude/skills/<name>/` | Whole plugin in the user-level local plugin directory |

Native packages may use root `plugin.json` (Agent Plugins 1.0), `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, or `.cursor-plugin/plugin.json`. A host-specific package must have the selected host's manifest. Supply prebuilt host variants in separate manifest entries or select only compatible targets. Agent Sync does not translate hook event semantics or run dependency installers. A portable package gets a Claude discovery manifest and MCP transport adapter when needed; its original contents remain in `.agent-sync/plugins/`.

After the first sync, opt into native installation once per repository:

```sh
agent-sync activate codex
agent-sync activate cursor
```

Subsequent syncs and checkout hooks refresh those installations. Codex uses its official CLI to register a repository-specific marketplace and install complete packages. Cursor gets copies under `~/.cursor/plugins/local/` using repository-specific folder names. Existing installed files are checked against the recorded baseline before updates. Claude's project-local discovery needs no separate activation command.

Native installations are **user-scoped** in Codex and Cursor. They can be visible in other projects; repository-specific installation identities prevent cache overwrites but do not provide per-window isolation. Do not enable conflicting native plugins from multiple repositories simultaneously. Use `mode: portable` for strictly project-scoped skills/MCP integration. Hosts may require trust, authentication, plugin approval, local-import permission, or a restart/reload. Cursor enterprise policy can disallow local plugins. The Codex desktop app and CLI support plugins; current OpenAI documentation says the separate Codex IDE extension does not.

`mode: portable` requires the Agent Plugins 1.0 root manifest. It retains the package and projects skills and MCP to project-local files with plugin-prefixed names. It reports host-specific extensions rather than claiming to activate them. The supported plugin MCP subset is stdio and streamable HTTP with literal settings and `${PLUGIN_ROOT}` references; `cwd`, `${PLUGIN_DATA}`, other substitutions, and legacy SSE require native mode. Skills should keep supporting resources within their skill directory when using projection. Native Cursor inherits Cursor's documented lack of `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` substitution support.

## Checkout automation

`install-hooks` creates a managed hook directory in Git's per-worktree operational state and configures the repository's `core.hooksPath`. It chains an existing `post-checkout` and forwards other existing hooks, including hooks from an existing hook manager. It never edits those original scripts. Installation requires a successful sync. Reinstalling is idempotent. If a team setup task resets `core.hooksPath` to its own hook manager, rerun `agent-sync install-hooks` to reconnect it. Locally edited Agent Sync wrappers are protected.

The hook runs on branch checkouts (`$3 = 1`), including linked-worktree creation, and skips file-only checkouts. It resolves the manifest from the current checkout. A branch without a manifest retires clean untracked outputs and retains tracked files under Git’s control. Local conflicts preserve files and print a diagnostic without failing an otherwise successful Git checkout. The previous hook's exit status is preserved. The Node executable and CLI path are captured at installation, so keep that installation available.

Git does not distribute hooks through normal repository commits. Install once per clone, or create an opt-in Git template for future clones:

```sh
agent-sync hook-template /absolute/path/to/agent-sync-template
git clone --template=/absolute/path/to/agent-sync-template YOUR_REPOSITORY
```

No global Git configuration is changed. If your hook manager adds new hook filenames, rerun `install-hooks` to refresh forwarding. Current automated coverage runs on macOS and Linux; Windows host behavior is not yet verified.

## Local edits and contributions

```sh
agent-sync diff
agent-sync keep
agent-sync sync
agent-sync merge AGENTS.md
agent-sync replace AGENTS.md
agent-sync promote AGENTS.md
agent-sync promote AGENTS.md --source-index 1
agent-sync promote .agents/skills/review/SKILL.md --publish \
  --title 'Improve review guidance' --body 'Explain the change and validation.'
```

Promotion uses recorded provenance, clones the source into an isolated contribution checkout, starts from the recorded revision, creates a `codex/agent-sync-*` branch, and stages a reviewable patch. It does not modify the source repository or application checkout. Without `--publish`, it does not commit, push, or create a PR. With `--publish`, it commits, pushes the review branch, and creates a draft GitHub PR. It never pushes to the source's default branch. Local-source changes produce a reviewable checkout and patch; publishing those requires explicitly targeting the application repository yourself.

For combined instructions, promotion identifies a single changed fragment or requires `--source-index` (zero-based) when ambiguous. Skills and native package files map to their original paths. Single-source MCP outputs can be translated back into the canonical source representation; ambiguous multi-source MCP edits and unknown host-specific settings require editing the declared sources directly. Generated adapter files are not contribution sources. Promote one file at a time; additions/deletions should be authored in the source repository. Changes made directly inside a host's native cache are protected, but must first be brought back to the corresponding managed package file for promotion.

`keep` leaves the original baseline intact: it does not relabel a local edit as generated content. Sync continues to report that divergence. `replace` cannot seize an unowned file; it can replace an owned tracked output when the manifest uses committed outputs. Merge conflicts leave the active file untouched and write conflict markers separately. A clean merge retains the upstream baseline so the retained local improvement remains visible to `diff` and `promote`.

## Library API

```ts
import { sync, installHooks, diff, promote, activate } from "@agent-sync/core";

const result = await sync({ cwd: "/repos/service", offline: false });
if (!result.applied) {
  console.log(result.changes.filter((change) => change.action === "conflict"));
}

await installHooks("/repos/service");
const edits = await diff("/repos/service");
const contribution = await promote("AGENTS.md", { cwd: "/repos/service" });
await activate("codex", { cwd: "/repos/service" });
```

Exports include typed manifest parsing, synchronization results, provenance, three-way merge, hook-template generation, and native activation. CLI exit codes: `0` success/preview, `2` output conflicts, `1` validation, resolution, activation, or execution errors.

## State and failure handling

Operational state lives at `git rev-parse --git-path agent-sync`, so linked worktrees have independent baselines. It contains active baselines, Git-source caches, conflict candidates, backups, contribution checkouts, native-activation records, and a transaction journal. These can include private source content; do not publish them. Generated files and state are written with restrictive permissions; executable resources retain their executable status.

All source resolution and output validation finish before generated writes. A conflict blocks the repository output transaction. Individual files are replaced atomically, caught failures roll back, and a journal survives interrupted transactions. Another process cannot acquire the same sync lock. After a crash, inspect `lock/owner.json` and `journal.json`; restore or preserve the recorded files before removing stale operational markers. There is no automatic crash recovery that could overwrite edits made after the crash. Do not delete operational state as a way to resolve conflicts: doing so loses ownership and provenance.

Dry runs do not modify outputs, native installations, or the active baseline; they may refresh source caches and use a temporary lock. Native host activation happens after the repository transaction and has a separate failure boundary. If activation fails, generated repository files can already be current while a host still uses its prior package; resolve the reported issue and rerun sync. Multi-file updates are not filesystem-wide atomic against power loss or unrelated editors.

## Development

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

Run `npm run test:onboarding` for the minimal team onboarding scenarios. They use disposable Git repositories and run in the default suite without needing an external checkout. The [onboarding coverage guide](docs/onboarding-verification.md) describes these scenarios.

For an opt-in acceptance run against a local repository with existing agent configuration, set `AGENT_SYNC_TEST_REPO` to its path when running `npm test`. The test makes disposable clones, reproduces the partial starter setup, and verifies migration, a teammate clone, checkout hooks, linked worktrees, and local-edit protection. It does not migrate the original checkout.

Tests exercise filesystem ownership, real Git checkouts, worktrees, offline Git sources, binary assets, secret references, whole plugin packages, native Cursor copies, merges, and contribution branches. CI runs the build and tests on Node.js 22 and 24 on Linux and macOS. Native application UI loading and authenticated remote PR publication require host-level acceptance testing.

The implementation is organized around manifest validation, source resolution, instruction composition, skills, MCP, plugins, synchronization, Git integration, and source contributions. See [architecture notes](docs/architecture.md).

## Format references

- [vsync](https://github.com/nicepkg/vsync) — useful prior art for cross-tool synchronization. This implementation uses a repository manifest, composed sources, checkout automation, preserved local edits, complete packages, and source contribution workflows.
- [Agent Plugins 1.0](https://agent-plugins.org/) and [Vercel's announcement](https://vercel.com/blog/introducing-agent-plugins).
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins), [plugin surfaces](https://learn.chatgpt.com/docs/plugins), and [MCP configuration](https://developers.openai.com/codex/mcp).
- [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference), including project skills-directory discovery.
- [Cursor plugins](https://cursor.com/docs/plugins), [plugin reference](https://cursor.com/docs/reference/plugins), and [MCP configuration](https://cursor.com/docs/mcp).

Host APIs evolve independently. Format behavior was checked against these references and the installed Codex CLI during development; this library does not promise identical host-specific plugin capabilities across all surfaces.

## License

[MIT](LICENSE).
