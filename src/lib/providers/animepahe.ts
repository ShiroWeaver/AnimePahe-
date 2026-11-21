import z from "zod";
import type { Meta } from "stremio-rewired";
import { parseHTML } from 'linkedom';
import type { Provider } from "./interface.js";
import JsUnpacker from "js-unpacker"; // necessary for one of the animepahe scraping methods

const BASEURL = "https://animepahe.pw";

const CLOUDFLARE_CHALLENGE =
  /cf-chl-|challenge-platform|just a moment|verify you are human|performing security verification/i;

async function animePaheRequest(path: string): Promise<Response> {
  const url = new URL(path, `${BASEURL}/`);
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": `${BASEURL}/`,
    },
  });

  if (!response.ok) {
    const body = await response.clone().text().catch(() => "");
    if (CLOUDFLARE_CHALLENGE.test(body) || [403, 429, 503].includes(response.status)) {
      throw new Error(
        `AnimePahe blocked this server request (HTTP ${response.status}). It may require a browser-based Cloudflare verification; a normal Cloudflare Worker cannot complete that check.`,
      );
    }
    throw new Error(`AnimePahe request failed with HTTP ${response.status}`);
  }

  return response;
}

async function fetchAnimePaheJson(path: string): Promise<unknown> {
  const response = await animePaheRequest(path);
  const body = await response.text();

  try {
    return JSON.parse(body) as unknown;
  } catch {
    if (CLOUDFLARE_CHALLENGE.test(body)) {
      throw new Error(
        "AnimePahe returned a Cloudflare verification page instead of JSON. A browser-capable session is required.",
      );
    }
    throw new Error("AnimePahe returned an invalid JSON response");
  }
}

async function fetchAnimePaheHtml(path: string): Promise<string> {
  const response = await animePaheRequest(path);
  const body = await response.text();

  if (CLOUDFLARE_CHALLENGE.test(body)) {
    throw new Error(
      "AnimePahe returned a Cloudflare verification page. A standard Cloudflare Worker cannot complete browser verification.",
    );
  }

  return body;
}

function safeIsoDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export class AnimePaheProvider implements Provider {
  async search(title: string, proxyBase: string) {
    const params = new URLSearchParams({ m: "search", l: "8", q: title });
    const json = await fetchAnimePaheJson(`/api?${params.toString()}`);

    const schema = z.object({
      data: z.array(
        z.object({
          id: z.number(),
          title: z.string(),
          type: z.string(),
          episodes: z.number(),
          status: z.string(),
          year: z.number(),
          score: z.number(),
          poster: z.string(),
          session: z.string()
        })
      ),
    });

    try {
      const data = schema.parse(json);
      return data.data.map((record) => ({
        title: record.title,
        id: "ap" + record.session,
        imageUrl: proxyUrl(record.poster, proxyBase),
      }));
    } catch (error) {
      console.error("Search returned invalid data:", error);
      return [];
    }
  }

  async getLatest(proxyBase: string) {
    const latestJson = await fetchAnimePaheJson("/api?m=airing&page=1");
    const latestSchema = z.object({
      data: z.array(
        z.object({
          id: z.number(),
          anime_id: z.number(),
          anime_title: z.string(),
          anime_session: z.string(),
          episode: z.number(),
          episode2: z.number(),
          edition: z.string(),
          fansub: z.string(),
          snapshot: z.string(),
          disc: z.string(),
          session: z.string(),
          filler: z.number(),
          created_at: z.string(),
          completed: z.number()
        })
      )
    })

    const latestParsed = latestSchema.parse(latestJson);
    return latestParsed.data.map((record) => ({
      id: `ap${record.anime_session}`,
      title: record.anime_title,
      imageUrl: proxyUrl(record.snapshot, proxyBase),
    }))

  }

  async getMeta(id: string, proxyBase: string): Promise<Meta> {
    const animeId = id.replace(/^ap/, "").split("|")[0];

    const json = await fetchAnimePaheHtml(`/anime/${encodeURIComponent(animeId)}`);

    const { document } = parseHTML(json);
    var description = document.querySelector('.anime-synopsis')?.innerHTML.replace(/<br\s*\/?>/g, "\n").trim();
    var name = document.querySelector('span[style="user-select:text"]')?.textContent?.trim();
    var poster = document.querySelector('img[data-src$=".jpg"]')?.getAttribute('data-src')?.trim();
    var background = document.querySelector('div.anime-cover')?.getAttribute('data-src')?.trim();
    const pTags = document.querySelectorAll(".anime-info p");
    const airedTag = Array.from(pTags).find(p =>
      p.textContent.trim().startsWith('Aired:')
    );
    var aired = airedTag?.textContent
      .replace(/\s+/g, ' ')        // normalize whitespace
      .replace('Aired:', '')       // remove the label
      .trim();

    const durationTag = Array.from(pTags).find(p =>
      p.textContent.trim().startsWith('Duration:')
    );
    var duration = durationTag?.textContent
      .replace(/\s+/g, ' ')        // normalize whitespace
      .replace('Duration:', '')       // remove the label
      .trim();

    const externalHref = document.querySelector(".external-links a")?.getAttribute("href")?.trim();
    let externalLink = "";
    if (externalHref) {
      try {
        const parsedExternalUrl = new URL(externalHref, BASEURL);
        if (parsedExternalUrl.protocol === "https:" || parsedExternalUrl.protocol === "http:") {
          externalLink = parsedExternalUrl.href;
        }
      } catch {
        externalLink = "";
      }
    }
    var genres = Array.from(document.querySelectorAll(".anime-genre li")).map(g => g.textContent.trim())



    poster = proxyUrl(poster ?? "", proxyBase);
    background = proxyUrl(background ?? "", proxyBase);

    const videosSchema = z.object({
      last_page: z.number(),
      data: z.array(
        z.object({
          id: z.number(),
          anime_id: z.number(),
          episode: z.number(),
          episode2: z.number(),
          edition: z.string(),
          title: z.string(),
          snapshot: z.string(),
          disc: z.string(),
          audio: z.string(),
          duration: z.string(),
          session: z.string(),
          filler: z.number(),
          created_at: z.string(),
        })
      ),
    });

    const fetchVideos = async (page: number) => {
      return await fetchAnimePaheJson(
        `/api?m=release&id=${encodeURIComponent(animeId)}&sort=episode_dsc&page=${page}`,
      );
    }

    const videosJson = await fetchVideos(1);
    const videosParsed = videosSchema.parse(videosJson);

    // Page 1 is already loaded. Fetch every remaining page, including last_page.
    const additionalPages = Array.from(
      { length: Math.max(0, videosParsed.last_page - 1) },
      (_, index) => index + 2,
    );
    const additionalPageData = await Promise.all(
      additionalPages.map(async (page) =>
        videosSchema.parse(await fetchVideos(page)),
      ),
    );

    const allVideos = [
      ...videosParsed.data,
      ...additionalPageData.flatMap((page) => page.data),
    ];

    const videos = allVideos.map((video) => ({
      id: `ap${animeId}|${video.session}`,
      title: video.title || `Episode ${video.episode}`,
      released: safeIsoDate(video.created_at),
      episode: video.episode,
      season: 1, // if no season they will be sorted in reverse order
      thumbnail: proxyUrl(video.snapshot, proxyBase),
      available: true,
    }));

    videos.sort((a, b) => a.episode - b.episode);

    return {
      id: `ap${animeId}`,
      name: name ?? "",
      type: "series",
      //logo: "https://raw.githubusercontent.com/93Pd9s8Jt/stremio-addon-animepahe/refs/heads/main/images/apdoesnthavelogotheysaidapistooplaintheysaid.png", // higher quality conversion of the svg
      poster: poster ?? "",
      description: description ?? "",
      background: background ?? "",
      releaseInfo: aired ?? "",
      runtime: duration,
      genres: genres,
      website: externalLink ?? "",
      videos,
    };
  }

  async getStreams(
    id: string
  ): Promise<Array<{ id: string; title: string; url: string }>> {
    const [animeId, animeSession] = id.split("|");
    if (!animeId || !animeSession) {
      throw new Error("Invalid AnimePahe episode ID");
    }

    const html = await fetchAnimePaheHtml(
      `/play/${encodeURIComponent(animeId)}/${encodeURIComponent(animeSession)}`,
    );
    const { document } = parseHTML(html);

    const buttons = Array.from(
      document.querySelectorAll("div#resolutionMenu > button"),
    );
    if (buttons.length === 0) {
      throw new Error("AnimePahe did not return any playable resolution options");
    }

    const videos: Array<{
      id: string;
      title: string;
      url: string;
      _quality: string;
    }> = [];

    for (const button of buttons) {
      const audio = button.getAttribute("data-audio") ?? "Unknown";
      const quality = button.getAttribute("data-resolution") ?? "Unknown";
      const kwikLink = button.getAttribute("data-src");

      if (!kwikLink) continue;

      let kwikUrl: URL;
      try {
        kwikUrl = new URL(kwikLink, BASEURL);
      } catch {
        console.warn("Skipping an invalid Kwik player URL");
        continue;
      }

      const kwikHost = kwikUrl.hostname.toLowerCase();
      const isKwikHost =
        kwikHost === "kwik.cx" ||
        kwikHost.endsWith(".kwik.cx") ||
        kwikHost === "kwik.si" ||
        kwikHost.endsWith(".kwik.si");
      if (kwikUrl.protocol !== "https:" || !isKwikHost) {
        console.warn("Skipping a player URL outside the expected Kwik hosts");
        continue;
      }

      const response = await fetch(kwikUrl, {
        headers: {
          Referer: `${BASEURL}/`,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        },
      });
      if (!response.ok) {
        console.warn(`Kwik request failed with HTTP ${response.status}`);
        continue;
      }

      const body = await response.text();
      const scriptNode = Array.from(
        parseHTML(body).document.querySelectorAll("script"),
      ).find((node) => node.innerHTML.includes("eval(function"));

      if (!scriptNode) {
        console.warn("Kwik page did not contain the expected player script");
        continue;
      }

      const packedScript = `eval(function(${substringAfterLast(
        scriptNode.innerHTML,
        "eval(function(",
      )}`;
      const unpackedScript = unpackJsAndCombine(packedScript);
      const sourceMatch = unpackedScript.match(
        /(?:const|let|var)\s+source\s*=\s*['"]([^'"]+)['"]/,
      );
      const videoUrl = sourceMatch?.[1] ?? "";

      let parsedVideoUrl: URL;
      try {
        parsedVideoUrl = new URL(videoUrl);
      } catch {
        console.warn("Kwik player did not expose a valid stream URL");
        continue;
      }
      if (parsedVideoUrl.protocol !== "https:") {
        console.warn("Skipping a non-HTTPS stream URL");
        continue;
      }

      videos.push({
        id: `ap${animeId}--${quality}--${audio}`,
        title: `${audio} / ${quality}p`,
        url: parsedVideoUrl.href,
        _quality: quality,
      });
    }

    videos.sort(
      (a, b) => Number.parseInt(b._quality, 10) - Number.parseInt(a._quality, 10),
    );

    if (videos.length === 0) {
      throw new Error(
        "No direct video URL could be extracted from the available Kwik options",
      );
    }

    return videos.map(({ id, title, url }) => ({ id, title, url }));
  }
}


function proxyUrl(url: string, proxyBase: string) {
  if (!url.trim()) return "";
  try {
    const normalizedUrl = new URL(url, BASEURL);
    if (normalizedUrl.protocol !== "https:") return "";
    return `${proxyBase}img/${encodeURIComponent(normalizedUrl.href)}`;
  } catch {
    return "";
  }
}

function substringBefore(str: string, pattern: string) {
  const endIndex = str.indexOf(pattern);
  if (endIndex === -1) {
    return str.substring(0);
  }
  return str.substring(0, endIndex);
}

function substringAfterLast(str: string, pattern: string) {
  return str.split(pattern).pop() || "";
}

function substringAfter(str: string, pattern: string) {
  const startIndex = str.indexOf(pattern);
  if (startIndex === -1) {
    return str.substring(0);
  }
  const start = startIndex + pattern.length;
  return str.substring(start);
}

function getMapValue(mapString: string, key: string): string | null {
  try {
    const map = JSON.parse(mapString);
    return map[key] != null ? map[key].toString() : "";
  } catch {
    return "";
  }
}


// We can inline the simplified getString logic for maximum efficiency.

/**
 * Decrypts the packed string payload from Kwik.
 * This is a direct port of the Dart decryption logic.
 *
 * @param packedStr The packed/encoded string (Dart: fS).
 * @param key The string containing the characters used for the base conversion.
 * @param offsetStr A string representation of an integer used as a character code offset (Dart: v1).
 * @param delimiterIndex The integer index pointing to the delimiter character within the `key` (Dart: v2).
 *                       Crucially, this is also used as the *base* for the number conversion.
 * @returns The decrypted HTML string.
 */
function decrypt(packedStr: string, key: string, offsetStr: string, delimiterIndex: number): string {
  let html = "";
  let i = 0;
  const offset = parseInt(offsetStr, 10);

  if (isNaN(offset)) {
    throw new Error("Invalid offset value for decryption.");
  }

  // `delimiterIndex` points to the character in the `key` that separates chunks.
  const delimiter = key[delimiterIndex];
  // `delimiterIndex` is also bizarrely used as the numerical base for parsing.
  const radix = delimiterIndex;

  while (i < packedStr.length) {
    let chunk = "";

    // 1. Read characters from the packed string until the delimiter is found.
    while (i < packedStr.length && packedStr[i] !== delimiter) {
      chunk += packedStr[i];
      i++;
    }

    // 2. Convert the chunk from its custom "alphabet" (the `key`) into a
    //    string of standard decimal digits.
    //    For example, if key="abc" and chunk="ba", it becomes "10".
    let chunkWithDigits = chunk;
    for (let j = 0; j < key.length; j++) {
      // String.prototype.replaceAll is supported in Cloudflare Workers.
      chunkWithDigits = chunkWithDigits.replaceAll(key[j]!, j.toString());
    }

    // 3. Perform the `getString` logic: parse the digit string using the
    //    `radix` (which is `delimiterIndex`), and convert it to a base-10 number.
    const numericValue = parseInt(chunkWithDigits, radix);

    // 4. Subtract the offset and convert the final number into a character.
    const charCode = numericValue - offset;
    html += String.fromCharCode(charCode);

    // 5. Move the main index past the delimiter to start the next chunk.
    i++;
  }

  return html;
}

function unpackJsAndCombine(js: string) {
  const unpacker = new JsUnpacker(js)
  if (unpacker.detect()) return unpacker.unpack();
  throw new Error(`Unable to unpack js
    
    JS: ${js}`)
}
