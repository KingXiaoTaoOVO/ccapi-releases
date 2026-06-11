//! 请求/响应转换工具集。
//!
//! 当前只有 `param_override` —— 在 relay 转发上游前对请求体 JSON
//! 做声明式改写（NewAPI 风格的 15 种 mode + 条件 + 路径语法）。

pub mod param_override;
pub mod sensitive;
