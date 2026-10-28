// InstanceEntry retains authoritative routing.
import { InstanceEntry } from "@/components/auth/instance-entry";
import { EntryFrame } from "@/components/auth/entry-frame";
import { SignInForm } from "./sign-in-form";
export default function SignInPage(): React.JSX.Element {
  return (
    <EntryFrame
      eyebrow="Welcome back"
      title="Sign in to Wrenly"
      description="Continue building on your instance."
    >
      <InstanceEntry kind="sign-in">
        <SignInForm />
      </InstanceEntry>
    </EntryFrame>
  );
}
