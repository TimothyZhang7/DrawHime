/** 导航栏：桌面端顶部导航，手机端底部 App 导航和更多入口。 */
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../providers/AuthProvider';
import { config } from '../../lib/config';
import { getAvatarInitial, resolveDisplayAvatar } from '../../lib/avatar';
import { Paintbrush, Images, User, LogOut, Wallet, Bot, Layout, Activity, X, Folder, MoreHorizontal, Wrench, Trophy, ScanSearch, Cpu, type LucideIcon } from 'lucide-react';
import './Navbar.css';

const brandName = '绘图姬';
const brandEnglishName = 'DrawHime';

type NavigationLink = {
  to: string;
  label: string;
  Icon: LucideIcon;
  external?: boolean;
};

export function Navbar() {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  // 桌面导航将本地模型紧随绘图，方便在主站与独立推理平台之间切换。
  const links: NavigationLink[] = [
    { to: '/', label: '绘图', Icon: Paintbrush },
    { to: '/local-model/', label: '本地模型', Icon: Cpu, external: true },
    { to: '/reverse', label: '反推', Icon: ScanSearch },
    { to: '/gallery', label: '图库', Icon: Images },
    { to: '/personal', label: '我的', Icon: Folder },
    { to: '/leaderboard', label: '排行', Icon: Trophy },
    { to: '/tools', label: '工具', Icon: Wrench },
  ];
  if (user) {
    links.push({ to: '/templates', label: '模板', Icon: Layout });
    links.push({ to: '/recharge', label: '充值', Icon: Wallet });
    links.push({ to: '/bots', label: 'Bot', Icon: Bot });
  }
  links.push({ to: '/status', label: '状态', Icon: Activity });

  // 手机底栏固定展示五个高频入口，本地模型紧随绘图，充值等低频功能统一收进“更多”。
  const mobilePrimary: NavigationLink[] = [
    { to: '/', label: '绘图', Icon: Paintbrush },
    { to: '/local-model/', label: '本地模型', Icon: Cpu, external: true },
    { to: '/reverse', label: '反推', Icon: ScanSearch },
    { to: '/gallery', label: '图库', Icon: Images },
    { to: '/personal/gallery', label: '我的', Icon: Folder },
  ];

  const mobileMoreLinks: NavigationLink[] = user
    ? [
        { to: '/templates', label: '模板', Icon: Layout },
        { to: '/recharge', label: '充值', Icon: Wallet },
        { to: '/leaderboard', label: '排行榜', Icon: Trophy },
        { to: '/tools', label: '工具', Icon: Wrench },
        { to: '/bots', label: 'Bot 管理', Icon: Bot },
        { to: '/profile', label: '个人中心', Icon: User },
        { to: '/status', label: '服务状态', Icon: Activity },
      ]
    : [
        { to: '/leaderboard', label: '排行榜', Icon: Trophy },
        { to: '/status', label: '服务状态', Icon: Activity },
      ];

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <>
      <nav className="desktop-navbar sticky top-0 z-50 hidden sm:flex items-center gap-1 px-3 sm:px-5 border-b" style={{ height: 48, background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
        <Link to="/" aria-label={config.siteName} title={config.siteName} className="flex items-center gap-2 no-underline flex-shrink-0">
          <img src="/favicon-32x32.png" alt="" width={28} height={28} className="rounded-md" />
          <span className="flex flex-col leading-none">
            <span className="text-base sm:text-lg font-extrabold tracking-tight" style={{ color: 'var(--color-primary)' }}>{brandName}</span>
            <span className="text-[10px] font-semibold tracking-wide hidden lg:block" style={{ color: 'var(--color-text-2)' }}>{brandEnglishName}</span>
          </span>
        </Link>

        <div className="flex gap-0.5 h-full items-center flex-1">
          {links.map(l => {
            const active = pathname === l.to || (l.to !== '/' && pathname.startsWith(l.to));
            const className = 'flex items-center gap-1.5 px-2.5 xl:px-3 text-[12px] xl:text-[13px] font-medium no-underline transition-colors';
            const style = { height: 34, borderRadius: 8, color: active ? 'var(--color-primary)' : 'var(--color-text-2)', background: active ? 'var(--color-primary-soft)' : 'transparent' };
            // 独立本地模型平台仍在同一站点路径下，使用整页当前窗口导航以加载它自己的应用入口。
            if (l.external) return <a key={l.to} href={l.to} className={className} style={style}><l.Icon size={14} />{l.label}</a>;
            return <Link key={l.to} to={l.to} className={className} style={style}><l.Icon size={14} />{l.label}</Link>;
          })}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {user ? (
            <NavbarUserMenu user={user} logout={logout} />
          ) : (
            <Link to="/login" className="btn btn-sm">登录</Link>
          )}
        </div>
      </nav>

      <nav className="mobile-tabbar sm:hidden" aria-label="底部导航" style={{ gridTemplateColumns: `repeat(${mobilePrimary.length + 1}, minmax(0, 1fr))` }}>
        {mobilePrimary.map(l => {
          const active = pathname === l.to || (l.to !== '/' && pathname.startsWith(l.to));
          if (l.external) {
            return (
              <a key={l.to} href={l.to} className={`mobile-tabbar-item${active ? ' is-active' : ''}`}>
                <l.Icon size={19} />
                <span>{l.label}</span>
              </a>
            );
          }
          return (
            <Link key={l.to} to={l.to} className={`mobile-tabbar-item${active ? ' is-active' : ''}`}>
              <l.Icon size={19} />
              <span>{l.label}</span>
            </Link>
          );
        })}
        <button type="button" onClick={() => setMobileOpen(v => !v)} className={`mobile-tabbar-item mobile-tabbar-more${mobileOpen ? ' is-active' : ''}`} aria-expanded={mobileOpen}>
          {mobileOpen ? <X size={19} /> : <MoreHorizontal size={20} />}
          <span>更多</span>
        </button>
      </nav>

      {mobileOpen && (
        <div className="mobile-more-sheet sm:hidden" role="dialog" aria-label="更多导航">
          <div className="mobile-more-head">
            <strong>{user ? <><NavbarUserAvatar user={user} />{user.username}</> : config.siteName}</strong>
            <button type="button" onClick={() => setMobileOpen(false)} aria-label="关闭更多导航"><X size={16} /></button>
          </div>
          <div className="mobile-more-list">
            {mobileMoreLinks.map(l => {
              const active = pathname === l.to || (l.to !== '/' && pathname.startsWith(l.to));
              if (l.external) return <a key={l.to} href={l.to} className="mobile-more-link"><l.Icon size={16} />{l.label}</a>;
              return <Link key={l.to} to={l.to} className={`mobile-more-link${active ? ' is-active' : ''}`}><l.Icon size={16} />{l.label}</Link>;
            })}
            {!user && <Link to="/login" className="mobile-more-link is-primary"><User size={16} />登录</Link>}
            {user && <button type="button" onClick={() => { logout(); setMobileOpen(false); }} className="mobile-more-link mobile-more-danger"><LogOut size={16} />登出</button>}
          </div>
        </div>
      )}
    </>
  );
}

/** 桌面导航右侧用户快捷菜单；参考 V2 的头像切分按钮结构，并复用统一头像外显优先级。 */
function NavbarUserMenu({ user, logout }: {
  user: { username: string; role: string; avatarUrl?: string | null; qqNumber?: string | null };
  logout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="navbar-user-menu" ref={rootRef}>
      <button type="button" className="navbar-user-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <NavbarUserAvatar user={user} />
        <span className="navbar-user-trigger-body">
          <strong>{user.username}</strong>
        </span>
        <span className={`navbar-user-caret${open ? ' is-open' : ''}`} aria-hidden="true">▼</span>
      </button>

      {open && (
        <div className="navbar-user-dropdown" role="menu">
          <Link to="/profile" className="navbar-user-menu-item" role="menuitem" onClick={() => setOpen(false)}>
            <User size={15} />个人中心
          </Link>
          <Link to="/personal/gallery" className="navbar-user-menu-item" role="menuitem" onClick={() => setOpen(false)}>
            <Images size={15} />我的图片
          </Link>
          <Link to="/recharge" className="navbar-user-menu-item" role="menuitem" onClick={() => setOpen(false)}>
            <Wallet size={15} />充值钱包
          </Link>
          <Link to="/bots" className="navbar-user-menu-item" role="menuitem" onClick={() => setOpen(false)}>
            <Bot size={15} />Bot 管理
          </Link>
          <div className="navbar-user-menu-separator" />
          <button type="button" className="navbar-user-menu-item is-danger" role="menuitem" onClick={() => { setOpen(false); logout(); }}>
            <LogOut size={15} />登出
          </button>
        </div>
      )}
    </div>
  );
}

/** 导航栏头像按当前用户要求统一使用：网页头像 > QQ 头像 > 首字符。 */
function NavbarUserAvatar({ user }: { user: { username: string; avatarUrl?: string | null; qqNumber?: string | null } }) {
  const avatar = resolveDisplayAvatar(user);
  const initial = getAvatarInitial(user.username);
  return (
    <span className="navbar-user-avatar" aria-hidden="true">
      {avatar.url ? <img src={avatar.url} alt="" loading="lazy" /> : initial}
    </span>
  );
}
