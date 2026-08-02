/**
 * 本文件装配桌面业务页面并在页面级订阅独立状态仓库，避免根组件承接高频任务与下载更新。
 */
import type { DesktopBootstrapView } from "@drawhime/contracts";
import { memo, useEffect, type ComponentType } from "react";
import { GenerationPage } from "./GenerationPage";
import { LocalGalleryPage } from "./LocalGalleryPages";
import { LoraRepositoryPage, ModelRepositoryPage } from "./RepositoryPages";
import { CaptioningPage, LoraTrainingPage } from "./TrainingPages";
import {
  desktopLoraImported,
  desktopManagedFileDeleted,
  desktopModelImported,
  ensureDesktopWebsiteLoras,
  ensureDesktopWebsiteModels,
  installDesktopRepositoryLora,
  installDesktopRepositoryModel,
  refreshDesktopLoras,
  refreshDesktopModels,
  useDesktopRepositorySelector,
} from "./stores/desktop-repository-store";
import {
  cancelDesktopTask,
  desktopAiCleanJobUpdated,
  desktopCaptionJobUpdated,
  desktopLocalJobCreated,
  desktopTrainingDatasetDeleted,
  desktopTrainingDatasetUpdated,
  desktopTrainingJobUpdated,
  useDesktopTaskSelector,
} from "./stores/desktop-task-store";

export type DesktopFeaturePage = "generate" | "captioning" | "training" | "models" | "loras" | "gallery";

interface DesktopFeaturePagesProps {
  activePage: string;
  environment: DesktopBootstrapView["environment"];
  runtimeReady: boolean;
  defaultPrivacy: DesktopBootstrapView["settings"]["defaultPrivacy"];
  modelRoot: string;
  accountConnected: boolean;
  onOpenModelSettings: () => void;
  onOpenResources: () => void;
  onToggleGenerationPreview: () => void;
  onShowGalleryPreview: (id: string) => void;
  onRevealGalleryArtifact: (id: string) => void;
  onMessage: (message: string) => void;
}

/** 高频状态更新时只重绘数据真正变化的当前功能页。 */
function samePageDataProps<Props extends object>(previous: Readonly<Props>, next: Readonly<Props>): boolean {
  const previousKeys = Object.keys(previous) as Array<keyof Props>;
  const nextKeys = Object.keys(next) as Array<keyof Props>;
  return previousKeys.length === nextKeys.length && previousKeys.every((key) => typeof previous[key] === "function" || Object.is(previous[key], next[key]));
}

/** 隐藏页面保持表单挂载，但在重新显示前不接收新的大列表属性。 */
function cacheWhileHidden<Props extends object>(Component: ComponentType<Props>) {
  const CachedPage = ({ active: _active, ...props }: Props & { active: boolean }) => <Component {...props as Props} />;
  return memo(CachedPage, (previous, next) => !next.active || samePageDataProps(previous, next));
}

const StableGenerationPage = cacheWhileHidden(GenerationPage);
const StableModelRepositoryPage = cacheWhileHidden(ModelRepositoryPage);
const StableLoraRepositoryPage = cacheWhileHidden(LoraRepositoryPage);
const StableCaptioningPage = cacheWhileHidden(CaptioningPage);
const StableLoraTrainingPage = cacheWhileHidden(LoraTrainingPage);
const StableLocalGalleryPage = cacheWhileHidden(LocalGalleryPage);

/** 生成页只订阅生成所需的模型、LoRA 与下载进度。 */
function GenerationFeaturePage({ active, environment, runtimeReady, defaultPrivacy, onTogglePreview, onMessage }: { active: boolean; environment: DesktopBootstrapView["environment"]; runtimeReady: boolean; defaultPrivacy: DesktopBootstrapView["settings"]["defaultPrivacy"]; onTogglePreview: () => void; onMessage: (message: string) => void }) {
  const models = useDesktopRepositorySelector((snapshot) => snapshot.models);
  const loras = useDesktopRepositorySelector((snapshot) => snapshot.loras);
  const websiteLoras = useDesktopRepositorySelector((snapshot) => snapshot.websiteLoras);
  const websiteLoraProgress = useDesktopRepositorySelector((snapshot) => snapshot.websiteLoraProgress);
  useEffect(() => { if (active) void ensureDesktopWebsiteLoras(); }, [active]);
  return <div className="desktop-page-host" hidden={!active}><StableGenerationPage active={active} models={models} loras={loras} websiteLoras={websiteLoras} websiteLoraProgress={websiteLoraProgress} executionBackend={environment.executionBackend} inferenceReady={environment.capabilities.inference} coreRunning={runtimeReady} defaultPrivacy={defaultPrivacy} onCreated={desktopLocalJobCreated} onInstallWebsiteLora={(id) => void installDesktopRepositoryLora(id)} onOpenLoraLibrary={() => void ensureDesktopWebsiteLoras()} onTogglePreview={onTogglePreview} onError={onMessage} /></div>;
}

/** 模型仓库页只订阅模型域；LoRA 下载和训练事件不会触发该页更新。 */
function ModelRepositoryFeaturePage({ active, accountConnected, modelRoot, onOpenSettings, onMessage }: { active: boolean; accountConnected: boolean; modelRoot: string; onOpenSettings: () => void; onMessage: (message: string) => void }) {
  const models = useDesktopRepositorySelector((snapshot) => snapshot.models);
  const websiteModels = useDesktopRepositorySelector((snapshot) => snapshot.websiteModels);
  const websiteProgress = useDesktopRepositorySelector((snapshot) => snapshot.websiteModelProgress);
  const refreshing = useDesktopRepositorySelector((snapshot) => snapshot.modelsRefreshing);
  const jobs = useDesktopTaskSelector((snapshot) => snapshot.jobs);
  useEffect(() => { if (active) void ensureDesktopWebsiteModels(); }, [active]);
  return <div className="desktop-page-host" hidden={!active}><StableModelRepositoryPage active={active} models={models} websiteModels={websiteModels} jobs={jobs} websiteProgress={websiteProgress} accountConnected={accountConnected} modelRoot={modelRoot} refreshing={refreshing} onRefresh={() => void refreshDesktopModels()} onInstallWebsite={(id) => void installDesktopRepositoryModel(id)} onImported={desktopModelImported} onDeleted={(result) => void desktopManagedFileDeleted(result)} onOpenSettings={onOpenSettings} onError={onMessage} /></div>;
}

/** LoRA 仓库页独立订阅 LoRA、训练产物和引用任务。 */
function LoraRepositoryFeaturePage({ active, accountConnected, modelRoot, onMessage }: { active: boolean; accountConnected: boolean; modelRoot: string; onMessage: (message: string) => void }) {
  const loras = useDesktopRepositorySelector((snapshot) => snapshot.loras);
  const websiteLoras = useDesktopRepositorySelector((snapshot) => snapshot.websiteLoras);
  const progress = useDesktopRepositorySelector((snapshot) => snapshot.websiteLoraProgress);
  const refreshing = useDesktopRepositorySelector((snapshot) => snapshot.lorasRefreshing);
  const jobs = useDesktopTaskSelector((snapshot) => snapshot.jobs);
  const trainingJobs = useDesktopTaskSelector((snapshot) => snapshot.trainingJobs);
  useEffect(() => { if (active) void ensureDesktopWebsiteLoras(); }, [active]);
  return <div className="desktop-page-host" hidden={!active}><StableLoraRepositoryPage active={active} loras={loras} websiteLoras={websiteLoras} jobs={jobs} trainingJobs={trainingJobs} progress={progress} accountConnected={accountConnected} modelRoot={modelRoot} refreshing={refreshing} onRefresh={() => void refreshDesktopLoras()} onInstall={(id) => void installDesktopRepositoryLora(id)} onImported={desktopLoraImported} onDatasetCopied={desktopTrainingDatasetUpdated} onDeleted={(result) => void desktopManagedFileDeleted(result)} onError={onMessage} /></div>;
}

/** 打标页只订阅训练集、打标和清洗任务。 */
function CaptioningFeaturePage({ active, captioningReady, onOpenResources, onMessage }: { active: boolean; captioningReady: boolean; onOpenResources: () => void; onMessage: (message: string) => void }) {
  const datasets = useDesktopTaskSelector((snapshot) => snapshot.datasets);
  const captionJobs = useDesktopTaskSelector((snapshot) => snapshot.captionJobs);
  const aiCleanJobs = useDesktopTaskSelector((snapshot) => snapshot.aiCleanJobs);
  return <div className="desktop-page-host" hidden={!active}><StableCaptioningPage active={active} datasets={datasets} captionJobs={captionJobs} aiCleanJobs={aiCleanJobs} captioningReady={captioningReady} onUpdated={desktopTrainingDatasetUpdated} onDeleted={desktopTrainingDatasetDeleted} onCaptionJobUpdated={desktopCaptionJobUpdated} onAiCleanJobUpdated={desktopAiCleanJobUpdated} onOpenResources={onOpenResources} onError={onMessage} /></div>;
}

/** 训练页只订阅训练集、训练任务和可用底模。 */
function TrainingFeaturePage({ active, trainingReady, runtimeReady, onOpenResources, onMessage }: { active: boolean; trainingReady: boolean; runtimeReady: boolean; onOpenResources: () => void; onMessage: (message: string) => void }) {
  const datasets = useDesktopTaskSelector((snapshot) => snapshot.datasets);
  const trainingJobs = useDesktopTaskSelector((snapshot) => snapshot.trainingJobs);
  const models = useDesktopRepositorySelector((snapshot) => snapshot.models);
  return <div className="desktop-page-host" hidden={!active}><StableLoraTrainingPage active={active} datasets={datasets} trainingJobs={trainingJobs} models={models} trainingReady={trainingReady} coreRunning={runtimeReady} onTrainingJobUpdated={desktopTrainingJobUpdated} onOpenResources={onOpenResources} onError={onMessage} /></div>;
}

/** 图库页只订阅本地任务和 LoRA 展示信息。 */
function GalleryFeaturePage({ active, onPreview, onReveal }: { active: boolean; onPreview: (id: string) => void; onReveal: (id: string) => void }) {
  const jobs = useDesktopTaskSelector((snapshot) => snapshot.jobs);
  const cancellingJobIds = useDesktopTaskSelector((snapshot) => snapshot.cancellingJobIds);
  const loras = useDesktopRepositorySelector((snapshot) => snapshot.loras);
  const websiteLoras = useDesktopRepositorySelector((snapshot) => snapshot.websiteLoras);
  useEffect(() => { if (active) void ensureDesktopWebsiteLoras(); }, [active]);
  return <div className="desktop-page-host" hidden={!active}><StableLocalGalleryPage active={active} jobs={jobs} loras={loras} websiteLoras={websiteLoras} cancellingJobIds={cancellingJobIds} onCancel={(id) => void cancelDesktopTask(id)} onPreview={onPreview} onReveal={onReveal} /></div>;
}

/** 所有业务页保持挂载，状态订阅留在各自边界内。 */
export const DesktopFeaturePages = memo(function DesktopFeaturePages(props: DesktopFeaturePagesProps) {
  const { activePage, environment, runtimeReady, defaultPrivacy, modelRoot, accountConnected, onOpenModelSettings, onOpenResources, onToggleGenerationPreview, onShowGalleryPreview, onRevealGalleryArtifact, onMessage } = props;
  return <>
    <GenerationFeaturePage active={activePage === "generate"} environment={environment} runtimeReady={runtimeReady} defaultPrivacy={defaultPrivacy} onTogglePreview={onToggleGenerationPreview} onMessage={onMessage} />
    <ModelRepositoryFeaturePage active={activePage === "models"} accountConnected={accountConnected} modelRoot={modelRoot} onOpenSettings={onOpenModelSettings} onMessage={onMessage} />
    <LoraRepositoryFeaturePage active={activePage === "loras"} accountConnected={accountConnected} modelRoot={modelRoot} onMessage={onMessage} />
    <CaptioningFeaturePage active={activePage === "captioning"} captioningReady={environment.capabilities.captioning} onOpenResources={onOpenResources} onMessage={onMessage} />
    <TrainingFeaturePage active={activePage === "training"} trainingReady={environment.capabilities.training} runtimeReady={runtimeReady} onOpenResources={onOpenResources} onMessage={onMessage} />
    <GalleryFeaturePage active={activePage === "gallery"} onPreview={onShowGalleryPreview} onReveal={onRevealGalleryArtifact} />
  </>;
});

/** 侧栏仅订阅“是否存在活动任务”布尔值，任务百分比变化不会重绘侧栏。 */
export function ActiveLocalJobIndicator() {
  const active = useDesktopTaskSelector((snapshot) => snapshot.hasActiveLocalJobs);
  return active ? <i /> : null;
}
