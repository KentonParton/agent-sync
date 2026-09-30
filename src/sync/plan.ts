import { posix } from "node:path";
import { relativePathSchema } from "../manifest/manifest.js";
import type { FileTree, Provenance, SourceFile } from "../sources/source.js";
export interface Output extends SourceFile {
  provenance: Provenance[];
  kind: "instructions" | "skill" | "mcp" | "plugin";
}
export class OutputPlan {
  readonly files = new Map<string, Output>();
  readonly warnings: string[] = [];
  add(
    path: string,
    file: SourceFile,
    kind: Output["kind"],
    provenance: Provenance[],
  ) {
    path = posix.normalize(relativePathSchema.parse(path));
    if (this.files.has(path))
      throw new Error(`Multiple resources produce ${path}`);
    for (const existing of this.files.keys()) {
      if (
        existing.toLowerCase() === path.toLowerCase() ||
        existing.toLowerCase().startsWith(`${path.toLowerCase()}/`) ||
        path.toLowerCase().startsWith(`${existing.toLowerCase()}/`)
      )
        throw new Error(`Overlapping output paths: ${path} and ${existing}`);
    }
    this.files.set(path, { ...file, kind, provenance });
  }
  text(
    path: string,
    text: string,
    kind: Output["kind"],
    provenance: Provenance[],
  ) {
    this.add(
      path,
      { content: Buffer.from(text), executable: false },
      kind,
      provenance,
    );
  }
  tree(
    path: string,
    files: FileTree,
    kind: Output["kind"],
    provenance: Provenance,
  ) {
    for (const [name, file] of files)
      this.add(posix.join(path, name), file, kind, [
        { ...provenance, path: posix.join(provenance.path, name) },
      ]);
  }
}
