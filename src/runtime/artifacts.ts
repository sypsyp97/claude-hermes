import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { hermesDir, canonicalWorkspace } from "../paths";

export function artifactDirectory(workspace: string, sessionKey: string): string {
  return join(
    hermesDir(canonicalWorkspace(workspace)),
    "outbox",
    createHash("sha256").update(sessionKey).digest("hex")
  );
}

export function extractSendFileDirectives(text: string): { cleanedText: string; filePaths: string[] } {
  const paths = new Set<string>();
  const cleanedText = text
    .replace(/\[send-file:([^\]\r\n]+)\]/gi, (_match, raw: string) => {
      if (raw.trim()) paths.add(raw.trim());
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, filePaths: [...paths] };
}

/** Every conversation owns an explicit output directory; resolve symlinks before upload. */
export async function prepareArtifact(
  path: string,
  outbox: string,
  limit = 10 * 1024 * 1024
): Promise<{ name: string; file: Blob }> {
  const [root, resolved] = await Promise.all([realpath(outbox), realpath(path)]);
  if (root !== resolve(outbox)) throw new Error("Conversation outbox must not be a symlink");
  const rel = relative(root, resolved);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(rel)
  ) {
    throw new Error("File must be inside this conversation's outbox");
  }
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error("Artifact must be a regular file");
  if (info.size > limit) throw new Error("Artifact exceeds upload size limit");
  const bytes = await readFile(resolved);
  if (bytes.length > limit) throw new Error("Artifact exceeds upload size limit");
  return { name: basename(resolved), file: new Blob([bytes]) };
}
