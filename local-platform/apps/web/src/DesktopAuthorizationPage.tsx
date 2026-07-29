/** 本文件渲染桌面设备码确认页，并只允许当前已登录身份完成授权。 */
import type { DesktopAuthorizationApprovalView, LocalPlatformSessionView } from "@drawhime/contracts";
import { CheckCircle2, Laptop, LoaderCircle, LogIn, ShieldCheck } from "lucide-react";
import { useState } from "react";

interface DesktopAuthorizationPageProps {
  apiBase: string;
  userCode: string;
  session: LocalPlatformSessionView | null;
  loading: boolean;
}

/** 在主站同源页面确认桌面登录，不把独立会话写入地址栏。 */
export function DesktopAuthorizationPage({ apiBase, userCode, session, loading }: DesktopAuthorizationPageProps) {
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState<DesktopAuthorizationApprovalView | null>(null);
  const [message, setMessage] = useState("");

  const approve = async () => {
    if (!session || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`${apiBase}/v1/desktop-auth/requests/approve`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({ userCode }),
        cache: "no-store",
      });
      const payload = await response.json() as { ok?: boolean; data?: DesktopAuthorizationApprovalView; message?: string };
      if (!response.ok || payload.ok !== true || !payload.data) throw new Error(payload.message || "设备授权确认失败");
      setApproved(payload.data);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "设备授权确认失败");
    } finally {
      setBusy(false);
    }
  };

  return <main className="desktop-authorization-page">
    <section className="desktop-authorization-card">
      <div className="desktop-authorization-mark">{approved ? <CheckCircle2 /> : <Laptop />}</div>
      <span>DrawHime Desktop</span>
      <h1>{approved ? "电脑已连接" : "连接这台电脑"}</h1>
      <p>{approved ? `已允许“${approved.deviceName}”使用当前绘图姬账号。可以关闭此页面并返回桌面程序。` : "确认桌面程序显示的设备码与下方一致，再允许本机访问账号和图库同步。"}</p>
      <strong className="desktop-authorization-code">{userCode}</strong>
      {loading ? <button disabled><LoaderCircle className="spin" />正在确认登录状态</button> : approved ? <div className="desktop-authorization-success"><ShieldCheck />授权使用 Windows Credential Manager 保存，网页不会获得本机模型或训练集。</div> : session ? <>
        <div className="desktop-authorization-identity"><img src={session.identity.avatarUrl || "/favicon-32x32.png"} alt="" /><span><small>将连接为</small><strong>{session.identity.displayName}</strong></span></div>
        <button disabled={busy} onClick={() => void approve()}>{busy ? <LoaderCircle className="spin" /> : <ShieldCheck />}{busy ? "正在确认" : "允许连接"}</button>
      </> : <>
        <div className="desktop-authorization-warning">当前浏览器还未登录绘图姬。登录后重新打开桌面程序给出的确认链接。</div>
        <a href="/login"><LogIn />前往主站登录</a>
      </>}
      {message && <div className="desktop-authorization-error">{message}</div>}
      <small>仅在设备码有效期内确认；未确认的请求会自动过期。</small>
    </section>
  </main>;
}
