import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";

export const MANIFEST_FILE = ".agent-sync.yaml";
export const harnessSchema = z.enum(["codex", "claude", "cursor"]);
export type Harness = z.infer<typeof harnessSchema>;
export const harnesses = harnessSchema.options;
export const nameSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    "Use a lowercase name with letters, digits, dots, dashes or underscores",
  );
export const relativePathSchema = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.split("/").some((s) => s === ".." || s.toLowerCase() === ".git") &&
      !/^[A-Za-z]:/.test(p) &&
      !/[\x00-\x1f]/.test(p),
    "Expected a relative path inside the repository, outside .git",
  );
const sourceFields = {
  source: z
    .string()
    .min(1)
    .refine(
      (s) => !s.startsWith("-") && !s.includes("\0") && !s.includes("::"),
      "Invalid Git source",
    )
    .optional(),
  ref: z
    .string()
    .min(1)
    .refine((s) => !s.startsWith("-") && !s.includes("\0"), "Invalid Git ref")
    .optional(),
  path: relativePathSchema,
};
const sourceSchema = z
  .strictObject(sourceFields)
  .refine((s) => !s.ref || !!s.source, "ref requires source");
const collectionSchema = z
  .strictObject({
    ...sourceFields,
    include: z.array(nameSchema).min(1).optional(),
  })
  .refine((s) => !s.ref || !!s.source, "ref requires source");
const pluginSchema = z
  .strictObject({
    source: sourceFields.source,
    ref: sourceFields.ref,
    path: relativePathSchema.optional(),
    catalog: relativePathSchema.optional(),
    include: z.array(nameSchema).min(1).optional(),
    targets: z.array(harnessSchema).min(1).optional(),
    mode: z.enum(["portable", "native"]).default("native"),
  })
  .refine(
    (s) => !!s.path !== !!s.catalog,
    "Choose exactly one of path or catalog",
  )
  .refine((s) => !s.ref || !!s.source, "ref requires source");
export const manifestSchema = z.strictObject({
  version: z.literal(1).default(1),
  targets: z
    .array(harnessSchema)
    .min(1)
    .refine((t) => new Set(t).size === t.length, "Duplicate target")
    .default([...harnesses]),
  outputs: z.enum(["local", "committed"]).default("local"),
  instructions: z
    .array(
      z
        .strictObject({
          ...sourceFields,
          targets: z.array(harnessSchema).min(1).optional(),
        })
        .refine((s) => !s.ref || !!s.source, "ref requires source")
        .refine(
          (s) =>
            !s.targets ||
            s.targets.includes("codex") === s.targets.includes("cursor"),
          "Codex and Cursor share AGENTS.md; target both together, or Claude separately",
        ),
    )
    .default([]),
  skills: z.array(collectionSchema).default([]),
  mcp: z.array(sourceSchema).default([]),
  plugins: z.array(pluginSchema).default([]),
});
export type Manifest = z.infer<typeof manifestSchema>;
export type SourceSpec = { source?: string; ref?: string; path: string };
export type PluginSpec = Manifest["plugins"][number];
export function parseManifest(text: string): Manifest {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length)
    throw new Error(
      `Invalid manifest: ${doc.errors.map((e) => e.message).join("; ")}`,
    );
  return manifestSchema.parse(doc.toJS({ maxAliasCount: 50 }));
}
export async function loadManifest(root: string): Promise<Manifest> {
  return parseManifest(await readFile(resolve(root, MANIFEST_FILE), "utf8"));
}
