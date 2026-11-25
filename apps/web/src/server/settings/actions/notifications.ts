"use server";
import { z } from "zod";
import { act, UserFacingError } from "../act";
import { ALERT_TYPES, setPushPreference, type AlertType } from "../push";

/** Turn one alert type on or off for the signed-in user (worker's settings.push_preferences). */
export async function setPushPreferenceAction(type: string, enabled: boolean) {
  return act("push.preference", { revalidate: "/settings/notifications" }, async ({ ctx, user }) => {
    const t = z.enum(ALERT_TYPES.map((a) => a.type) as [AlertType, ...AlertType[]]).parse(type);
    const def = ALERT_TYPES.find((a) => a.type === t)!;
    if (def.admin && user.role !== "admin") throw new UserFacingError("That alert goes to the admin only.");
    await setPushPreference(ctx, user.id, t, z.boolean().parse(enabled));
    return {};
  });
}
