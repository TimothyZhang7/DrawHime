//! 本模块实现主站浏览器设备授权，并把独立会话密钥保存到 Windows Credential Manager。

use keyring::{Entry, Error as KeyringError};
use reqwest::{blocking::Client, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::time::Duration;

const API_BASE_URL: &str = "https://www.xanime.ink/local-model-api";
const CREDENTIAL_SERVICE: &str = "ink.xanime.drawhime.desktop";
const CREDENTIAL_USER: &str = "local-platform-session";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopIdentityView {
    pub issuer: String,
    pub subject: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub roles: Vec<String>,
    pub email_verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAccountView {
    pub status: String,
    pub identity: Option<DesktopIdentityView>,
    pub expires_at: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuthorizationStartInput { pub device_name: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuthorizationRequestView {
    pub device_code: String,
    pub user_code: String,
    pub verification_url: String,
    pub expires_at: String,
    pub interval_seconds: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuthorizationPollInput { pub device_code: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuthorizationPollView {
    pub status: String,
    pub interval_seconds: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuthorizationPollOutcome {
    pub poll: DesktopAuthorizationPollView,
    pub account: Option<DesktopAccountView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalPlatformSessionView {
    identity: DesktopIdentityView,
    session_token: String,
    expires_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizationPollResponse {
    status: String,
    interval_seconds: u64,
    session: Option<LocalPlatformSessionView>,
}

#[derive(Debug, Deserialize)]
struct ApiResponse<T> {
    ok: bool,
    data: Option<T>,
    code: Option<String>,
    message: Option<String>,
}

/** 在线校验 Credential Manager 中的会话；断网不删除仍可能有效的凭据。 */
pub fn account_status() -> Result<DesktopAccountView, String> {
    let Some(token) = read_credential()? else { return Ok(signed_out_view()); };
    let client = api_client()?;
    match send_session_request(&client, "GET", "/v1/auth/me", &token) {
        Ok(session) => Ok(connected_view(session)),
        Err(ApiFailure::Unauthorized) => {
            delete_credential()?;
            Ok(DesktopAccountView { status: "expired".into(), identity: None, expires_at: None, message: "账号授权已过期，请重新登录".into() })
        }
        Err(ApiFailure::Network) => Ok(DesktopAccountView { status: "offline".into(), identity: None, expires_at: None, message: "当前离线；本地生成和训练继续可用，联网后再校验图库账号".into() }),
        Err(ApiFailure::Service(message)) => Err(message),
    }
}

/** 创建一次设备授权请求；设备密钥只停留在当前 WebView 内存直至授权结束。 */
pub fn start_authorization(input: DesktopAuthorizationStartInput) -> Result<DesktopAuthorizationRequestView, String> {
    let device_name = input.device_name.trim();
    if device_name.is_empty() || device_name.chars().count() > 80 { return Err("设备名称必须为 1–80 个字符".into()); }
    post_json("/v1/desktop-auth/requests", &serde_json::json!({ "deviceName": device_name }))
}

/** 轮询设备授权；成功后立刻写入 Credential Manager，返回值不包含会话密钥。 */
pub fn poll_authorization(input: DesktopAuthorizationPollInput) -> Result<DesktopAuthorizationPollOutcome, String> {
    if input.device_code.len() < 32 || input.device_code.len() > 256 { return Err("设备授权密钥格式不正确".into()); }
    let response: AuthorizationPollResponse = post_json("/v1/desktop-auth/token", &serde_json::json!({ "deviceCode": input.device_code }))?;
    let poll = DesktopAuthorizationPollView { status: response.status.clone(), interval_seconds: response.interval_seconds };
    if response.status != "authorized" { return Ok(DesktopAuthorizationPollOutcome { poll, account: None }); }
    let session = response.session.ok_or_else(|| "设备授权响应缺少账号会话".to_string())?;
    credential_entry()?.set_password(&session.session_token).map_err(|_| "写入 Windows Credential Manager 失败".to_string())?;
    Ok(DesktopAuthorizationPollOutcome { poll, account: Some(connected_view(session)) })
}

/** 本机退出先尽力撤销服务端会话，再删除 Credential Manager 凭据。 */
pub fn sign_out() -> Result<DesktopAccountView, String> {
    if let Some(token) = read_credential()? {
        if let Ok(client) = api_client() { let _ = send_session_request(&client, "DELETE", "/v1/auth/session", &token); }
    }
    delete_credential()?;
    Ok(signed_out_view())
}

/** 使用固定超时创建桌面联网客户端，禁止请求无限挂起。 */
fn api_client() -> Result<Client, String> {
    Client::builder().connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(15)).user_agent("DrawHime-Desktop/0.1").build().map_err(|_| "创建账号网络客户端失败".into())
}

/** 调用设备授权 JSON 接口，公开错误不会包含密钥或服务端路径。 */
fn post_json<T: DeserializeOwned>(path: &str, body: &serde_json::Value) -> Result<T, String> {
    let response = api_client()?.post(format!("{API_BASE_URL}{path}")).json(body).send().map_err(|_| "连接账号服务失败，请检查网络".to_string())?;
    let status = response.status();
    let payload: ApiResponse<T> = response.json().map_err(|_| "账号服务返回格式不正确".to_string())?;
    if !status.is_success() || !payload.ok { return Err(payload.message.unwrap_or_else(|| payload.code.unwrap_or_else(|| format!("账号服务 HTTP {}", status.as_u16())))); }
    payload.data.ok_or_else(|| "账号服务未返回结果".into())
}

/** 读取或撤销独立会话，区分失效、离线与服务错误。 */
fn send_session_request(client: &Client, method: &str, path: &str, token: &str) -> Result<LocalPlatformSessionView, ApiFailure> {
    let builder = if method == "DELETE" { client.delete(format!("{API_BASE_URL}{path}")) } else { client.get(format!("{API_BASE_URL}{path}")) };
    let response = builder.bearer_auth(token).send().map_err(|_| ApiFailure::Network)?;
    let status = response.status();
    let payload: ApiResponse<LocalPlatformSessionView> = response.json().map_err(|_| ApiFailure::Service("账号服务返回格式不正确".into()))?;
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN { return Err(ApiFailure::Unauthorized); }
    if !status.is_success() || !payload.ok { return Err(ApiFailure::Service(payload.message.unwrap_or_else(|| format!("账号服务 HTTP {}", status.as_u16())))); }
    payload.data.ok_or_else(|| ApiFailure::Service("账号服务未返回会话".into()))
}

/** 创建固定 Credential Manager 项，不使用 SQLite 或明文配置保存会话。 */
fn credential_entry() -> Result<Entry, String> { Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_USER).map_err(|_| "初始化 Windows Credential Manager 失败".into()) }

/** 读取会话密钥；凭据不存在属于正常未登录状态。 */
fn read_credential() -> Result<Option<String>, String> {
    match credential_entry()?.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) | Err(KeyringError::NoEntry) => Ok(None),
        Err(_) => Err("读取 Windows Credential Manager 失败".into()),
    }
}

/** 幂等删除本机会话凭据。 */
fn delete_credential() -> Result<(), String> {
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(_) => Err("删除 Windows Credential Manager 凭据失败".into()),
    }
}

/** 构造已连接账号视图，原始 token 不进入 WebView。 */
fn connected_view(session: LocalPlatformSessionView) -> DesktopAccountView {
    DesktopAccountView { status: "connected".into(), identity: Some(session.identity), expires_at: Some(session.expires_at), message: "已连接绘图姬账号，可同步本地作品".into() }
}

/** 构造未登录状态。 */
fn signed_out_view() -> DesktopAccountView { DesktopAccountView { status: "signed_out".into(), identity: None, expires_at: None, message: "尚未连接绘图姬账号".into() } }

enum ApiFailure { Unauthorized, Network, Service(String) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_view_never_serializes_session_token() {
        let session = LocalPlatformSessionView {
            identity: DesktopIdentityView { issuer: "https://www.xanime.ink".into(), subject: "user-1".into(), display_name: "测试用户".into(), avatar_url: None, roles: vec!["user".into()], email_verified: true },
            session_token: "secret-device-session-token-never-exposed".into(),
            expires_at: "2026-08-29T00:00:00Z".into(),
        };
        let json = serde_json::to_string(&connected_view(session)).expect("序列化账号视图");
        assert!(!json.contains("secret-device-session-token-never-exposed"));
        assert!(!json.contains("sessionToken"));
    }
}
