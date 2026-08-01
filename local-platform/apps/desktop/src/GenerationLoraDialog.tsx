/**
 * 本文件实现生成页完整 LoRA 仓库弹窗，统一本机选择、主站下载、封面和双权重编辑。
 */
import type { DesktopLocalJobCreateInput, DesktopLocalLoraView, DesktopWebsiteLoraInstallProgress, DesktopWebsiteLoraView } from "@drawhime/contracts";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Check, Download, Image, Layers3, LoaderCircle, Search, X } from "lucide-react";
import { useMemo, useState } from "react";

interface GenerationLoraDialogProps {
  localLoras: DesktopLocalLoraView[];
  websiteLoras: DesktopWebsiteLoraView[];
  selected: DesktopLocalJobCreateInput["loras"];
  selectionLimit: number;
  progress: Record<string, DesktopWebsiteLoraInstallProgress>;
  onToggle: (id: string) => void;
  onStrength: (id: string, key: "strength" | "clipStrength", value: number) => void;
  onInstall: (id: string) => void;
  onClose: () => void;
}

interface LoraDialogEntry {
  key: string;
  title: string;
  description: string;
  type: string;
  modelFamilyName: string;
  triggerWords: string[];
  coverPath: string | null;
  local: DesktopLocalLoraView | null;
  website: DesktopWebsiteLoraView | null;
}

const LORA_TYPES = [
  { value: "all", label: "全部" },
  { value: "character", label: "角色" },
  { value: "style", label: "画风" },
  { value: "clothing", label: "服装" },
  { value: "pose", label: "姿势" },
  { value: "concept", label: "概念" },
  { value: "other", label: "其他" },
] as const;

/** 弹窗直接展示当前账号完整仓库，本机已有内容按 SHA-256 与网站版本合并。 */
export function GenerationLoraDialog({ localLoras, websiteLoras, selected, selectionLimit, progress, onToggle, onStrength, onInstall, onClose }: GenerationLoraDialogProps) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const entries = useMemo(() => mergeEntries(localLoras, websiteLoras), [localLoras, websiteLoras]);
  // 分类数量始终基于完整仓库计算，切换分类时用户仍能判断各分类是否有内容。
  const typeCounts = useMemo(() => Object.fromEntries(LORA_TYPES.map((item) => [item.value, item.value === "all" ? entries.length : entries.filter((entry) => entry.type === item.value).length])), [entries]);
  const visible = entries.filter((entry) => (type === "all" || entry.type === type) && searchable(`${entry.title} ${entry.description} ${entry.modelFamilyName} ${entry.triggerWords.join(" ")}`, query));
  return <div className="generation-lora-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className="generation-lora-dialog" role="dialog" aria-modal="true" aria-label="选择 LoRA"><header><div><Layers3 /><span><strong>选择 LoRA</strong><small>仓库 {entries.length} 个 · 已选择 {selected.length}/{selectionLimit}</small></span></div><button onClick={onClose} aria-label="关闭 LoRA 选择器"><X /></button></header><div className="generation-lora-toolbar"><label><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、说明、底模或触发词" /></label><div className="generation-lora-categories" role="group" aria-label="LoRA 分类">{LORA_TYPES.map((item) => <button key={item.value} type="button" className={type === item.value ? "active" : ""} aria-pressed={type === item.value} onClick={() => setType(item.value)}><span>{item.label}</span><b>{typeCounts[item.value] || 0}</b></button>)}</div><small>显示 {visible.length} 个</small></div><div className="generation-lora-library">{visible.map((entry) => {
    const selection = entry.local ? selected.find((item) => item.id === entry.local!.id) : null;
    const current = entry.website ? progress[entry.website.id] : null;
    const downloading = Boolean(current && ["downloading", "verifying", "installing"].includes(current.status));
    const percent = current ? Math.min(100, Math.round(current.downloadedBytes / Math.max(1, current.totalBytes) * 100)) : null;
    const limitReached = !selection && selected.length >= selectionLimit;
    return <article key={entry.key} className={selection ? "selected" : ""}><div className="generation-lora-cover">{entry.coverPath ? <img src={convertFileSrc(entry.coverPath)} alt={entry.title} /> : <div><Image /><span>LORA</span></div>}{selection && <i><Check /></i>}</div><div className="generation-lora-copy"><header><span><strong title={entry.title}>{entry.title}</strong><small>{loraTypeLabel(entry.type)} · {entry.modelFamilyName}</small></span>{entry.local ? <b>已安装</b> : <b className="remote">主站</b>}</header><p title={entry.description}>{entry.description || entry.triggerWords.join(", ") || "未填写说明"}</p><small title={entry.triggerWords.join(", ")}>{entry.triggerWords.length ? `触发词：${entry.triggerWords.join(", ")}` : "无需固定触发词"}</small>{selection && <div className="generation-lora-weights"><label><span>模型</span><input aria-label={`${entry.title} 模型权重`} type="number" min={-2} max={2} step={0.05} value={selection.strength} onChange={(event) => onStrength(entry.local!.id, "strength", Number(event.target.value))} /></label><label><span>CLIP</span><input aria-label={`${entry.title} CLIP 权重`} type="number" min={-2} max={2} step={0.05} value={selection.clipStrength} onChange={(event) => onStrength(entry.local!.id, "clipStrength", Number(event.target.value))} /></label></div>}{percent !== null && current && <div className="generation-lora-progress"><i style={{ width: `${percent}%` }} /><span>{loraProgressLabel(current.status)} · {percent}%</span></div>}</div><div className="generation-lora-action">{entry.local ? <button className={selection ? "remove" : "select"} disabled={limitReached} title={limitReached ? `当前后端最多选择 ${selectionLimit} 个 LoRA` : undefined} onClick={() => onToggle(entry.local!.id)}>{selection ? <X /> : <Check />}{selection ? "移除" : limitReached ? "已达上限" : "选择"}</button> : entry.website ? <button disabled={downloading} title={downloading ? `${loraProgressLabel(current!.status)}，请勿重复提交` : "从主站镜像下载并校验该 LoRA"} onClick={() => onInstall(entry.website!.id)}>{downloading ? <LoaderCircle className="spin" /> : <Download />}{downloading ? loraProgressLabel(current!.status) : "下载"}</button> : null}</div></article>;
  })}{visible.length === 0 && <div className="empty-block">没有符合当前筛选条件的 LoRA</div>}</div><footer><span>选择结果与权重会固化到任务快照；主站下载仍执行权限和 SHA-256 校验。</span><button onClick={onClose}>完成</button></footer></section></div>;
}

/** 本机和网站条目按文件哈希合并，避免同一 LoRA 重复出现。 */
function mergeEntries(localLoras: DesktopLocalLoraView[], websiteLoras: DesktopWebsiteLoraView[]): LoraDialogEntry[] {
  const used = new Set<string>();
  const entries: LoraDialogEntry[] = websiteLoras.map((website) => {
    const local = localLoras.find((item) => item.sha256 === website.sha256) || null;
    if (local) used.add(local.id);
    return { key: `website:${website.id}`, title: local?.title || website.title, description: website.description, type: website.type, modelFamilyName: website.modelFamilyName, triggerWords: local?.triggerWords || website.triggerWords, coverPath: website.coverPath, local, website };
  });
  for (const local of localLoras) if (!used.has(local.id)) entries.push({ key: `local:${local.id}`, title: local.title, description: "本机导入并通过文件校验的 LoRA", type: local.type, modelFamilyName: "本机模型", triggerWords: local.triggerWords, coverPath: null, local, website: null });
  return entries;
}

function searchable(value: string, query: string): boolean { return !query.trim() || value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()); }
function loraTypeLabel(type: string): string { return { style: "画风", character: "角色", concept: "概念", clothing: "服装", pose: "姿势", other: "其他" }[type] || "其他"; }
function loraProgressLabel(status: DesktopWebsiteLoraInstallProgress["status"]): string { return { downloading: "下载中", verifying: "校验中", installing: "安装中", installed: "已安装", failed: "失败" }[status]; }
