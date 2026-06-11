// 简易图形 CAPTCHA：生成 6 位字符 + 随机噪声线 + 颜色干扰的 PNG。
// 不依赖任何第三方 captcha crate（避免冷门依赖），自己用 `image` + 简单像素绘制。

use base64::Engine;
use image::{ImageBuffer, Rgb, RgbImage};
use rand::Rng;
use serde_json::{json, Value};
use std::io::Cursor;
use uuid::Uuid;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};

use crate::server::error::{ApiError, ApiResult};
use crate::server::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/captcha/new", get(new_captcha_handler))
}

const W: u32 = 160;
const H: u32 = 48;
const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

async fn new_captcha_handler(
    State(state): State<AppState>,
) -> ApiResult<Json<Value>> {
    new_captcha(state).await
}

pub async fn new_captcha(state: AppState) -> ApiResult<Json<Value>> {
    let (answer, png) = {
        let mut rng = rand::thread_rng();
        let ans: String = (0..5)
            .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
            .collect();
        let p = render_captcha(&ans);
        (ans, p)
    };
    let id = Uuid::new_v4().to_string();
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);

    let mut conn = state.redis.clone();
    let _: Result<i32, _> = redis::cmd("SET")
        .arg(format!("captcha:{}", id))
        .arg(&answer)
        .arg("EX")
        .arg(120)
        .query_async(&mut conn)
        .await;

    Ok(Json(json!({
        "ok": true,
        "captchaId": id,
        "imageBase64": format!("data:image/png;base64,{}", b64),
    })))
}

/// 校验：成功后立即删除（防止暴力穷举）
pub async fn verify_captcha(
    state: &AppState,
    captcha_id: &str,
    answer: &str,
) -> ApiResult<()> {
    let mut conn = state.redis.clone();
    let stored: Option<String> = redis::cmd("GET")
        .arg(format!("captcha:{}", captcha_id))
        .query_async(&mut conn)
        .await
        .ok()
        .flatten();
    let Some(expected) = stored else {
        return Err(ApiError::BadRequest("验证码已过期，请刷新".into()));
    };
    if expected.eq_ignore_ascii_case(answer) {
        let _: Result<i32, _> = redis::cmd("DEL")
            .arg(format!("captcha:{}", captcha_id))
            .query_async(&mut conn)
            .await;
        Ok(())
    } else {
        let _: Result<i32, _> = redis::cmd("DEL")
            .arg(format!("captcha:{}", captcha_id))
            .query_async(&mut conn)
            .await;
        Err(ApiError::BadRequest("验证码错误".into()))
    }
}

/// 简单 5x7 位图字体（仅 A-Z、2-9）—— 像素 1 表示笔画
fn glyph(c: char) -> [[u8; 5]; 7] {
    match c {
        'A' => [
            [0,1,1,1,0],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,1,1,1,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
        ],
        'B' => [
            [1,1,1,1,0],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,1,1,1,0],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,1,1,1,0],
        ],
        'C' => [
            [0,1,1,1,1],
            [1,0,0,0,0],
            [1,0,0,0,0],
            [1,0,0,0,0],
            [1,0,0,0,0],
            [1,0,0,0,0],
            [0,1,1,1,1],
        ],
        'D' => [
            [1,1,1,1,0],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,1,1,1,0],
        ],
        'E' => [
            [1,1,1,1,1],
            [1,0,0,0,0],
            [1,0,0,0,0],
            [1,1,1,1,0],
            [1,0,0,0,0],
            [1,0,0,0,0],
            [1,1,1,1,1],
        ],
        'F' => [
            [1,1,1,1,1],
            [1,0,0,0,0],
            [1,0,0,0,0],
            [1,1,1,1,0],
            [1,0,0,0,0],
            [1,0,0,0,0],
            [1,0,0,0,0],
        ],
        'G' => [
            [0,1,1,1,1],
            [1,0,0,0,0],
            [1,0,0,0,0],
            [1,0,1,1,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [0,1,1,1,1],
        ],
        'H' => [
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,1,1,1,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
        ],
        'J' => [
            [0,0,0,0,1],
            [0,0,0,0,1],
            [0,0,0,0,1],
            [0,0,0,0,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [0,1,1,1,0],
        ],
        'K' => [
            [1,0,0,0,1],
            [1,0,0,1,0],
            [1,0,1,0,0],
            [1,1,0,0,0],
            [1,0,1,0,0],
            [1,0,0,1,0],
            [1,0,0,0,1],
        ],
        'L' => [
            [1,0,0,0,0],
            [1,0,0,0,0],
            [1,0,0,0,0],
            [1,0,0,0,0],
            [1,0,0,0,0],
            [1,0,0,0,0],
            [1,1,1,1,1],
        ],
        'M' => [
            [1,0,0,0,1],
            [1,1,0,1,1],
            [1,0,1,0,1],
            [1,0,1,0,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
        ],
        'N' => [
            [1,0,0,0,1],
            [1,1,0,0,1],
            [1,0,1,0,1],
            [1,0,1,0,1],
            [1,0,0,1,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
        ],
        'P' => [
            [1,1,1,1,0],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,1,1,1,0],
            [1,0,0,0,0],
            [1,0,0,0,0],
            [1,0,0,0,0],
        ],
        'Q' => [
            [0,1,1,1,0],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,0,1,0,1],
            [1,0,0,1,1],
            [0,1,1,1,1],
        ],
        'R' => [
            [1,1,1,1,0],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,1,1,1,0],
            [1,0,1,0,0],
            [1,0,0,1,0],
            [1,0,0,0,1],
        ],
        'S' => [
            [0,1,1,1,1],
            [1,0,0,0,0],
            [1,0,0,0,0],
            [0,1,1,1,0],
            [0,0,0,0,1],
            [0,0,0,0,1],
            [1,1,1,1,0],
        ],
        'T' => [
            [1,1,1,1,1],
            [0,0,1,0,0],
            [0,0,1,0,0],
            [0,0,1,0,0],
            [0,0,1,0,0],
            [0,0,1,0,0],
            [0,0,1,0,0],
        ],
        'U' => [
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [0,1,1,1,0],
        ],
        'V' => [
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [0,1,0,1,0],
            [0,0,1,0,0],
        ],
        'W' => [
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [1,0,1,0,1],
            [1,0,1,0,1],
            [1,1,0,1,1],
            [1,0,0,0,1],
        ],
        'X' => [
            [1,0,0,0,1],
            [1,0,0,0,1],
            [0,1,0,1,0],
            [0,0,1,0,0],
            [0,1,0,1,0],
            [1,0,0,0,1],
            [1,0,0,0,1],
        ],
        'Y' => [
            [1,0,0,0,1],
            [1,0,0,0,1],
            [0,1,0,1,0],
            [0,0,1,0,0],
            [0,0,1,0,0],
            [0,0,1,0,0],
            [0,0,1,0,0],
        ],
        'Z' => [
            [1,1,1,1,1],
            [0,0,0,0,1],
            [0,0,0,1,0],
            [0,0,1,0,0],
            [0,1,0,0,0],
            [1,0,0,0,0],
            [1,1,1,1,1],
        ],
        '2' => [
            [0,1,1,1,0],
            [1,0,0,0,1],
            [0,0,0,0,1],
            [0,0,1,1,0],
            [0,1,0,0,0],
            [1,0,0,0,0],
            [1,1,1,1,1],
        ],
        '3' => [
            [1,1,1,1,0],
            [0,0,0,0,1],
            [0,0,0,0,1],
            [0,1,1,1,0],
            [0,0,0,0,1],
            [0,0,0,0,1],
            [1,1,1,1,0],
        ],
        '4' => [
            [0,0,0,1,0],
            [0,0,1,1,0],
            [0,1,0,1,0],
            [1,0,0,1,0],
            [1,1,1,1,1],
            [0,0,0,1,0],
            [0,0,0,1,0],
        ],
        '5' => [
            [1,1,1,1,1],
            [1,0,0,0,0],
            [1,1,1,1,0],
            [0,0,0,0,1],
            [0,0,0,0,1],
            [1,0,0,0,1],
            [0,1,1,1,0],
        ],
        '6' => [
            [0,0,1,1,1],
            [0,1,0,0,0],
            [1,0,0,0,0],
            [1,1,1,1,0],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [0,1,1,1,0],
        ],
        '7' => [
            [1,1,1,1,1],
            [0,0,0,0,1],
            [0,0,0,1,0],
            [0,0,1,0,0],
            [0,1,0,0,0],
            [0,1,0,0,0],
            [0,1,0,0,0],
        ],
        '8' => [
            [0,1,1,1,0],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [0,1,1,1,0],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [0,1,1,1,0],
        ],
        '9' => [
            [0,1,1,1,0],
            [1,0,0,0,1],
            [1,0,0,0,1],
            [0,1,1,1,1],
            [0,0,0,0,1],
            [0,0,0,1,0],
            [1,1,1,0,0],
        ],
        _ => [[0; 5]; 7],
    }
}

fn render_captcha(text: &str) -> Vec<u8> {
    let mut img: RgbImage = ImageBuffer::from_fn(W, H, |_, _| Rgb([245u8, 244, 240]));
    let mut rng = rand::thread_rng();

    // 噪点
    for _ in 0..280 {
        let x = rng.gen_range(0..W);
        let y = rng.gen_range(0..H);
        let c = Rgb([
            rng.gen_range(150..230) as u8,
            rng.gen_range(150..230) as u8,
            rng.gen_range(150..230) as u8,
        ]);
        img.put_pixel(x, y, c);
    }

    // 干扰线
    for _ in 0..5 {
        let x1 = rng.gen_range(0..W as i32);
        let y1 = rng.gen_range(0..H as i32);
        let x2 = rng.gen_range(0..W as i32);
        let y2 = rng.gen_range(0..H as i32);
        let color = Rgb([
            rng.gen_range(100..200) as u8,
            rng.gen_range(80..160) as u8,
            rng.gen_range(80..160) as u8,
        ]);
        draw_line(&mut img, x1, y1, x2, y2, color);
    }

    // 字符
    let char_w = 5 * 4; // 放大 4 倍
    let total_w = char_w * text.len() as u32;
    let mut x = (W - total_w) / 2;
    for ch in text.chars() {
        let glyph = glyph(ch);
        let color = Rgb([
            rng.gen_range(0..120) as u8,
            rng.gen_range(0..120) as u8,
            rng.gen_range(40..160) as u8,
        ]);
        let dx_offset = rng.gen_range(-2..=2);
        let dy_offset = rng.gen_range(-2..=2);
        for (row, row_pixels) in glyph.iter().enumerate() {
            for (col, p) in row_pixels.iter().enumerate() {
                if *p == 1 {
                    let bx = x as i32 + (col as i32) * 4 + dx_offset;
                    let by = 6 + (row as i32) * 4 + dy_offset;
                    for sx in 0..4 {
                        for sy in 0..4 {
                            let px = bx + sx;
                            let py = by + sy;
                            if px >= 0 && py >= 0 && (px as u32) < W && (py as u32) < H {
                                img.put_pixel(px as u32, py as u32, color);
                            }
                        }
                    }
                }
            }
        }
        x += char_w;
    }

    let mut buf = Vec::new();
    {
        let mut cursor = Cursor::new(&mut buf);
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .expect("encode png");
    }
    buf
}

fn draw_line(img: &mut RgbImage, x0: i32, y0: i32, x1: i32, y1: i32, color: Rgb<u8>) {
    // Bresenham
    let dx = (x1 - x0).abs();
    let sx = if x0 < x1 { 1 } else { -1 };
    let dy = -(y1 - y0).abs();
    let sy = if y0 < y1 { 1 } else { -1 };
    let mut err = dx + dy;
    let mut x = x0;
    let mut y = y0;
    loop {
        if x >= 0 && y >= 0 && (x as u32) < img.width() && (y as u32) < img.height() {
            img.put_pixel(x as u32, y as u32, color);
        }
        if x == x1 && y == y1 {
            break;
        }
        let e2 = 2 * err;
        if e2 >= dy {
            err += dy;
            x += sx;
        }
        if e2 <= dx {
            err += dx;
            y += sy;
        }
    }
}
