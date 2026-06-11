//! 异步任务管理（用户排队 + 管理员查看）。
//!
//! 当前没有真正的"消费者"——长任务最终由谁执行由业务侧决定。这一层只负责：
//!   - 用户提交任务（生成排队记录）
//!   - 用户查看自己的任务
//!   - 管理员看全站
//!   - 任意角色（含 root cron）调 `update_task_status` 推进状态
//!
//! 路由：
//!   POST /api/me/tasks                  {taskType, payload}  → 排队
//!   GET  /api/me/tasks                                       → 我的列表
//!   GET  /api/me/tasks/{id}                                  → 详情
//!   POST /api/me/tasks/{id}/cancel
//!   GET  /api/admin/tasks                                    → 全站
//!   POST /api/admin/tasks/{id}/update   {status, progress, result, error}

use axum::extract::{Extension, Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/me/tasks", get(my_tasks).post(create_task))
        .route("/api/me/tasks/{id}", get(get_one))
        .route("/api/me/tasks/{id}/cancel", post(cancel))
        .route("/api/admin/tasks", get(admin_tasks))
        .route("/api/admin/tasks/{id}/update", post(admin_update))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct TaskRow {
    id: i64,
    user_id: i64,
    task_type: String,
    status: String,
    payload: Option<sqlx::types::Json<Value>>,
    result: Option<sqlx::types::Json<Value>>,
    error: Option<String>,
    progress: i32,
    started_at: Option<NaiveDateTime>,
    finished_at: Option<NaiveDateTime>,
    created_at: Option<NaiveDateTime>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTaskBody {
    task_type: String,
    #[serde(default)]
    payload: Option<Value>,
}

async fn create_task(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<CreateTaskBody>,
) -> ApiResult<Json<Value>> {
    if body.task_type.trim().is_empty() {
        return Err(ApiError::BadRequest("taskType 不能为空".into()));
    }
    let res = sqlx::query(
        "INSERT INTO async_tasks (user_id, task_type, status, payload) \
         VALUES (?, ?, 'queued', ?)",
    )
    .bind(ctx.user_id)
    .bind(body.task_type.trim())
    .bind(
        body.payload
            .as_ref()
            .map(|v| sqlx::types::Json(v.clone())),
    )
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "id": res.last_insert_id() })))
}

async fn my_tasks(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    let rows: Vec<TaskRow> = sqlx::query_as(
        "SELECT id, user_id, task_type, status, payload, result, error, progress, \
                started_at, finished_at, created_at \
         FROM async_tasks WHERE user_id = ? ORDER BY id DESC LIMIT 500",
    )
    .bind(ctx.user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "tasks": rows })))
}

async fn get_one(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let row: Option<TaskRow> = sqlx::query_as(
        "SELECT id, user_id, task_type, status, payload, result, error, progress, \
                started_at, finished_at, created_at \
         FROM async_tasks WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let row = row.ok_or_else(|| ApiError::NotFound("任务不存在".into()))?;
    if row.user_id != ctx.user_id && !ctx.has("config.read") {
        return Err(ApiError::Forbidden("无权访问该任务".into()));
    }
    Ok(Json(json!({ "ok": true, "task": row })))
}

async fn cancel(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let res = sqlx::query(
        "UPDATE async_tasks SET status = 'cancelled', finished_at = NOW() \
         WHERE id = ? AND user_id = ? AND status IN ('queued','running')",
    )
    .bind(id)
    .bind(ctx.user_id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound(
            "任务不存在或非可取消状态".into(),
        ));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn admin_tasks(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.read")?;
    let rows: Vec<TaskRow> = sqlx::query_as(
        "SELECT id, user_id, task_type, status, payload, result, error, progress, \
                started_at, finished_at, created_at \
         FROM async_tasks ORDER BY id DESC LIMIT 1000",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "tasks": rows })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTaskBody {
    status: Option<String>,
    progress: Option<i32>,
    result: Option<Value>,
    error: Option<String>,
}

async fn admin_update(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
    Json(body): Json<UpdateTaskBody>,
) -> ApiResult<Json<Value>> {
    ctx.require("config.write")?;
    let mut frags = Vec::<&str>::new();
    if body.status.is_some() {
        frags.push("status = ?");
    }
    if body.progress.is_some() {
        frags.push("progress = ?");
    }
    if body.result.is_some() {
        frags.push("result = CAST(? AS JSON)");
    }
    if body.error.is_some() {
        frags.push("error = ?");
    }
    if body.status.as_deref() == Some("running") {
        frags.push("started_at = NOW()");
    }
    if matches!(
        body.status.as_deref(),
        Some("succeeded") | Some("failed") | Some("cancelled")
    ) {
        frags.push("finished_at = NOW()");
    }
    if frags.is_empty() {
        return Err(ApiError::BadRequest("没有要更新的字段".into()));
    }
    let sql = format!("UPDATE async_tasks SET {} WHERE id = ?", frags.join(", "));
    let mut q = sqlx::query(&sql);
    if let Some(s) = &body.status {
        q = q.bind(s);
    }
    if let Some(p) = body.progress {
        q = q.bind(p);
    }
    if let Some(r) = &body.result {
        q = q.bind(r.to_string());
    }
    if let Some(e) = &body.error {
        q = q.bind(e);
    }
    q = q.bind(id);
    let res = q.execute(&state.db).await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("任务不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}
