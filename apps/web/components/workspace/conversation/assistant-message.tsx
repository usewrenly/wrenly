"use client";
// COMPONENT: Assistant Markdown message
// Displays model Markdown without executing HTML or loading external images.
import { CopyMessage } from "./copy-message";
import { WrenlyMark } from "@/components/wrenly-mark";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Renders model text as safe Markdown without raw HTML or automatic external image requests. */
export function AssistantMessage({
  content,
}: {
  content: string;
}): React.JSX.Element {
  return (
    <section className="workspace-assistant">
      <div className="workspace-message-sender">
        <WrenlyMark className="size-5" />
        <span>Wrenly</span>
      </div>
      <div className="min-w-0 space-y-3 break-words text-sm leading-relaxed text-[var(--color-text-1)] [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-[var(--color-surface-2)] [&_pre]:p-3 [&_code]:font-mono [&_code]:text-xs [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_table]:block [&_table]:overflow-auto [&_th]:border [&_th]:p-2 [&_td]:border [&_td]:p-2 [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold">
        <Markdown
          skipHtml
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) =>
              href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  {children}
                </a>
              ) : (
                <span>{children}</span>
              ),
            img: ({ alt }) => (
              <span className="text-[var(--color-text-3)]">
                {alt ?? "Image omitted"}
              </span>
            ),
          }}
        >
          {content}
        </Markdown>
      </div>
      <CopyMessage content={content} />
    </section>
  );
}
