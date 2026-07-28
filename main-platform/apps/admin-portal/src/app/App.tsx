/** 管理后台 — Tailwind 布局壳 (lucide-react 图标, 响应式侧边栏, 移动端汉堡菜单) */
import { useState, useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Users, Image, Globe, Bot, Wand,
  Palette, Wallet, CreditCard, Settings, FileText,
  Menu, X, LogOut, Wrench, HardDrive, Tags, Cpu, type LucideIcon,
} from 'lucide-react';

import { DashboardPage } from '../pages/Dashboard/DashboardPage';
import { UsersPage } from '../pages/Users/UsersPage';
import { SitesPage } from '../pages/Sites/SitesPage';
import { ConfigPage } from '../pages/Config/ConfigPage';
import { RechargePage } from '../pages/Recharge/RechargePage';
import { BotPage } from '../pages/Bot/BotPage';
import { AdminTemplatesPage } from '../pages/Templates/TemplatesPage';
import { BalancePage } from '../pages/Balance/BalancePage';
import { ImageManagePage } from '../pages/Images/ImageManagePage';
import { DrawingManagePage } from '../pages/Drawing/DrawingManagePage';
import { CardPreviewPage } from '../pages/Cards/CardPreviewPage';
import { ToolsSettingsPage } from '../pages/Tools/ToolsSettingsPage';
import { StoragePage } from '../pages/Storage/StoragePage';
import { GalleryTagsPage } from '../pages/GalleryTags/GalleryTagsPage';
import { AdminRuntimeConfigProvider } from './runtime-config';

/* ===== 菜单定义 ===== */
type AdminMenuItem = {
  path: string;
  label: string;
  icon: LucideIcon;
  externalUrl?: string;
};

const MENU_GROUPS: { label: string; items: AdminMenuItem[] }[] = [
  {
    label: '概览',
    items: [
      { path: '/dashboard', label: '仪表盘', icon: LayoutDashboard },
    ],
  },
  {
    label: '绘图与生成',
    items: [
      { path: '/drawing', label: '绘图任务', icon: Wand },
      { path: '/local-model-admin/', label: '本地模型平台', icon: Cpu, externalUrl: '/local-model-admin/' },
      { path: '/images', label: '图片管理', icon: FileText },
      { path: '/gallery-tags', label: '图库标签', icon: Tags },
    ],
  },
  {
    label: '站点与服务',
    items: [
      { path: '/sites', label: 'API 站点', icon: Globe },
      { path: '/bot', label: 'Bot 管理', icon: Bot },
      { path: '/cards', label: '命令管理', icon: Palette },
      { path: '/storage', label: '存储', icon: HardDrive },
    ],
  },
  {
    label: '用户与财务',
    items: [
      { path: '/users', label: '用户与钱包', icon: Users },
      { path: '/balance', label: '钱包管理', icon: Wallet },
      { path: '/recharge', label: '充值管理', icon: CreditCard },
    ],
  },
  {
    label: '系统',
    items: [
      { path: '/config', label: '系统设置', icon: Settings },
      { path: '/tools', label: '工具设置', icon: Wrench },
      { path: '/templates', label: '模板管理', icon: FileText },
    ],
  },
];

/* ===== 受保护路由包装 ===== */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  if (!localStorage.getItem('admin_token')) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/* ===== 登录页 ===== */
function LoginScreen() {
  const [form, setForm] = useState({ account: '', password: '' });
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const nav = useNavigate();

  const submit = async () => {
    if (!form.account.trim() || !form.password.trim()) {
      setMsg('请输入账号和密码');
      return;
    }
    setLoading(true);
    setMsg('');
    try {
      const BASE = import.meta.env.VITE_API_BASE ?? '';
      const r = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: form.account, password: form.password }),
      });
      const d = (await r.json()) as { ok?: boolean; token?: string; message?: string };
      if (d.ok && d.token) {
        localStorage.setItem('admin_token', d.token);
        localStorage.setItem('admin_user', form.account);
        nav('/dashboard', { replace: true });
      } else {
        setMsg(d.message ?? '登录失败');
      }
    } catch {
      setMsg('网络错误，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen" style={{ background: 'var(--color-bg)' }}>
      <div className="card p-8 w-full max-w-[400px] mx-4">
        <h1 className="text-xl font-bold text-center mb-2" style={{ color: 'var(--color-text)' }}>
          绘图姬
        </h1>
        <p className="text-xs text-center mb-6" style={{ color: 'var(--color-text-2)' }}>
          DrawHime 管理后台
        </p>

        <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--color-text-2)' }}>
          账号
        </label>
        <input
          placeholder="用户名或邮箱"
          value={form.account}
          onChange={(e) => setForm({ ...form, account: e.target.value })}
          className="input mb-3"
          autoComplete="username"
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />

        <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--color-text-2)' }}>
          密码
        </label>
        <input
          type="password"
          placeholder="密码"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          className="input mb-1"
          autoComplete="current-password"
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />

        {msg && (
          <div className="text-xs mt-2 mb-1 px-2 py-1.5 rounded-lg" style={{ background: 'var(--color-error-soft)', color: 'var(--color-error)' }}>
            {msg}
          </div>
        )}

        <button
          onClick={submit}
          disabled={loading}
          className="btn btn-block mt-4"
          style={{ background: 'var(--color-primary)', color: '#fff', border: 'none' }}
        >
          {loading ? (
            <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            '管理员登录'
          )}
        </button>
      </div>
    </div>
  );
}

/* ===== 管理布局壳（侧边栏 + 顶栏 + 内容区） ===== */
function AdminShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();
  const adminUser = localStorage.getItem('admin_user') ?? '管理员';

  /* 检测移动端视口 */
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  /* 路由切换时关闭移动端侧边栏 */
  useEffect(() => {
    setMobileOpen(false);
  }, [loc.pathname]);

  const logout = useCallback(() => {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    nav('/login', { replace: true });
  }, [nav]);

  const isActive = (path: string) => loc.pathname === path || loc.pathname.startsWith(path + '/');

  /* 侧边栏内容（桌面端和移动端共用） */
  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div
        className="flex items-center h-12 px-3 border-b flex-shrink-0 cursor-pointer select-none"
        style={{ borderColor: 'var(--color-border)' }}
        onClick={() => nav('/dashboard')}
      >
        {collapsed && !isMobile ? (
          <span className="text-sm font-bold mx-auto" style={{ color: 'var(--color-primary)' }}>绘</span>
        ) : (
          <span className="text-sm font-bold" style={{ color: 'var(--color-primary)' }}>绘图姬</span>
        )}
      </div>

      {/* 导航菜单 */}
      <nav className="flex-1 py-2 overflow-y-auto">
        {MENU_GROUPS.map((group, gi) => (
          <div key={gi} className="mb-1">
            {(!collapsed || isMobile) && (
              <div className="px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-2)' }}>
                {group.label}
              </div>
            )}
            {group.items.map((item) => (
              <button
                key={item.path}
                onClick={() => item.externalUrl ? window.open(item.externalUrl, '_blank', 'noopener,noreferrer') : nav(item.path)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors rounded-lg mx-1.5"
                style={{
                  background: isActive(item.path) ? 'var(--color-primary-soft)' : 'transparent',
                  color: isActive(item.path) ? 'var(--color-primary)' : 'var(--color-text-2)',
                  fontWeight: isActive(item.path) ? 600 : 400,
                }}
                title={item.label}
              >
                <item.icon size={collapsed && !isMobile ? 18 : 16} />
                {(!collapsed || isMobile) && <span className="truncate">{item.label}</span>}
              </button>
            ))}
          </div>
        ))}
      </nav>

      {/* 移动端关闭按钮 */}
      {isMobile && (
        <div className="p-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
          <button
            onClick={() => setMobileOpen(false)}
            className="btn btn-outline btn-sm w-full flex items-center justify-center gap-2"
          >
            <X size={14} />
            关闭菜单
          </button>
        </div>
      )}
    </div>
  );

  return (
    <AdminRuntimeConfigProvider>
    <div className="flex min-h-screen" style={{ background: 'var(--color-bg)' }}>
      {/* 移动端遮罩 */}
      {isMobile && mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm transition-opacity"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* 侧边栏 — 桌面端 */}
      {!isMobile && (
        <aside
          className={`flex-shrink-0 border-r transition-all duration-200 ${collapsed ? 'w-[56px]' : 'w-[216px]'}`}
          style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
        >
          {sidebarContent}
        </aside>
      )}

      {/* 侧边栏 — 移动端抽屉 */}
      {isMobile && (
        <aside
          className={`fixed top-0 left-0 h-full z-40 w-[240px] max-w-[85vw] transition-transform duration-300 shadow-2xl ${
            mobileOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
          style={{ background: 'var(--color-surface)', borderRight: '1px solid var(--color-border)' }}
        >
          {sidebarContent}
        </aside>
      )}

      {/* 主内容区域 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 顶栏 */}
        <header
          className="h-12 flex items-center justify-between px-3 border-b flex-shrink-0 gap-2"
          style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
        >
          <button
            onClick={() => (isMobile ? setMobileOpen(!mobileOpen) : setCollapsed(!collapsed))}
            className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors flex-shrink-0"
            style={{ color: 'var(--color-text-2)' }}
            title={isMobile ? '菜单' : collapsed ? '展开侧边栏' : '折叠侧边栏'}
          >
            {isMobile ? (
              mobileOpen ? <X size={18} /> : <Menu size={18} />
            ) : (
              <Menu size={18} />
            )}
          </button>

          <div className="flex items-center gap-3">
            <span className="text-xs truncate max-w-[120px]" style={{ color: 'var(--color-text-2)' }}>
              {adminUser}
            </span>
            <button
              onClick={logout}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg transition-colors flex-shrink-0"
              style={{ color: 'var(--color-text-2)' }}
              title="登出"
            >
              <LogOut size={14} />
              <span className="hidden sm:inline">登出</span>
            </button>
          </div>
        </header>

        {/* 内容区 */}
        <main className="flex-1 p-3 md:p-4 overflow-auto">
          <div className="card p-4 md:p-5" style={{ minHeight: 'calc(100vh - 48px - 24px)' }}>
            {children}
          </div>
        </main>
      </div>
    </div>
    </AdminRuntimeConfigProvider>
  );
}

/* ===== 根组件 ===== */
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginScreen />} />
        <Route path="/dashboard" element={<ProtectedRoute><AdminShell><DashboardPage /></AdminShell></ProtectedRoute>} />
        <Route path="/drawing" element={<ProtectedRoute><AdminShell><DrawingManagePage /></AdminShell></ProtectedRoute>} />
        <Route path="/images" element={<ProtectedRoute><AdminShell><ImageManagePage /></AdminShell></ProtectedRoute>} />
        <Route path="/gallery-tags" element={<ProtectedRoute><AdminShell><GalleryTagsPage /></AdminShell></ProtectedRoute>} />
        <Route path="/sites" element={<ProtectedRoute><AdminShell><SitesPage /></AdminShell></ProtectedRoute>} />
        <Route path="/bot" element={<ProtectedRoute><AdminShell><BotPage /></AdminShell></ProtectedRoute>} />
        <Route path="/cards" element={<ProtectedRoute><AdminShell><CardPreviewPage /></AdminShell></ProtectedRoute>} />
        <Route path="/storage" element={<ProtectedRoute><AdminShell><StoragePage /></AdminShell></ProtectedRoute>} />
        <Route path="/users" element={<ProtectedRoute><AdminShell><UsersPage /></AdminShell></ProtectedRoute>} />
        <Route path="/balance" element={<ProtectedRoute><AdminShell><BalancePage /></AdminShell></ProtectedRoute>} />
        <Route path="/recharge" element={<ProtectedRoute><AdminShell><RechargePage /></AdminShell></ProtectedRoute>} />
        <Route path="/config" element={<ProtectedRoute><AdminShell><ConfigPage /></AdminShell></ProtectedRoute>} />
        <Route path="/tools" element={<ProtectedRoute><AdminShell><ToolsSettingsPage /></AdminShell></ProtectedRoute>} />
        <Route path="/templates" element={<ProtectedRoute><AdminShell><AdminTemplatesPage /></AdminShell></ProtectedRoute>} />
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
