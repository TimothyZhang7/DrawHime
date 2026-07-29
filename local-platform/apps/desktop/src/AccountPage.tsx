/** 本文件实现桌面账号设备授权界面，设备密钥仅保存在当前组件内存并由 Rust 写入 Credential Manager。 */
import type { DesktopAccountView, DesktopAuthorizationRequestView } from "@drawhime/contracts";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckCircle2, ExternalLink, Laptop, LoaderCircle, LogOut, RefreshCw, ShieldCheck, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { loadDesktopAccountStatus, pollDesktopAuthorization, signOutDesktopAccount, startDesktopAuthorization } from "./desktop-api";

interface AccountPageProps {
  account: DesktopAccountView;
  onChanged: (account: DesktopAccountView) => void;
  onError: (message: string) => void;
}

/** 主站授权只影响模型仓库与图库同步，本地生成、打标和训练始终保持离线可用。 */
export function AccountPage({ account, onChanged, onError }: AccountPageProps) {
  const [request, setRequest] = useState<DesktopAuthorizationRequestView | null>(null);
  const [busy, setBusy] = useState(false);
  const [pollMessage, setPollMessage] = useState("");

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      if (cancelled) return;
      try {
        const outcome = await pollDesktopAuthorization(request.deviceCode);
        if (outcome.account) {
          onChanged(outcome.account);
          setRequest(null);
          setPollMessage("账号连接成功");
          return;
        }
        setPollMessage("等待浏览器确认");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/过期|撤销/.test(message)) setRequest(null);
        setPollMessage(message);
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), request.intervalSeconds * 1000);
    };
    timer = window.setTimeout(() => void poll(), request.intervalSeconds * 1000);
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [request, onChanged]);

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setPollMessage("");
    try {
      const next = await startDesktopAuthorization({ deviceName: "DrawHime Desktop（Windows）" });
      setRequest(next);
      await openUrl(next.verificationUrl);
      setPollMessage("已打开浏览器，请核对并允许连接");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const recheck = async () => {
    setBusy(true);
    try { onChanged(await loadDesktopAccountStatus()); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const signOut = async () => {
    setBusy(true);
    try { onChanged(await signOutDesktopAccount()); setRequest(null); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const connected = account.status === "connected";
  return <div className="desktop-page account-page"><section className="account-hero section-card">
    <div className={`account-seal is-${account.status}`}>{connected ? <CheckCircle2 /> : account.status === "offline" ? <WifiOff /> : <Laptop />}</div>
    <div className="account-copy"><span>MAIN ACCOUNT</span><h2>{connected ? account.identity?.displayName : account.status === "offline" ? "离线使用中" : "连接绘图姬账号"}</h2><p>{account.message}</p></div>
    <div className="account-actions">{connected || account.status === "offline" ? <><button disabled={busy} onClick={() => void recheck()}>{busy ? <LoaderCircle className="spin" /> : <RefreshCw />}重新校验</button><button className="danger" disabled={busy} onClick={() => void signOut()}><LogOut />退出账号</button></> : <button className="primary" disabled={busy} onClick={() => void start()}>{busy ? <LoaderCircle className="spin" /> : <ShieldCheck />}{busy ? "正在创建授权" : "在浏览器中登录"}</button>}</div>
  </section>
  {connected && account.identity && <section className="account-details section-card"><header><div><span>CONNECTED IDENTITY</span><h2>账号信息</h2></div><ShieldCheck /></header><dl><div><dt>显示名称</dt><dd>{account.identity.displayName}</dd></div><div><dt>邮箱状态</dt><dd>{account.identity.emailVerified ? "已验证" : "待验证"}</dd></div><div><dt>权限</dt><dd>{account.identity.roles.includes("admin") ? "管理员" : "用户"}</dd></div><div><dt>授权有效期</dt><dd>{account.expiresAt ? new Date(account.expiresAt).toLocaleString("zh-CN") : "-"}</dd></div></dl><p>凭据保存在 Windows Credential Manager；网页不会读取本机模型、LoRA、训练图片或提示词。</p></section>}
  {request && <section className="account-device-flow section-card"><header><div><span>DEVICE AUTHORIZATION</span><h2>等待浏览器确认</h2></div><LoaderCircle className="spin" /></header><div className="account-device-code"><small>设备码</small><strong>{request.userCode}</strong><span>{pollMessage || "等待确认"} · {new Date(request.expiresAt).toLocaleTimeString("zh-CN")} 前有效</span></div><button onClick={() => void openUrl(request.verificationUrl)}><ExternalLink />重新打开确认页面</button></section>}
  {!connected && !request && <section className="account-boundary section-card"><ShieldCheck /><div><strong>本地功能不依赖登录</strong><span>离线生成、自动打标和 LoRA 训练始终在本机运行；登录只用于下载账号私有资源和同步用户明确选择的作品。</span></div></section>}
  </div>;
}
