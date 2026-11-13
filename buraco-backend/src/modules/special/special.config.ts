/**
 * Special Features (Figma "SPECIAL FEATURES"): prices in coins and the limits they raise.
 * Change the numbers here; the game reads them from GET /special/features.
 */
export const SPECIAL = {
  /** Usernames of 1, 2 or 3 characters can only be bought (Figma: 70,000 / 7,000 / 1,000). */
  shortNamePrice: { 1: 70000, 2: 7000, 3: 1000 } as Record<number, number>,
  /** "Change Your Name": every rename (also Edit Name on the profile). */
  renamePrice: 1000,
  /** "Change Club Name" (club leader). */
  clubRenamePrice: 10000,
  /** "+10 Clan Member" (club leader). */
  clubSeatsPrice: 40000,
  clubSeatsStep: 10,
  /** "+10 Black List". */
  blockSlotsPrice: 40000,
  blockSlotsStep: 10,
  /** Free usernames are at least this long; shorter ones are bought. */
  minFreeNameLength: 4,
  /** Names nobody can buy or take (compared without case). */
  reserved: ['admin', 'mod', 'support', 'system', 'staff', 'help', 'root', 'null', 'test', 'waraga', 'buraco', 'god', 'owner'],
  /** Characters short names can use, in the order the name list shows them. */
  nameAlphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
};

export const USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;
