import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useConfirmStore } from "@/store/useConfirmStore";

/** 挂载到 App 根部，与 ToastContainer 同级 */
export function ConfirmHost() {
  const open = useConfirmStore((s) => s.open);
  const request = useConfirmStore((s) => s.request);
  const loading = useConfirmStore((s) => s.loading);
  const confirm = useConfirmStore((s) => s.confirm);
  const cancel = useConfirmStore((s) => s.cancel);
  return (
    <ConfirmDialog
      open={open}
      request={request}
      loading={loading}
      onConfirm={confirm}
      onCancel={cancel}
    />
  );
}
