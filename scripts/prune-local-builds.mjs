import { lstat, readFile, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const version = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const review = /^desktop-\d{3,}(?:-[\w-]+)?$/;
const installer = /^Cage-(\d+\.\d+\.\d+(?:-[\w.-]+)?)-(windows-amd64-setup(?:-unsigned|-test-signed)?\.exe|linux-[\w]+\.deb)$/;
const source = /^(?:mihomo|qemu)-[\w.-]+-source\.tar\.(?:gz|xz|zst)$/;
const normalized = value => process.platform === "win32" ? value.toLowerCase() : value;

async function plain(path, directory = false) {
  const stat = await lstat(path).catch(() => null);
  return stat && (directory ? stat.isDirectory() : stat.isFile()) &&
    normalized(await realpath(path)) === normalized(resolve(path));
}

// Only remove individually identified build outputs. Neighbouring review files,
// shared toolchains, published copies and abandoned builds have no ownership here.
async function release(dir, platform) {
  const sums = join(dir, "SHA256SUMS");
  if (!await plain(dir, true) || !await plain(sums)) return;
  const lines = (await readFile(sums, "utf8")).trim().split(/\r?\n/);
  const files = [];
  let product;
  for (const line of lines) {
    const name = /^[\da-f]{64} [ *]([^/\\:]+)$/i.exec(line)?.[1];
    const match = name && installer.exec(name);
    if (match && !product && match[2].startsWith(platform)) product = match[1];
    else if (!name || !source.test(name)) return;
    if (!await plain(join(dir, name))) return;
    files.push(join(dir, name));
  }
  if (product) return { dir, product, files: [...files, sums], date: (await lstat(sums)).mtimeMs };
}

async function ownedApp(build) {
  const dir = join(dirname(build.dir), "app");
  if (!review.test(basename(dirname(dir))) || !await plain(dir, true)) return [];
  const manifest = join(dir, "Cage.install-files.json");
  if (!await plain(manifest) || !await plain(join(dir, "Cage.install-id")) ||
      !await plain(join(dir, "version.txt")) ||
      (await readFile(join(dir, "Cage.install-id"), "utf8")).trim() !== "io.github.lee-xeo.claude-cage" ||
      (await readFile(join(dir, "version.txt"), "utf8")).trim() !== build.product) return [];
  let ownership;
  try { ownership = JSON.parse(await readFile(manifest, "utf8")); } catch { return []; }
  if (ownership.version !== 1 || !Array.isArray(ownership.files)) return [];
  const allowed = new Set(ownership.files.map(entry => entry.path));
  const paths = [];
  async function visit(parent) {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const path = join(parent, entry.name);
      if (entry.isDirectory() && await plain(path, true)) {
        if (!await visit(path)) return false;
        paths.push([path, true]);
      } else if (entry.isFile() && await plain(path) &&
                 (path === manifest || allowed.has(relative(dir, path).split(sep).join("/")))) {
        paths.push([path, false]);
      } else return false;
    }
    return true;
  }
  return await visit(dir) ? [...paths, [dir, true]] : [];
}

export async function prune(output, dryRun = false) {
  const current = resolve(output);
  const platform = basename(current).replace(/-final$/, "");
  const folder = basename(dirname(current));
  if (!["windows", "linux"].includes(platform)) return [];
  const fromReview = review.test(folder);
  const root = dirname(dirname(current));
  if (!fromReview && (!version.test(folder) || basename(root) !== "releases")) return [];
  if (!await plain(root, true) || !await release(current, platform)) return [];
  const builds = [];
  for (const group of await readdir(root, { withFileTypes: true })) {
    if (!group.isDirectory() || !(fromReview ? review : version).test(group.name)) continue;
    for (const name of fromReview && platform === "windows" ? ["windows", "windows-final"] : [platform]) {
      const build = await release(join(root, group.name, name), platform);
      if (build && (fromReview || build.product === group.name)) builds.push(build);
    }
  }
  builds.sort((a,b) => Number(b.dir === current) - Number(a.dir === current) || b.date - a.date);
  const removed = [];
  for (const build of builds.slice(2)) {
    const app = platform === "windows" ? await ownedApp(build) : [];
    if (!dryRun) {
      for (const [path, directory] of app) {
        if (directory) await rmdir(path); else await unlink(path);
      }
      for (const path of build.files) await unlink(path);
    }
    removed.push(build.dir);
  }
  return removed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const path of await prune(process.argv[2], process.argv.includes("--dry-run"))) console.log(path);
}
