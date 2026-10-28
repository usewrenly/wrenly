import type { Metadata } from "next";
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
import { EntryFrame } from "@/components/auth/entry-frame";
import { ResetPasswordForm } from "./reset-password-form";
export default function ResetPasswordPage(): React.JSX.Element {
  return (
    <EntryFrame
      eyebrow="Private account recovery"
      title="A fresh start."
      description="Choose a new password for your existing account."
    >
      <ResetPasswordForm />
    </EntryFrame>
  );
}
