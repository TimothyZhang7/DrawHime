/**
 * 本文件在 1Panel OpenResty 现有站点配置中幂等安装本地模型独立路径，并在校验失败时回滚。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const container = process.env.OPENRESTY_CONTAINER || findOpenRestyContainer();
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const sites = [
  {
    file: "/data/1panel/www/conf.d/xanime.ink.conf",
    anchor: "    # 静态资源长缓存",
    block: `    # BEGIN DRAW HIME LOCAL PLATFORM
    location ^~ /local-model-api/ {
        proxy_pass http://127.0.0.1:7102/;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
    location ^~ /local-model/ {
        root /www/sites/xanime.ink;
        try_files $uri $uri/ /local-model/index.html;
    }
    # END DRAW HIME LOCAL PLATFORM
`,
  },
  {
    file: "/data/1panel/www/conf.d/admin.xanime.ink.conf",
    anchor: "    # 图片文件代理",
    block: `    # BEGIN DRAW HIME LOCAL PLATFORM
    location ^~ /local-model-api/ {
        proxy_pass http://127.0.0.1:7102/;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
    location ^~ /local-model-admin/ {
        root /www/sites/admin.xanime.ink;
        try_files $uri $uri/ /local-model-admin/index.html;
    }
    # END DRAW HIME LOCAL PLATFORM
`,
  },
];

const changed = [];
try {
  for (const site of sites) {
    if (!existsSync(site.file)) throw new Error(`站点配置不存在：${site.file}`);
    const content = readFileSync(site.file, "utf8");
    if (content.includes("# BEGIN DRAW HIME LOCAL PLATFORM")) continue;
    if (!content.includes(site.anchor)) throw new Error(`未找到配置插入点：${site.file}`);
    const backup = `${site.file}.before-local-platform-${stamp}`;
    copyFileSync(site.file, backup);
    writeFileSync(site.file, content.replace(site.anchor, `${site.block}${site.anchor}`), "utf8");
    changed.push({ file: site.file, backup });
  }
  execFileSync("docker", ["exec", container, "openresty", "-t"], { stdio: "inherit" });
  execFileSync("docker", ["exec", container, "openresty", "-s", "reload"], { stdio: "inherit" });
  process.stdout.write(`本地模型路径已安装并重载 OpenResty：${container}\n`);
} catch (error) {
  for (const item of changed.reverse()) copyFileSync(item.backup, item.file);
  throw error;
}

/** 查找当前 1Panel OpenResty 容器，避免把固定容器后缀写入脚本。 */
function findOpenRestyContainer() {
  const output = execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  const names = output.split(/\r?\n/).filter((name) => name.startsWith("1Panel-openresty-"));
  if (names.length !== 1) throw new Error(`预期找到 1 个 OpenResty 容器，实际 ${names.length} 个`);
  return names[0];
}
