/** 用户前台 — react-router-dom */
import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, matchPath } from 'react-router-dom';
import { AuthProvider, useAuth } from '../providers/AuthProvider';
import { AppearanceProvider, useAppearance } from '../providers/AppearanceProvider';
import { ToastProvider } from '../providers/ToastProvider';
import { Navbar } from '../components/layout/Navbar';
import { FloatingQueue } from '../components/layout/FloatingQueue';
import { AuthPage } from '../pages/auth/LoginPage';
import { ForgotPasswordPage } from '../pages/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '../pages/auth/ResetPasswordPage';
import { GeneratePage } from '../pages/generate/GeneratePage';
import { WorkbenchPage } from '../pages/workbench/WorkbenchPage';
import { GalleryPage } from '../pages/gallery/GalleryPage';
import { ImageDetailWrapper } from '../pages/image/ImageDetailWrapper';
import { ProfilePage } from '../pages/profile/ProfilePage';
import { RechargePage } from '../pages/recharge/RechargePage';
import { BotsPage } from '../pages/bots/BotsPage';
import { AddBotPage } from '../pages/bots/AddBotPage';
import { VerifyEmailPage } from '../pages/auth/VerifyEmailPage';
import { PersonalPage } from '../pages/personal/PersonalPage';
import { ServiceStatusPage } from '../pages/status/ServiceStatusPage';
import { TemplatesPage } from '../pages/templates/TemplatesPage';
import { TemplateDetailPage } from '../pages/templates/TemplateDetailPage';
import { TemplateUsePage } from '../pages/templates/TemplateUsePage';
import { ToolsPage } from '../pages/tools/ToolsPage';
import { ImageSplitterPage } from '../pages/tools/image-splitter/ImageSplitterPage';
import { ImageConverterPage } from '../pages/tools/image-converter/ImageConverterPage';
import { ImageScramblerPage } from '../pages/tools/image-scrambler/ImageScramblerPage';
import { ImageWobblePage } from '../pages/tools/image-wobble/ImageWobblePage';
import { ImageReversePage } from '../pages/tools/image-reverse/ImageReversePage';
import { ImageReverseHistoryPage } from '../pages/tools/image-reverse/ImageReverseHistoryPage';
import { ImageUpscalePage } from '../pages/tools/image-upscale/ImageUpscalePage';
import { ImageUpscaleHistoryPage } from '../pages/tools/image-upscale/ImageUpscaleHistoryPage';
import { LeaderboardPage } from '../pages/leaderboard/LeaderboardPage';
import { UserPublicProfilePage } from '../pages/users/UserPublicProfilePage';
import { Seo } from '../components/Seo';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="text-center py-16 text-text-2">加载中...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const { backgroundActive } = useAppearance();
  // 生成页已迁移为首页，仍沿用自身实时任务面板，避免同一任务被全局队列重复轮询。
  const showFloatingQueue = !isGenerateWorkspacePath(location.pathname);
  return <div className={`site-page-layout min-h-screen${backgroundActive ? ' site-page-layout-background' : ' bg-bg'}`}><Navbar /><main className="app-main mx-auto p-4" style={{ maxWidth: 1400 }}>{children}</main>{showFloatingQueue && <FloatingQueue />}</div>;
}
function FullLayout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const { backgroundActive } = useAppearance();
  // 生成页和工作台都有页面内任务展示，不再挂全局右下角任务浮窗。
  const showFloatingQueue = shouldShowFloatingQueue(location.pathname);
  const mainClassName = `app-main app-main-full p-4${isWorkbenchPath(location.pathname) ? ' app-main-workbench' : ''}`;
  return <div className={`site-page-layout min-h-screen${backgroundActive ? ' site-page-layout-background' : ' bg-bg'}`}><Navbar /><main className={mainClassName}>{children}</main>{showFloatingQueue && <FloatingQueue />}</div>;
}

/** 判断当前路径是否为绘图工作台入口；旧 /generate 仅用于兼容跳转。 */
function isGenerateWorkspacePath(pathname: string) {
  return pathname === '/' || pathname === '/generate';
}

/** 判断当前路径是否为导航工作台；该页使用满高布局和页面内任务状态。 */
function isWorkbenchPath(pathname: string) {
  return pathname === '/workbench';
}

/** 判断是否渲染全局任务浮窗；有内置任务区的页面不重复展示。 */
function shouldShowFloatingQueue(pathname: string) {
  return !isGenerateWorkspacePath(pathname) && !isWorkbenchPath(pathname);
}

/** 旧生成入口保留查询参数跳转到首页，保证历史模板链接和收藏入口不丢 prompt。 */
function RedirectGenerateToHome() {
  const location = useLocation();
  return <Navigate to={{ pathname: '/', search: location.search, hash: location.hash }} replace />;
}

/** 旧 LoRA 地址保留永久兼容跳转，资产写入统一由独立本地模型平台负责。 */
function RedirectLoraToLocalPlatform() {
  useEffect(() => {
    window.location.replace('/local-model/?tab=loras');
  }, []);
  return <div className="text-center py-16 text-text-2">正在前往独立 LoRA 仓库…</div>;
}

function NotFound() {
  return (
    <Layout>
      <div className="text-center py-24">
        <div className="text-6xl font-bold mb-3 text-text">404</div>
        <div className="text-base text-text-2 mb-5">页面不存在</div>
        <a href="/gallery" className="btn">返回图库</a>
      </div>
    </Layout>
  );
}

type RouteSeoMeta = {
  title: string;
  description: string;
  index?: boolean;
};

const routeSeoFallbacks: { pattern: string; meta: RouteSeoMeta }[] = [
  {
    pattern: '/',
    meta: {
      title: 'AI绘图生成',
      description: '在绘图姬 DrawHime 在线提交 AI 绘图和图生图任务，支持提示词、参考图、隐私状态和实时生成预览。',
    },
  },
  {
    pattern: '/workbench',
    meta: {
      title: '导航工作台',
      description: '在绘图姬 DrawHime 使用对话式工作台提交 AI 绘图任务，按当前模型、张数和隐私设置进入真实生成链路。',
      index: false,
    },
  },
  {
    pattern: '/profile',
    meta: {
      title: '个人中心',
      description: '管理绘图姬 DrawHime 账号资料、QQ 绑定、邮箱验证、余额和隐私偏好。',
      index: false,
    },
  },
  {
    pattern: '/recharge',
    meta: {
      title: '充值',
      description: '查看绘图姬 DrawHime 余额并兑换卡密或进入充值入口。',
      index: false,
    },
  },
  {
    pattern: '/bots',
    meta: {
      title: 'Bot 管理',
      description: '管理绘图姬 DrawHime Bot 连接、命令和群聊绘图能力。',
      index: false,
    },
  },
  {
    pattern: '/bots/add',
    meta: {
      title: '添加 Bot',
      description: '在绘图姬 DrawHime 添加 Bot 连接配置。',
      index: false,
    },
  },
  {
    pattern: '/personal/gallery',
    meta: {
      title: '我的图片',
      description: '查看和管理绘图姬 DrawHime 账号下的图片，支持批量删除、隐私切换和下载。',
      index: false,
    },
  },
  {
    pattern: '/personal/generations/:taskId',
    meta: {
      title: '任务详情',
      description: '查看绘图姬 DrawHime 生成任务详情、结果、耗时、站点尝试和子任务时间线。',
      index: false,
    },
  },
  {
    pattern: '/personal/generations',
    meta: {
      title: '生成记录',
      description: '查看绘图姬 DrawHime 账号下的生成任务状态、失败原因和历史记录。',
      index: false,
    },
  },
  {
    pattern: '/templates/new',
    meta: {
      title: '新建模板',
      description: '创建绘图姬 DrawHime 绘图模板，复用提示词和参数。',
      index: false,
    },
  },
  {
    pattern: '/templates/:id/edit',
    meta: {
      title: '编辑模板',
      description: '编辑绘图姬 DrawHime 绘图模板内容、变量和公开状态。',
      index: false,
    },
  },
  {
    pattern: '/templates/:id',
    meta: {
      title: '使用模板',
      description: '使用绘图姬 DrawHime 模板快速填充提示词并发起生成。',
      index: false,
    },
  },
  {
    pattern: '/templates',
    meta: {
      title: '模板',
      description: '管理和使用绘图姬 DrawHime 绘图模板。',
      index: false,
    },
  },
  {
    pattern: '/tools/image-splitter',
    meta: {
      title: '图片拆分',
      description: '上传一张图片，按行列拆分为多张图片并本地打包下载。',
      index: true,
    },
  },
  {
    pattern: '/tools/image-converter',
    meta: {
      title: '格式转换与压缩',
      description: '批量转换 PNG、JPEG、WebP，并按质量、尺寸或目标体积在浏览器本地压缩。',
      index: true,
    },
  },
  {
    pattern: '/tools/image-scrambler',
    meta: {
      title: '图片混淆',
      description: '上传一张图片后，一键使用空间填充曲线完成混淆或解混淆。',
      index: true,
    },
  },
  {
    pattern: '/tools/image-wobble',
    meta: {
      title: '局部抖动',
      description: '在浏览器本地涂抹图片区域，制作柔软弹跳、漂浮或颤动动画并录制导出。',
      index: true,
    },
  },
  {
    pattern: '/tools/image-upscale',
    meta: {
      title: '图片放大',
      description: '上传一张图片，调用本地 GPU 超分模型放大并增强细节。',
      index: false,
    },
  },
  {
    pattern: '/upscale/history',
    meta: {
      title: '放大记录',
      description: '查看绘图姬 DrawHime 账号下的图片放大任务、运行进度、持久化源图和历史结果。',
      index: false,
    },
  },
  {
    pattern: '/reverse',
    meta: {
      title: '图片反推',
      description: '上传一张图片，用 AI 识图模型提取完整风格、构图和可复用绘图提示词。',
      index: false,
    },
  },
  {
    pattern: '/reverse/history',
    meta: {
      title: '反推记录',
      description: '查看当前账号的图片反推任务进度、源图和历史结果。',
      index: false,
    },
  },
  {
    pattern: '/tools/image-reverse',
    meta: {
      title: '图片反推',
      description: '上传一张图片，用 AI 识图模型提取完整风格、构图和可复用绘图提示词。',
      index: false,
    },
  },
  {
    pattern: '/tools',
    meta: {
      title: '工具',
      description: '绘图姬 DrawHime 工具中心，提供格式转换与压缩、图片拆分等 AI 绘图辅助工具。',
      index: true,
    },
  },
  {
    pattern: '/leaderboard',
    meta: {
      title: '排行榜',
      description: '查看绘图姬 DrawHime 用户任务排行榜，按 24 小时、7 天、30 天和全部时间统计主任务调用次数。',
      index: true,
    },
  },
  {
    pattern: '/loras',
    meta: { title: 'LoRA 仓库已迁移', description: 'LoRA 仓库已经迁移到独立本地模型平台。', index: false },
  },
  {
    pattern: '/users/:id',
    meta: {
      title: '用户主页',
      description: '查看绘图姬 DrawHime 用户公开主页、公开作品和公开图片统计。',
      index: true,
    },
  },
  {
    pattern: '/reset-password',
    meta: {
      title: '重置密码',
      description: '重置绘图姬 DrawHime 账号密码。',
      index: false,
    },
  },
];

/** 路由标题兜底：只处理未在页面内单独挂 Seo 的登录后页面，避免地址变化后标题沿用上一页。 */
function RouteSeoFallback() {
  const location = useLocation();
  const matched = routeSeoFallbacks.find(item => matchPath({ path: item.pattern, end: true }, location.pathname));
  if (!matched) return null;
  return <Seo {...matched.meta} path={location.pathname} />;
}

function AppRoutes() {
  return (
    <>
      <RouteSeoFallback />
      <Routes>
        <Route path="/login" element={<Layout><AuthPage /></Layout>} />
        <Route path="/forgot" element={<Layout><ForgotPasswordPage /></Layout>} />
        <Route path="/reset-password" element={<Layout><ResetPasswordPage /></Layout>} />
        <Route path="/gallery" element={<Layout><GalleryPage /></Layout>} />
        <Route path="/leaderboard" element={<Layout><LeaderboardPage /></Layout>} />
        <Route path="/loras" element={<RedirectLoraToLocalPlatform />} />
        <Route path="/users/:id" element={<Layout><UserPublicProfilePage /></Layout>} />
        <Route path="/image/:id" element={<Layout><ImageDetailWrapper /></Layout>} />
        <Route path="/tools" element={<Layout><ToolsPage /></Layout>} />
        <Route path="/tools/image-splitter" element={<Layout><ImageSplitterPage /></Layout>} />
        <Route path="/tools/image-converter" element={<Layout><ImageConverterPage /></Layout>} />
        <Route path="/tools/image-scrambler" element={<Layout><ImageScramblerPage /></Layout>} />
        <Route path="/tools/image-wobble" element={<Layout><ImageWobblePage /></Layout>} />
        <Route path="/tools/image-upscale" element={<ProtectedRoute><Layout><ImageUpscalePage /></Layout></ProtectedRoute>} />
        <Route path="/upscale/history" element={<ProtectedRoute><Layout><ImageUpscaleHistoryPage /></Layout></ProtectedRoute>} />
        <Route path="/tools/image-reverse" element={<ProtectedRoute><FullLayout><ImageReversePage /></FullLayout></ProtectedRoute>} />
        <Route path="/reverse" element={<ProtectedRoute><FullLayout><ImageReversePage /></FullLayout></ProtectedRoute>} />
        <Route path="/reverse/history" element={<ProtectedRoute><Layout><ImageReverseHistoryPage /></Layout></ProtectedRoute>} />
        <Route path="/" element={<ProtectedRoute><FullLayout><GeneratePage /></FullLayout></ProtectedRoute>} />
        <Route path="/workbench" element={<ProtectedRoute><FullLayout><WorkbenchPage /></FullLayout></ProtectedRoute>} />
        <Route path="/generate" element={<RedirectGenerateToHome />} />
        <Route path="/profile" element={<ProtectedRoute><Layout><ProfilePage /></Layout></ProtectedRoute>} />
        <Route path="/recharge" element={<ProtectedRoute><Layout><RechargePage /></Layout></ProtectedRoute>} />
        <Route path="/bots" element={<ProtectedRoute><Layout><BotsPage /></Layout></ProtectedRoute>} />
        <Route path="/bots/add" element={<ProtectedRoute><Layout><AddBotPage /></Layout></ProtectedRoute>} />
        <Route path="/verify-email" element={<Layout><VerifyEmailPage /></Layout>} />
        <Route path="/personal/*" element={<ProtectedRoute><Layout><PersonalPage /></Layout></ProtectedRoute>} />
        <Route path="/my-images" element={<Navigate to="/personal/gallery" replace />} />
        <Route path="/status" element={<Layout><ServiceStatusPage /></Layout>} />
        <Route path="/templates" element={<ProtectedRoute><Layout><TemplatesPage /></Layout></ProtectedRoute>} />
        <Route path="/templates/new" element={<ProtectedRoute><Layout><TemplateDetailPage /></Layout></ProtectedRoute>} />
        <Route path="/templates/:id/edit" element={<ProtectedRoute><Layout><TemplateDetailPage /></Layout></ProtectedRoute>} />
        <Route path="/templates/:id" element={<ProtectedRoute><Layout><TemplateUsePage /></Layout></ProtectedRoute>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}

export function App() {
  return <BrowserRouter><AuthProvider><AppearanceProvider><ToastProvider><AppRoutes /></ToastProvider></AppearanceProvider></AuthProvider></BrowserRouter>;
}
