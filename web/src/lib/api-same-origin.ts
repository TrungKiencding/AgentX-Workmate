// Same-origin guard shared by the dashboard's fetch helpers (api.ts).

// A scheme (``https:``) or a protocol-relative ``//host`` prefix: the request
// can leave this origin even when no ``window.location`` is available to compare.
const LEAVES_PATH_SPACE = /^(?:[a-z][a-z\d+.-]*:|[\\/]{2})/i;

/**
 * The URL ``fetchJSON``/``authedFetch`` will request, refused when it resolves
 * to another origin. Both helpers attach the dashboard session token and send
 * credentials, so an absolute URL a plugin got from a third party (an asset
 * link from a game server) would otherwise hand that host the token.
 */
export function sameOriginRequestUrl(base: string, url: string): string {
  const target = `${base}${url}`;
  const here = typeof window === "undefined" ? undefined : window.location;
  let sameOrigin: boolean;
  if (here?.href) {
    try {
      sameOrigin = new URL(target, here.href).origin === here.origin;
    } catch {
      sameOrigin = false;
    }
  } else {
    sameOrigin = !LEAVES_PATH_SPACE.test(target);
  }
  if (!sameOrigin) {
    throw new Error(
      `Refusing to send the AgentX session to ${url}: fetchJSON/authedFetch only call ` +
        "this dashboard's own endpoints. Use plain fetch() for other hosts.",
    );
  }
  return target;
}
