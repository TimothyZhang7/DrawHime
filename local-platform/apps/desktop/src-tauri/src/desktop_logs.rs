//! 本模块持久化和分页查询不含敏感业务正文的桌面结构化日志。

use crate::models::{DesktopLogEntryView, DesktopLogPageView, DesktopLogQueryInput};
use chrono::{Duration, Utc};
use rusqlite::{params, Connection};
use uuid::Uuid;

const MAX_LOG_ROWS: u64 = 50_000;
const MAX_RETENTION_DAYS: i64 = 30;

/** 写入单条脱敏日志，并限制日志表最多保留 30 天或 50,000 条。 */
pub fn append_log(
    database: &Connection,
    task_id: Option<&str>,
    level: &str,
    scope: &str,
    event: &str,
    message: &str,
    details: Option<&str>,
) -> Result<(), String> {
    let level = match level {
        "debug" | "info" | "warn" | "error" => level,
        _ => return Err("桌面日志级别无效".into()),
    };
    let now = Utc::now().to_rfc3339();
    database
        .execute(
            "INSERT INTO desktop_logs (id,task_id,level,scope,event,message,details,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![Uuid::new_v4().to_string(), task_id, level, scope, event, truncate(message, 2000), details.map(|value| truncate(value, 8000)), now],
        )
        .map_err(|error| format!("写入桌面日志失败：{error}"))?;
    prune_logs(database)
}

/** 分页查询结构化日志，固定 SQL 条件避免动态拼接用户输入。 */
pub fn list_logs(
    database: &Connection,
    input: DesktopLogQueryInput,
) -> Result<DesktopLogPageView, String> {
    validate_query(&input)?;
    let since = input
        .since_minutes
        .map(|minutes| (Utc::now() - Duration::minutes(i64::from(minutes))).to_rfc3339());
    let search = input
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let where_clause = "(?1 IS NULL OR created_at>=?1) AND (?2 IS NULL OR task_id=?2) AND (?3 IS NULL OR level=?3) AND (?4 IS NULL OR scope=?4) AND (?5 IS NULL OR message LIKE '%'||?5||'%' OR event LIKE '%'||?5||'%' OR COALESCE(details,'') LIKE '%'||?5||'%')";
    let total: u64 = database
        .query_row(
            &format!("SELECT COUNT(*) FROM desktop_logs WHERE {where_clause}"),
            params![since, input.task_id, input.level, input.scope, search],
            |row| row.get(0),
        )
        .map_err(|error| format!("统计桌面日志失败：{error}"))?;
    let mut statement = database
        .prepare(&format!("SELECT id,task_id,level,scope,event,message,details,created_at FROM desktop_logs WHERE {where_clause} ORDER BY created_at DESC LIMIT ?6 OFFSET ?7"))
        .map_err(|error| format!("准备桌面日志查询失败：{error}"))?;
    let rows = statement
        .query_map(
            params![
                since,
                input.task_id,
                input.level,
                input.scope,
                search,
                input.limit,
                input.offset
            ],
            |row| {
                Ok(DesktopLogEntryView {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    level: row.get(2)?,
                    scope: row.get(3)?,
                    event: row.get(4)?,
                    message: row.get(5)?,
                    details: row.get(6)?,
                    created_at: row.get(7)?,
                })
            },
        )
        .map_err(|error| format!("查询桌面日志失败：{error}"))?;
    let items = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析桌面日志失败：{error}"))?;
    Ok(DesktopLogPageView {
        has_more: u64::from(input.offset) + (items.len() as u64) < total,
        items,
        total,
    })
}

/** 启动时执行一次完整清理，后续写入只清除超过硬上限的最旧日志。 */
pub fn initialize_retention(database: &Connection) -> Result<(), String> {
    database
        .execute(
            "DELETE FROM desktop_logs WHERE julianday(created_at)<julianday('now',?1)",
            [format!("-{MAX_RETENTION_DAYS} days")],
        )
        .map_err(|error| format!("清理过期桌面日志失败：{error}"))?;
    prune_logs(database)
}

fn prune_logs(database: &Connection) -> Result<(), String> {
    database
        .execute(
            "DELETE FROM desktop_logs WHERE rowid IN (SELECT rowid FROM desktop_logs ORDER BY created_at DESC LIMIT -1 OFFSET ?1)",
            [MAX_LOG_ROWS],
        )
        .map_err(|error| format!("限制桌面日志容量失败：{error}"))?;
    Ok(())
}

fn validate_query(input: &DesktopLogQueryInput) -> Result<(), String> {
    if input.limit == 0 || input.limit > 500 {
        return Err("日志分页大小必须在 1 到 500 之间".into());
    }
    if input
        .since_minutes
        .is_some_and(|value| value == 0 || value > 43_200)
    {
        return Err("日志时间范围无效".into());
    }
    if input
        .search
        .as_ref()
        .is_some_and(|value| value.chars().count() > 200)
    {
        return Err("日志搜索文本过长".into());
    }
    Ok(())
}

fn truncate(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let database = Connection::open_in_memory().expect("创建日志测试数据库");
        database.execute_batch("CREATE TABLE desktop_logs (id TEXT PRIMARY KEY, task_id TEXT, level TEXT NOT NULL, scope TEXT NOT NULL, event TEXT NOT NULL, message TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL); CREATE INDEX desktop_logs_created_idx ON desktop_logs(created_at DESC);").expect("创建日志测试表");
        database
    }

    #[test]
    fn task_filter_returns_only_matching_logs() {
        let database = database();
        let task_id = Uuid::new_v4().to_string();
        append_log(
            &database,
            Some(&task_id),
            "info",
            "generation",
            "queued",
            "任务进入队列",
            None,
        )
        .expect("写入任务日志");
        append_log(
            &database,
            None,
            "error",
            "runtime",
            "failed",
            "Runtime 失败",
            Some("test"),
        )
        .expect("写入全局日志");
        let page = list_logs(
            &database,
            DesktopLogQueryInput {
                since_minutes: None,
                task_id: Some(task_id),
                level: None,
                scope: None,
                search: None,
                offset: 0,
                limit: 20,
            },
        )
        .expect("查询任务日志");
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].event, "queued");
        assert!(!page.has_more);
    }
}
