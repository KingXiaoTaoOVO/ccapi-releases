import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/i18n";
import { saveUserAvatar } from "@/services/tauri";
import { notify } from "@/services/notify";

const OUTPUT_SIZE = 256;
const MAX_BYTES = 2 * 1024 * 1024;

interface Props {
  open: boolean;
  userId: number;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * 头像上传 + 1:1 裁剪。本地化处理：原图 → canvas 居中裁剪 → 256x256 JPEG。
 * 输出直接发给 save_user_avatar；不上传到服务端。
 */
export function AvatarUploadModal({ open, userId, onClose, onSaved }: Props) {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const [zoom, setZoom] = useState(1);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // 重置
  useEffect(() => {
    if (!open) return;
    setFile(null);
    setZoom(1);
    imgRef.current = null;
  }, [open]);

  // 选文件 → 创建对象 URL → 加载 img
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      draw(1);
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // 拖入支持
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) pickFile(f);
  };

  const pickFile = (f: File) => {
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) {
      notify("error", t("avatar.errType"));
      return;
    }
    if (f.size > MAX_BYTES) {
      notify("error", t("avatar.errSize"));
      return;
    }
    setFile(f);
  };

  const draw = useCallback(
    (z: number) => {
      const canvas = canvasRef.current;
      const img = imgRef.current;
      if (!canvas || !img) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = OUTPUT_SIZE;
      canvas.height = OUTPUT_SIZE;
      ctx.clearRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

      // 1:1 居中 cover：先取较短边铺满，再按 zoom 放大
      const ratio = Math.max(OUTPUT_SIZE / img.width, OUTPUT_SIZE / img.height);
      const scale = ratio * z;
      const dw = img.width * scale;
      const dh = img.height * scale;
      const dx = (OUTPUT_SIZE - dw) / 2;
      const dy = (OUTPUT_SIZE - dh) / 2;
      ctx.drawImage(img, dx, dy, dw, dh);
    },
    [],
  );

  useEffect(() => {
    draw(zoom);
  }, [zoom, draw]);

  const submit = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !file) return;
    setSaving(true);
    try {
      const blob: Blob | null = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.9),
      );
      if (!blob) throw new Error("canvas.toBlob 失败");
      const buf = new Uint8Array(await blob.arrayBuffer());
      await saveUserAvatar({
        userId,
        mime: "image/jpeg",
        bytes: Array.from(buf),
      });
      notify("success", t("avatar.saved"));
      onSaved();
      onClose();
    } catch (e: any) {
      notify("error", t("avatar.saveFail"), e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("avatar.modalTitle")}
      description={t("avatar.modalDesc")}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t("confirm.cancel")}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!file || saving}
            loading={saving}
          >
            {t("avatar.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) pickFile(f);
          }}
        />

        {!file && (
          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            className="flex h-44 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border bg-surface-2/40 text-muted transition hover:border-primary/40 hover:text-primary"
          >
            <ImagePlus className="h-7 w-7" />
            <p className="text-sm">{t("avatar.dropOrClick")}</p>
            <p className="text-xs">{t("avatar.formats")}</p>
          </div>
        )}

        {file && (
          <div className="space-y-3">
            <div className="flex items-center justify-center">
              <canvas
                ref={canvasRef}
                width={OUTPUT_SIZE}
                height={OUTPUT_SIZE}
                className="h-44 w-44 rounded-2xl border border-border bg-surface-2/40"
              />
            </div>
            <div className="flex items-center gap-3 text-xs text-muted">
              <span>{t("avatar.zoom")}</span>
              <input
                type="range"
                min={1}
                max={3}
                step={0.05}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="flex-1 accent-primary"
              />
              <span className="w-12 text-right font-mono">
                {zoom.toFixed(2)}×
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => inputRef.current?.click()}
            >
              {t("avatar.choose")}
            </Button>
          </div>
        )}

        {saving && (
          <p className="flex items-center gap-2 text-xs text-muted">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("avatar.saving")}
          </p>
        )}
      </div>
    </Modal>
  );
}
