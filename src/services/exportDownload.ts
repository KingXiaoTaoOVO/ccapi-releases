import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "@/store/useAuthStore";
import { useModeStore } from "@/store/useModeStore";

/**
 * 从受保护的导出接口下载并保存到用户选择的位置。
 *
 * 在 Tauri 环境里走 dialog plugin 选保存路径 + 后端命令落盘（最可靠）。
 * 浏览器/非-Tauri 环境 fallback 到经典 blob + a.click()。
 *
 * @returns 实际保存路径（取消保存时返回 null）；抛错则上层抓 toast
 */
export async function downloadAdminExport(
  path: string,
  filename: string,
): Promise<string | null> {
  const base = (useModeStore.getState().serverUrl ?? "http://127.0.0.1:8787").replace(
    /\/+$/,
    "",
  );
  const token = useAuthStore.getState().session?.tokens.accessToken;
  const resp = await fetch(`${base}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!resp.ok) {
    // 试着读 message
    let msg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (j?.message) msg = j.message;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const blob = await resp.blob();

  // Tauri 路径：弹保存对话框 → 后端写盘
  const isTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
  if (isTauri) {
    const target = await saveDialog({
      defaultPath: filename,
      title: "保存导出文件",
      filters: filenameFilters(filename),
    });
    if (!target) return null; // 用户取消
    const buf = await blob.arrayBuffer();
    const b64 = bytesToBase64(new Uint8Array(buf));
    const saved: string = await invoke("save_bytes_to_file", {
      path: target,
      contentBase64: b64,
    });
    return saved;
  }

  // 浏览器 fallback
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
  return filename;
}

function filenameFilters(filename: string) {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "csv") return [{ name: "CSV", extensions: ["csv"] }];
  if (ext === "json") return [{ name: "JSON", extensions: ["json"] }];
  if (ext === "xlsx") return [{ name: "Excel", extensions: ["xlsx"] }];
  return [{ name: "All files", extensions: ["*"] }];
}

function bytesToBase64(bytes: Uint8Array): string {
  // 大文件分片，避免 String.fromCharCode 爆栈
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunk, bytes.length)),
    );
  }
  return btoa(bin);
}
