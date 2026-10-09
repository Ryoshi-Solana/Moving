/**
 * Accept only explicit, public HTTPS URLs on an approved host.
 * Requiring a non-root path prevents generic homepages from masquerading as
 * official project destinations (for example pump.fun/ or x.com/).
 */
export function verifiedPublicUrl(
  value: string | undefined,
  allowedHosts: readonly string[],
  requireNonRootPath = true
): string | null {
  if (!value || value.trim() === '') return null;

  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();

    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      !allowedHosts.includes(host)
    ) {
      return null;
    }

    if (requireNonRootPath && (url.pathname === '/' || url.pathname.length < 2)) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}
