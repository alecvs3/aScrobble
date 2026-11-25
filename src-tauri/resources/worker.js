// src/apple.ts
var API_BASE = "https://api.music.apple.com/v1";
var PAGE_SIZE = 30;
var RECENT_TRACKS_URL = `${API_BASE}/me/recent/played/tracks`;
var HISTORY_TYPES = "songs,library-songs";
var POLL_PAGES = 4;
var RECOVERY_PAGES = 30;
var MIN_CHECKPOINT_TRACKS = 5;
var MAX_CHECKPOINT_TRACKS = 8;
var TokenExpiredError = class extends Error {
  constructor() {
    super(
      "Apple Music API returned 401. Dev token or Music-User-Token expired. Re-open the aScrobble desktop app to re-authenticate with Apple Music."
    );
    this.name = "TokenExpiredError";
  }
};
var SPOOFED_HEADERS = {
  Origin: "https://music.apple.com",
  Referer: "https://music.apple.com/",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
};
function normalizeAlbumName(rawAlbum) {
  if (!rawAlbum) return "";
  return rawAlbum.replace(/ - (EP|Single)$/i, "").trim();
}
function trackFromItem(item) {
  const attrs = item.attributes ?? {};
  return {
    id: item.id,
    name: attrs.name ?? "",
    artist: attrs.artistName ?? "",
    album_artist: attrs.albumArtistName ?? attrs.artistName ?? "",
    album: normalizeAlbumName(attrs.albumName ?? ""),
    duration_ms: attrs.durationInMillis ?? 18e4,
    isrc: attrs.isrc,
    ...item.type === "library-songs" ? { library: true } : {}
  };
}
async function fetchHistoryPage(url, headers, probingOffset = false) {
  const response = await fetch(url, { headers, redirect: "manual" });
  if (response.status === 401) throw new TokenExpiredError();
  if (!response.ok) {
    await response.body?.cancel();
    if (probingOffset && (response.status === 400 || response.status === 404)) return { data: [] };
    throw new Error(`Apple Music history returned HTTP ${response.status}`);
  }
  const page = await response.json();
  if (!Array.isArray(page.data)) throw new Error("Apple Music history response has no track list");
  return page;
}
function historyUrl(offset) {
  const url = new URL(RECENT_TRACKS_URL);
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("types", HISTORY_TYPES);
  return url;
}
function historyHeaders(devToken, musicUserToken) {
  return {
    Authorization: `Bearer ${devToken}`,
    "Music-User-Token": musicUserToken,
    ...SPOOFED_HEADERS
  };
}
async function fetchRecentlyPlayed(devToken, musicUserToken) {
  const tracks = [];
  const headers = historyHeaders(devToken, musicUserToken);
  for (let page = 0; page < POLL_PAGES; page++) {
    const { data: items } = await fetchHistoryPage(historyUrl(page * PAGE_SIZE), headers, page > 0);
    const previousId = tracks.at(-1)?.id;
    tracks.push(...items.filter((item, index) => item.id && (index > 0 || item.id !== previousId)).map(trackFromItem));
    if (items.length < PAGE_SIZE) break;
  }
  return tracks;
}
function historyTrackKey(artist, track) {
  const normalize = (value) => value.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  return JSON.stringify([normalize(artist), normalize(track)]);
}
function nextHistoryPage(url, page) {
  const offset = Number(url.searchParams.get("offset") ?? 0);
  if (!page.next) {
    return page.data.length === PAGE_SIZE ? historyUrl(offset + PAGE_SIZE) : null;
  }
  const next = new URL(page.next, url);
  const nextOffset = Number(next.searchParams.get("offset"));
  if (next.origin !== url.origin || next.pathname !== url.pathname || !Number.isSafeInteger(nextOffset) || nextOffset !== offset + page.data.length) {
    throw new Error("Apple Music returned an invalid history continuation");
  }
  next.searchParams.set("limit", String(PAGE_SIZE));
  next.searchParams.set("types", HISTORY_TYPES);
  return next;
}
async function fetchRecoveryHistory(devToken, musicUserToken, checkpoint) {
  const metadata = checkpoint.identity === "track-metadata";
  const anchor = checkpoint.keys.slice(0, metadata ? MIN_CHECKPOINT_TRACKS : MAX_CHECKPOINT_TRACKS);
  const matchesAt = (keys2, index) => anchor.every((key, offset) => keys2[index + offset] === key);
  const shortCheckpoint = anchor.length < MIN_CHECKPOINT_TRACKS || new Set(anchor).size < 3;
  const repeatedCheckpoint = !shortCheckpoint && checkpoint.keys.some((_, index) => index > 0 && matchesAt(checkpoint.keys, index));
  const headers = historyHeaders(devToken, musicUserToken);
  const firstUrl = historyUrl(0);
  const tracks = [];
  const keys = [];
  const keyPositions = [];
  const result = { snapshot: [], checked: 0, matchLength: anchor.length, missing: null };
  const pageSignatures = /* @__PURE__ */ new Set();
  let url = firstUrl;
  let firstPageSignature = "";
  let nextMatchIndex = 0;
  let matchIndex = -1;
  let ambiguous = repeatedCheckpoint;
  let probingOffset = false;
  let pagesWithTracks = 0;
  for (let page = 0; url && page < RECOVERY_PAGES; page++) {
    const response = await fetchHistoryPage(url, headers, probingOffset);
    const items = response.data;
    const signature = JSON.stringify(items.map((item) => item.id));
    if (page === 0) firstPageSignature = signature;
    if (probingOffset && !response.next && pageSignatures.has(signature) || items.length === 0) {
      url = null;
      break;
    }
    pageSignatures.add(signature);
    pagesWithTracks++;
    for (const item of items) {
      const track = trackFromItem(item);
      tracks.push(track);
      if (checkpoint.catalogOnly && track.library) continue;
      keys.push(metadata ? historyTrackKey(track.artist, track.name) : track.id);
      keyPositions.push(tracks.length - 1);
    }
    if (!shortCheckpoint && !ambiguous) {
      for (; nextMatchIndex + anchor.length <= keys.length; nextMatchIndex++) {
        if (!matchesAt(keys, nextMatchIndex)) continue;
        if (matchIndex !== -1) {
          ambiguous = true;
          break;
        }
        matchIndex = keyPositions[nextMatchIndex];
      }
    }
    if (tracks.length >= POLL_PAGES * PAGE_SIZE && (shortCheckpoint || ambiguous || matchIndex !== -1)) break;
    url = nextHistoryPage(url, response);
    probingOffset = !response.next;
  }
  result.snapshot = tracks.slice(0, POLL_PAGES * PAGE_SIZE).filter((track) => track.id);
  result.checked = tracks.length;
  if (result.snapshot.length === 0) throw new Error("Apple Music returned an empty recovery history");
  if (!shortCheckpoint && !ambiguous && pagesWithTracks > 1) {
    const head = await fetchHistoryPage(firstUrl, headers);
    if (JSON.stringify(head.data.map((item) => item.id)) !== firstPageSignature) {
      throw new Error("Apple Music history shifted during recovery");
    }
  }
  if (shortCheckpoint) result.reason = "checkpoint was too short";
  else if (ambiguous) result.reason = "checkpoint was ambiguous";
  else if (matchIndex === -1) result.reason = url ? "search limit reached" : "history ended";
  else result.missing = tracks.slice(0, newerThanCheckpoint(tracks, matchIndex, checkpoint.catalogOnly)).filter((track) => track.id);
  return result;
}
function newerThanCheckpoint(tracks, matchIndex, catalogOnly) {
  if (!catalogOnly) return matchIndex;
  for (let index = matchIndex - 1; index >= 0; index--) {
    if (!tracks[index].library) return index + 1;
  }
  return 0;
}

// src/detect.ts
function detectPlays(current, previous, _elapsedSeconds = 180, prevState = {}) {
  if (previous.length === 0) {
    const plays = [...current].reverse().map((track) => ({ track, kind: "new" }));
    return {
      plays,
      newState: { stationaryIdle: false, handledCount: 1, position0ElapsedSec: 0 }
    };
  }
  const k = findShift(current, previous);
  if (k !== null && k > 0) {
    const newPlays = [];
    for (let i = 0; i < k; i++) {
      newPlays.push({ track: current[i], kind: "new" });
    }
    return {
      plays: newPlays.reverse(),
      newState: { stationaryIdle: false, handledCount: 1, position0ElapsedSec: 0 }
    };
  }
  if (current.length >= 2 && previous.length >= 2 && current[0].id === previous[0].id) {
    const curTail = current.slice(1);
    const prevTail = previous.slice(1);
    const tailShift = findShift(curTail, prevTail);
    if (tailShift !== null && tailShift > 0) {
      const interimPlays = [];
      for (let i = 0; i < tailShift; i++) {
        interimPlays.push({ track: curTail[i], kind: "top-rebound" });
      }
      interimPlays.push({ track: current[0], kind: "top-rebound" });
      return {
        plays: interimPlays.reverse(),
        newState: { stationaryIdle: false, handledCount: (prevState.handledCount ?? 1) + 1, position0ElapsedSec: 0 }
      };
    }
  }
  if (current.length > 0 && previous.length > 0 && current[0].id === previous[0].id) {
    return {
      plays: [],
      newState: {
        stationaryIdle: true,
        handledCount: prevState.handledCount ?? 1,
        position0ElapsedSec: 0
      }
    };
  }
  const fallback = fallbackDetect(current, previous);
  return {
    plays: fallback,
    newState: { stationaryIdle: false, handledCount: 1, position0ElapsedSec: 0 }
  };
}
function findShift(current, previous) {
  const curLen = current.length;
  const prevLen = previous.length;
  for (let k = 0; k < curLen; k++) {
    const suffixLen = curLen - k;
    if (suffixLen > prevLen) continue;
    let match = true;
    for (let i = 0; i < suffixLen; i++) {
      if (current[k + i].id !== previous[i].id) {
        match = false;
        break;
      }
    }
    if (match) return k;
  }
  return null;
}
function fallbackDetect(current, previous) {
  const prevIndex = /* @__PURE__ */ new Map();
  for (let i = 0; i < previous.length; i++) {
    if (!prevIndex.has(previous[i].id)) {
      prevIndex.set(previous[i].id, i);
    }
  }
  const detected = [];
  for (let newIdx = 0; newIdx < current.length; newIdx++) {
    const track = current[newIdx];
    const oldIdx = prevIndex.get(track.id);
    if (oldIdx === void 0) {
      detected.push({ track, kind: "new" });
      continue;
    }
    let newAbove = 0;
    for (let i = 0; i < newIdx; i++) {
      if (!prevIndex.has(current[i].id)) newAbove++;
    }
    if (newIdx < oldIdx + newAbove) {
      detected.push({ track, kind: "repeat" });
    } else {
      break;
    }
  }
  return detected.reverse();
}

// src/timestamps.ts
var DEFAULT_DURATION_MS = 18e4;
var HEAD_OFFSET_SECONDS = 10;
function assignTimestamps(plays, runTime, lastRunTime) {
  if (plays.length === 0) return plays;
  const floor = lastRunTime ?? new Date(runTime.getTime() - 6 * 60 * 60 * 1e3);
  const windowSeconds = Math.max(
    1,
    (runTime.getTime() - floor.getTime()) / 1e3 - HEAD_OFFSET_SECONDS
  );
  const totalDurationSeconds = plays.reduce(
    (sum, p) => sum + (p.track.duration_ms || DEFAULT_DURATION_MS) / 1e3,
    0
  );
  const scale = totalDurationSeconds > windowSeconds ? windowSeconds / totalDurationSeconds : 1;
  let cumulative = HEAD_OFFSET_SECONDS;
  const reversed = [];
  for (let i = plays.length - 1; i >= 0; i--) {
    const play = plays[i];
    const durationSeconds = (play.track.duration_ms || DEFAULT_DURATION_MS) / 1e3 * scale;
    const timestamp = new Date(
      runTime.getTime() - (cumulative + durationSeconds) * 1e3
    );
    cumulative += durationSeconds;
    reversed.push({ ...play, timestamp });
  }
  return reversed.reverse();
}

// src/md5.ts
function cmn(q, a, b, x, s, t) {
  a = (a + q | 0) + (x + t | 0) | 0;
  return (a << s | a >>> 32 - s) + b | 0;
}
function ff(a, b, c, d, x, s, t) {
  return cmn(b & c | ~b & d, a, b, x, s, t);
}
function gg(a, b, c, d, x, s, t) {
  return cmn(b & d | c & ~d, a, b, x, s, t);
}
function hh(a, b, c, d, x, s, t) {
  return cmn(b ^ c ^ d, a, b, x, s, t);
}
function ii(a, b, c, d, x, s, t) {
  return cmn(c ^ (b | ~d), a, b, x, s, t);
}
function md5cycle(x, k) {
  let [a, b, c, d] = x;
  a = ff(a, b, c, d, k[0], 7, -680876936);
  d = ff(d, a, b, c, k[1], 12, -389564586);
  c = ff(c, d, a, b, k[2], 17, 606105819);
  b = ff(b, c, d, a, k[3], 22, -1044525330);
  a = ff(a, b, c, d, k[4], 7, -176418897);
  d = ff(d, a, b, c, k[5], 12, 1200080426);
  c = ff(c, d, a, b, k[6], 17, -1473231341);
  b = ff(b, c, d, a, k[7], 22, -45705983);
  a = ff(a, b, c, d, k[8], 7, 1770035416);
  d = ff(d, a, b, c, k[9], 12, -1958414417);
  c = ff(c, d, a, b, k[10], 17, -42063);
  b = ff(b, c, d, a, k[11], 22, -1990404162);
  a = ff(a, b, c, d, k[12], 7, 1804603682);
  d = ff(d, a, b, c, k[13], 12, -40341101);
  c = ff(c, d, a, b, k[14], 17, -1502002290);
  b = ff(b, c, d, a, k[15], 22, 1236535329);
  a = gg(a, b, c, d, k[1], 5, -165796510);
  d = gg(d, a, b, c, k[6], 9, -1069501632);
  c = gg(c, d, a, b, k[11], 14, 643717713);
  b = gg(b, c, d, a, k[0], 20, -373897302);
  a = gg(a, b, c, d, k[5], 5, -701558691);
  d = gg(d, a, b, c, k[10], 9, 38016083);
  c = gg(c, d, a, b, k[15], 14, -660478335);
  b = gg(b, c, d, a, k[4], 20, -405537848);
  a = gg(a, b, c, d, k[9], 5, 568446438);
  d = gg(d, a, b, c, k[14], 9, -1019803690);
  c = gg(c, d, a, b, k[3], 14, -187363961);
  b = gg(b, c, d, a, k[8], 20, 1163531501);
  a = gg(a, b, c, d, k[13], 5, -1444681467);
  d = gg(d, a, b, c, k[2], 9, -51403784);
  c = gg(c, d, a, b, k[7], 14, 1735328473);
  b = gg(b, c, d, a, k[12], 20, -1926607734);
  a = hh(a, b, c, d, k[5], 4, -378558);
  d = hh(d, a, b, c, k[8], 11, -2022574463);
  c = hh(c, d, a, b, k[11], 16, 1839030562);
  b = hh(b, c, d, a, k[14], 23, -35309556);
  a = hh(a, b, c, d, k[1], 4, -1530992060);
  d = hh(d, a, b, c, k[4], 11, 1272893353);
  c = hh(c, d, a, b, k[7], 16, -155497632);
  b = hh(b, c, d, a, k[10], 23, -1094730640);
  a = hh(a, b, c, d, k[13], 4, 681279174);
  d = hh(d, a, b, c, k[0], 11, -358537222);
  c = hh(c, d, a, b, k[3], 16, -722521979);
  b = hh(b, c, d, a, k[6], 23, 76029189);
  a = hh(a, b, c, d, k[9], 4, -640364487);
  d = hh(d, a, b, c, k[12], 11, -421815835);
  c = hh(c, d, a, b, k[15], 16, 530742520);
  b = hh(b, c, d, a, k[2], 23, -995338651);
  a = ii(a, b, c, d, k[0], 6, -198630844);
  d = ii(d, a, b, c, k[7], 10, 1126891415);
  c = ii(c, d, a, b, k[14], 15, -1416354905);
  b = ii(b, c, d, a, k[5], 21, -57434055);
  a = ii(a, b, c, d, k[12], 6, 1700485571);
  d = ii(d, a, b, c, k[3], 10, -1894986606);
  c = ii(c, d, a, b, k[10], 15, -1051523);
  b = ii(b, c, d, a, k[1], 21, -2054922799);
  a = ii(a, b, c, d, k[8], 6, 1873313359);
  d = ii(d, a, b, c, k[15], 10, -30611744);
  c = ii(c, d, a, b, k[6], 15, -1560198380);
  b = ii(b, c, d, a, k[13], 21, 1309151649);
  a = ii(a, b, c, d, k[4], 6, -145523070);
  d = ii(d, a, b, c, k[11], 10, -1120210379);
  c = ii(c, d, a, b, k[2], 15, 718787259);
  b = ii(b, c, d, a, k[9], 21, -343485551);
  x[0] = x[0] + a | 0;
  x[1] = x[1] + b | 0;
  x[2] = x[2] + c | 0;
  x[3] = x[3] + d | 0;
}
function md51(bytes) {
  const n = bytes.length;
  const state = [1732584193, -271733879, -1732584194, 271733878];
  let i;
  const tail = new Array(16);
  for (i = 64; i <= n; i += 64) {
    md5blk(bytes, i - 64, tail);
    md5cycle(state, tail);
  }
  const bufLen = n - (i - 64);
  for (let j = 0; j < 16; j++) tail[j] = 0;
  for (let j = 0; j < bufLen; j++) {
    tail[j >> 2] |= bytes[i - 64 + j] << (j % 4 << 3);
  }
  tail[bufLen >> 2] |= 128 << (bufLen % 4 << 3);
  if (bufLen > 55) {
    md5cycle(state, tail);
    for (let j = 0; j < 16; j++) tail[j] = 0;
  }
  tail[14] = n * 8;
  md5cycle(state, tail);
  return state;
}
function md5blk(bytes, offset, out) {
  for (let i = 0; i < 16; i++) {
    const j = offset + i * 4;
    out[i] = bytes[j] | bytes[j + 1] << 8 | bytes[j + 2] << 16 | bytes[j + 3] << 24;
  }
}
function rhex(n) {
  const hex = "0123456789abcdef";
  let s = "";
  for (let j = 0; j < 4; j++) {
    s += hex[n >> j * 8 + 4 & 15] + hex[n >> j * 8 & 15];
  }
  return s;
}
function md5(text) {
  const bytes = new TextEncoder().encode(text);
  const state = md51(bytes);
  return state.map(rhex).join("");
}

// src/lastfm.ts
var API_URL = "https://ws.audioscrobbler.com/2.0/";
var LASTFM_BATCH_SIZE = 50;
function signParams(params, sharedSecret) {
  const sigString = Object.keys(params).filter((k) => k !== "format" && k !== "callback").sort().map((k) => `${k}${params[k]}`).join("") + sharedSecret;
  return md5(sigString);
}
async function scrobbleBatch(plays, apiKey, sharedSecret, sessionKey) {
  const result = { accepted: 0, acceptedIndexes: [], failedIndexes: [], ignored: 0, errors: 0 };
  if (plays.length === 0) return result;
  for (let chunkStart = 0; chunkStart < plays.length; chunkStart += LASTFM_BATCH_SIZE) {
    const chunk = plays.slice(chunkStart, chunkStart + LASTFM_BATCH_SIZE);
    const params = {
      method: "track.scrobble",
      api_key: apiKey,
      sk: sessionKey
    };
    const submittedIndexes = [];
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
        play.timestamp.getTime() / 1e3
      ).toString();
      if (play.album) params[`album[${position}]`] = play.album;
      if (play.duration_ms) {
        params[`duration[${position}]`] = Math.floor(play.duration_ms / 1e3).toString();
      }
    });
    if (submittedIndexes.length === 0) continue;
    params.api_sig = signParams(params, sharedSecret);
    params.format = "json";
    const body = new URLSearchParams(params);
    let response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
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
    let json2;
    try {
      json2 = await response.json();
    } catch {
      console.error("Last.fm non-JSON response");
      result.errors += submittedIndexes.length;
      result.failedIndexes.push(...submittedIndexes);
      continue;
    }
    const attr = json2?.scrobbles?.["@attr"];
    const accepted = Number(attr?.accepted);
    const ignored = Number(attr?.ignored);
    if (!Number.isInteger(accepted) || !Number.isInteger(ignored) || accepted < 0 || ignored < 0 || accepted + ignored !== submittedIndexes.length) {
      console.error("Last.fm returned an unexpected scrobble receipt", json2?.error);
      result.errors += submittedIndexes.length;
      result.failedIndexes.push(...submittedIndexes);
      continue;
    }
    result.accepted += accepted;
    result.ignored += ignored;
    const entries = json2.scrobbles.scrobble;
    const scrobbles = Array.isArray(entries) ? entries : entries ? [entries] : [];
    if (ignored === 0) {
      result.acceptedIndexes.push(...submittedIndexes);
    } else if (scrobbles.length === submittedIndexes.length) {
      const confirmedIndexes = submittedIndexes.filter(
        (_, index) => String(scrobbles[index]?.ignoredMessage?.code) === "0"
      );
      if (confirmedIndexes.length === accepted) result.acceptedIndexes.push(...confirmedIndexes);
    }
    if (ignored > 0) {
      for (const s of scrobbles) {
        const msg = s?.ignoredMessage ?? {};
        if (msg.code && msg.code !== "0") {
          console.warn(
            `  ignored: ${s?.track?.["#text"] ?? "?"} \u2014 ${msg["#text"] ?? "?"} (code ${msg.code})`
          );
        }
      }
    }
  }
  return result;
}

// src/listenbrainz.ts
var API_URL2 = "https://api.listenbrainz.org/1/submit-listens";
var BATCH_SIZE = 100;
async function submitBatch(plays, userToken) {
  const result = { accepted: 0, errors: 0 };
  if (plays.length === 0) return result;
  const entries = plays.filter((p) => p.artist && p.track).map((p) => ({
    listened_at: Math.floor(p.timestamp.getTime() / 1e3),
    track_metadata: {
      artist_name: p.artist,
      track_name: p.track,
      release_name: p.album || void 0,
      additional_info: {
        submission_client: "aScrobble-scrobbler",
        submission_client_version: "0.2.0",
        music_service: "music.apple.com",
        duration_ms: p.duration_ms || void 0
      }
    }
  }));
  for (let chunkStart = 0; chunkStart < entries.length; chunkStart += BATCH_SIZE) {
    const chunk = entries.slice(chunkStart, chunkStart + BATCH_SIZE);
    const body = {
      listen_type: chunk.length === 1 ? "single" : "import",
      payload: chunk
    };
    let response;
    try {
      response = await fetch(API_URL2, {
        method: "POST",
        headers: {
          Authorization: `Token ${userToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      console.error("ListenBrainz HTTP error:", e);
      result.errors += chunk.length;
      continue;
    }
    if (response.ok) {
      result.accepted += chunk.length;
    } else if (response.status === 401) {
      console.error(
        "ListenBrainz 401 \u2014 LISTENBRAINZ_TOKEN invalid. Get a new one at https://listenbrainz.org/profile/"
      );
      result.errors += chunk.length;
      break;
    } else {
      const text = await response.text();
      console.error(`ListenBrainz ${response.status}: ${text.slice(0, 300)}`);
      result.errors += chunk.length;
    }
  }
  return result;
}

// src/notify.ts
async function notifyTokenExpired(webhookUrl) {
  if (!webhookUrl) return;
  await postMessage(
    webhookUrl,
    "\u{1F534} **aScrobble**: Apple Music tokens expired (401).\nRe-open the aScrobble desktop app to re-authenticate with Apple Music."
  );
}
async function notifyMilestone(webhookUrl, total) {
  if (!webhookUrl) return;
  await postMessage(
    webhookUrl,
    `\u{1F3B5} **aScrobble**: hit **${total.toLocaleString()}** total scrobbles`
  );
}
async function notifySummary(webhookUrl, accepted, repeatCount, ignored) {
  if (!webhookUrl || accepted === 0) return;
  const parts = [`**${accepted}** scrobbled`];
  if (repeatCount > 0) parts.push(`${repeatCount} repeat plays`);
  if (ignored > 0) parts.push(`${ignored} ignored`);
  await postMessage(webhookUrl, "\u{1F3B5} " + parts.join(" \xB7 "));
}
async function postMessage(webhookUrl, message) {
  try {
    const r = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Discord uses "content", Slack accepts "text"; sending both covers both.
      body: JSON.stringify({ content: message, text: message })
    });
    if (!r.ok) {
      const body = await r.text();
      console.warn(`Notify webhook ${r.status}: ${body.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn("Notify webhook error:", e);
  }
}

// src/ledger.ts
var LEDGER_KEY = "ledger:v1";
function addLogEntry(ledger, step, details, level = "info") {
  if (!ledger.log_entries) ledger.log_entries = [];
  ledger.log_entries.unshift({
    timestamp_iso: (/* @__PURE__ */ new Date()).toISOString(),
    step,
    details,
    level
  });
  ledger.log_entries = ledger.log_entries.slice(0, 50);
}
var MAX_RECENT_SCROBBLES = 1e3;
var DEFAULT_LEDGER = {
  version: 1,
  last_run_iso: null,
  previous_recent: [],
  recent_scrobbles: [],
  stats: {
    total_scrobbled: 0,
    total_runs: 0,
    total_errors: 0,
    last_success_iso: null,
    last_error_iso: null,
    last_error_message: null
  }
};
var MEMORY_LEDGER_CACHE = null;
async function loadLedger(kv) {
  try {
    const raw = await kv.get(LEDGER_KEY, "json");
    if (raw && typeof raw === "object") {
      const kvLedger = { ...DEFAULT_LEDGER, ...raw };
      if (MEMORY_LEDGER_CACHE && MEMORY_LEDGER_CACHE.last_run_iso) {
        const memoryTime = new Date(MEMORY_LEDGER_CACHE.last_run_iso).getTime();
        const kvTime = kvLedger.last_run_iso ? new Date(kvLedger.last_run_iso).getTime() : 0;
        if (memoryTime >= kvTime) {
          return MEMORY_LEDGER_CACHE;
        }
      }
      MEMORY_LEDGER_CACHE = kvLedger;
      return kvLedger;
    }
  } catch (e) {
    console.warn("Ledger read failed, starting fresh:", e);
  }
  return MEMORY_LEDGER_CACHE ?? { ...DEFAULT_LEDGER };
}
async function saveLedger(kv, ledger) {
  await kv.put(LEDGER_KEY, JSON.stringify(ledger));
  MEMORY_LEDGER_CACHE = ledger;
}
function addRecentScrobbles(ledger, plays) {
  const newEntries = plays.map((p) => ({
    artist: p.track.artist,
    track: p.track.name,
    album: p.track.album,
    timestamp_iso: p.timestamp?.toISOString() ?? (/* @__PURE__ */ new Date()).toISOString(),
    kind: p.kind
  }));
  ledger.recent_scrobbles = [...newEntries, ...ledger.recent_scrobbles].slice(
    0,
    MAX_RECENT_SCROBBLES
  );
}
function parseLastRunTime(ledger) {
  if (!ledger.last_run_iso) return null;
  const d = new Date(ledger.last_run_iso);
  return isNaN(d.getTime()) ? null : d;
}

// src/kv_keys.ts
var KV_KEY_APPLE_DEV_TOKEN = "apple_dev_token";
var KV_KEY_APPLE_USER_TOKEN = "apple_user_token";

// src/scrobbler.ts
var CB_ERROR_THRESHOLD = 5;
var CB_BASE_COOLDOWN_MS = 30 * 60 * 1e3;
var CB_INSTANT_TRIP_ERRORS = /* @__PURE__ */ new Set(["apple_token_expired", "apple_tokens_missing_in_kv"]);
var CB_MAX_COOLDOWN_MS = 2 * 60 * 60 * 1e3;
var HISTORY_GAP_MS = 45 * 60 * 1e3;
var RECOVERY_WINDOW_MS = 13 * 24 * 60 * 60 * 1e3;
var DEDUP_WINDOW_MS = 30 * 1e3;
var DEDUP_MAX_ENTRIES = 200;
function isCircuitOpen(ledger, now) {
  if (!ledger.circuit_open_until_iso) return false;
  return now < new Date(ledger.circuit_open_until_iso).getTime();
}
function openCircuit(ledger, now) {
  const opens = ledger.consecutive_errors ?? CB_ERROR_THRESHOLD;
  const multiplier = Math.pow(2, Math.max(0, Math.floor(opens / CB_ERROR_THRESHOLD) - 1));
  const cooldown = Math.min(CB_BASE_COOLDOWN_MS * multiplier, CB_MAX_COOLDOWN_MS);
  ledger.circuit_open_until_iso = new Date(now + cooldown).toISOString();
  console.warn(
    `Circuit breaker OPEN \u2014 pausing polls for ${Math.round(cooldown / 6e4)} min (consecutive_errors=${ledger.consecutive_errors})`
  );
}
function resetCircuit(ledger) {
  ledger.consecutive_errors = 0;
  ledger.circuit_open_until_iso = void 0;
}
function dedupKey(trackId, bucketMs) {
  const bucket = Math.floor(bucketMs / DEDUP_WINDOW_MS);
  return `${trackId}:${bucket}`;
}
function pruneDedup(ledger, now) {
  if (!ledger.recent_scrobble_ids) return;
  const cutoff = Math.floor((now - DEDUP_WINDOW_MS) / DEDUP_WINDOW_MS);
  ledger.recent_scrobble_ids = ledger.recent_scrobble_ids.filter((k) => {
    const bucket = parseInt(k.split(":")[1] ?? "0", 10);
    return bucket > cutoff;
  }).slice(0, DEDUP_MAX_ENTRIES);
}
function isDuplicate(ledger, trackId, now) {
  if (!ledger.recent_scrobble_ids) return false;
  return ledger.recent_scrobble_ids.includes(dedupKey(trackId, now));
}
function recordScrobbled(ledger, trackId, now) {
  if (!ledger.recent_scrobble_ids) ledger.recent_scrobble_ids = [];
  ledger.recent_scrobble_ids.push(dedupKey(trackId, now));
}
function hasAppleHistoryError(ledger) {
  const error = ledger.stats.last_error_message ?? "";
  return CB_INSTANT_TRIP_ERRORS.has(error) || error.startsWith("apple_api_error:");
}
function findHistoryCheckpoint(ledger, startedAt) {
  const interrupted = ledger.apple_history_interrupted !== false && (ledger.apple_history_interrupted === true || hasAppleHistoryError(ledger));
  const lastPoll = Date.parse(ledger.snapshot_poll_iso ?? ledger.last_run_iso ?? "");
  if (ledger.previous_recent.length > 0) {
    if (!interrupted && !(startedAt - lastPoll > HISTORY_GAP_MS)) return null;
    const checkpointTime2 = Date.parse(ledger.snapshot_poll_iso ?? ledger.stats.last_success_iso ?? "");
    return {
      keys: ledger.previous_recent.map((track) => track.id),
      identity: "apple-id",
      capturedAt: Number.isFinite(checkpointTime2) ? new Date(checkpointTime2) : null,
      catalogOnly: !ledger.library_history_since_iso
    };
  }
  if (!interrupted || ledger.recent_scrobbles.length === 0) return null;
  const recent = ledger.recent_scrobbles.filter((play) => play.artist && play.track).sort((left, right) => Date.parse(right.timestamp_iso) - Date.parse(left.timestamp_iso)).slice(0, 12);
  const checkpointTime = Date.parse(recent[0]?.timestamp_iso ?? "");
  const libraryHistorySince = Date.parse(ledger.library_history_since_iso ?? "");
  return {
    keys: recent.map((play) => historyTrackKey(play.artist, play.track)),
    identity: "track-metadata",
    capturedAt: Number.isFinite(checkpointTime) ? new Date(checkpointTime) : null,
    // Scrobbles from before library plays were read can't be matched against them.
    catalogOnly: !Number.isFinite(libraryHistorySince) || recent.slice(0, 5).some((play) => Date.parse(play.timestamp_iso) < libraryHistorySince)
  };
}
function noPlays(startedAt) {
  return {
    ok: true,
    detected: 0,
    accepted: 0,
    ignored: 0,
    errors: 0,
    repeat_count: 0,
    elapsed_ms: Date.now() - startedAt
  };
}
function toPayload(play) {
  return {
    artist: play.track.artist,
    track: play.track.name,
    album: play.track.album,
    timestamp: play.timestamp,
    duration_ms: play.track.duration_ms
  };
}
async function stageHistoryRecovery(env, ledger, recovery, checkpoint, runTime, startedAt) {
  const plays = (recovery.missing ?? []).filter((track) => track.artist && track.name).reverse().map((track) => ({ track, kind: "new" }));
  ledger.previous_recent = recovery.snapshot;
  ledger.library_history_since_iso ??= runTime.toISOString();
  ledger.snapshot_poll_iso = runTime.toISOString();
  ledger.stats.last_success_iso = runTime.toISOString();
  ledger.last_save_iso = runTime.toISOString();
  ledger.apple_history_interrupted = void 0;
  ledger.stationary_idle = false;
  ledger.handled_count = 1;
  ledger.position0_elapsed_sec = 0;
  if (recovery.missing === null) {
    ledger.history_recovery_notice = `Couldn\u2019t match the saved Apple Music history after checking ${recovery.checked} tracks (${recovery.reason}). Normal scrobbling has resumed.`;
    addLogEntry(ledger, "history_recovery_unmatched", ledger.history_recovery_notice, "warn");
  } else if (plays.length === 0) {
    ledger.history_recovery_notice = "Matched the saved Apple Music history. No new plays were found.";
    addLogEntry(ledger, "history_recovery_complete", ledger.history_recovery_notice, "info");
  } else if (!checkpoint.capturedAt || startedAt - checkpoint.capturedAt.getTime() >= RECOVERY_WINDOW_MS) {
    ledger.history_recovery_notice = `Found ${plays.length} newer Apple Music entries. Their play dates are unavailable, and the checkpoint is outside Last.fm\u2019s backfill window or lacks a date. Normal scrobbling has resumed.`;
    addLogEntry(ledger, "history_recovery_preview", ledger.history_recovery_notice, "warn");
  } else if (checkpoint.identity === "track-metadata") {
    ledger.history_recovery_notice = `Found ${plays.length} newer Apple Music entries by matching the scrobble log. The original Apple Music checkpoint is missing. Normal scrobbling has resumed.`;
    addLogEntry(ledger, "history_recovery_preview", ledger.history_recovery_notice, "warn");
  } else {
    const timestamped = assignTimestamps(plays, runTime, checkpoint.capturedAt);
    ledger.pending_history_recovery = {
      plays: timestamped.map((play) => ({
        track: play.track,
        timestamp_iso: play.timestamp.toISOString()
      })),
      source: "recovery",
      total: timestamped.length,
      accepted: 0,
      ignored: 0
    };
    ledger.history_recovery_notice = `Matched ${recovery.matchLength} consecutive tracks in Apple Music. Queued ${timestamped.length} plays with estimated timestamps.`;
    addLogEntry(ledger, "history_recovery_queued", ledger.history_recovery_notice, "success");
  }
  await saveLedger(env.ASCROBBLE_STATE, ledger);
  return { ...noPlays(startedAt), detected: plays.length };
}
async function submitHistoryRecovery(env, ledger, pending, runTime, startedAt) {
  const batch = pending.plays.slice(0, LASTFM_BATCH_SIZE);
  const retry = pending.source === "retry";
  const plays = batch.map((play) => ({
    track: play.track,
    kind: play.kind ?? "new",
    timestamp: new Date(play.timestamp_iso)
  }));
  const payload = plays.map(toPayload);
  const result = await scrobbleBatch(payload, env.LASTFM_API_KEY, env.LASTFM_SHARED_SECRET, env.LASTFM_SESSION_KEY);
  if (result.errors > 0) {
    ledger.history_recovery_notice = retry ? `Last.fm still hasn\u2019t confirmed ${pending.plays.length} queued plays. They\u2019ll be retried.` : `Last.fm didn\u2019t confirm the latest recovery batch. ${pending.plays.length} plays are still queued for retry.`;
    addLogEntry(ledger, "history_recovery_retry", ledger.history_recovery_notice, "warn");
    return failRun(env, ledger, runTime, startedAt, "history_recovery_submit_failed");
  }
  if (env.LISTENBRAINZ_TOKEN && !retry) {
    const listenBrainz = await submitBatch(payload, env.LISTENBRAINZ_TOKEN);
    if (listenBrainz.errors > 0) {
      addLogEntry(ledger, "listenbrainz_recovery_error", `ListenBrainz recovery batch had ${listenBrainz.errors} errors.`, "warn");
    }
  }
  pending.plays = pending.plays.slice(batch.length);
  pending.accepted += result.accepted;
  pending.ignored += result.ignored;
  const oldTotal = ledger.stats.total_scrobbled;
  ledger.stats.total_scrobbled += result.accepted;
  addRecentScrobbles(ledger, result.acceptedIndexes.map((index) => plays[index]));
  resetCircuit(ledger);
  ledger.stats.last_error_message = null;
  ledger.stats.last_error_iso = null;
  ledger.last_save_iso = runTime.toISOString();
  const count = `${pending.accepted} of ${pending.total} plays added to Last.fm`;
  const ignored = pending.ignored > 0 ? `, ${pending.ignored} ignored` : "";
  if (pending.plays.length > 0) {
    ledger.history_recovery_notice = retry ? `Resending plays Last.fm missed. ${count}, ${pending.plays.length} still queued.` : `Recovering Apple Music history. ${count}, ${pending.plays.length} still queued.`;
  } else {
    ledger.pending_history_recovery = void 0;
    ledger.history_recovery_notice = retry ? `Resent plays Last.fm missed. ${count}${ignored}.` : `Apple Music recovery finished. ${count}${ignored}. Timestamps are estimated.`;
  }
  addLogEntry(ledger, "history_recovery_batch", ledger.history_recovery_notice, "success");
  await saveLedger(env.ASCROBBLE_STATE, ledger);
  await notifySummary(env.NOTIFY_WEBHOOK_URL, result.accepted, 0, result.ignored);
  if (Math.floor(oldTotal / 1e3) < Math.floor(ledger.stats.total_scrobbled / 1e3)) {
    await notifyMilestone(env.NOTIFY_WEBHOOK_URL, Math.floor(ledger.stats.total_scrobbled / 1e3) * 1e3);
  }
  return { ...noPlays(startedAt), detected: batch.length, accepted: result.accepted, ignored: result.ignored };
}
async function failRun(env, ledger, runTime, startedAt, errorMessage, instantTrip = false) {
  ledger.stats.total_errors += 1;
  ledger.stats.last_error_iso = runTime.toISOString();
  ledger.stats.last_error_message = errorMessage;
  ledger.consecutive_errors = (ledger.consecutive_errors ?? 0) + 1;
  const shouldOpen = instantTrip || CB_INSTANT_TRIP_ERRORS.has(errorMessage) || ledger.consecutive_errors >= CB_ERROR_THRESHOLD;
  if (shouldOpen && !isCircuitOpen(ledger, startedAt)) {
    openCircuit(ledger, startedAt);
  }
  await saveLedger(env.ASCROBBLE_STATE, ledger);
  return {
    ok: false,
    detected: 0,
    accepted: 0,
    ignored: 0,
    errors: 1,
    repeat_count: 0,
    elapsed_ms: Date.now() - startedAt,
    error_message: errorMessage,
    circuit_open: isCircuitOpen(ledger, startedAt)
  };
}
async function pollAndScrobble(env, isManual = false) {
  const startedAt = Date.now();
  const runTime = new Date(startedAt);
  const loadedLedger = await loadLedger(env.ASCROBBLE_STATE);
  const recoveryCheckpoint = findHistoryCheckpoint(loadedLedger, startedAt);
  const recovering = recoveryCheckpoint !== null;
  const recoveryActive = recovering || loadedLedger.pending_history_recovery !== void 0;
  if (recoveryActive && isManual) {
    if (isCircuitOpen(loadedLedger, startedAt)) {
      const ledger2 = structuredClone(loadedLedger);
      ledger2.apple_history_interrupted ||= recovering;
      resetCircuit(ledger2);
      await saveLedger(env.ASCROBBLE_STATE, ledger2);
    }
    return { ...noPlays(startedAt), recovery_deferred: true };
  }
  const ledger = recoveryActive ? structuredClone(loadedLedger) : loadedLedger;
  const lastRunTime = parseLastRunTime(ledger);
  ledger.stats.total_runs += 1;
  ledger.last_run_iso = runTime.toISOString();
  addLogEntry(ledger, "poll_start", `Run #${ledger.stats.total_runs} started${isManual ? " (manual)" : ""} \xB7 elapsed since last: ${lastRunTime ? Math.round((startedAt - lastRunTime.getTime()) / 1e3) + "s" : "first run"}`, "info");
  if (isManual) {
    resetCircuit(ledger);
    addLogEntry(ledger, "circuit_reset", "Manual trigger \u2014 circuit breaker reset", "info");
  }
  if (isCircuitOpen(ledger, startedAt)) {
    const until = new Date(ledger.circuit_open_until_iso);
    const minLeft = Math.round((until.getTime() - startedAt) / 6e4);
    console.warn(
      `Circuit breaker is OPEN \u2014 skipping poll. Will retry after ${until.toISOString()} (${minLeft} min remaining)`
    );
    addLogEntry(ledger, "circuit_open", `Circuit open \u2014 skipping poll for ${minLeft}min more`, "error");
    ledger.last_run_iso = runTime.toISOString();
    const lastSaveTime = ledger.last_save_iso ? new Date(ledger.last_save_iso).getTime() : 0;
    if (startedAt - lastSaveTime > 15 * 60 * 1e3) {
      ledger.last_save_iso = runTime.toISOString();
      await saveLedger(env.ASCROBBLE_STATE, ledger);
    }
    return {
      ok: false,
      detected: 0,
      accepted: 0,
      ignored: 0,
      errors: 0,
      repeat_count: 0,
      elapsed_ms: Date.now() - startedAt,
      circuit_open: true
    };
  }
  if (ledger.pending_history_recovery) {
    return submitHistoryRecovery(env, ledger, ledger.pending_history_recovery, runTime, startedAt);
  }
  addLogEntry(ledger, "kv_token_read", "Reading Apple dev + user tokens from Cloudflare KV...", "info");
  const [appleDevToken, appleUserToken] = await Promise.all([
    env.ASCROBBLE_STATE.get(KV_KEY_APPLE_DEV_TOKEN),
    env.ASCROBBLE_STATE.get(KV_KEY_APPLE_USER_TOKEN)
  ]);
  if (!appleDevToken || !appleUserToken) {
    if (ledger.apple_history_interrupted !== false) ledger.apple_history_interrupted = true;
    const msg = "apple_tokens_missing_in_kv";
    console.error(
      `${msg}: expected keys ${KV_KEY_APPLE_DEV_TOKEN} and ${KV_KEY_APPLE_USER_TOKEN}`
    );
    addLogEntry(ledger, "kv_token_missing", "Apple tokens not found in KV \u2014 circuit tripped", "error");
    return failRun(
      env,
      ledger,
      runTime,
      startedAt,
      msg,
      /*instantTrip=*/
      true
    );
  }
  addLogEntry(ledger, "kv_token_ok", "Apple tokens found in KV \u2713", "info");
  addLogEntry(ledger, "apple_fetch_start", "Calling Apple Music /v1/me/recent/played/tracks...", "info");
  let current;
  let recovery;
  try {
    recovery = recoveryCheckpoint ? await fetchRecoveryHistory(appleDevToken, appleUserToken, recoveryCheckpoint) : void 0;
    current = recovery?.snapshot ?? await fetchRecentlyPlayed(appleDevToken, appleUserToken);
    if (current.length === 0 && ledger.previous_recent.length > 0) {
      throw new Error("Apple Music returned an empty history after a saved checkpoint");
    }
  } catch (e) {
    if (ledger.apple_history_interrupted !== false) ledger.apple_history_interrupted = true;
    if (e instanceof TokenExpiredError) {
      console.error("Apple token expired \u2014 tripping circuit breaker");
      addLogEntry(ledger, "apple_token_expired", "Apple Music token returned 401 \u2014 circuit tripped", "error");
      await notifyTokenExpired(env.NOTIFY_WEBHOOK_URL);
      return failRun(
        env,
        ledger,
        runTime,
        startedAt,
        "apple_token_expired",
        /*instantTrip=*/
        true
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Apple API error:", msg);
    addLogEntry(ledger, "apple_fetch_error", `Apple API error: ${msg}`, "error");
    return failRun(env, ledger, runTime, startedAt, `apple_api_error: ${msg}`);
  }
  resetCircuit(ledger);
  ledger.stats.last_error_message = null;
  ledger.stats.last_error_iso = null;
  if (recovery && recoveryCheckpoint) {
    return stageHistoryRecovery(env, ledger, recovery, recoveryCheckpoint, runTime, startedAt);
  }
  console.log(`Apple returned ${current.length} tracks`);
  addLogEntry(ledger, "apple_fetch_success", `Fetched ${current.length} recently played tracks from Apple API`, "info");
  if (ledger.previous_recent.length === 0) {
    console.log(`First run \u2014 snapshotting ${current.length} tracks without scrobbling`);
    addLogEntry(ledger, "bootstrap_snapshot", `Snapshotting ${current.length} tracks on initial run`, "info");
    ledger.previous_recent = current;
    ledger.library_history_since_iso ??= runTime.toISOString();
    ledger.snapshot_poll_iso = runTime.toISOString();
    ledger.apple_history_interrupted = void 0;
    ledger.stats.last_success_iso = runTime.toISOString();
    await saveLedger(env.ASCROBBLE_STATE, ledger);
    return {
      ok: true,
      detected: 0,
      accepted: 0,
      ignored: 0,
      errors: 0,
      repeat_count: 0,
      elapsed_ms: Date.now() - startedAt
    };
  }
  const elapsedSeconds = lastRunTime ? Math.max(0, Math.round((startedAt - lastRunTime.getTime()) / 1e3)) : 180;
  const prevState = {
    stationaryIdle: ledger.stationary_idle ?? false,
    handledCount: ledger.handled_count ?? 1,
    position0ElapsedSec: ledger.position0_elapsed_sec ?? 0
  };
  const upgradingSnapshot = !ledger.library_history_since_iso;
  if (upgradingSnapshot) {
    ledger.library_history_since_iso = runTime.toISOString();
    addLogEntry(ledger, "history_library_enabled", "Now reading plays from your Apple Music library too", "info");
  }
  const comparable = upgradingSnapshot ? current.filter((track) => !track.library) : current;
  const detection = detectPlays(comparable, ledger.previous_recent, elapsedSeconds, prevState);
  const plays = detection.plays;
  ledger.stationary_idle = detection.newState.stationaryIdle;
  ledger.handled_count = detection.newState.handledCount;
  ledger.position0_elapsed_sec = detection.newState.position0ElapsedSec;
  pruneDedup(ledger, startedAt);
  const deduped = plays.filter((p) => {
    const trackId = p.track.id;
    if (!trackId) return true;
    if (isDuplicate(ledger, trackId, startedAt)) {
      console.warn(`Dedup guard: skipping "${p.track.name}" \u2014 already scrobbled in last 30s`);
      addLogEntry(ledger, "dedup_skipped", `Skipping duplicate play "${p.track.name}" within 30s window`, "warn");
      return false;
    }
    return true;
  });
  if (deduped.length === 0) {
    console.log("No new plays");
    ledger.previous_recent = current;
    ledger.snapshot_poll_iso = runTime.toISOString();
    const topTrackName = current[0]?.name ?? "None";
    addLogEntry(ledger, "poll_idle", `Checked ${current.length} Apple tracks \u2014 0 new plays. Latest track in history: "${topTrackName}"`, "info");
    const lastSaveTime = ledger.last_save_iso ? new Date(ledger.last_save_iso).getTime() : 0;
    const shouldSave = upgradingSnapshot || !ledger.last_save_iso || startedAt - lastSaveTime >= 5 * 60 * 1e3;
    if (shouldSave) {
      ledger.last_save_iso = runTime.toISOString();
      await saveLedger(env.ASCROBBLE_STATE, ledger);
    }
    return {
      ok: true,
      detected: 0,
      accepted: 0,
      ignored: 0,
      errors: 0,
      repeat_count: 0,
      elapsed_ms: Date.now() - startedAt
    };
  }
  addLogEntry(ledger, "scrobble_detected", `Detected ${deduped.length} play(s): ${deduped.map((p) => `"${p.track.name}"`).join(", ")}`, "success");
  const dedupDropped = plays.length - deduped.length;
  console.log(`Detected ${deduped.length} play(s) (${dedupDropped} deduped)`);
  const timestamped = assignTimestamps(deduped, runTime, lastRunTime);
  for (const p of timestamped) {
    console.log(
      `  [${p.kind}] ${p.track.artist} \u2014 ${p.track.name} @ ${p.timestamp?.toISOString()}`
    );
  }
  const payload = timestamped.map(toPayload);
  addLogEntry(ledger, "lastfm_submit_start", `Submitting ${payload.length} scrobble(s) to Last.fm...`, "info");
  let lfmResult = await scrobbleBatch(
    payload,
    env.LASTFM_API_KEY,
    env.LASTFM_SHARED_SECRET,
    env.LASTFM_SESSION_KEY
  );
  if (lfmResult.errors > 0 && lfmResult.accepted === 0) {
    console.warn(`Last.fm: all ${lfmResult.errors} tracks failed \u2014 retrying after 1 s`);
    addLogEntry(ledger, "lastfm_submit_retry", `All ${lfmResult.errors} tracks failed \u2014 retrying in 1s...`, "warn");
    await new Promise((r) => setTimeout(r, 1e3));
    lfmResult = await scrobbleBatch(
      payload,
      env.LASTFM_API_KEY,
      env.LASTFM_SHARED_SECRET,
      env.LASTFM_SESSION_KEY
    );
  }
  console.log(
    `Last.fm: ${lfmResult.accepted} accepted, ${lfmResult.ignored} ignored, ${lfmResult.errors} errors`
  );
  addLogEntry(
    ledger,
    "lastfm_submit_done",
    `Last.fm: ${lfmResult.accepted} accepted \xB7 ${lfmResult.ignored} ignored \xB7 ${lfmResult.errors} errors`,
    lfmResult.accepted > 0 ? "success" : lfmResult.errors > 0 ? "error" : "info"
  );
  if (lfmResult.errors > 0 && lfmResult.accepted === 0) {
    const msg = `lastfm_submit_failed (${lfmResult.errors} errors)`;
    console.error(msg);
    ledger.consecutive_errors = (ledger.consecutive_errors ?? 0) + 1;
    addLogEntry(ledger, "circuit_error_count", `Consecutive errors: ${ledger.consecutive_errors}/${5}`, "warn");
    if (ledger.consecutive_errors >= CB_ERROR_THRESHOLD) {
      openCircuit(ledger, startedAt);
      addLogEntry(ledger, "circuit_tripped", `Circuit breaker tripped after ${CB_ERROR_THRESHOLD} consecutive errors`, "error");
    }
  }
  const failedPlays = lfmResult.failedIndexes.map((index) => timestamped[index]);
  if (failedPlays.length > 0) {
    ledger.pending_history_recovery = {
      plays: failedPlays.map((play) => ({
        track: play.track,
        timestamp_iso: play.timestamp.toISOString(),
        kind: play.kind
      })),
      source: "retry",
      total: failedPlays.length,
      accepted: 0,
      ignored: 0
    };
    ledger.history_recovery_notice = `Last.fm didn\u2019t confirm ${failedPlays.length} play(s). They\u2019re queued and will be resent.`;
    addLogEntry(ledger, "lastfm_retry_queued", ledger.history_recovery_notice, "warn");
  }
  if (env.LISTENBRAINZ_TOKEN) {
    addLogEntry(ledger, "listenbrainz_submit", "Also submitting to ListenBrainz...", "info");
    const lbResult = await submitBatch(payload, env.LISTENBRAINZ_TOKEN);
    console.log(
      `ListenBrainz: ${lbResult.accepted} accepted, ${lbResult.errors} errors`
    );
    addLogEntry(ledger, "listenbrainz_done", `ListenBrainz: ${lbResult.accepted} accepted \xB7 ${lbResult.errors} errors`, lbResult.accepted > 0 ? "success" : "info");
  }
  const repeatCount = timestamped.filter((p) => p.kind === "repeat").length;
  await notifySummary(
    env.NOTIFY_WEBHOOK_URL,
    lfmResult.accepted,
    repeatCount,
    lfmResult.ignored
  );
  const oldTotal = ledger.stats.total_scrobbled;
  const newTotal = oldTotal + lfmResult.accepted;
  if (Math.floor(oldTotal / 1e3) < Math.floor(newTotal / 1e3)) {
    const milestone = Math.floor(newTotal / 1e3) * 1e3;
    await notifyMilestone(env.NOTIFY_WEBHOOK_URL, milestone);
  }
  for (const p of timestamped) {
    const trackId = p.track.id;
    if (trackId) recordScrobbled(ledger, trackId, startedAt);
  }
  addRecentScrobbles(ledger, lfmResult.acceptedIndexes.map((index) => timestamped[index]));
  ledger.previous_recent = current;
  ledger.snapshot_poll_iso = runTime.toISOString();
  ledger.stats.total_scrobbled = newTotal;
  ledger.stats.last_success_iso = runTime.toISOString();
  if (lfmResult.accepted > 0) {
    ledger.stats.last_error_message = null;
    ledger.stats.last_error_iso = null;
  }
  ledger.last_save_iso = runTime.toISOString();
  addLogEntry(
    ledger,
    "poll_complete",
    `Run done in ${Date.now() - startedAt}ms \u2014 ${lfmResult.accepted} scrobbled, ${newTotal} total. Saving KV.`,
    "success"
  );
  await saveLedger(env.ASCROBBLE_STATE, ledger);
  return {
    ok: lfmResult.errors === 0,
    detected: deduped.length,
    accepted: lfmResult.accepted,
    ignored: lfmResult.ignored,
    errors: lfmResult.errors,
    error_message: lfmResult.errors > 0 ? "Last.fm could not confirm every play in the poll." : void 0,
    repeat_count: repeatCount,
    elapsed_ms: Date.now() - startedAt
  };
}
async function getStatus(env) {
  return loadLedger(env.ASCROBBLE_STATE);
}
async function resetLedgerStats(env) {
  const ledger = await loadLedger(env.ASCROBBLE_STATE);
  if (ledger.apple_history_interrupted !== false && hasAppleHistoryError(ledger)) {
    ledger.apple_history_interrupted = true;
  }
  ledger.stats.total_errors = 0;
  ledger.stats.last_error_message = null;
  ledger.stats.last_error_iso = null;
  ledger.consecutive_errors = 0;
  ledger.circuit_open_until_iso = void 0;
  await saveLedger(env.ASCROBBLE_STATE, ledger);
  return ledger;
}
async function updateTokens(env, appleDevToken, appleUserToken) {
  const updated = [];
  if (appleDevToken) {
    await env.ASCROBBLE_STATE.put(KV_KEY_APPLE_DEV_TOKEN, appleDevToken);
    updated.push(KV_KEY_APPLE_DEV_TOKEN);
  }
  if (appleUserToken) {
    await env.ASCROBBLE_STATE.put(KV_KEY_APPLE_USER_TOKEN, appleUserToken);
    updated.push(KV_KEY_APPLE_USER_TOKEN);
  }
  const ledger = await loadLedger(env.ASCROBBLE_STATE);
  if (ledger.apple_history_interrupted !== false && hasAppleHistoryError(ledger)) {
    ledger.apple_history_interrupted = true;
  }
  resetCircuit(ledger);
  ledger.stats.last_error_message = null;
  ledger.stats.last_error_iso = null;
  addLogEntry(ledger, "tokens_updated", `Updated KV tokens: ${updated.join(", ")}`, "success");
  await saveLedger(env.ASCROBBLE_STATE, ledger);
  return { ok: true, updated };
}
async function clearCache(env, opts = {}) {
  const ledger = await loadLedger(env.ASCROBBLE_STATE);
  if (opts.clear_snapshot !== false) {
    ledger.previous_recent = [];
    ledger.snapshot_poll_iso = void 0;
    ledger.apple_history_interrupted = false;
    ledger.pending_history_recovery = void 0;
    ledger.history_recovery_notice = void 0;
    ledger.stationary_idle = false;
    ledger.handled_count = 0;
    ledger.position0_elapsed_sec = 0;
  }
  if (opts.clear_dedup !== false) {
    ledger.recent_scrobble_ids = [];
  }
  if (opts.clear_logs) {
    ledger.log_entries = [];
  }
  if (opts.clear_recent) {
    ledger.recent_scrobbles = [];
  }
  if (opts.clear_circuit !== false) {
    if (ledger.previous_recent.length > 0 && hasAppleHistoryError(ledger)) {
      ledger.apple_history_interrupted = true;
    }
    resetCircuit(ledger);
    ledger.stats.last_error_message = null;
    ledger.stats.last_error_iso = null;
  }
  addLogEntry(ledger, "cache_cleared", "Cleared worker state & cache via API", "info");
  await saveLedger(env.ASCROBBLE_STATE, ledger);
  return { ok: true, ledger };
}

// src/index.ts
var index_default = {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      pollAndScrobble(env).catch((err) => {
        console.error("scheduled() failed:", err);
      })
    );
  },
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-ascrobble-auth"
    };
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }
    if (url.pathname === "/health") {
      return json(
        { ok: true, service: "aScrobble-scrobbler", version: "0.3.0" },
        200,
        corsHeaders
      );
    }
    const providedKey = url.searchParams.get("key") ?? request.headers.get("x-ascrobble-auth") ?? "";
    if (!env.STATUS_AUTH_KEY) {
      console.error("STATUS_AUTH_KEY not set in worker environment");
      return json(
        { error: "Worker is misconfigured: STATUS_AUTH_KEY not set" },
        500,
        corsHeaders
      );
    }
    if (providedKey !== env.STATUS_AUTH_KEY) {
      console.warn("Unauthorized request to worker: invalid/missing auth key");
      return json({ error: "unauthorized" }, 401, corsHeaders);
    }
    if (url.pathname === "/status" && request.method === "GET") {
      try {
        const ledger = await getStatus(env);
        return json(ledger, 200, corsHeaders);
      } catch (err) {
        console.error("/status request failed:", err);
        return json({ error: "failed to fetch status" }, 500, corsHeaders);
      }
    }
    if (url.pathname === "/reset-stats" && request.method === "POST") {
      try {
        const ledger = await resetLedgerStats(env);
        return json(ledger, 200, corsHeaders);
      } catch (err) {
        console.error("/reset-stats failed:", err);
        return json({ error: "failed to reset stats" }, 500, corsHeaders);
      }
    }
    if (url.pathname === "/clear-cache" && request.method === "POST") {
      try {
        let opts = {};
        if (request.headers.get("Content-Type")?.includes("application/json")) {
          opts = await request.json().catch(() => ({}));
        }
        const res = await clearCache(env, opts);
        return json(res, 200, corsHeaders);
      } catch (err) {
        console.error("/clear-cache failed:", err);
        return json({ error: "failed to clear cache" }, 500, corsHeaders);
      }
    }
    if (url.pathname === "/update-tokens" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const res = await updateTokens(
          env,
          body.apple_dev_token,
          body.apple_user_token
        );
        return json(res, 200, corsHeaders);
      } catch (err) {
        console.error("/update-tokens failed:", err);
        return json({ error: "failed to update tokens" }, 500, corsHeaders);
      }
    }
    if (url.pathname === "/trigger" && request.method === "POST") {
      try {
        const run = await pollAndScrobble(env, true);
        const ledger = await getStatus(env);
        const status = run.recovery_deferred && !ledger.pending_history_recovery ? { ...ledger, history_recovery_notice: "Apple Music recovery will start on the next scheduled poll." } : ledger;
        return json({
          ok: run.ok,
          triggered: true,
          ledger: status,
          error: run.error_message
        }, 200, corsHeaders);
      } catch (err) {
        console.error("/trigger failed:", err);
        return json({ error: String(err) }, 500, corsHeaders);
      }
    }
    return json({ error: "not found" }, 404, corsHeaders);
  }
};
function json(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
      ...corsHeaders
    }
  });
}
export {
  index_default as default
};
