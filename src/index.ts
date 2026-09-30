export { sync, type SyncOptions } from "./sync/sync.js";
export {
  parseManifest,
  manifestSchema,
  type Manifest,
  type Harness,
  type SourceSpec,
} from "./manifest/manifest.js";
export {
  diff,
  merge,
  promote,
  type PromoteOptions,
} from "./contributions/contributions.js";
export { installHooks, writeHookTemplate } from "./git/hooks.js";
export { activate, type NativeTarget } from "./plugins/activation.js";
export type { SyncResult, Change } from "./sync/state.js";
export type { Provenance } from "./sources/source.js";

export {
  importResources,
  type ImportOptions,
  type ImportPlan,
} from "./import/import.js";
