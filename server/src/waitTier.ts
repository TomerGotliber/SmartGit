import {
  WaitTier as WaitTierConst,
  type AllOpenPrItem,
  type AllOpenPrItemBase,
  type PendingReviewItem,
  type PendingReviewItemBase,
  type WaitTier,
} from "./types.js";

const TIER_MAX_HOURS = [24, 72, 168] as const;

export function computeWaitMetrics(updatedAt: string): { hoursWaiting: number; waitTier: WaitTier } {
  const ms = Date.now() - new Date(updatedAt).getTime();
  const hoursWaiting = Math.max(0, Math.floor(ms / 3600000));
  let waitTier: WaitTier = WaitTierConst.Critical;
  if (hoursWaiting < TIER_MAX_HOURS[0]) waitTier = WaitTierConst.Fresh;
  else if (hoursWaiting < TIER_MAX_HOURS[1]) waitTier = WaitTierConst.Aging;
  else if (hoursWaiting < TIER_MAX_HOURS[2]) waitTier = WaitTierConst.Stale;
  return { hoursWaiting, waitTier };
}

/** Merge wait + stored meta into a row. */
export function enrichPendingItem(
  item: PendingReviewItemBase,
  rowReviewerLogin?: string
): PendingReviewItem {
  const { hoursWaiting, waitTier } = computeWaitMetrics(item.updatedAt);

  return {
    ...item,
    hoursWaiting,
    waitTier,
    severity: null,
    rowReviewerLogin,
  };
}

export function enrichAllOpenPr(item: AllOpenPrItemBase): AllOpenPrItem {
  const { hoursWaiting, waitTier } = computeWaitMetrics(item.updatedAt);

  return {
    ...item,
    hoursWaiting,
    waitTier,
    severity: null,
  };
}
