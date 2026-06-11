//! 多租户：组织 + 成员管理（MVP）。
//!
//! 设计取舍：
//! - 本轮 **不强制把 organization_id 加到 users/usage_logs/subscriptions 等** —— 那是 weeks 级别的重构
//! - 提供完整 CRUD + 成员管理 API，让 root/admin 可以建组织、加成员
//! - 「按 org 切分账单」TODO：等用户实际有需求时，再在 relay/charge_user_with_token 中
//!   读取 ctx 当前 active_org_id（来自 header 或 session），写入 usage_logs.org_id
//!
//! 路由（管理员需要 `org.manage` 权限；本轮所有 root/admin 都隐式具备）：
//!   GET/POST           /api/admin/orgs
//!   GET/PATCH/DELETE   /api/admin/orgs/{id}
//!   GET/POST           /api/admin/orgs/{id}/members
//!   PATCH/DELETE       /api/admin/orgs/{id}/members/{user_id}
//!
//! 用户自助：
//!   GET                /api/me/orgs           我所在的所有组织

use axum::extract::{Extension, Path, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/orgs", get(list_orgs).post(create_org))
        .route(
            "/api/admin/orgs/{id}",
            get(get_org).patch(update_org).delete(delete_org),
        )
        .route(
            "/api/admin/orgs/{id}/members",
            get(list_members).post(add_member),
        )
        .route(
            "/api/admin/orgs/{id}/members/{user_id}",
            axum::routing::patch(update_member).delete(remove_member),
        )
        .route("/api/me/orgs", get(my_orgs))
}

fn need_root_or_admin(ctx: &UserContext) -> ApiResult<()> {
    if ctx.has("config.write") || ctx.has("*") {
        Ok(())
    } else {
        Err(ApiError::Forbidden("需要管理员权限".into()))
    }
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct OrgRow {
    id: i64,
    name: String,
    display_name: String,
    owner_user_id: i64,
    billing_email: Option<String>,
    status: String,
    description: Option<String>,
    created_at: Option<NaiveDateTime>,
    updated_at: Option<NaiveDateTime>,
}

async fn list_orgs(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    need_root_or_admin(&ctx)?;
    let rows: Vec<OrgRow> = sqlx::query_as(
        "SELECT id, name, display_name, owner_user_id, billing_email, status, description, \
                created_at, updated_at FROM organizations ORDER BY id DESC",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "orgs": rows })))
}

async fn get_org(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    need_root_or_admin(&ctx)?;
    let row: Option<OrgRow> = sqlx::query_as(
        "SELECT id, name, display_name, owner_user_id, billing_email, status, description, \
                created_at, updated_at FROM organizations WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let row = row.ok_or_else(|| ApiError::NotFound("组织不存在".into()))?;
    Ok(Json(json!({ "ok": true, "org": row })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertOrg {
    name: String,
    display_name: String,
    owner_user_id: Option<i64>,
    billing_email: Option<String>,
    #[serde(default = "default_status")]
    status: String,
    description: Option<String>,
}

fn default_status() -> String {
    "active".into()
}

async fn create_org(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<UpsertOrg>,
) -> ApiResult<Json<Value>> {
    need_root_or_admin(&ctx)?;
    let owner_id = body.owner_user_id.unwrap_or(ctx.user_id);
    if !["active", "disabled"].contains(&body.status.as_str()) {
        return Err(ApiError::BadRequest("status 必须是 active/disabled".into()));
    }
    let res = sqlx::query(
        "INSERT INTO organizations (name, display_name, owner_user_id, billing_email, status, description) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(body.name.trim())
    .bind(body.display_name.trim())
    .bind(owner_id)
    .bind(body.billing_email.as_deref())
    .bind(&body.status)
    .bind(body.description.as_deref())
    .execute(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("Duplicate") {
            ApiError::Conflict("组织代号已被使用".into())
        } else {
            ApiError::Database(e.to_string())
        }
    })?;
    let new_id = res.last_insert_id() as i64;
    // 自动把 owner 加为 owner role 成员
    sqlx::query(
        "INSERT IGNORE INTO organization_members (org_id, user_id, role) \
         VALUES (?, ?, 'owner')",
    )
    .bind(new_id)
    .bind(owner_id)
    .execute(&state.db)
    .await
    .ok();
    Ok(Json(json!({ "ok": true, "id": new_id })))
}

async fn update_org(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
    Json(body): Json<UpsertOrg>,
) -> ApiResult<Json<Value>> {
    need_root_or_admin(&ctx)?;
    let res = sqlx::query(
        "UPDATE organizations SET name=?, display_name=?, owner_user_id=?, billing_email=?, \
         status=?, description=? WHERE id=?",
    )
    .bind(body.name.trim())
    .bind(body.display_name.trim())
    .bind(body.owner_user_id.unwrap_or(ctx.user_id))
    .bind(body.billing_email.as_deref())
    .bind(&body.status)
    .bind(body.description.as_deref())
    .bind(id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("组织不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn delete_org(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    need_root_or_admin(&ctx)?;
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM organization_members WHERE org_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let res = sqlx::query("DELETE FROM organizations WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("组织不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

// ============================================================================
// 成员管理
// ============================================================================

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct MemberRow {
    id: i64,
    org_id: i64,
    user_id: i64,
    username: String,
    role: String,
    created_at: Option<NaiveDateTime>,
}

async fn list_members(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(org_id): Path<i64>,
) -> ApiResult<Json<Value>> {
    need_root_or_admin(&ctx)?;
    let rows: Vec<MemberRow> = sqlx::query_as(
        "SELECT m.id, m.org_id, m.user_id, u.username, m.role, m.created_at \
         FROM organization_members m JOIN users u ON u.id = m.user_id \
         WHERE m.org_id = ? ORDER BY m.id",
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "members": rows })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddMember {
    user_id: i64,
    #[serde(default = "default_member_role")]
    role: String,
}

fn default_member_role() -> String {
    "member".into()
}

async fn add_member(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(org_id): Path<i64>,
    Json(body): Json<AddMember>,
) -> ApiResult<Json<Value>> {
    need_root_or_admin(&ctx)?;
    if !["owner", "admin", "member"].contains(&body.role.as_str()) {
        return Err(ApiError::BadRequest(
            "role 必须是 owner/admin/member".into(),
        ));
    }
    sqlx::query(
        "INSERT INTO organization_members (org_id, user_id, role) VALUES (?, ?, ?) \
         ON DUPLICATE KEY UPDATE role = VALUES(role)",
    )
    .bind(org_id)
    .bind(body.user_id)
    .bind(&body.role)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateMember {
    role: String,
}

async fn update_member(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path((org_id, user_id)): Path<(i64, i64)>,
    Json(body): Json<UpdateMember>,
) -> ApiResult<Json<Value>> {
    need_root_or_admin(&ctx)?;
    if !["owner", "admin", "member"].contains(&body.role.as_str()) {
        return Err(ApiError::BadRequest("role 不合法".into()));
    }
    let res = sqlx::query(
        "UPDATE organization_members SET role = ? WHERE org_id = ? AND user_id = ?",
    )
    .bind(&body.role)
    .bind(org_id)
    .bind(user_id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("成员不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn remove_member(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path((org_id, user_id)): Path<(i64, i64)>,
) -> ApiResult<Json<Value>> {
    need_root_or_admin(&ctx)?;
    let res = sqlx::query(
        "DELETE FROM organization_members WHERE org_id = ? AND user_id = ?",
    )
    .bind(org_id)
    .bind(user_id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("成员不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

// ============================================================================
// 用户自助
// ============================================================================

async fn my_orgs(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    let rows: Vec<(i64, String, String, String)> = sqlx::query_as(
        "SELECT o.id, o.name, o.display_name, m.role \
         FROM organization_members m JOIN organizations o ON o.id = m.org_id \
         WHERE m.user_id = ? AND o.status = 'active' ORDER BY o.id",
    )
    .bind(ctx.user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({
        "ok": true,
        "orgs": rows.into_iter().map(|(id, name, dn, role)| json!({
            "id": id, "name": name, "displayName": dn, "role": role,
        })).collect::<Vec<_>>(),
    })))
}
