"use client";
// Image failures preserve an initials identity.
import { useState } from "react";
import { useOwnPicture } from "@/lib/accounts/profile-pictures";
/** Renders only same-instance picture routes, with an initials fallback. */
export function ProfileAvatar({
  name,
  userId,
  pictureUrl,
  own = false,
  className,
}: {
  name: string;
  userId?: string;
  pictureUrl?: string | null;
  own?: boolean;
  className: string;
}): React.JSX.Element {
  const picture = useOwnPicture(userId, own);
  const source = own ? picture.data?.url : pictureUrl;
  const [failed, setFailed] = useState<string | null>(null);
  const safeSource = source?.startsWith("/api/account/profile-picture/image?")
    ? source
    : null;
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => Array.from(part)[0])
      .join("")
      .toUpperCase() || "?";
  return (
    <span
      className={`${className} profile-avatar`}
      aria-hidden="true"
      title={name}
    >
      {initials}
      {safeSource && failed !== safeSource && (
        <img src={safeSource} alt="" onError={() => setFailed(safeSource)} />
      )}
    </span>
  );
}
