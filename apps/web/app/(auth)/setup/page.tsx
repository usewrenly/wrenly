"use client";
import { EntryFrame } from "@/components/auth/entry-frame";
import { useEffect, useState } from "react";
// The authoritative instance-entry gate distinguishes setup, recovery and sign-in;
// a failed request must never be interpreted as an empty instance.
import { SetupForm } from "./setup-form";
import { InstanceEntry } from "@/components/auth/instance-entry";
export default function SetupPage(): React.JSX.Element {
  const [proof, setProof] = useState("");
  useEffect(() => {
    // Development effect replay sees the cleaned URL; keep the captured proof in memory.
    const suppliedProof = new URLSearchParams(
      window.location.hash.slice(1),
    ).get("setup");
    if (suppliedProof !== null) setProof(suppliedProof);
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }, []);
  return (
    <EntryFrame
      eyebrow="Your starting point"
      title="Create your account"
      description="Set up the first account to manage your Wrenly instance."
    >
      <InstanceEntry kind="setup">
        <SetupForm initialProof={proof} />
      </InstanceEntry>
    </EntryFrame>
  );
}
