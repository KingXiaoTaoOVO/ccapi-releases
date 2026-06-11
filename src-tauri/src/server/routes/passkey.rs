//! Passkey / WebAuthn 路由 —— 升级版：能解 attestationObject 抽 COSE 公钥 +
//! 用 p256 真做 ECDSA 签名验证（覆盖最常见的 ES256 / alg=-7 / P-256 场景）。
//!
//! **范围**：
//! - 注册：解析 navigator.credentials.create() 的 attestationObject (CBOR)，
//!   从 authData 中抽出 P-256 公钥（COSE_Key）并入库；同时校验 challenge。
//! - 登录：navigator.credentials.get() 的 assertion 提交后，按 W3C WebAuthn
//!   spec 6.3.3 用 p256 ECDSA 验签：sig over (authenticatorData ‖ SHA256(clientDataJSON))。
//! - 没做：attestation statement 校验（fmt=packed/fido-u2f 等的证书链 / 信任链
//!   —— 99% 个人级 Passkey 场景用 fmt="none"，不需要）。Ed25519 / RS256 公钥也未支持
//!   —— 浏览器默认 ES256 通常够用；如需扩展可加 ed25519-dalek + rsa crate。

use axum::extract::{Extension, Path, Query, State};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::Engine;
use chrono::{NaiveDateTime, Utc};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::server::error::{ApiError, ApiResult};
use crate::server::jwt_mw::UserContext;
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/me/passkey/register-options", post(register_options))
        .route("/api/me/passkey/register", post(register_complete))
        .route("/api/me/passkey/list", get(list_passkeys))
        .route("/api/me/passkey/{id}", delete(delete_passkey))
}

pub fn public_router() -> Router<AppState> {
    Router::new()
        .route("/api/passkey/login-options", get(login_options))
        .route("/api/passkey/login", post(login_complete))
}

// ===========================================================================
// 工具
// ===========================================================================

const B64URL: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

fn random_b64(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut bytes);
    B64URL.encode(&bytes)
}

fn decode_b64url(s: &str) -> Result<Vec<u8>, ApiError> {
    B64URL
        .decode(s)
        .map_err(|e| ApiError::BadRequest(format!("base64url decode: {e}")))
}

async fn challenge_put(
    state: &AppState,
    purpose: &str,
    key_suffix: &str,
    challenge: &str,
) -> ApiResult<()> {
    let mut redis = state.redis.clone();
    let key = format!("passkey_chal:{purpose}:{key_suffix}:{challenge}");
    let _: () = redis::cmd("SET")
        .arg(&key)
        .arg("1")
        .arg("EX")
        .arg(5 * 60)
        .query_async(&mut redis)
        .await?;
    Ok(())
}

async fn challenge_consume(
    state: &AppState,
    purpose: &str,
    key_suffix: &str,
    challenge: &str,
) -> ApiResult<()> {
    let mut redis = state.redis.clone();
    let key = format!("passkey_chal:{purpose}:{key_suffix}:{challenge}");
    let deleted: i64 = redis::cmd("DEL").arg(&key).query_async(&mut redis).await?;
    if deleted == 0 {
        return Err(ApiError::BadRequest(
            "challenge 已过期或无效，请重新发起".into(),
        ));
    }
    Ok(())
}

// ===========================================================================
// CBOR / WebAuthn 解析（最小子集）
// ===========================================================================

#[derive(Debug)]
struct P256Pub {
    x: [u8; 32],
    y: [u8; 32],
}

/// 解析 attestationObject (CBOR) → 抽出 authData，再从 authData 中抽出
/// rpIdHash / flags / signCount / credentialId / COSE_Key(ES256).
fn parse_attestation(att_bytes: &[u8]) -> Result<(Vec<u8>, P256Pub, [u8; 32]), String> {
    let val: ciborium::Value = ciborium::de::from_reader(att_bytes)
        .map_err(|e| format!("CBOR decode attestationObject: {e}"))?;
    let map = match val {
        ciborium::Value::Map(m) => m,
        _ => return Err("attestationObject is not a CBOR map".into()),
    };
    let mut auth_data: Option<Vec<u8>> = None;
    for (k, v) in map {
        if let ciborium::Value::Text(s) = k {
            if s == "authData" {
                if let ciborium::Value::Bytes(b) = v {
                    auth_data = Some(b);
                }
            }
        }
    }
    let auth_data =
        auth_data.ok_or_else(|| "attestationObject lacks authData".to_string())?;
    let (cred_id, pub_key, rp_id_hash) = parse_auth_data(&auth_data)?;
    Ok((cred_id, pub_key, rp_id_hash))
}

fn parse_auth_data(auth: &[u8]) -> Result<(Vec<u8>, P256Pub, [u8; 32]), String> {
    if auth.len() < 37 {
        return Err("authData too short".into());
    }
    let mut rp_id_hash = [0u8; 32];
    rp_id_hash.copy_from_slice(&auth[..32]);
    let flags = auth[32];
    // signCount auth[33..37]
    let has_attested = (flags & 0b0100_0000) != 0;
    if !has_attested {
        return Err("authData missing attestedCredentialData (AT flag)".into());
    }
    let mut off = 37 + 16; // skip aaguid
    if auth.len() < off + 2 {
        return Err("authData too short before credIdLen".into());
    }
    let cred_id_len = u16::from_be_bytes([auth[off], auth[off + 1]]) as usize;
    off += 2;
    if auth.len() < off + cred_id_len {
        return Err("authData too short for credentialId".into());
    }
    let cred_id = auth[off..off + cred_id_len].to_vec();
    off += cred_id_len;
    let cose_key_bytes = &auth[off..];

    let key_val: ciborium::Value = ciborium::de::from_reader(cose_key_bytes)
        .map_err(|e| format!("CBOR decode COSE_Key: {e}"))?;
    let key_map = match key_val {
        ciborium::Value::Map(m) => m,
        _ => return Err("COSE_Key is not a map".into()),
    };
    let mut kty: Option<i64> = None;
    let mut alg: Option<i64> = None;
    let mut crv: Option<i64> = None;
    let mut x: Option<Vec<u8>> = None;
    let mut y: Option<Vec<u8>> = None;
    for (k, v) in key_map {
        let label = match k {
            ciborium::Value::Integer(i) => {
                let raw: i128 = i.into();
                raw as i64
            }
            _ => continue,
        };
        match (label, v) {
            (1, ciborium::Value::Integer(i)) => kty = Some({ let r: i128 = i.into(); r as i64 }),
            (3, ciborium::Value::Integer(i)) => alg = Some({ let r: i128 = i.into(); r as i64 }),
            (-1, ciborium::Value::Integer(i)) => crv = Some({ let r: i128 = i.into(); r as i64 }),
            (-2, ciborium::Value::Bytes(b)) => x = Some(b),
            (-3, ciborium::Value::Bytes(b)) => y = Some(b),
            _ => {}
        }
    }
    if kty != Some(2) {
        return Err(format!("only EC2 kty supported (got {kty:?})"));
    }
    if alg != Some(-7) {
        return Err(format!(
            "only ES256 (alg=-7) supported (got {alg:?})"
        ));
    }
    if crv != Some(1) {
        return Err(format!("only P-256 crv (got {crv:?})"));
    }
    let (Some(x), Some(y)) = (x, y) else {
        return Err("missing x/y in COSE_Key".into());
    };
    if x.len() != 32 || y.len() != 32 {
        return Err("x/y must be 32 bytes each for P-256".into());
    }
    let mut xa = [0u8; 32];
    let mut ya = [0u8; 32];
    xa.copy_from_slice(&x);
    ya.copy_from_slice(&y);
    Ok((cred_id, P256Pub { x: xa, y: ya }, rp_id_hash))
}

/// 序列化公钥为 base64url(SEC1 uncompressed: 04 || X || Y)
fn pubkey_to_b64(pk: &P256Pub) -> String {
    let mut buf = Vec::with_capacity(65);
    buf.push(0x04);
    buf.extend_from_slice(&pk.x);
    buf.extend_from_slice(&pk.y);
    B64URL.encode(&buf)
}

/// 反序列化 base64url 的 SEC1 公钥 → VerifyingKey
fn b64_to_verifying(s: &str) -> Result<VerifyingKey, ApiError> {
    let bytes = decode_b64url(s)?;
    VerifyingKey::from_sec1_bytes(&bytes)
        .map_err(|e| ApiError::BadRequest(format!("公钥解析失败: {e}")))
}

/// 解 DER/raw ECDSA 签名
fn parse_sig(bytes: &[u8]) -> Result<Signature, ApiError> {
    Signature::from_der(bytes)
        .or_else(|_| {
            if bytes.len() == 64 {
                Signature::try_from(bytes)
                    .map_err(|e| ApiError::BadRequest(format!("签名 raw 解码失败: {e}")))
            } else {
                Err(ApiError::BadRequest("签名既不是 DER 也不是 64 字节 raw".into()))
            }
        })
}

// ===========================================================================
// 注册
// ===========================================================================

async fn register_options(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    let username: (String,) = sqlx::query_as("SELECT username FROM users WHERE id = ?")
        .bind(ctx.user_id)
        .fetch_one(&state.db)
        .await?;
    let challenge = random_b64(16);
    challenge_put(&state, "register", &ctx.user_id.to_string(), &challenge).await?;
    let existing: Vec<(String,)> =
        sqlx::query_as("SELECT credential_id FROM user_passkeys WHERE user_id = ?")
            .bind(ctx.user_id)
            .fetch_all(&state.db)
            .await?;
    Ok(Json(json!({
        "ok": true,
        "challenge": challenge,
        "rpId": "ccapi.local",
        "rpName": "CCAPI",
        "userId": B64URL.encode(format!("u{}", ctx.user_id).as_bytes()),
        "userName": username.0,
        "excludeCredentials": existing.iter().map(|(c,)| c).collect::<Vec<_>>(),
        // 前端传给 PublicKeyCredentialCreationOptions：仅 ES256
        "pubKeyAlgorithms": [-7],
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterComplete {
    challenge: String,
    /// base64url(navigator.credentials.create().response.attestationObject)
    attestation_object: String,
    /// base64url(clientDataJSON) —— 用于校验 challenge 是否回灌
    client_data_json: String,
    #[serde(default)]
    nickname: Option<String>,
}

async fn register_complete(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Json(body): Json<RegisterComplete>,
) -> ApiResult<Json<Value>> {
    // 1) 校验 + 消费 challenge
    challenge_consume(&state, "register", &ctx.user_id.to_string(), &body.challenge).await?;
    // 2) clientDataJSON 里的 challenge 必须匹配
    let client_data_bytes = decode_b64url(&body.client_data_json)?;
    let cd: Value = serde_json::from_slice(&client_data_bytes)
        .map_err(|e| ApiError::BadRequest(format!("clientDataJSON 解码失败: {e}")))?;
    let cd_chal = cd
        .get("challenge")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::BadRequest("clientDataJSON 缺 challenge".into()))?;
    if cd_chal != body.challenge {
        return Err(ApiError::BadRequest(
            "clientDataJSON.challenge 与服务端不一致".into(),
        ));
    }
    let cd_type = cd.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if cd_type != "webauthn.create" {
        return Err(ApiError::BadRequest(
            "clientDataJSON.type 必须为 webauthn.create".into(),
        ));
    }
    // 3) 解 attestationObject 抽公钥 + credentialId
    let att_bytes = decode_b64url(&body.attestation_object)?;
    let (cred_id, pubkey, _rp_id_hash) =
        parse_attestation(&att_bytes).map_err(ApiError::BadRequest)?;
    let cred_id_b64 = B64URL.encode(&cred_id);
    let pubkey_b64 = pubkey_to_b64(&pubkey);
    // 4) 防 credential 重复
    let dup: Option<(i64,)> =
        sqlx::query_as("SELECT id FROM user_passkeys WHERE credential_id = ?")
            .bind(&cred_id_b64)
            .fetch_optional(&state.db)
            .await?;
    if dup.is_some() {
        return Err(ApiError::Conflict("该 Passkey 已被注册".into()));
    }
    sqlx::query(
        "INSERT INTO user_passkeys (user_id, credential_id, public_key, nickname) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(ctx.user_id)
    .bind(&cred_id_b64)
    .bind(&pubkey_b64)
    .bind(body.nickname.as_deref())
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "credentialId": cred_id_b64 })))
}

// ===========================================================================
// 登录（公开）
// ===========================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginOptionsQuery {
    /// 客户端可以提供 username 让服务端过滤候选 credentialIds；
    /// 不提供则纯 platform discovery（浏览器主动列已有 passkey）。
    username: Option<String>,
}

async fn login_options(
    State(state): State<AppState>,
    Query(q): Query<LoginOptionsQuery>,
) -> ApiResult<Json<Value>> {
    let challenge = random_b64(16);
    // 用 challenge 本身作 key 后缀，无用户态
    challenge_put(&state, "login", "anon", &challenge).await?;
    let allow: Vec<String> = if let Some(u) = q.username.as_deref() {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT p.credential_id FROM user_passkeys p \
             JOIN users u ON u.id = p.user_id WHERE u.username = ?",
        )
        .bind(u)
        .fetch_all(&state.db)
        .await?;
        rows.into_iter().map(|(c,)| c).collect()
    } else {
        Vec::new()
    };
    Ok(Json(json!({
        "ok": true,
        "challenge": challenge,
        "rpId": "ccapi.local",
        "allowCredentials": allow,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginComplete {
    challenge: String,
    credential_id: String,
    authenticator_data: String, // base64url
    client_data_json: String,   // base64url
    signature: String,          // base64url
}

async fn login_complete(
    State(state): State<AppState>,
    Json(body): Json<LoginComplete>,
) -> ApiResult<Json<Value>> {
    challenge_consume(&state, "login", "anon", &body.challenge).await?;

    // 取 credential 对应的用户 + 公钥
    let row: Option<(i64, String, String)> = sqlx::query_as(
        "SELECT p.user_id, p.public_key, r.name AS role \
         FROM user_passkeys p \
         JOIN users u ON u.id = p.user_id \
         JOIN roles r ON r.id = u.role_id \
         WHERE p.credential_id = ?",
    )
    .bind(&body.credential_id)
    .fetch_optional(&state.db)
    .await?;
    let (user_id, pubkey_b64, role) =
        row.ok_or_else(|| ApiError::Unauthorized)?;

    // clientDataJSON 校验
    let client_data_bytes = decode_b64url(&body.client_data_json)?;
    let cd: Value = serde_json::from_slice(&client_data_bytes)
        .map_err(|e| ApiError::BadRequest(format!("clientDataJSON 解码失败: {e}")))?;
    if cd.get("challenge").and_then(|v| v.as_str()) != Some(body.challenge.as_str()) {
        return Err(ApiError::Unauthorized);
    }
    if cd.get("type").and_then(|v| v.as_str()) != Some("webauthn.get") {
        return Err(ApiError::Unauthorized);
    }

    // 验签：sig over (authenticatorData ‖ SHA256(clientDataJSON))
    let mut signed = Vec::new();
    let ad = decode_b64url(&body.authenticator_data)?;
    signed.extend_from_slice(&ad);
    let mut h = Sha256::new();
    h.update(&client_data_bytes);
    let cd_hash = h.finalize();
    signed.extend_from_slice(&cd_hash);

    let sig_bytes = decode_b64url(&body.signature)?;
    let sig = parse_sig(&sig_bytes)?;
    let vk = b64_to_verifying(&pubkey_b64)?;
    vk.verify(&signed, &sig)
        .map_err(|_| ApiError::Unauthorized)?;

    // 更新 last_used_at + sign_count
    sqlx::query(
        "UPDATE user_passkeys SET last_used_at = NOW(), sign_count = sign_count + 1 \
         WHERE credential_id = ?",
    )
    .bind(&body.credential_id)
    .execute(&state.db)
    .await
    .ok();

    // 颁发 JWT
    let pair = state.jwt.issue_pair(user_id, &role)?;
    let mut conn = state.redis.clone();
    let _: Result<i32, _> = redis::cmd("SET")
        .arg(format!("refresh:{}", pair.jti))
        .arg(user_id)
        .arg("EX")
        .arg(pair.refresh_expires_in)
        .query_async(&mut conn)
        .await;
    let username_row: (String,) = sqlx::query_as("SELECT username FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(json!({
        "ok": true,
        "tokens": pair,
        "user": { "id": user_id, "username": username_row.0, "role": role },
    })))
}

// ===========================================================================
// list / delete
// ===========================================================================

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct PasskeyRow {
    id: i64,
    credential_id: String,
    nickname: Option<String>,
    sign_count: i64,
    last_used_at: Option<NaiveDateTime>,
    created_at: Option<NaiveDateTime>,
}

async fn list_passkeys(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
) -> ApiResult<Json<Value>> {
    let rows: Vec<PasskeyRow> = sqlx::query_as(
        "SELECT id, credential_id, nickname, sign_count, last_used_at, created_at \
         FROM user_passkeys WHERE user_id = ? ORDER BY id DESC",
    )
    .bind(ctx.user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true, "passkeys": rows })))
}

async fn delete_passkey(
    State(state): State<AppState>,
    Extension(ctx): Extension<UserContext>,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let res = sqlx::query("DELETE FROM user_passkeys WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(ctx.user_id)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound("Passkey 不存在".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

#[allow(dead_code)]
fn now_naive() -> NaiveDateTime {
    Utc::now().naive_utc()
}
