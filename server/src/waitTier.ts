import { canPokeAgain, type PrMetaEntry } from "./prMetaStore.js";
import {
  PendingReviewKind,
  ReviewSeverity,
  WaitTier as WaitTierConst,
  type AllOpenPrItem,
  type AllOpenPrItemBase,
  type PendingReviewItem,
  type PendingReviewItemBase,
  type ReviewSeverityValue,
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

function normalizeSeverity(
  s: ReviewSeverityValue | undefined
): Exclude<ReviewSeverityValue, "none"> | null {
  if (!s || s === ReviewSeverity.None) return null;
  return s as Exclude<ReviewSeverityValue, "none">;
}

/** Merge wait + stored meta into a row. */
export function enrichPendingItem(
  item: PendingReviewItemBase,
  prMetaMap: Record<string, PrMetaEntry>,
  rowReviewerLogin?: string
): PendingReviewItem {
  const key = `${item.repoFullName}#${item.pullNumber}`;
  const entry = prMetaMap[key] ?? {};
  const { hoursWaiting, waitTier } = computeWaitMetrics(item.updatedAt);
  const severity = normalizeSeverity(entry.severity);

  let canPokeReviewer: boolean | undefined;
  let nextPokeAt: string | undefined;
  if (rowReviewerLogin) {
    const last = entry.pokes?.[rowReviewerLogin];
    const poke = canPokeAgain(last, Date.now());
    canPokeReviewer = poke.ok;
    if (!poke.ok && poke.nextAt) nextPokeAt = poke.nextAt;
  }

  let pokeStatusByReviewer: PendingReviewItem["pokeStatusByReviewer"];
  if (item.kind === PendingReviewKind.ChangesRequested && item.changesRequestedBy?.length) {
    pokeStatusByReviewer = {};
    for (const rev of item.changesRequestedBy) {
      const last = entry.pokes?.[rev];
      const poke = canPokeAgain(last, Date.now());
      pokeStatusByReviewer[rev] = {
        canPoke: poke.ok,
        ...(poke.nextAt ? { nextPokeAt: poke.nextAt } : {}),
      };
    }
  }

  return {
    ...item,
    hoursWaiting,
    waitTier,
    severity,
    rowReviewerLogin,
    canPokeReviewer,
    nextPokeAt,
    pokeStatusByReviewer,
  };
}

export function enrichAllOpenPr(
  item: AllOpenPrItemBase,
  prMetaMap: Record<string, PrMetaEntry>
): AllOpenPrItem {
  const key = `${item.repoFullName}#${item.pullNumber}`;
  const entry = prMetaMap[key] ?? {};
  const { hoursWaiting, waitTier } = computeWaitMetrics(item.updatedAt);
  const severity = normalizeSeverity(entry.severity);

  let pokeStatusByReviewer: AllOpenPrItem["pokeStatusByReviewer"];
  if (item.changesRequestedBy.length > 0) {
    pokeStatusByReviewer = {};
    for (const rev of item.changesRequestedBy) {
      const last = entry.pokes?.[rev];
      const poke = canPokeAgain(last, Date.now());
      pokeStatusByReviewer[rev] = {
        canPoke: poke.ok,
        ...(poke.nextAt ? { nextPokeAt: poke.nextAt } : {}),
      };
    }
  }

  return {
    ...item,
    hoursWaiting,
    waitTier,
    severity,
    pokeStatusByReviewer,
  };
}
