import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export async function ensureDirs(...directories) {
  await Promise.all(directories.map((directory) => fsp.mkdir(directory, { recursive: true })));
}

export function safeUploadId(value) {
  const id = String(value ?? "");
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("invalid file id");
  return id;
}

export function safeOutputPath(folder, filename) {
  const name = String(filename ?? "").trim();
  if (!name || /[\/\\\0]/.test(name) || name !== path.basename(name) || !name.toLowerCase().endsWith(".mp3")) {
    throw new Error("invalid output filename");
  }
  const rawFolder = String(folder ?? "");
  if (rawFolder.includes("\0")) throw new Error("invalid output folder");
  const normalizedFolder = rawFolder.replaceAll("\\", "/").replace(/^\/+/, "");
  const cleanFolder = normalizedFolder ? path.posix.normalize(normalizedFolder) : "";
  if (cleanFolder === "." || cleanFolder.startsWith("../") || path.posix.isAbsolute(cleanFolder)) {
    throw new Error("invalid output folder");
  }
  const relative = cleanFolder ? path.posix.join(cleanFolder, name) : name;
  if (relative.startsWith("../") || path.posix.isAbsolute(relative)) throw new Error("unsafe output path");
  return relative;
}

export async function saveMultipartFile(part, destination) {
  await ensureDirs(path.dirname(destination));
  const output = fs.createWriteStream(destination, { flags: "wx" });
  try {
    await pipeline(part.file, output);
    if (part.file.truncated) throw new Error("uploaded file exceeded the configured size limit");
    const stat = await fsp.stat(destination);
    if (stat.size === 0) throw new Error("uploaded file is empty");
    return stat.size;
  } catch (error) {
    output.destroy();
    await fsp.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
}

export function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
