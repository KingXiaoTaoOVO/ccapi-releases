use chrono::Utc;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use super::error::{ApiError, ApiResult};
use super::local_config::argon2_verify;

use argon2::password_hash::{rand_core::OsRng, PasswordHasher, SaltString};
use argon2::Argon2;

pub fn hash_password(password: &str) -> ApiResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| ApiError::Internal(format!("Argon2: {e}")))
}

pub fn check_password(password: &str, hash: &str) -> bool {
    argon2_verify(password, hash)
}

const ACCESS_TTL_SECS: i64 = 15 * 60;
const REFRESH_TTL_SECS: i64 = 7 * 24 * 60 * 60;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    pub sub: i64,        // user_id
    pub role: String,    // role name
    pub jti: String,     // session id for revocation
    pub exp: i64,
    pub iat: i64,
    pub typ: String,     // "access" or "refresh"
}

pub struct JwtIssuer {
    secret: Vec<u8>,
}

impl JwtIssuer {
    pub fn new(secret_b64: &str) -> Self {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(secret_b64.trim_end_matches('='))
            .unwrap_or_else(|_| secret_b64.as_bytes().to_vec());
        Self { secret: bytes }
    }

    pub fn issue_pair(&self, user_id: i64, role: &str) -> ApiResult<TokenPair> {
        let jti = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        let access = Claims {
            sub: user_id,
            role: role.to_string(),
            jti: jti.clone(),
            exp: now + ACCESS_TTL_SECS,
            iat: now,
            typ: "access".into(),
        };
        let refresh = Claims {
            sub: user_id,
            role: role.to_string(),
            jti: jti.clone(),
            exp: now + REFRESH_TTL_SECS,
            iat: now,
            typ: "refresh".into(),
        };
        let access_token = encode(
            &Header::default(),
            &access,
            &EncodingKey::from_secret(&self.secret),
        )
        .map_err(|e| ApiError::Internal(format!("JWT 签发失败: {e}")))?;
        let refresh_token = encode(
            &Header::default(),
            &refresh,
            &EncodingKey::from_secret(&self.secret),
        )
        .map_err(|e| ApiError::Internal(format!("JWT 签发失败: {e}")))?;
        Ok(TokenPair {
            access_token,
            refresh_token,
            jti,
            access_expires_in: ACCESS_TTL_SECS,
            refresh_expires_in: REFRESH_TTL_SECS,
        })
    }

    pub fn decode(&self, token: &str) -> ApiResult<Claims> {
        decode::<Claims>(
            token,
            &DecodingKey::from_secret(&self.secret),
            &Validation::default(),
        )
        .map(|d| d.claims)
        .map_err(|_| ApiError::Unauthorized)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenPair {
    pub access_token: String,
    pub refresh_token: String,
    pub jti: String,
    pub access_expires_in: i64,
    pub refresh_expires_in: i64,
}
