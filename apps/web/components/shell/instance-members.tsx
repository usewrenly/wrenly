"use client";
// Owner-only directory; invitation authority remains server-enforced.
import { ProfileAvatar } from "@/components/account/profile-avatar";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon } from "lucide-react";
import { useSetupSummary } from "@/lib/onboarding/setup-summary";
import { invitationRequest } from "@/lib/accounts/invitations";
const MAX_VISIBLE_MEMBERS = 3;
interface Member {
  id: string;
  name: string;
  pictureUrl?: string | null;
}
/** Reuses owner-authorized membership data without exposing the private directory to other users. */
export function InstanceMembers(): React.JSX.Element | null {
  const summary = useSetupSummary();
  const owner = !summary.isError && summary.data?.role === "owner";
  const members = useQuery({
    queryKey: ["header-instance-members"],
    enabled: owner,
    staleTime: 0,
    retry: false,
    queryFn: async ({ signal }): Promise<Member[]> => {
      try {
        const result = await invitationRequest(
          "/api/instance/access/members",
          undefined,
          signal,
        );
        if (
          !result ||
          typeof result !== "object" ||
          !("members" in result) ||
          !Array.isArray(result.members)
        )
          throw new Error("Members unavailable");
        return result.members
          .filter(
            (item: unknown) =>
              !item ||
              typeof item !== "object" ||
              !("suspended" in item) ||
              item.suspended !== true,
          )
          .map((item: unknown) => {
            if (
              !item ||
              typeof item !== "object" ||
              !("id" in item) ||
              typeof item.id !== "string" ||
              !("name" in item) ||
              typeof item.name !== "string"
            )
              throw new Error("Members unavailable");
            return {
              id: item.id,
              name: item.name,
              pictureUrl:
                "pictureUrl" in item && typeof item.pictureUrl === "string"
                  ? item.pictureUrl
                  : null,
            };
          });
      } catch {
        throw new Error("Members unavailable");
      }
    },
  });
  if (!owner) return null;
  return (
    <div className="app-instance-members">
      {members.isError ? (
        <button
          type="button"
          className="app-member-retry"
          onClick={() => void members.refetch()}
        >
          Retry members
        </button>
      ) : (
        <Link
          href="/settings/access"
          className="app-member-stack"
          aria-label={
            members.isPending
              ? "Loading instance members"
              : `View ${members.data?.length ?? 0} instance members`
          }
        >
          {members.data?.slice(0, MAX_VISIBLE_MEMBERS).map((member) => (
            <ProfileAvatar
              key={member.id}
              name={member.name}
              pictureUrl={member.pictureUrl}
              className="app-avatar"
            />
          ))}
          {(members.data?.length ?? 0) > MAX_VISIBLE_MEMBERS && (
            <span className="app-avatar">
              +{members.data!.length - MAX_VISIBLE_MEMBERS}
            </span>
          )}
          <ChevronDownIcon
            className="app-member-chevron"
            size={12}
            aria-hidden="true"
          />
        </Link>
      )}
      <Link
        href="/settings/access#invite-member"
        className="app-invite-button"
        aria-label="Invite others"
      >
        <span>Invite others</span>
      </Link>
    </div>
  );
}
