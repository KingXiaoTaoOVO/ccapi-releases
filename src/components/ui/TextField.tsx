import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const fieldBase =
  "w-full bg-surface-2 text-text placeholder:text-muted/70 border border-border rounded-xl px-3.5 py-2.5 text-sm " +
  "transition-[box-shadow,border-color] duration-200 outline-none no-drag " +
  "focus:border-primary/60 focus:shadow-[0_0_0_3px_rgb(var(--primary)/0.18)]";

interface FieldWrapProps {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}

export function Field({ label, hint, error, required, children }: FieldWrapProps) {
  return (
    <label className="block space-y-1.5">
      {label && (
        <span className="flex items-center gap-1 text-xs font-medium text-muted">
          {label}
          {required && <span className="text-danger">*</span>}
        </span>
      )}
      {children}
      {error ? (
        <span className="block text-xs text-danger">{error}</span>
      ) : hint ? (
        <span className="block text-xs text-muted/80">{hint}</span>
      ) : null}
    </label>
  );
}

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  ({ label, hint, error, required, className, ...rest }, ref) => (
    <Field label={label} hint={hint} error={error} required={required}>
      <input
        ref={ref}
        required={required}
        className={cn(fieldBase, error && "border-danger/60", className)}
        {...rest}
      />
    </Field>
  ),
);
TextField.displayName = "TextField";

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  ({ label, hint, error, required, className, ...rest }, ref) => (
    <Field label={label} hint={hint} error={error} required={required}>
      <textarea
        ref={ref}
        required={required}
        className={cn(fieldBase, "resize-none leading-relaxed", error && "border-danger/60", className)}
        {...rest}
      />
    </Field>
  ),
);
TextArea.displayName = "TextArea";
