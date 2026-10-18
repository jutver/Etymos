import { useState } from "react";
import type { User as AuthUser } from "@supabase/supabase-js";
import { User } from "@phosphor-icons/react";
import { cn } from "@etymos/shared";
import { avatarUrlFor, initialsFor } from "../../lib/auth";

/**
 * The user's Google profile photo, or their initials when there is none (or
 * it fails to load). `className` sets the size and text size; `cn` has no
 * tailwind-merge, so the base classes deliberately set neither.
 */
export function UserAvatar({ user, className }: { user: AuthUser | null; className?: string }) {
  const url = avatarUrlFor(user);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (url && failedUrl !== url) {
    return (
      <img
        src={url}
        alt=""
        // Google's image host can refuse hot-linked requests that send a referrer.
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(url)}
        className={cn("shrink-0 rounded-full bg-brand-400 object-cover", className)}
      />
    );
  }

  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-full bg-brand-400 font-bold text-white", className)}>
      {initialsFor(user) || <User size={14} weight="fill" />}
    </span>
  );
}
