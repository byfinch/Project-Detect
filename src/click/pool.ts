import type { Device } from "../types.js";
import type { ClickTarget, TargetDevice } from "./types.js";

/** Decide which device pool(s) to use based on where the ad was seen. */
export function resolveTargetDevice(desktopSeen: boolean, mobileSeen: boolean): TargetDevice {
  if (desktopSeen && mobileSeen) return "both";
  if (mobileSeen) return "mobile";
  if (desktopSeen) return "desktop";
  return "both";
}

export interface DevicePool {
  device: Device;
  profileIds: string[];
}

export interface PoolSelection {
  targetDevice: TargetDevice;
  pools: DevicePool[];
}

/**
 * Given a target and the full list of available profiles, return the device
 * pool(s) that should be used for clicking.
 *
 * Each profile name must start with the configured desktop/mobile prefix so
 * that its device can be inferred. Unknown profiles are dropped.
 */
export function selectPools(
  target: ClickTarget,
  allProfileIds: string[],
  desktopPrefix: string,
  mobilePrefix: string
): PoolSelection {
  const desktopIds = allProfileIds.filter((id) => id.startsWith(desktopPrefix));
  const mobileIds = allProfileIds.filter((id) => id.startsWith(mobilePrefix));

  const targetDevice = target.targetDevice;

  if (targetDevice === "mobile") {
    return { targetDevice, pools: [{ device: "mobile", profileIds: mobileIds }] };
  }
  if (targetDevice === "desktop") {
    return { targetDevice, pools: [{ device: "desktop", profileIds: desktopIds }] };
  }

  return {
    targetDevice,
    pools: [
      { device: "desktop", profileIds: desktopIds },
      { device: "mobile", profileIds: mobileIds },
    ],
  };
}

/**
 * Infer device from profile name using the configured prefixes.
 */
export function deviceOfProfile(name: string, desktopPrefix: string, mobilePrefix: string): Device | null {
  if (name.startsWith(mobilePrefix)) return "mobile";
  if (name.startsWith(desktopPrefix)) return "desktop";
  return null;
}
