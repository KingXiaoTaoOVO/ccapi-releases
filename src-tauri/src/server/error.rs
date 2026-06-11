use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
#[allow(dead_code)]
pub enum ApiError {
    Unauthorized,
    Forbidden(String),
    BadRequest(String),
    NotFound(String),
    Conflict(String),
    TooManyRequests,
    QuotaExhausted(String),
    NotInitialized,
    ServiceUnavailable(String),
    Database(String),
    Redis(String),
    Internal(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Unauthorized => write!(f, "未授权"),
            ApiError::Forbidden(m) => write!(f, "禁止访问: {m}"),
            ApiError::BadRequest(m) => write!(f, "参数错误: {m}"),
            ApiError::NotFound(m) => write!(f, "找不到资源: {m}"),
            ApiError::Conflict(m) => write!(f, "冲突: {m}"),
            ApiError::TooManyRequests => write!(f, "请求过快"),
            ApiError::QuotaExhausted(m) => write!(f, "额度已用完: {m}"),
            ApiError::NotInitialized => write!(f, "服务端未初始化"),
            ApiError::ServiceUnavailable(m) => write!(f, "服务暂不可用: {m}"),
            ApiError::Database(m) => write!(f, "数据库错误: {m}"),
            ApiError::Redis(m) => write!(f, "Redis 错误: {m}"),
            ApiError::Internal(m) => write!(f, "内部错误: {m}"),
        }
    }
}

impl std::error::Error for ApiError {}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            ApiError::Forbidden(_) => (StatusCode::FORBIDDEN, "forbidden"),
            ApiError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            ApiError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            ApiError::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            ApiError::TooManyRequests => (StatusCode::TOO_MANY_REQUESTS, "too_many_requests"),
            ApiError::QuotaExhausted(_) => (StatusCode::PAYMENT_REQUIRED, "quota_exhausted"),
            ApiError::NotInitialized => (StatusCode::SERVICE_UNAVAILABLE, "not_initialized"),
            ApiError::ServiceUnavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, "service_unavailable"),
            ApiError::Database(_) => (StatusCode::INTERNAL_SERVER_ERROR, "database"),
            ApiError::Redis(_) => (StatusCode::INTERNAL_SERVER_ERROR, "redis"),
            ApiError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        };
        let body = Json(json!({
            "ok": false,
            "code": code,
            "message": self.to_string(),
        }));
        (status, body).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        if matches!(e, sqlx::Error::RowNotFound) {
            ApiError::NotFound("记录不存在".into())
        } else {
            ApiError::Database(e.to_string())
        }
    }
}

impl From<redis::RedisError> for ApiError {
    fn from(e: redis::RedisError) -> Self {
        ApiError::Redis(e.to_string())
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(e: serde_json::Error) -> Self {
        ApiError::Internal(format!("JSON: {e}"))
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
