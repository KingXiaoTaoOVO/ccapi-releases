import type { ImportedKey } from "@/types";
import { validateKeyFormat } from "@/lib/defaults";
import { uid } from "@/lib/format";
import { t } from "@/i18n";
import { readTextFile } from "./tauri";

export type Delimiter = "newline" | "comma" | "space" | "auto";

function makeRow(key: string, name?: string, note?: string, url?: string): ImportedKey {
  const trimmed = key.trim();
  const v = validateKeyFormat(trimmed);
  return {
    id: uid("imp"),
    name: name?.trim() || "",
    key: trimmed,
    url: url?.trim() || undefined,
    note: note?.trim() || undefined,
    valid: v.valid,
    reasonKey: v.reasonKey,
    selected: v.valid,
  };
}

/** De-duplicate by key value, keeping the first occurrence. */
function dedupe(rows: ImportedKey[]): ImportedKey[] {
  const seen = new Set<string>();
  const out: ImportedKey[] = [];
  for (const r of rows) {
    if (!r.key) continue;
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    out.push(r);
  }
  return out;
}

/** Auto-number any unnamed rows. */
function autoName(rows: ImportedKey[]): ImportedKey[] {
  let n = 0;
  return rows.map((r) => {
    if (r.name) return r;
    n += 1;
    return { ...r, name: t("import.defaultName", { n }) };
  });
}

/** Split a single delimited line and pull out the most key-like field. */
function extractFromLine(line: string): ImportedKey | null {
  const parts = line
    .split(/[,\t]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return makeRow(parts[0]);

  // Pick the field that best looks like a key.
  let keyIdx = parts.findIndex((p) => validateKeyFormat(p).valid);
  if (keyIdx < 0) {
    // fall back to the longest field
    keyIdx = parts.reduce((best, p, i) => (p.length > parts[best].length ? i : best), 0);
  }
  const key = parts[keyIdx];
  const rest = parts.filter((_, i) => i !== keyIdx);
  const name = rest[0];
  const note = rest.slice(1).join(" ") || undefined;
  return makeRow(key, name, note);
}

/**
 * Characters that may surround a key inside a labeled line, e.g.
 * "Secret: fe_oa_...", "key=fe_oa_...", "「fe_oa_...」". Underscores, dashes and
 * dots are intentionally excluded so real keys stay intact.
 */
const KEY_BOUNDARY = /[\s,:;=|"'`()[\]{}<>，：；、「」【】]+/;

/** Pull every key-shaped token out of one line ("Secret: fe_oa_..." → fe_oa_...). */
function extractKeyTokens(line: string): string[] {
  return line
    .split(KEY_BOUNDARY)
    .map((tok) => tok.trim())
    .filter((tok) => tok.length > 0 && validateKeyFormat(tok).valid);
}

/** Derive a human name from a non-key line — prefers an embedded email address. */
function labelFromLine(line: string): string | undefined {
  const email = line.match(/[A-Za-z0-9._%+*-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return email ? email[0] : undefined;
}

/** Build a row from a token, scanning for an embedded key if the token isn't one. */
function makeRowSmart(token: string, name?: string): ImportedKey {
  const direct = makeRow(token, name);
  if (direct.valid) return direct;
  const embedded = extractKeyTokens(token)[0];
  return embedded ? makeRow(embedded, name) : direct;
}

/**
 * Robustly pull keys out of free-form / labeled text where each key may be
 * prefixed by a label and live on its own line — e.g. a block like:
 *
 *   [ 1] 邮箱: a@b.com
 *        Secret: fe_oa_xxxxxxxx
 *
 * Lines that embed a key yield that key; a non-key line carrying an email is
 * remembered and becomes the following key's name. Lines with no key and no
 * email are ignored, so surrounding prose / numbering never produces junk rows.
 */
function extractKeysFromLines(text: string): ImportedKey[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const rows: ImportedKey[] = [];
  let pendingName: string | undefined;

  for (const line of lines) {
    // 1) Structured "name,key,note" row, or a bare key on its own line.
    const structured = extractFromLine(line);
    if (structured && structured.valid) {
      rows.push(
        pendingName && !structured.name ? { ...structured, name: pendingName } : structured,
      );
      pendingName = undefined;
      continue;
    }
    // 2) A labeled line that embeds one or more keys ("Secret: fe_oa_...").
    const tokens = extractKeyTokens(line);
    if (tokens.length > 0) {
      tokens.forEach((k, i) => rows.push(makeRow(k, i === 0 ? pendingName : undefined)));
      pendingName = undefined;
      continue;
    }
    // 3) No key here — keep an email (if any) as the next key's name.
    pendingName = labelFromLine(line);
  }

  return autoName(dedupe(rows));
}

/** Parse plain text where every token is a (possibly labeled) key. */
export function parseText(content: string, delimiter: Delimiter = "newline"): ImportedKey[] {
  // "newline"/"auto" are the loosest splits — route them through the smart
  // scanner so labeled blocks ("Secret: <key>") and email/key pairs work too.
  if (delimiter === "newline" || delimiter === "auto") return extractKeysFromLines(content);
  const sep = delimiter === "comma" ? /,/ : /\s+/;
  const rows = content
    .split(sep)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => makeRowSmart(t));
  return autoName(dedupe(rows));
}

// --- minimal CSV parsing (handles quoted fields with commas) ---
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function matchColumn(headers: string[], keywords: string[]): number {
  return headers.findIndex((h) =>
    keywords.some((k) => h.toLowerCase().includes(k)),
  );
}

/** Parse a CSV with optional header row (名称 / Key / 备注 / URL). */
export function parseCSV(content: string): ImportedKey[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const first = parseCsvLine(lines[0]);
  const looksLikeHeader =
    first.some((c) => /name|名称|key|密钥|note|备注|url|remark/i.test(c)) &&
    !first.some((c) => validateKeyFormat(c).valid);

  let nameIdx = 0;
  let keyIdx = 1;
  let noteIdx = 2;
  let urlIdx = -1;
  let dataLines = lines;

  if (looksLikeHeader) {
    nameIdx = matchColumn(first, ["name", "名称", "标识"]);
    keyIdx = matchColumn(first, ["key", "密钥", "token"]);
    noteIdx = matchColumn(first, ["note", "备注", "remark", "说明"]);
    urlIdx = matchColumn(first, ["url", "地址", "endpoint"]);
    dataLines = lines.slice(1);
    if (keyIdx < 0) keyIdx = 1; // sane fallback
  }

  const rows = dataLines
    .map((line) => parseCsvLine(line))
    .map((cols) => {
      const key = cols[keyIdx] ?? "";
      if (!key) return null;
      return makeRow(
        key,
        nameIdx >= 0 ? cols[nameIdx] : undefined,
        noteIdx >= 0 ? cols[noteIdx] : undefined,
        urlIdx >= 0 ? cols[urlIdx] : undefined,
      );
    })
    .filter((r): r is ImportedKey => r !== null);

  return autoName(dedupe(rows));
}

function pickKeyField(obj: Record<string, unknown>): string | undefined {
  for (const k of ["key", "apiKey", "api_key", "token", "value", "secret"]) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function pick(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** Parse JSON: array of strings, array of objects, or { keys: [...] }. */
export function parseJSON(content: string): ImportedKey[] {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return [];
  }

  let arr: unknown[] = [];
  if (Array.isArray(data)) arr = data;
  else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.keys)) arr = obj.keys;
    else if (Array.isArray(obj.apiKeys)) arr = obj.apiKeys;
    else arr = [obj];
  }

  const rows = arr
    .map((item) => {
      if (typeof item === "string") return makeRow(item);
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const key = pickKeyField(obj);
        if (!key) return null;
        return makeRow(
          key,
          pick(obj, ["name", "名称", "label", "title"]),
          pick(obj, ["note", "备注", "remark", "desc", "description"]),
          pick(obj, ["url", "baseUrl", "base_url", "endpoint", "地址"]),
        );
      }
      return null;
    })
    .filter((r): r is ImportedKey => r !== null);

  return autoName(dedupe(rows));
}

/** Auto-detect format from pasted clipboard text. */
export function parseClipboard(content: string): ImportedKey[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const json = parseJSON(trimmed);
    if (json.length) return json;
  }
  // Otherwise scan every line for an embedded key, tolerating labels/prefixes.
  return extractKeysFromLines(trimmed);
}

/** Read + parse a file chosen via the dialog, dispatching on its extension. */
export async function parseFile(path: string): Promise<ImportedKey[]> {
  const content = await readTextFile(path);
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "json") return parseJSON(content);
  if (ext === "csv") return parseCSV(content);
  // .txt and anything else → tolerant line scan (handles "Secret: <key>" blocks).
  return extractKeysFromLines(content);
}
