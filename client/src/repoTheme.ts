/**
 * Deterministic, distinct-ish colors per `owner/repo` for quick visual grouping.
 * Tuned for the app’s dark theme.
 */
export function repoTheme(repoFullName: string): {
  stripe: string;
  labelColor: string;
  labelBackground: string;
  labelBorder: string;
} {
  let hash = 5381;
  for (let i = 0; i < repoFullName.length; i++) {
    hash = (Math.imul(hash, 33) ^ repoFullName.charCodeAt(i)) >>> 0;
  }
  const u = hash;
  const h = u % 360;
  const s = 46 + ((u >> 9) % 20); // ~46–65%
  return {
    stripe: `hsl(${h}, ${s}%, 52%)`,
    labelColor: `hsl(${h}, ${s}%, 82%)`,
    labelBackground: `hsla(${h}, ${s}%, 26%, 0.55)`,
    labelBorder: `hsla(${h}, ${s}%, 44%, 0.9)`,
  };
}
