"use client";
// Copies saved text without changing conversation history.
import { useState } from "react";
import { CopyIcon } from "lucide-react";
/** Reports clipboard failure explicitly, including browsers without clipboard permission. */
export function CopyMessage({
  content,
}: {
  content: string;
}): React.JSX.Element {
  const [status, setStatus] = useState("");
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content);
      setStatus("Copied");
    } catch {
      setStatus("Copy unavailable. Select the text to copy it.");
    }
  };
  return (
    <div className="workspace-message-actions">
      <button
        type="button"
        aria-label="Copy message"
        onClick={() => void copy()}
      >
        <CopyIcon size={12} aria-hidden="true" /> Copy
      </button>
      <span role="status">{status}</span>
    </div>
  );
}
