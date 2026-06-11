//! 渠道级参数覆盖（参考 NewAPI 实现，功能等价 + Rust 适配）。
//!
//! 支持两种模式（由顶层 JSON 是否含 `operations` 数组区分）：
//!
//! 1. **简单模式**（直接合并）
//!    ```json
//!    { "temperature": 0.5, "max_tokens": 2048 }
//!    ```
//!    顶层每个键都做"递归深合并"到请求体；数组 / 标量按"整体替换"语义。
//!
//! 2. **高级模式**（按顺序执行 operations）
//!    ```json
//!    {
//!      "operations": [
//!        { "mode": "set", "path": "stream", "value": false,
//!          "conditions": [
//!            { "path": "model", "match": "prefix", "value": "gpt-4",
//!              "invert": false, "passMissingKey": false }
//!          ],
//!          "logic": "AND" }
//!      ]
//!    }
//!    ```
//!
//! ### 15 种 mode
//!
//! | mode | 说明 | 必填字段 |
//! |------|------|----------|
//! | set | 设值（创建或覆盖） | path + value |
//! | delete | 删除字段 | path |
//! | move | 移动 from → to | from + to |
//! | copy | 复制 from → to | from + to |
//! | append | 字符串追加 / 数组 push | path + value |
//! | prepend | 字符串前缀 / 数组 unshift | path + value |
//! | trim_prefix | 去掉指定字符串前缀 | path + value |
//! | trim_suffix | 去掉指定字符串后缀 | path + value |
//! | ensure_prefix | 不以指定前缀开头则补上 | path + value |
//! | ensure_suffix | 不以指定后缀结尾则补上 | path + value |
//! | trim_space | 字符串两端去空白 | path |
//! | to_lower | 字符串转小写 | path |
//! | to_upper | 字符串转大写 | path |
//! | replace | 字面量字符串替换 | path + pattern + replacement |
//! | regex_replace | 正则替换 | path + pattern + replacement |
//!
//! ### 路径语法
//!
//! `.` 分隔。整数 = 数组下标，`-1` = 数组末尾。例：
//! - `model`
//! - `messages.0.role`
//! - `messages.-1.content`
//!
//! ### 内置变量（value/replacement 中 `{{xxx}}` 替换）
//!
//! - `{{model}}` / `{{upstream_model}}` —— 最终下发到上游的 model
//! - `{{original_model}}` —— 用户请求体原 model
//!
//! ### 条件
//!
//! - `match`: full / prefix / suffix / contains / gt / gte / lt / lte
//! - `invert`: 反选
//! - `passMissingKey`: 路径字段不存在时是否视为匹配
//! - `logic`: AND（默认）/ OR

use regex::Regex;
use serde::Deserialize;
#[cfg(not(test))]
use serde_json::Value;
#[cfg(test)]
use serde_json::{json, Value};

// ----------------------------------------------------------------------------
// Public entry
// ----------------------------------------------------------------------------

/// 应用 param_override 配置到请求体 `body`。
/// 任何字段缺失或类型异常都是"静默跳过"，不会改坏请求体。
pub fn apply(spec: Option<&Value>, body: &mut Value, original_model: &str, upstream_model: &str) {
    let Some(spec) = spec else { return };
    let Some(obj) = spec.as_object() else { return };

    // 高级模式优先
    if let Some(Value::Array(ops)) = obj.get("operations") {
        let ctx = Vars {
            model: upstream_model.to_string(),
            upstream_model: upstream_model.to_string(),
            original_model: original_model.to_string(),
        };
        for op_val in ops {
            apply_operation(op_val, body, &ctx);
        }
        return;
    }

    // 简单模式：深合并
    if let Some(b) = body.as_object_mut() {
        for (k, v) in obj.iter() {
            // operations / _meta 之外的所有顶层字段都作为合并键
            if k == "operations" {
                continue;
            }
            merge_into(b.entry(k.clone()).or_insert(Value::Null), v);
        }
    }
}

/// 深合并：object 深递归；其它（数组 / 标量）整体覆盖。
fn merge_into(dst: &mut Value, src: &Value) {
    if let (Value::Object(d), Value::Object(s)) = (&mut *dst, src) {
        for (k, v) in s.iter() {
            merge_into(d.entry(k.clone()).or_insert(Value::Null), v);
        }
    } else {
        *dst = src.clone();
    }
}

// ----------------------------------------------------------------------------
// Operation 执行
// ----------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct OpRaw {
    mode: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    value: Option<Value>,
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    to: Option<String>,
    #[serde(default)]
    pattern: Option<String>,
    #[serde(default)]
    replacement: Option<String>,
    #[serde(default)]
    conditions: Option<Vec<CondRaw>>,
    #[serde(default = "default_logic")]
    logic: String,
}

fn default_logic() -> String {
    "AND".into()
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct CondRaw {
    path: String,
    #[serde(rename = "match")]
    match_: String,
    #[serde(default)]
    value: Option<Value>,
    #[serde(default)]
    invert: bool,
    #[serde(default)]
    pass_missing_key: bool,
}

#[derive(Debug)]
struct Vars {
    model: String,
    upstream_model: String,
    original_model: String,
}

fn apply_operation(op_val: &Value, body: &mut Value, vars: &Vars) {
    let op: OpRaw = match serde_json::from_value(op_val.clone()) {
        Ok(o) => o,
        Err(_) => return,
    };

    if !eval_conditions(op.conditions.as_deref(), &op.logic, body, vars) {
        return;
    }

    match op.mode.as_str() {
        "set" => {
            if let Some(v) = op.value.as_ref().map(|v| substitute_value(v, vars)) {
                set_path(body, &op.path, v);
            }
        }
        "delete" => {
            delete_path(body, &op.path);
        }
        "move" => {
            if let (Some(from), Some(to)) = (op.from.as_deref(), op.to.as_deref()) {
                if let Some(v) = get_path(body, from).cloned() {
                    delete_path(body, from);
                    set_path(body, to, v);
                }
            }
        }
        "copy" => {
            if let (Some(from), Some(to)) = (op.from.as_deref(), op.to.as_deref()) {
                if let Some(v) = get_path(body, from).cloned() {
                    set_path(body, to, v);
                }
            }
        }
        "append" => {
            let val = op.value.as_ref().map(|v| substitute_value(v, vars));
            if let Some(v) = val {
                mutate_path(body, &op.path, |slot| match slot {
                    Value::String(s) => {
                        if let Some(suffix) = v.as_str() {
                            s.push_str(suffix);
                        } else {
                            s.push_str(&v.to_string());
                        }
                    }
                    Value::Array(arr) => arr.push(v.clone()),
                    other => {
                        // 路径不存在时（other 为 Null 占位）按字符串/数组语义二选一：
                        // 字符串场景占主流，按字符串。
                        if let Some(suffix) = v.as_str() {
                            *other = Value::String(suffix.to_string());
                        } else if v.is_array() {
                            *other = v.clone();
                        }
                    }
                });
            }
        }
        "prepend" => {
            let val = op.value.as_ref().map(|v| substitute_value(v, vars));
            if let Some(v) = val {
                mutate_path(body, &op.path, |slot| match slot {
                    Value::String(s) => {
                        let head = v.as_str().map(|x| x.to_string()).unwrap_or_else(|| v.to_string());
                        *s = format!("{}{}", head, s);
                    }
                    Value::Array(arr) => arr.insert(0, v.clone()),
                    other => {
                        if let Some(head) = v.as_str() {
                            *other = Value::String(head.to_string());
                        } else if v.is_array() {
                            *other = v.clone();
                        }
                    }
                });
            }
        }
        "trim_prefix" => {
            let head = op
                .value
                .as_ref()
                .and_then(|v| v.as_str().map(|x| substitute_str(x, vars)));
            if let Some(prefix) = head {
                mutate_string(body, &op.path, |s| {
                    if let Some(stripped) = s.strip_prefix(&prefix) {
                        *s = stripped.to_string();
                    }
                });
            }
        }
        "trim_suffix" => {
            let tail = op
                .value
                .as_ref()
                .and_then(|v| v.as_str().map(|x| substitute_str(x, vars)));
            if let Some(suffix) = tail {
                mutate_string(body, &op.path, |s| {
                    if let Some(stripped) = s.strip_suffix(&suffix) {
                        *s = stripped.to_string();
                    }
                });
            }
        }
        "ensure_prefix" => {
            let head = op
                .value
                .as_ref()
                .and_then(|v| v.as_str().map(|x| substitute_str(x, vars)));
            if let Some(prefix) = head {
                ensure_string_at(body, &op.path, |s| {
                    if !s.starts_with(&prefix) {
                        *s = format!("{}{}", prefix, s);
                    }
                });
            }
        }
        "ensure_suffix" => {
            let tail = op
                .value
                .as_ref()
                .and_then(|v| v.as_str().map(|x| substitute_str(x, vars)));
            if let Some(suffix) = tail {
                ensure_string_at(body, &op.path, |s| {
                    if !s.ends_with(&suffix) {
                        *s = format!("{}{}", s, suffix);
                    }
                });
            }
        }
        "trim_space" => {
            mutate_string(body, &op.path, |s| *s = s.trim().to_string());
        }
        "to_lower" => {
            mutate_string(body, &op.path, |s| *s = s.to_lowercase());
        }
        "to_upper" => {
            mutate_string(body, &op.path, |s| *s = s.to_uppercase());
        }
        "replace" => {
            if let (Some(pat), Some(rep)) = (op.pattern.as_deref(), op.replacement.as_deref()) {
                let pat = substitute_str(pat, vars);
                let rep = substitute_str(rep, vars);
                mutate_string(body, &op.path, |s| *s = s.replace(&pat, &rep));
            }
        }
        "regex_replace" => {
            if let (Some(pat), Some(rep)) = (op.pattern.as_deref(), op.replacement.as_deref()) {
                let pat = substitute_str(pat, vars);
                let rep = substitute_str(rep, vars);
                if let Ok(re) = Regex::new(&pat) {
                    mutate_string(body, &op.path, |s| {
                        *s = re.replace_all(s, rep.as_str()).into_owned();
                    });
                }
            }
        }
        _ => {
            // 未知 mode 直接跳过，保持向后兼容
        }
    }
}

// ----------------------------------------------------------------------------
// 条件求值
// ----------------------------------------------------------------------------

fn eval_conditions(conds: Option<&[CondRaw]>, logic: &str, body: &Value, vars: &Vars) -> bool {
    let Some(conds) = conds else { return true };
    if conds.is_empty() {
        return true;
    }
    let logic_or = logic.eq_ignore_ascii_case("OR");
    let mut acc = !logic_or; // AND 起点 true；OR 起点 false
    for c in conds {
        let ok = eval_one_cond(c, body, vars);
        if logic_or {
            acc = acc || ok;
        } else {
            acc = acc && ok;
        }
    }
    acc
}

fn eval_one_cond(c: &CondRaw, body: &Value, vars: &Vars) -> bool {
    let actual = get_path(body, &c.path);
    let result = match actual {
        None => return c.pass_missing_key,
        Some(actual) => {
            let cmp_val = c.value.as_ref().map(|v| substitute_value(v, vars));
            match c.match_.as_str() {
                "full" => cmp_val.as_ref().map(|v| v == actual).unwrap_or(false),
                "prefix" => {
                    let (a, b) = (actual.as_str(), cmp_val.as_ref().and_then(|v| v.as_str()));
                    match (a, b) {
                        (Some(a), Some(b)) => a.starts_with(b),
                        _ => false,
                    }
                }
                "suffix" => {
                    let (a, b) = (actual.as_str(), cmp_val.as_ref().and_then(|v| v.as_str()));
                    match (a, b) {
                        (Some(a), Some(b)) => a.ends_with(b),
                        _ => false,
                    }
                }
                "contains" => {
                    let (a, b) = (actual.as_str(), cmp_val.as_ref().and_then(|v| v.as_str()));
                    match (a, b) {
                        (Some(a), Some(b)) => a.contains(b),
                        _ => false,
                    }
                }
                "gt" | "gte" | "lt" | "lte" => {
                    let (a, b) = (
                        actual.as_f64(),
                        cmp_val.as_ref().and_then(|v| v.as_f64()),
                    );
                    match (a, b) {
                        (Some(a), Some(b)) => match c.match_.as_str() {
                            "gt" => a > b,
                            "gte" => a >= b,
                            "lt" => a < b,
                            "lte" => a <= b,
                            _ => false,
                        },
                        _ => false,
                    }
                }
                _ => false,
            }
        }
    };
    if c.invert {
        !result
    } else {
        result
    }
}

// ----------------------------------------------------------------------------
// 路径访问
// ----------------------------------------------------------------------------

#[derive(Debug)]
enum Seg<'a> {
    Key(&'a str),
    Idx(isize),
}

fn split_path(p: &str) -> Vec<Seg<'_>> {
    p.split('.')
        .filter(|s| !s.is_empty())
        .map(|s| {
            if let Ok(n) = s.parse::<isize>() {
                Seg::Idx(n)
            } else {
                Seg::Key(s)
            }
        })
        .collect()
}

fn resolve_idx(seg: isize, len: usize) -> Option<usize> {
    if seg >= 0 {
        let i = seg as usize;
        if i < len {
            Some(i)
        } else {
            None
        }
    } else {
        // -1 = 末尾
        let abs = (-seg) as usize;
        if abs == 0 || abs > len {
            None
        } else {
            Some(len - abs)
        }
    }
}

fn get_path<'a>(body: &'a Value, path: &str) -> Option<&'a Value> {
    let segs = split_path(path);
    let mut cur = body;
    for seg in segs {
        cur = match (cur, seg) {
            (Value::Object(o), Seg::Key(k)) => o.get(k)?,
            (Value::Array(a), Seg::Idx(i)) => {
                let idx = resolve_idx(i, a.len())?;
                a.get(idx)?
            }
            _ => return None,
        };
    }
    Some(cur)
}

/// 找到 path 指向的可变槽。若中间节点不存在，会按下一段类型创建（Key → Object；Idx → 跳过设值返回 None）。
fn slot_mut<'a>(body: &'a mut Value, path: &str, create: bool) -> Option<&'a mut Value> {
    let segs = split_path(path);
    if segs.is_empty() {
        return Some(body);
    }
    let mut cur = body;
    let last = segs.len() - 1;
    for (i, seg) in segs.into_iter().enumerate() {
        let is_last = i == last;
        cur = match seg {
            Seg::Key(k) => {
                if !cur.is_object() {
                    if create && cur.is_null() {
                        *cur = Value::Object(Default::default());
                    } else {
                        return None;
                    }
                }
                let obj = cur.as_object_mut()?;
                if is_last {
                    return Some(obj.entry(k.to_string()).or_insert(Value::Null));
                }
                if !obj.contains_key(k) {
                    if !create {
                        return None;
                    }
                    obj.insert(k.to_string(), Value::Object(Default::default()));
                }
                obj.get_mut(k)?
            }
            Seg::Idx(idx) => {
                let arr = cur.as_array_mut()?;
                let pos = resolve_idx(idx, arr.len())?;
                if is_last {
                    return arr.get_mut(pos);
                }
                arr.get_mut(pos)?
            }
        };
    }
    Some(cur)
}

fn set_path(body: &mut Value, path: &str, value: Value) {
    if path.is_empty() {
        *body = value;
        return;
    }
    if let Some(slot) = slot_mut(body, path, true) {
        *slot = value;
    }
}

fn delete_path(body: &mut Value, path: &str) {
    let segs = split_path(path);
    if segs.is_empty() {
        *body = Value::Null;
        return;
    }
    let last_segs = segs.len() - 1;
    let mut cur = body;
    for (i, seg) in segs.iter().enumerate() {
        if i == last_segs {
            match seg {
                Seg::Key(k) => {
                    if let Some(o) = cur.as_object_mut() {
                        o.remove(*k);
                    }
                }
                Seg::Idx(idx) => {
                    if let Some(a) = cur.as_array_mut() {
                        if let Some(pos) = resolve_idx(*idx, a.len()) {
                            a.remove(pos);
                        }
                    }
                }
            }
            return;
        }
        cur = match seg {
            Seg::Key(k) => match cur.as_object_mut().and_then(|o| o.get_mut(*k)) {
                Some(v) => v,
                None => return,
            },
            Seg::Idx(i2) => {
                let arr = match cur.as_array_mut() {
                    Some(a) => a,
                    None => return,
                };
                let pos = match resolve_idx(*i2, arr.len()) {
                    Some(p) => p,
                    None => return,
                };
                &mut arr[pos]
            }
        };
    }
}

/// 在路径处取可变 slot 并交给闭包改写（用于 append/prepend 等需要看类型的操作）。
fn mutate_path(body: &mut Value, path: &str, f: impl FnOnce(&mut Value)) {
    if let Some(slot) = slot_mut(body, path, true) {
        f(slot);
    }
}

/// 在路径处取可变字符串槽；若类型不是字符串则跳过（避免改坏类型）。
fn mutate_string(body: &mut Value, path: &str, f: impl FnOnce(&mut String)) {
    if let Some(slot) = slot_mut(body, path, false) {
        if let Value::String(s) = slot {
            f(s);
        }
    }
}

/// 同 mutate_string，但路径不存在时按空字符串创建（用于 ensure_prefix/suffix）。
fn ensure_string_at(body: &mut Value, path: &str, f: impl FnOnce(&mut String)) {
    if let Some(slot) = slot_mut(body, path, true) {
        if slot.is_null() {
            *slot = Value::String(String::new());
        }
        if let Value::String(s) = slot {
            f(s);
        }
    }
}

// ----------------------------------------------------------------------------
// 变量替换
// ----------------------------------------------------------------------------

fn substitute_str(input: &str, vars: &Vars) -> String {
    input
        .replace("{{model}}", &vars.model)
        .replace("{{upstream_model}}", &vars.upstream_model)
        .replace("{{original_model}}", &vars.original_model)
}

fn substitute_value(v: &Value, vars: &Vars) -> Value {
    match v {
        Value::String(s) => Value::String(substitute_str(s, vars)),
        Value::Array(arr) => Value::Array(arr.iter().map(|x| substitute_value(x, vars)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, vv)| (k.clone(), substitute_value(vv, vars)))
                .collect(),
        ),
        other => other.clone(),
    }
}

// ----------------------------------------------------------------------------
// 单测
// ----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn body() -> Value {
        json!({
            "model": "gpt-4o",
            "temperature": 0.7,
            "messages": [
                { "role": "system", "content": "you are helpful" },
                { "role": "user", "content": "hello" }
            ]
        })
    }

    fn run(spec: Value, mut b: Value) -> Value {
        apply(Some(&spec), &mut b, "gpt-4o-original", "gpt-4o");
        b
    }

    #[test]
    fn simple_merge() {
        let out = run(json!({"max_tokens": 2048, "temperature": 0.5}), body());
        assert_eq!(out["max_tokens"], 2048);
        assert_eq!(out["temperature"], 0.5);
        // 未涉及字段保持
        assert_eq!(out["model"], "gpt-4o");
    }

    #[test]
    fn op_set_and_delete() {
        let spec = json!({
            "operations": [
                {"mode": "set", "path": "stream", "value": false},
                {"mode": "delete", "path": "temperature"}
            ]
        });
        let out = run(spec, body());
        assert_eq!(out["stream"], false);
        assert!(out.get("temperature").is_none());
    }

    #[test]
    fn op_move_copy() {
        let spec = json!({
            "operations": [
                {"mode": "copy", "from": "model", "to": "_orig"},
                {"mode": "move", "from": "temperature", "to": "params.temperature"}
            ]
        });
        let out = run(spec, body());
        assert_eq!(out["_orig"], "gpt-4o");
        assert!(out.get("temperature").is_none());
        assert_eq!(out["params"]["temperature"], 0.7);
    }

    #[test]
    fn op_append_prepend_str_and_array() {
        let spec = json!({
            "operations": [
                {"mode": "append", "path": "messages.-1.content", "value": "!!!"},
                {"mode": "prepend", "path": "messages.0.content", "value": "PREFIX: "}
            ]
        });
        let out = run(spec, body());
        assert_eq!(out["messages"][1]["content"], "hello!!!");
        assert_eq!(out["messages"][0]["content"], "PREFIX: you are helpful");
    }

    #[test]
    fn op_append_into_array() {
        let mut b = json!({"tags": ["a", "b"]});
        let spec = json!({"operations": [
            {"mode": "append", "path": "tags", "value": "c"}
        ]});
        apply(Some(&spec), &mut b, "m", "m");
        assert_eq!(b["tags"], json!(["a", "b", "c"]));
    }

    #[test]
    fn op_trim_and_ensure() {
        let mut b = json!({"x": "hello world", "y": "world"});
        let spec = json!({"operations": [
            {"mode": "trim_prefix", "path": "x", "value": "hello "},
            {"mode": "ensure_prefix", "path": "y", "value": "hello "},
            {"mode": "ensure_suffix", "path": "y", "value": "!"}
        ]});
        apply(Some(&spec), &mut b, "m", "m");
        assert_eq!(b["x"], "world");
        assert_eq!(b["y"], "hello world!");
    }

    #[test]
    fn op_to_lower_upper_trim() {
        let mut b = json!({"a": "  Hello  ", "b": "Mixed Case"});
        let spec = json!({"operations": [
            {"mode": "trim_space", "path": "a"},
            {"mode": "to_lower", "path": "b"}
        ]});
        apply(Some(&spec), &mut b, "m", "m");
        assert_eq!(b["a"], "Hello");
        assert_eq!(b["b"], "mixed case");
    }

    #[test]
    fn op_regex_replace_and_vars() {
        let mut b = json!({"system": "You are using model X"});
        let spec = json!({"operations": [
            {"mode": "regex_replace", "path": "system",
             "pattern": "model [A-Z]", "replacement": "model {{model}}"}
        ]});
        apply(Some(&spec), &mut b, "orig", "claude-3");
        assert_eq!(b["system"], "You are using model claude-3");
    }

    #[test]
    fn conditions_and_logic() {
        let spec = json!({"operations": [
            {"mode": "set", "path": "marker", "value": "hit",
             "conditions": [
               {"path": "model", "match": "prefix", "value": "gpt-4"},
               {"path": "temperature", "match": "gte", "value": 0.5}
             ],
             "logic": "AND"}
        ]});
        let out = run(spec.clone(), body());
        assert_eq!(out["marker"], "hit");

        // 改成条件不满足
        let mut b2 = body();
        b2["temperature"] = json!(0.1);
        apply(Some(&spec), &mut b2, "gpt-4o", "gpt-4o");
        assert!(b2.get("marker").is_none());
    }

    #[test]
    fn conditions_invert_and_pass_missing() {
        let spec = json!({"operations": [
            {"mode": "set", "path": "marker", "value": "fired",
             "conditions": [
               {"path": "no_such_field", "match": "full", "value": "x",
                "passMissingKey": true}
             ]}
        ]});
        let out = run(spec, body());
        assert_eq!(out["marker"], "fired");
    }

    #[test]
    fn array_negative_index_get() {
        let b = body();
        let v = get_path(&b, "messages.-1.role").unwrap();
        assert_eq!(v, "user");
    }

    #[test]
    fn unknown_mode_no_throw() {
        let spec = json!({"operations": [
            {"mode": "blackhole", "path": "x", "value": 1},
            {"mode": "set", "path": "y", "value": 2}
        ]});
        let out = run(spec, body());
        // 未知 mode 被跳过，但后面合法 op 仍执行
        assert_eq!(out["y"], 2);
    }
}
