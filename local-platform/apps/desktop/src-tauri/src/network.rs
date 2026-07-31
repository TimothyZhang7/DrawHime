//! 本模块统一创建桌面在线请求客户端，并读取 Windows 当前用户的系统代理设置。

use reqwest::{blocking::ClientBuilder, NoProxy, Proxy};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProxyScope {
    All,
    Http,
    Https,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProxyRule {
    scope: ProxyScope,
    url: String,
}

/** 创建会继承环境变量及 Windows 手动系统代理的在线客户端构造器。 */
pub fn online_client_builder() -> ClientBuilder {
    let mut builder = reqwest::blocking::Client::builder().user_agent("DrawHime-Desktop/0.1");
    #[cfg(windows)]
    {
        if let Some((rules, bypass)) = windows_proxy_configuration() {
            let no_proxy = NoProxy::from_string(&bypass);
            for rule in rules {
                let proxy = match rule.scope {
                    ProxyScope::All => Proxy::all(&rule.url),
                    ProxyScope::Http => Proxy::http(&rule.url),
                    ProxyScope::Https => Proxy::https(&rule.url),
                };
                if let Ok(proxy) = proxy {
                    builder = builder.proxy(proxy.no_proxy(no_proxy.clone()));
                }
            }
        }
    }
    builder
}

#[cfg(windows)]
/** 读取当前 Windows 用户实时代理设置，使应用启动后切换梯子也能在下一次请求生效。 */
fn windows_proxy_configuration() -> Option<(Vec<ProxyRule>, String)> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    let internet_settings = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    let enabled = internet_settings.get_value::<u32, _>("ProxyEnable").unwrap_or(0) == 1;
    if !enabled {
        return None;
    }
    let server = internet_settings.get_value::<String, _>("ProxyServer").ok()?;
    let rules = parse_proxy_server(&server);
    if rules.is_empty() {
        return None;
    }
    let overrides = internet_settings.get_value::<String, _>("ProxyOverride").unwrap_or_default();
    Some((rules, normalize_proxy_bypass(&overrides)))
}

/** 解析 Windows 的统一代理及按 HTTP、HTTPS、SOCKS 分协议代理格式。 */
fn parse_proxy_server(value: &str) -> Vec<ProxyRule> {
    let value = value.trim();
    if value.is_empty() {
        return Vec::new();
    }
    if !value.contains('=') {
        return normalize_proxy_url(value, false)
            .map(|url| vec![ProxyRule { scope: ProxyScope::All, url }])
            .unwrap_or_default();
    }
    value
        .split(';')
        .filter_map(|entry| {
            let (kind, address) = entry.split_once('=')?;
            let kind = kind.trim().to_ascii_lowercase();
            let scope = match kind.as_str() {
                "http" => ProxyScope::Http,
                "https" => ProxyScope::Https,
                "socks" | "socks5" => ProxyScope::All,
                _ => return None,
            };
            normalize_proxy_url(address.trim(), matches!(kind.as_str(), "socks" | "socks5"))
                .map(|url| ProxyRule { scope, url })
        })
        .collect()
}

/** 为省略协议的代理地址补全 reqwest 可识别的 URL，并保留用户显式协议。 */
fn normalize_proxy_url(value: &str, socks: bool) -> Option<String> {
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        return None;
    }
    if value.contains("://") {
        return Some(value.to_string());
    }
    Some(format!("{}://{value}", if socks { "socks5h" } else { "http" }))
}

/** 把 Windows 常见绕过规则转换为 reqwest NoProxy 支持的域名和 CIDR 列表。 */
fn normalize_proxy_bypass(value: &str) -> String {
    let mut entries = vec!["localhost".to_string(), "127.0.0.1".to_string(), "::1".to_string()];
    for raw in value.split(';').map(str::trim).filter(|entry| !entry.is_empty()) {
        let normalized = match raw.to_ascii_lowercase().as_str() {
            "<local>" => continue,
            "127.*" => "127.0.0.0/8",
            "10.*" => "10.0.0.0/8",
            "192.168.*" => "192.168.0.0/16",
            "172.16.*" => "172.16.0.0/12",
            _ if raw.contains('*') => continue,
            _ => raw,
        };
        if !entries.iter().any(|entry| entry.eq_ignore_ascii_case(normalized)) {
            entries.push(normalized.to_string());
        }
    }
    entries.join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_windows_proxy_formats() {
        assert_eq!(parse_proxy_server("127.0.0.1:7897"), vec![ProxyRule { scope: ProxyScope::All, url: "http://127.0.0.1:7897".into() }]);
        assert_eq!(parse_proxy_server("http=127.0.0.1:7897;https=127.0.0.1:7897;socks=127.0.0.1:7898").len(), 3);
    }

    #[test]
    fn keeps_loopback_requests_out_of_system_proxy() {
        let bypass = normalize_proxy_bypass("localhost;127.*;192.168.*;<local>;*.invalid");
        assert_eq!(bypass, "localhost,127.0.0.1,::1,127.0.0.0/8,192.168.0.0/16");
    }
}
