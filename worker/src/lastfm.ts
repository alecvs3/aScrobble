/**
 * Last.fm scrobble client.
 *
 * Ported from v1/apple_scrobbler/lastfm.py.
 *
 * Implements track.scrobble with the proper auth signing scheme:
 *   1. Take all params except 'format' and 'callback'
 *   2. Sort by key
 *   3. Concatenate as key1value1key2value2...
 *   4. Append shared secret
 *   5. MD5 the resulting UTF-8 string
 *   6. Add the hex digest as 'api_sig'
 *
 * Uses the pure-TypeScript MD5 from ./md5 instead of node:crypto so the
 * worker doesn't need the `nodejs_compat` compatibility flag. Smaller
 * bundle, fewer compat surfaces.
 *
 * Last.fm applies its own dedup based on (artist, track, timestamp) so
 * resubmissions of the same play are silently dropped, making retries safe.
 */
import { md5 } from "./md5";
import type { ScrobblePayload } from "./env";

const API_URL = "https://ws.audioscrobbler.com/2.0/";
export const LASTFM_BATCH_SIZE = 50;

function signParams(
  params: Record<string, string>,
  sharedSecret: string
): string {
  const sigString =
    Object.keys(params)
      .filter((k) => k !== "format" && k !== "callback")
      .sort()
      .map((k) => `${k}${params[k]}`)
      .join("") + sharedSecret;
  return md5(sigString);
}

export interface LastfmResult {
  accepted: number;
  acceptedIndexes: number[];
  /** Plays Last.fm didn't answer for. Safe to resend with the same timestamps. */
  failedIndexes: number[];
  ignored: number;
  errors: number;
}

export async function scrobbleBatch(
  plays: ScrobblePayload[],
  apiKey: string,
  sharedSecret: string,
  sessionKey: string
): Promise<LastfmResult> {
  const result: LastfmResult = { accepted: 0, acceptedIndexes: [], failedIndexes: [], ignored: 0, errors: 0 };
  if (plays.length === 0) return result;

  for (let chunkStart = 0; chunkStart < plays.length; chunkStart += LASTFM_BATCH_SIZE) {
    const chunk = plays.slice(chunkStart, chunkStart + LASTFM_BATCH_SIZE);
    const params: Record<string, string> = {
      method: "track.scrobble",
      api_key: apiKey,
      sk: sessionKey,
    };

    const submittedIndexes: number[] = [];
    chunk.forEach((play, i) => {
      if (!play.artist || !play.track) {
        result.ignored++;
        return;
      }
      const position = submittedIndexes.length;
      submittedIndexes.push(chunkStart + i);
      params[`artist[${position}]`] = play.artist;
      params[`track[${position}]`] = play.track;
      params[`timestamp[${position}]`] = Math.floor(
        play.timestamp.getTime() / 1000
      ).toString();
      if (play.album) params[`album[${position}]`] = play.album;
      if (play.duration_ms) {
        params[`duration[${position}]`] = Math.floor(play.duration_ms / 1000).toString();
      }
    });
    if (submittedIndexes.length === 0) continue;

    params.api_sig = signParams(params, sharedSecret);
    params.format = "json";

    const body = new URLSearchParams(params);

    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (e) {
      console.error("Last.fm HTTP error:", e);
      result.errors += submittedIndexes.length;
      result.failedIndexes.push(...submittedIndexes);
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      console.error(`Last.fm ${response.status}: ${text.slice(0, 300)}`);
      result.errors += submittedIndexes.length;
      result.failedIndexes.push(...submittedIndexes);
      continue;
    }

    let json: any;
    try {
      json = await response.json();
    } catch {
      console.error("Last.fm non-JSON response");
      result.errors += submittedIndexes.length;
      result.failedIndexes.push(...submittedIndexes);
      continue;
    }

    const attr = json?.scrobbles?.["@attr"];
    const accepted = Number(attr?.accepted);
    const ignored = Number(attr?.ignored);
    if (!Number.isInteger(accepted) || !Number.isInteger(ignored) || accepted < 0 ||
        ignored < 0 || accepted + ignored !== submittedIndexes.length) {
      console.error("Last.fm returned an unexpected scrobble receipt", json?.error);
      result.errors += submittedIndexes.length;
      result.failedIndexes.push(...submittedIndexes);
      continue;
    }
    result.accepted += accepted;
    result.ignored += ignored;

    const entries = json.scrobbles.scrobble;
    const scrobbles = Array.isArray(entries) ? entries : entries ? [entries] : [];
    if (ignored === 0) {
      result.acceptedIndexes.push(...submittedIndexes);
    } else if (scrobbles.length === submittedIndexes.length) {
      const confirmedIndexes = submittedIndexes.filter((_, index) =>
        String(scrobbles[index]?.ignoredMessage?.code) === "0"
      );
      if (confirmedIndexes.length === accepted) result.acceptedIndexes.push(...confirmedIndexes);
    }

    // Log per-track reasons when Last.fm rejected something
    if (ignored > 0) {
      for (const s of scrobbles) {
        const msg = s?.ignoredMessage ?? {};
        if (msg.code && msg.code !== "0") {
          console.warn(
            `  ignored: ${s?.track?.["#text"] ?? "?"} — ${msg["#text"] ?? "?"} (code ${msg.code})`
          );
        }
      }
    }
  }

  return result;
}
