import { PromptDialog } from "@/components/PromptDialog";
import { usePromptStore } from "@/store/usePromptStore";

/** 挂在 App 根部，与 ConfirmHost 同级。 */
export function PromptHost() {
  const open = usePromptStore((s) => s.open);
  const request = usePromptStore((s) => s.request);
  const loading = usePromptStore((s) => s.loading);
  const submit = usePromptStore((s) => s.submit);
  const cancel = usePromptStore((s) => s.cancel);
  return (
    <PromptDialog
      open={open}
      request={request}
      loading={loading}
      onConfirm={submit}
      onCancel={cancel}
    />
  );
}
