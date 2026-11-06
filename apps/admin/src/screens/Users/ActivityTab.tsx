// Activity tab of a user's page: everything recorded on the account.
import { useAdminAuth } from "../../lib/auth";
import { UserActivityLog } from "./UserActivityLog";
import { useUserDetail } from "./userDetailContext";

export default function ActivityTab() {
  const { profile } = useUserDetail();
  const { user } = useAdminAuth();
  // Remounts each time the tab opens, so admin actions made on another tab show.
  return <UserActivityLog userId={profile.id} adminId={user?.id} refreshKey={0} />;
}
