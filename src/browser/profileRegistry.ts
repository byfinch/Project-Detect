/**
 * Central registry of AdsPower profile IDs currently owned by a live
 * scan/click worker. The panel's idle reaper uses this to kill ORPHANED
 * browsers (left behind by wedged/reaped jobs) without touching profiles
 * that are legitimately working right now.
 */
const inUse = new Set<string>();

export function markProfileInUse(id: string): void {
  inUse.add(id);
}

export function releaseProfile(id: string): void {
  inUse.delete(id);
}

export function getInUseProfiles(): ReadonlySet<string> {
  return inUse;
}
