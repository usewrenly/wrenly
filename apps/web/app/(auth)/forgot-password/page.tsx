import type { Metadata } from "next";
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
import { EntryFrame } from "@/components/auth/entry-frame";
import { DocumentationLink } from "@/components/documentation-link";
export default function ForgotPasswordPage(): React.JSX.Element {
  return (
    <EntryFrame
      eyebrow="Account recovery"
      title="Find your way back."
      description="Reset your password with a private link from this instance."
    >
      <div className="entry-note">
        <p>
          If you run this instance, open a terminal in the Wrenly repository root and run:
        </p>
        <pre className="my-4 overflow-x-auto rounded-lg border p-4 text-xs">
          bun run recover-password your-email@example.com
        </pre>
        <p>
          Open the private link within 10 minutes to choose a new password. Your
          projects stay yours; existing sessions will be signed out.
        </p>
        <p className="mt-4">
          Part of a team? Ask the person who runs this instance to issue your
          private recovery link. Email delivery is not configured by this
          recovery flow.
        </p>
        <p className="mt-4">
          <DocumentationLink guide="guides/account-settings">
            Recovery guide →
          </DocumentationLink>
        </p>
      </div>
      <a className="mt-6 inline-block text-sm underline" href="/sign-in">
        Back to sign in
      </a>
    </EntryFrame>
  );
}
