/**
 * 本文件在生产主机生成并持久化主站与本地模型平台共用的身份集成凭证，然后重启对应服务。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const localEnvironmentPath = "/local-platform/.env";
const mainEcosystemPath = "/v3/ecosystem.config.js";
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);

const localEnvironment = readFileSync(localEnvironmentPath, "utf8");
const existing = readEnvironmentValue(localEnvironment, "MAIN_PLATFORM_CLIENT_SECRET");
const token = existing || randomBytes(32).toString("hex");
const nextLocalEnvironment = setEnvironmentValue(
  setEnvironmentValue(localEnvironment, "MAIN_PLATFORM_INTERNAL_URL", "http://127.0.0.1:6369"),
  "MAIN_PLATFORM_CLIENT_SECRET",
  token,
);

const ecosystem = readFileSync(mainEcosystemPath, "utf8");
const nextEcosystem = setBackendEnvironmentValue(ecosystem, "LOCAL_PLATFORM_INTEGRATION_TOKEN", token);

copyFileSync(localEnvironmentPath, `${localEnvironmentPath}.before-integration-${stamp}`);
copyFileSync(mainEcosystemPath, `${mainEcosystemPath}.before-local-integration-${stamp}`);
writeFileSync(localEnvironmentPath, nextLocalEnvironment, { encoding: "utf8", mode: 0o600 });
writeFileSync(mainEcosystemPath, nextEcosystem, "utf8");

execFileSync("bash", ["-lc", "set -a; . /local-platform/.env; set +a; cd /local-platform && pm2 startOrReload ecosystem.config.cjs --only local-api --update-env"], { stdio: "inherit" });
execFileSync("bash", ["-lc", "cd /v3 && pm2 restart ecosystem.config.js --only v3-backend --update-env"], { stdio: "inherit" });
execFileSync("pm2", ["save"], { stdio: "inherit" });
process.stdout.write("主站身份集成凭证已配置，明文未输出\n");

/** 读取环境文件中的单个配置值。 */
function readEnvironmentValue(content, key) {
  return content.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim() || "";
}

/** 幂等写入环境文件配置。 */
function setEnvironmentValue(content, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  return pattern.test(content)
    ? content.replace(pattern, `${key}=${value}`)
    : `${content.trimEnd()}\n${key}=${value}\n`;
}

/** 在主站 backend 私有 env 对象中幂等写入集成 token。 */
function setBackendEnvironmentValue(content, key, value) {
  const existingPattern = new RegExp(`(\\b${key}\\s*:\\s*)['\"][^'\"]*['\"]`);
  if (existingPattern.test(content)) return content.replace(existingPattern, `$1'${value}'`);
  const anchor = /(\s+WS_PROXY_TOKEN\s*:\s*[^,\n]+,\r?\n)/;
  if (!anchor.test(content)) throw new Error("主站 ecosystem 中未找到 WS_PROXY_TOKEN 插入点");
  return content.replace(anchor, `$1    ${key}: '${value}',\n`);
}
