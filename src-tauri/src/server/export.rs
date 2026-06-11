use chrono::NaiveDateTime;
use rust_xlsxwriter::{Format, Workbook};
use serde_json::Value;

use super::error::{ApiError, ApiResult};

pub type CodeExportRow = (
    String,                          // code
    String,                          // code_type
    sqlx::types::Json<Value>,        // payload
    Option<NaiveDateTime>,           // expires_at
    Option<String>,                  // batch_id
    Option<i64>,                     // redeemed_by
    Option<NaiveDateTime>,           // redeemed_at
);

pub fn codes_to_xlsx(rows: &[CodeExportRow]) -> ApiResult<Vec<u8>> {
    let mut workbook = Workbook::new();
    let header_fmt = Format::new().set_bold();
    let sheet = workbook.add_worksheet();
    let headers = ["Code", "Type", "Payload", "Batch", "Expires", "Redeemed", "RedeemedAt"];
    for (i, h) in headers.iter().enumerate() {
        sheet
            .write_string_with_format(0, i as u16, *h, &header_fmt)
            .map_err(|e| ApiError::Internal(e.to_string()))?;
    }
    for (idx, (code, ty, payload, expires_at, batch_id, redeemed_by, redeemed_at)) in
        rows.iter().enumerate()
    {
        let r = (idx + 1) as u32;
        sheet
            .write_string(r, 0, code)
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        sheet
            .write_string(r, 1, ty)
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        sheet
            .write_string(r, 2, payload.0.to_string())
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        sheet
            .write_string(r, 3, batch_id.clone().unwrap_or_default())
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        sheet
            .write_string(
                r,
                4,
                expires_at.map(|d| d.to_string()).unwrap_or_default(),
            )
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        sheet
            .write_string(
                r,
                5,
                redeemed_by.map(|i| i.to_string()).unwrap_or_default(),
            )
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        sheet
            .write_string(
                r,
                6,
                redeemed_at.map(|d| d.to_string()).unwrap_or_default(),
            )
            .map_err(|e| ApiError::Internal(e.to_string()))?;
    }
    workbook
        .save_to_buffer()
        .map_err(|e| ApiError::Internal(e.to_string()))
}

pub fn codes_to_csv(rows: &[CodeExportRow]) -> ApiResult<Vec<u8>> {
    let mut buf = Vec::new();
    {
        let mut w = csv::Writer::from_writer(&mut buf);
        w.write_record([
            "code",
            "type",
            "payload",
            "batch",
            "expires",
            "redeemed_by",
            "redeemed_at",
        ])
        .map_err(|e| ApiError::Internal(e.to_string()))?;
        for (code, ty, payload, expires_at, batch_id, redeemed_by, redeemed_at) in rows {
            w.write_record([
                code.as_str(),
                ty.as_str(),
                &payload.0.to_string(),
                batch_id.as_deref().unwrap_or(""),
                &expires_at.map(|d| d.to_string()).unwrap_or_default(),
                &redeemed_by.map(|i| i.to_string()).unwrap_or_default(),
                &redeemed_at.map(|d| d.to_string()).unwrap_or_default(),
            ])
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        }
        w.flush().map_err(|e| ApiError::Internal(e.to_string()))?;
    }
    Ok(buf)
}

pub fn codes_to_txt(rows: &[CodeExportRow]) -> Vec<u8> {
    let mut buf = String::new();
    for (code, _ty, _payload, _exp, _batch, _by, _at) in rows {
        buf.push_str(code);
        buf.push('\n');
    }
    buf.into_bytes()
}
