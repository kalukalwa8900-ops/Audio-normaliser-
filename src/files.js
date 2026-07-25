import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import unzipper from 'unzipper';
import archiver from 'archiver';

export async function ensureDirs(...dirs) {
  await Promise.all(dirs.map((dir) => fsp.mkdir(dir, { recursive: true })));
}

export async function saveUpload(part, destination, maxBytes) {
  await ensureDirs(path.dirname(destination));
  let bytes = 0;
  const out = fs.createWriteStream(destination, { flags: 'wx' });
  try {
    for await (const chunk of part.file) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error(`Upload exceeds ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => out.end((err) => err ? reject(err) : resolve()));
    return bytes;
  } catch (error) {
    out.destroy();
    await fsp.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
}

function safeRelative(entryPath) {
  const normalized = entryPath.replaceAll('\\', '/').replace(/^\/+/, '');
  const clean = path.posix.normalize(normalized);
  if (!clean || clean === '.' || clean.startsWith('../') || path.posix.isAbsolute(clean)) return null;
  return clean;
}

export async function extractZip(zipPath, destination) {
  await ensureDirs(destination);
  const directory = await unzipper.Open.file(zipPath);
  const audioEntries = [];
  let sequence = 0;

  for (const entry of directory.files) {
    const rel = safeRelative(entry.path);
    if (!rel || entry.type === 'Directory') continue;
    if (path.extname(rel).toLowerCase() !== '.mp3') continue;
    sequence += 1;
    const target = path.join(destination, ...rel.split('/'));
    const root = path.resolve(destination) + path.sep;
    if (!path.resolve(target).startsWith(root)) throw new Error(`Unsafe ZIP path: ${entry.path}`);
    await ensureDirs(path.dirname(target));
    await new Promise((resolve, reject) => {
      entry.stream().pipe(fs.createWriteStream(target)).on('finish', resolve).on('error', reject);
    });
    audioEntries.push({ sequence, relativePath: rel, absolutePath: target, filename: path.basename(rel) });
  }

  if (!audioEntries.length) throw new Error('ZIP contains no MP3 files');
  return audioEntries;
}

export async function zipDirectory(sourceDir, outputPath) {
  await ensureDirs(path.dirname(outputPath));
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('warning', (err) => err.code === 'ENOENT' ? null : reject(err));
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

export function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
