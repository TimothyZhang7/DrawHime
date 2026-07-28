/**
 * 本文件负责从被 Git 忽略的私有目录加载运维环境变量，公开源码只保留配置键和占位示例。
 */
import { existsSync, readFileSync } from "node:fs";

/** 加载简单 KEY=VALUE 私有配置；调用进程已设置的环境变量拥有更高优先级。 */
export function loadPrivateEnvironment(filePath) {
  if (!existsSync(filePath)) return;
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (/^[A-Z][A-Z0-9_]*$/.test(key) && process.env[key] === undefined) process.env[key] = value;
  }
}

/** 读取必填运维配置，避免公开脚本回退到真实生产地址。 */
export function requirePrivateEnvironment(key) {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`缺少运维配置：${key}；请参考 configs/deployment.env.example`);
  return value;
}
