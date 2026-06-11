//! AES-256-GCM 字段加密。
//!
//! 主密钥从 jwt_secret 派生（SHA-256）—— 重置 jwt_secret 即等价于撤销所有已加密
//! 字段（解密时返回错误，调用方降级到"视作明文"或要求用户重新填）。
//!
//! 存储格式（Base64）：`nonce(12B) || ciphertext || tag(16B)`。
//!
//! 之所以选 AES-GCM 而不是 ChaCha20-Poly1305：项目里已经没有 chacha 依赖，
//! `aes` crate 在 x86_64 上能用 AES-NI 硬件加速，性能也够。

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Nonce};
use base64::Engine;
use sha2::{Digest, Sha256};

fn derive_key(secret: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    // 域分离前缀，避免和 JWT 直接混用
    hasher.update(b"|ccapi.field.encryption|v1");
    let out = hasher.finalize();
    let mut k = [0u8; 32];
    k.copy_from_slice(&out);
    k
}

/// 加密 `plain`，返回 `nonce || ciphertext || tag` 的 Base64。
pub fn encrypt(secret: &str, plain: &str) -> Result<String, String> {
    let key_bytes = derive_key(secret);
    let cipher = Aes256Gcm::new_from_slice(&key_bytes).map_err(|e| format!("key: {e}"))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(&nonce, plain.as_bytes())
        .map_err(|e| format!("encrypt: {e}"))?;
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(base64::engine::general_purpose::STANDARD.encode(out))
}

/// 解密 `blob`（Base64）。失败时返回 Err，调用方可决定是把它当作明文（向后兼容）
/// 还是直接报错。
pub fn decrypt(secret: &str, blob: &str) -> Result<String, String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(blob.as_bytes())
        .map_err(|e| format!("base64: {e}"))?;
    if raw.len() < 12 + 16 {
        return Err("ciphertext too short".into());
    }
    let (nonce_bytes, ct) = raw.split_at(12);
    let key_bytes = derive_key(secret);
    let cipher = Aes256Gcm::new_from_slice(&key_bytes).map_err(|e| format!("key: {e}"))?;
    let nonce_arr: [u8; 12] = nonce_bytes
        .try_into()
        .map_err(|_| "nonce length".to_string())?;
    let nonce = Nonce::from(nonce_arr);
    let plain = cipher
        .decrypt(&nonce, ct)
        .map_err(|e| format!("decrypt: {e}"))?;
    String::from_utf8(plain).map_err(|e| format!("utf8: {e}"))
}

/// 智能解密：先按密文解，失败回退到把整段当作明文。
/// 用于过渡期（数据库里可能混存了加密 / 明文）。
pub fn decrypt_or_plain(secret: &str, blob: &str) -> String {
    decrypt(secret, blob).unwrap_or_else(|_| blob.to_string())
}
