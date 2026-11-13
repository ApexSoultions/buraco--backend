/**
 * Premium is active while the player has a paid status and it has not run out.
 * A status with no expiry (set by an admin) never runs out.
 */
export function isPremiumActive(
  user: { subscriptionStatus?: string | null; subscriptionExpiry?: Date | null } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!user || !user.subscriptionStatus || user.subscriptionStatus === 'FREE') return false;
  return !user.subscriptionExpiry || user.subscriptionExpiry > now;
}

/** Voice chat subscription is active until voiceChatExpiry. */
export function isVoiceChatActive(user: { voiceChatExpiry?: Date | null } | null | undefined, now: Date = new Date()): boolean {
  return !!user?.voiceChatExpiry && user.voiceChatExpiry > now;
}
