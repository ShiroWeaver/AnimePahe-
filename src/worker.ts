import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAddonHandler } from "./lib/addon.js";

// Restrict the public proxy to hosts used by AnimePahe's site, images and player.
// Hosts are checked against exact names / dot-delimited suffixes, not loose regexes.
const IMAGE_HOSTS = new Set([
  "i.animepahe.si",
  "animepahe.pw",
  "animepahe.com",
  "animepahe.org",
]);
const STREAM_HOST_SUFFIXES = [
  ".uwucdn.top",
  ".kwik.cx",
  ".kwik.si",
];

function hostAllowed(hostname: string, kind: "image" | "stream"): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (kind === "image") {
    return (
      IMAGE_HOSTS.has(host) ||
      host.endsWith(".animepahe.pw") ||
      host.endsWith(".animepahe.com") ||
      host.endsWith(".animepahe.org")
    );
  }
  return STREAM_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function parseAllowedUrl(rawUrl: string, kind: "image" | "stream"): URL | null {
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !hostAllowed(url.hostname, kind)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function fetchAllowedUrl(
  initialUrl: URL,
  kind: "image" | "stream",
): Promise<Response> {
  let currentUrl = initialUrl;

  // Follow only a small number of redirects, validating every destination.
  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    const response = await fetch(currentUrl.toString(), {
      redirect: "manual",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        Accept:
          kind === "image"
            ? "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
            : "*/*",
        Referer: "https://animepahe.pw/",
      },
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }

    const location = response.headers.get("Location");
    if (!location) {
      return response;
    }
    if (redirectCount === 5) {
      return new Response("Too many upstream redirects", { status: 502 });
    }

    const nextUrl = parseAllowedUrl(
      new URL(location, currentUrl).toString(),
      kind,
    );
    if (!nextUrl) {
      return new Response("Upstream redirect destination is not allowed", {
        status: 502,
      });
    }
    currentUrl = nextUrl;
  }

  return new Response("Too many upstream redirects", { status: 502 });
}

console.log("Starting AnimePahe Stremio addon");

const app = new Hono();

app.use("*", cors());

app.get("/_internal/stream-proxy/img/:url", async (c) => {
  try {
    const url = parseAllowedUrl(c.req.param("url"), "image");
    if (!url) {
      return new Response("Image host is not allowed", { status: 403 });
    }

    const response = await fetchAllowedUrl(url, "image");
    if (!response.ok) {
      return new Response("Image source failed", { status: response.status });
    }

    const contentType = response.headers.get("Content-Type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return new Response("Upstream did not return an image", { status: 502 });
    }

    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    console.error("Image proxy error:", error);
    return new Response("Image proxy request failed", { status: 502 });
  }
});

app.get("/_internal/stream-proxy/:url", async (c) => {
  try {
    const url = parseAllowedUrl(c.req.param("url"), "stream");
    if (!url) {
      return new Response("Stream host is not allowed", { status: 403 });
    }

    const response = await fetchAllowedUrl(url, "stream");
    if (!response.ok) {
      return new Response(`Upstream stream request failed: ${response.status}`, {
        status: response.status,
      });
    }

    const headers = new Headers();
    for (const name of ["Content-Type", "Content-Length", "Accept-Ranges"]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("Cache-Control", "no-store");

    return new Response(response.body, {
      status: response.status,
      headers,
    });
  } catch (error) {
    console.error("Stream proxy error:", error);
    return new Response("Stream proxy request failed", { status: 502 });
  }
});

app.get("*", async (c) => {
  try {
    const url = new URL(c.req.url);
    const proxyBase = `${url.origin}/_internal/stream-proxy/`;
    const response = await createAddonHandler(proxyBase)(c.req.raw);

    if (!response) {
      return new Response("Not found", { status: 404 });
    }

    return response;
  } catch (error) {
    console.error("Addon request failed:", error);
    const message =
      error instanceof Error ? error.message : "Unexpected addon error";
    return new Response(message, { status: 502 });
  }
});

export default app;
