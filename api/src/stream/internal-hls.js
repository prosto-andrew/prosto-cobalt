import HLS from "hls-parser";
import { createInternalStream } from "./manage.js";
import { fetch, request } from "undici";
import { assertPublicURL } from "../security/ssrf.js";

function getURL(url) {
    try {
        return new URL(url);
    } catch {
        return null;
    }
}

// `transformed` holds the objects that already point at an internal tunnel:
// hls-parser reuses the same key and map object for every segment they apply
// to, and wrapping their uri again would make a tunnel to a tunnel on
// 127.0.0.1, which is refused by the ssrf blocklist.
function transformObject(streamInfo, hlsObject, transformed, isPlaylist = false) {
    if (hlsObject === undefined) {
        return (object) => transformObject(streamInfo, object, transformed, isPlaylist);
    }

    if (!hlsObject?.uri || transformed.has(hlsObject)) {
        return hlsObject;
    }
    transformed.add(hlsObject);

    let fullUrl;
    if (getURL(hlsObject.uri)) {
        fullUrl = new URL(hlsObject.uri);
    } else {
        fullUrl = new URL(hlsObject.uri, streamInfo.url);
    }

    // every uri (including ones pointing at 127.0.0.1) goes through an
    // internal tunnel, where it's checked against the ssrf blocklist.
    // ffmpeg can't fetch anything that isn't an internal tunnel (see
    // ffmpeg.js), so uris that aren't rewritten here stop working.
    hlsObject.uri = createInternalStream(fullUrl.toString(), {
        ...streamInfo,
        hlsPlaylist: isPlaylist,
    });

    if (hlsObject.map) {
        hlsObject.map = transformObject(streamInfo, hlsObject.map, transformed);
    }

    // aes-128 / sample-aes decryption keys
    if (hlsObject.key) {
        hlsObject.key = transformObject(streamInfo, hlsObject.key, transformed);
    }

    return hlsObject;
}

function transformMasterPlaylist(streamInfo, hlsPlaylist, transformed) {
    // variants and renditions are media playlists themselves
    const makeInternalPlaylist = transformObject(streamInfo, undefined, transformed, true);

    const makeInternalVariants = (variant) => {
        variant = makeInternalPlaylist(variant);
        variant.video = variant.video.map(makeInternalPlaylist);
        variant.audio = variant.audio.map(makeInternalPlaylist);
        variant.subtitles = variant.subtitles.map(makeInternalPlaylist);
        return variant;
    };
    hlsPlaylist.variants = hlsPlaylist.variants.map(makeInternalVariants);

    return hlsPlaylist;
}

function transformMediaPlaylist(streamInfo, hlsPlaylist, transformed) {
    const makeInternalSegments = transformObject(streamInfo, undefined, transformed);
    hlsPlaylist.segments = hlsPlaylist.segments.map(makeInternalSegments);
    hlsPlaylist.prefetchSegments = hlsPlaylist.prefetchSegments.map(makeInternalSegments);
    return hlsPlaylist;
}

// ffmpeg recognizes all of these (case-insensitively, with parameters)
// as hls, so a playlist served with any of them has to be rewritten
const HLS_MIME_TYPES = [
    "application/vnd.apple.mpegurl",
    "application/x-mpegurl",
    "audio/mpegurl",
    "audio/x-mpegurl",
];

export function isHlsResponse(req, streamInfo) {
    const mimeType = String(req.headers['content-type'] ?? '')
        .split(';')[0].trim().toLowerCase();

    return HLS_MIME_TYPES.includes(mimeType)
        || streamInfo.hlsPlaylist
        // bluesky's cdn responds with wrong content-type for the hls playlist,
        // so we enforce it here until they fix it
        || (streamInfo.service === 'bsky' && streamInfo.url.endsWith('.m3u8'));
}

export async function handleHlsPlaylist(streamInfo, req, res) {
    let hlsPlaylist = await req.body.text();
    hlsPlaylist = HLS.parse(hlsPlaylist);

    const transformed = new WeakSet();
    hlsPlaylist = hlsPlaylist.isMasterPlaylist
        ? transformMasterPlaylist(streamInfo, hlsPlaylist, transformed)
        : transformMediaPlaylist(streamInfo, hlsPlaylist, transformed);

    hlsPlaylist = HLS.stringify(hlsPlaylist);

    res.send(hlsPlaylist);
}

async function getSegmentSize(url, config) {
    await assertPublicURL(url);
    const segmentResponse = await request(url, {
        ...config,
        throwOnError: true
    });

    if (segmentResponse.headers['content-length']) {
        segmentResponse.body.dump();
        return +segmentResponse.headers['content-length'];
    }

    // if the response does not have a content-length
    // header, we have to compute it ourselves
    let size = 0;

    for await (const data of segmentResponse.body) {
        size += data.length;
    }

    return size;
}

export async function probeInternalHLSTunnel(streamInfo) {
    const { url, headers, dispatcher, signal } = streamInfo;

    // remove all falsy headers
    Object.keys(headers).forEach(key => {
        if (!headers[key]) delete headers[key];
    });

    const config = { headers, dispatcher, signal, maxRedirections: 16 };

    await assertPublicURL(url);
    const manifestResponse = await fetch(url, config);

    const manifest = HLS.parse(await manifestResponse.text());
    if (manifest.segments.length === 0)
        return -1;

    const segmentSamples = await Promise.all(
        Array(5).fill().map(async () => {
            const manifestIdx = Math.floor(Math.random() * manifest.segments.length);
            const randomSegment = manifest.segments[manifestIdx];
            if (!randomSegment.uri)
                throw "segment is missing URI";

            let segmentUrl;

            if (getURL(randomSegment.uri)) {
                segmentUrl = new URL(randomSegment.uri);
            } else {
                segmentUrl = new URL(randomSegment.uri, streamInfo.url);
            }

            const segmentSize = await getSegmentSize(segmentUrl, config) / randomSegment.duration;
            return segmentSize;
        })
    );

    const averageBitrate = segmentSamples.reduce((a, b) => a + b) / segmentSamples.length;
    const totalDuration = manifest.segments.reduce((acc, segment) => acc + segment.duration, 0);

    return averageBitrate * totalDuration;
}
