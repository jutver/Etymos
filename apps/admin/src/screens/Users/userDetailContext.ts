import { useOutletContext } from "react-router-dom";
import type { Profile } from "../../lib/types";

/** What a user's page hands its tabs: the loaded profile, and a way to put a
 * refreshed one back so the header updates too. */
export interface UserDetailContext {
  profile: Profile;
  setProfile: (profile: Profile) => void;
}

export function useUserDetail(): UserDetailContext {
  return useOutletContext<UserDetailContext>();
}
