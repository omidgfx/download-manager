import path from "path";
import fs from "fs";

// Fallback or dynamic directory provider
let dlDir = "./downloads";

export function configureDownloadDirectory(newPath: string) {
  dlDir = path.resolve(newPath);
}

export function sanitizeDirectory(userDir: string): string {
  const base = path.resolve(dlDir);
  const target = path.resolve(base, userDir);
  if (!target.startsWith(base)) {
    throw new Error("Directory traversal not allowed");
  }
  return target;
}

export async function ensureUniqueFilename(dirPath: string, baseName: string): Promise<{ finalPath: string; finalName: string }> {
  const ext = path.extname(baseName);
  const name = path.basename(baseName, ext);
  let counter = 0;
  let finalName = baseName;
  let finalPath = path.join(dirPath, finalName);

  while (true) {
    try {
      await fs.promises.access(finalPath);
      counter++;
      finalName = `${name} (${counter})${ext}`;
      finalPath = path.join(dirPath, finalName);
    } catch {
      break;
    }
  }
  return { finalPath, finalName };
}
