/**
 * 本文件原子同步桌面 Web、Tauri 配置、Rust 包和 Cargo 锁文件版本，避免更新包内外版本漂移。
 */
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const nextVersion = process.argv[2]?.trim();
if (!nextVersion || !/^\d+\.\d+\.\d+$/.test(nextVersion)) throw new Error("用法：node scripts/set-desktop-version.mjs X.Y.Z");

const packagePath = resolve(root, "apps", "desktop", "package.json");
const tauriPath = resolve(root, "apps", "desktop", "src-tauri", "tauri.conf.json");
const cargoPath = resolve(root, "apps", "desktop", "src-tauri", "Cargo.toml");
const lockPath = resolve(root, "apps", "desktop", "src-tauri", "Cargo.lock");

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const tauriJson = JSON.parse(await readFile(tauriPath, "utf8"));
const cargo = await readFile(cargoPath, "utf8");
const lock = await readFile(lockPath, "utf8");
const cargoVersion = packageVersion(cargo, "Cargo.toml");
const lockVersion = lockedDesktopVersion(lock);
const versions = [packageJson.version, tauriJson.version, cargoVersion, lockVersion];
if (new Set(versions).size !== 1) throw new Error(`桌面版本当前不一致：${versions.join(" / ")}`);
if (compareVersions(nextVersion, versions[0]) <= 0) throw new Error(`新版本必须高于当前版本 ${versions[0]}`);

packageJson.version = nextVersion;
tauriJson.version = nextVersion;
const nextCargo = cargo.replace(/(\[package\][\s\S]*?\nversion = ")\d+\.\d+\.\d+("\r?\n)/, `$1${nextVersion}$2`);
const nextLock = lock.replace(/(\[\[package\]\]\r?\nname = "drawhime-desktop"\r?\nversion = ")\d+\.\d+\.\d+("\r?\n)/, `$1${nextVersion}$2`);

await writeVersionFiles([
  { path: packagePath, previous: await readFile(packagePath, "utf8"), next: `${JSON.stringify(packageJson, null, 2)}\n` },
  { path: tauriPath, previous: await readFile(tauriPath, "utf8"), next: `${JSON.stringify(tauriJson, null, 2)}\n` },
  { path: cargoPath, previous: cargo, next: nextCargo },
  { path: lockPath, previous: lock, next: nextLock },
]);
process.stdout.write(`桌面版本已从 ${versions[0]} 同步到 ${nextVersion}\n`);

/** 提取 Cargo 主包版本，拒绝模糊匹配依赖版本。 */
function packageVersion(content, fileName) {
  const match = /\[package\][\s\S]*?\nversion = "(\d+\.\d+\.\d+)"/.exec(content);
  if (!match) throw new Error(`${fileName} 缺少桌面包版本`);
  return match[1];
}

/** 只读取 Cargo.lock 中 drawhime-desktop 条目的版本。 */
function lockedDesktopVersion(content) {
  const match = /\[\[package\]\]\r?\nname = "drawhime-desktop"\r?\nversion = "(\d+\.\d+\.\d+)"/.exec(content);
  if (!match) throw new Error("Cargo.lock 缺少 drawhime-desktop 条目");
  return match[1];
}

/** 先写完全部临时文件再依次切换；切换异常时用原内容恢复已经替换的文件。 */
async function writeVersionFiles(entries) {
  for (const entry of entries) await writeFile(`${entry.path}.incoming`, entry.next, "utf8");
  const replaced = [];
  try {
    for (const entry of entries) {
      await rename(`${entry.path}.incoming`, entry.path);
      replaced.push(entry);
    }
  } catch (error) {
    for (const entry of replaced) {
      await writeFile(`${entry.path}.rollback`, entry.previous, "utf8");
      await rename(`${entry.path}.rollback`, entry.path);
    }
    await Promise.all(entries.map((entry) => rm(`${entry.path}.incoming`, { force: true })));
    throw error;
  }
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  return 0;
}
