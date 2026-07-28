/**
 * 本文件实现 LoRA 训练的独立标签核对页面，复用主站打标工具的单图单行、中英标签与显式保存交互。
 */
import type { TrainingDatasetView, TrainingTagTranslationView } from "@drawhime/contracts";
import { Check, Copy, LoaderCircle, Plus, Save, Sparkles, Tags, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { loadTrainingImage, trainingJson } from "./training-client";

type TagTranslation = TrainingTagTranslationView["translations"][number];
type TranslationMap = Record<string, TagTranslation>;

/** 逐图核对标签并在当前数据集快照上执行最终确认。 */
export function TrainingCaptionReview({ token, dataset, onChanged, onConfirmed, onError }: { token: string; dataset: TrainingDatasetView; onChanged: () => Promise<void>; onConfirmed: () => Promise<void>; onError: (message: string) => void }) {
  const [translations, setTranslations] = useState<TranslationMap>({});
  const [sort, setSort] = useState<"created_at" | "missing_caption">("created_at");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [confirming, setConfirming] = useState(false);
  const allTags = useMemo(() => [...new Set(dataset.assets.flatMap((asset) => splitTags(asset.caption || "")))], [dataset.assets]);
  const allCaptioned = dataset.assets.length >= 5 && dataset.assets.every((asset) => splitTags(asset.caption || "").length > 0);
  const active = [dataset.captionStage, ...dataset.assets.map((asset) => asset.captionStage)].some((stage) => ["queued", "running"].includes(stage?.status || ""));
  const locked = dataset.trainingJobCount > 0 || active;
  const assets = useMemo(() => [...dataset.assets].sort((left, right) => {
    const direction = order === "asc" ? 1 : -1;
    if (sort === "missing_caption") {
      const difference = Number(Boolean(left.caption?.trim())) - Number(Boolean(right.caption?.trim()));
      if (difference) return difference * direction;
    }
    return left.createdAt.localeCompare(right.createdAt) * direction;
  }), [dataset.assets, order, sort]);

  useEffect(() => {
    const missing = allTags.filter((tag) => !translations[tag]);
    if (!missing.length) return;
    let cancelled = false;
    void (async () => {
      for (let index = 0; index < missing.length; index += 200) {
        const payload = await trainingJson<TrainingTagTranslationView>("/v1/training/tag-translations", token, { method: "POST", body: JSON.stringify({ tags: missing.slice(index, index + 200) }) });
        if (cancelled) return;
        setTranslations((current) => ({ ...current, ...Object.fromEntries(payload.translations.map((item) => [item.tag, item])) }));
      }
    })().catch((error) => { if (!cancelled) onError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [allTags, onError, token, translations]);

  /** 服务端再次校验图片快照与全部标签后才确认当前阶段。 */
  const confirm = async () => {
    const stage = dataset.captionStage;
    if (!stage || stage.status !== "awaiting_confirmation" || !window.confirm("确认已逐图核对全部标签，并以当前图片快照进入训练设置？")) return;
    setConfirming(true);
    try {
      await trainingJson(`/v1/training/datasets/${dataset.id}/caption-jobs/${stage.id}/confirm`, token, { method: "POST", body: "{}" });
      await onChanged();
      await onConfirmed();
    } catch (error) { onError(errorMessage(error)); }
    finally { setConfirming(false); }
  };

  return <section className="training-caption-review">
    <header className="training-caption-review-toolbar"><div><span>逐图核对</span><strong>{dataset.assets.length} 张图片 · {allTags.length} 个唯一标签</strong></div><div><label>排序<select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="created_at">上传时间</option><option value="missing_caption">缺失标签</option></select></label><label>顺序<select value={order} onChange={(event) => setOrder(event.target.value as typeof order)}><option value="asc">正序</option><option value="desc">倒序</option></select></label><button className="training-caption-confirm" disabled={confirming || locked || !allCaptioned || dataset.captionStage?.status !== "awaiting_confirmation"} onClick={() => void confirm()}>{confirming ? <LoaderCircle className="spin" /> : <Check size={14} />}{dataset.captionStage?.status === "confirmed" ? "标签已确认" : confirming ? "确认中" : "确认全部标签"}</button></div></header>
    {!allCaptioned && <div className="training-caption-warning"><Tags size={15} />仍有图片缺少标签；补齐并保存后才能确认。</div>}
    {locked && <div className="training-caption-warning"><Tags size={15} />{active ? "自动打标仍在处理，完成后再编辑。" : "数据集已用于训练，标签已锁定用于审计。"}</div>}
    <div className="training-caption-assets">{assets.map((asset) => <TrainingCaptionAsset key={asset.id} token={token} datasetId={dataset.id} asset={asset} mode={dataset.captionStage?.mode || "character"} locked={locked} translations={translations} onChanged={onChanged} onError={onError} />)}</div>
  </section>;
}

/** 单张图片以左图右标签布局提供重新打标、复制、增删和保存操作。 */
function TrainingCaptionAsset({ token, datasetId, asset, mode, locked, translations, onChanged, onError }: { token: string; datasetId: string; asset: TrainingDatasetView["assets"][number]; mode: "character" | "style" | "concept"; locked: boolean; translations: TranslationMap; onChanged: () => Promise<void>; onError: (message: string) => void }) {
  const [tags, setTags] = useState(() => splitTags(asset.caption || ""));
  const [newTag, setNewTag] = useState("");
  const [edited, setEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [captioning, setCaptioning] = useState(false);
  const serverCaption = normalizeCaption(asset.caption || "");
  const draftCaption = normalizeCaption(tags.join(", "));
  const dirty = draftCaption !== serverCaption;
  useEffect(() => { if (!edited) setTags(splitTags(asset.caption || "")); }, [asset.caption, edited]);
  const addTag = () => { const tag = normalizeTag(newTag); if (!tag) return; setTags((current) => current.includes(tag) ? current : [...current, tag]); setEdited(true); setNewTag(""); };
  const save = async () => {
    setSaving(true);
    try { await trainingJson(`/v1/training/datasets/${datasetId}/assets/${asset.id}`, token, { method: "PATCH", body: JSON.stringify({ caption: draftCaption || null }) }); setEdited(false); await onChanged(); }
    catch (error) { onError(errorMessage(error)); }
    finally { setSaving(false); }
  };
  const recaption = async () => {
    setCaptioning(true);
    try { await trainingJson(`/v1/training/datasets/${datasetId}/assets/${asset.id}/caption-jobs`, token, { method: "POST", body: JSON.stringify({ mode }) }); await onChanged(); }
    catch (error) { onError(errorMessage(error)); }
    finally { setCaptioning(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(tags.join(", ")); }
    catch { onError("复制标签失败，请检查浏览器剪贴板权限"); }
  };
  const captionActive = ["queued", "running"].includes(asset.captionStage?.status || "");
  return <article className={`training-caption-asset${asset.caption?.trim() ? " captioned" : ""}`}>
    <div className="training-caption-image"><TrainingPrivateImage token={token} datasetId={datasetId} assetId={asset.id} /><span>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : "训练图片"}</span></div>
    <section className="training-caption-column"><header><span>图片标签</span><div><small>{tags.length} 个</small><button className="training-caption-recaption" disabled={locked || captioning} onClick={() => void recaption()}>{captioning || captionActive ? <LoaderCircle className="spin" /> : <Sparkles size={12} />}{captioning || captionActive ? "重新打标中" : "重新打标"}</button><button className="training-caption-copy" disabled={!tags.length} onClick={() => void copy()}><Copy size={12} />复制 Anima Tag</button></div></header><div className="training-caption-tag-list">{tags.length ? tags.map((tag) => { const translation = translations[tag]; return <span className={`training-caption-tag${translation ? "" : " is-pending"}`} style={{ "--tag-color": translation?.color || "#64748b" } as CSSProperties} key={tag}><b>{tag}</b><small>{translation?.translated || "翻译中"}</small><button disabled={locked} onClick={() => { setTags((current) => current.filter((item) => item !== tag)); setEdited(true); }} aria-label={`删除标签 ${tag}`}><X size={11} /></button></span>; }) : <p>尚未打标，可重新打标或手动添加。</p>}</div><footer><div className="training-caption-add"><input value={newTag} disabled={locked} onChange={(event) => setNewTag(event.target.value)} placeholder="输入英文标签" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTag(); } }} /><button disabled={locked || !newTag.trim()} onClick={addTag}><Plus size={13} />添加</button></div><button className="training-caption-save" disabled={locked || saving || !dirty} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" /> : <Save size={14} />}{saving ? "保存中" : dirty ? "保存标签" : "已保存"}</button></footer></section>
  </article>;
}

/** 图片进入视口后再读取私有二进制，避免大数据集首屏同时下载全部原图。 */
export function TrainingPrivateImage({ token, datasetId, assetId }: { token: string; datasetId: string; assetId: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [source, setSource] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (!root.current || visible) return; const observer = new IntersectionObserver((items) => { if (items.some((item) => item.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "240px" }); observer.observe(root.current); return () => observer.disconnect(); }, [visible]);
  useEffect(() => { if (!visible) return; const controller = new AbortController(); let objectUrl = ""; void loadTrainingImage(datasetId, assetId, token, controller.signal).then((blob) => { objectUrl = URL.createObjectURL(blob); setSource(objectUrl); }).catch(() => { if (!controller.signal.aborted) setFailed(true); }); return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); }; }, [assetId, datasetId, token, visible]);
  return <div ref={root}>{source ? <img src={source} alt="LoRA 训练图片" /> : failed ? <span>图片读取失败</span> : <LoaderCircle className="spin" />}</div>;
}

/** 把持久化 Caption 拆成去重的标准英文标签。 */
function splitTags(value: string): string[] { return [...new Set(value.split(/[,，\n;；]+/).map(normalizeTag).filter(Boolean))]; }
/** 统一单个标签的大小写与空白。 */
function normalizeTag(value: string): string { return value.trim().replace(/\s+/g, " ").toLowerCase(); }
/** 固定 Caption 为逗号加空格的 Anima 标签格式。 */
function normalizeCaption(value: string): string { return splitTags(value).join(", "); }
/** 把未知异常转换为训练页面可读错误。 */
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "标签操作失败"; }
