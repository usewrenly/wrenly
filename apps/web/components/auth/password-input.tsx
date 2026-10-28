"use client";
// Reveal is explicit and does not alter form submission.
import { useState } from "react";
import { Input } from "@/components/ui/input";
/** Offers keyboard-accessible password visibility while preserving native form semantics. */
export function PasswordInput(
  props: Omit<React.ComponentProps<"input">, "type">,
): React.JSX.Element {
  const [visible, setVisible] = useState(false);
  return (
    <div className="entry-password">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        className={`entry-control ${props.className ?? ""}`}
      />
      <button
        type="button"
        disabled={props.disabled}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-controls={props.id}
        aria-pressed={visible}
        onClick={() => setVisible((value) => !value)}
      >
        {visible ? "Hide" : "Show"}
      </button>
    </div>
  );
}
