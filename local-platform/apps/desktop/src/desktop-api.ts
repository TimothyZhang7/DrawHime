/** 本文件封装 WebView 到 Tauri 本地核心的受类型约束命令。 */
import type { DesktopBootstrapView, DesktopEnvironmentReport, DesktopGalleryPrivacy, DesktopGallerySyncItem, DesktopResourceCatalogView, DesktopResourceDownloadView, DesktopResourceInstallView, DesktopSettings, DesktopSettingsUpdate } from "@drawhime/contracts";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** 加载本机设置、环境报告和图库待同步数量。 */
export function loadDesktopBootstrap(): Promise<DesktopBootstrapView> { return invoke("desktop_bootstrap"); }
/** 主动重新检测本机环境。 */
export function inspectDesktopEnvironment(): Promise<DesktopEnvironmentReport> { return invoke("desktop_inspect_environment"); }
/** 校验并保存桌面端设置。 */
export function saveDesktopSettings(settings: DesktopSettingsUpdate): Promise<DesktopSettings> { return invoke("desktop_save_settings", { settings }); }
/** 读取本机持久化图库同步队列。 */
export function listDesktopGallerySyncQueue(): Promise<DesktopGallerySyncItem[]> { return invoke("desktop_list_gallery_sync_queue"); }
/** 把已校验的本地结果加入幂等图库同步队列。 */
export function enqueueDesktopGalleryPublication(input: { localTaskId: string; artifactPath: string; privacy: DesktopGalleryPrivacy }): Promise<DesktopGallerySyncItem> { return invoke("desktop_enqueue_gallery_publication", { input }); }
/** 拉取并验签桌面端资源目录；发布通道未配置时返回明确状态。 */
export function loadDesktopResourceCatalog(): Promise<DesktopResourceCatalogView> { return invoke("desktop_load_resource_catalog"); }
/** 执行真实的断点下载、切源和整体哈希校验。 */
export function downloadDesktopResource(resourceId: string): Promise<DesktopResourceDownloadView> { return invoke("desktop_download_resource", { resourceId }); }
/** 监听 Rust 下载线程发出的资源进度。 */
export function listenDesktopResourceProgress(handler: (progress: DesktopResourceDownloadView) => void): Promise<UnlistenFn> { return listen<DesktopResourceDownloadView>("desktop-resource-progress", (event) => handler(event.payload)); }
/** 把已验证资源安全安装到受控目录并保留旧版本回滚副本。 */
export function installDesktopResource(resourceId: string): Promise<DesktopResourceInstallView> { return invoke("desktop_install_resource", { resourceId }); }
/** 监听资源校验、解压、切换和回滚进度。 */
export function listenDesktopResourceInstallProgress(handler: (progress: DesktopResourceInstallView) => void): Promise<UnlistenFn> { return listen<DesktopResourceInstallView>("desktop-resource-install-progress", (event) => handler(event.payload)); }
