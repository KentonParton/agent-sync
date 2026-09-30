import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
const exec = promisify(execFile);
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec(
    "git",
    ["-c", "protocol.ext.allow=never", ...args],
    {
      cwd,
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  return stdout.trimEnd();
}
export interface Repository {
  root: string;
  stateDir: string;
  head: string;
}
export async function repository(cwd: string): Promise<Repository> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const stateDir = resolve(
    root,
    await git(root, ["rev-parse", "--git-path", "agent-sync"]),
  );
  let head = "unborn";
  try {
    head = await git(root, ["rev-parse", "HEAD"]);
  } catch {
    /* Empty repositories are supported. */
  }
  return { root, stateDir, head };
}
