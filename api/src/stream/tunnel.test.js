import test, { mock } from "node:test";
import dns from "node:dns";
import http from "node:http";
import assert from "node:assert/strict";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import express from "express";
import ffmpegPath from "ffmpeg-static";
import { Agent } from "undici";

import { setupTunnelHandler } from "../core/itunnel.js";
import { createInternalStream, getInternalTunnelFromURL } from "./manage.js";
import { handleHlsPlaylist, isHlsResponse } from "./internal-hls.js";
import proxy from "./proxy.js";
import ffmpeg from "./ffmpeg.js";

// test origins are served from 127.0.0.1, which the ssrf checks refuse.
// so ORIGIN_HOST resolves to a public address for the preflight check,
// and the tunnels get a plain agent that connects it to 127.0.0.1. this
// tests what happens *after* a media url passed the ssrf checks.
const ORIGIN_HOST = "origin.test";
const lookup = dns.promises.lookup;
mock.method(dns.promises, "lookup", (host, ...args) =>
    host === ORIGIN_HOST
        ? Promise.resolve([{ address: "93.184.215.14", family: 4 }])
        : lookup(host, ...args)
);

const localAgent = new Agent({
    connect: {
        lookup: (_, options, callback) => options.all
            ? callback(null, [{ address: "127.0.0.1", family: 4 }])
            : callback(null, "127.0.0.1", 4),
    },
});

const listen = async (handler) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return server;
}

const urlOf = (server, path = "/", host = "127.0.0.1") =>
    `http://${host}:${server.address().port}${path}`;

const originURL = (server, path) => urlOf(server, path, ORIGIN_HOST);

const tunnel = (url, options = {}) => createInternalStream(url, {
    service: "test",
    dispatcher: localAgent,
    ...options,
});

// stands in for anything on the local network that must stay unreachable
const startSecretServer = async () => {
    const hits = [];
    const server = await listen((req, res) => {
        hits.push(req.url);
        res.end("0123456789abcdef");
    });
    return { server, hits };
}

// serves the response of an express handler (like /tunnel in api.js)
const download = async (handler) => {
    const app = express();
    app.get("/", handler);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
        const response = await fetch(urlOf(server));
        const body = Buffer.from(await response.arrayBuffer());
        return { status: response.status, body };
    } finally {
        server.close();
    }
}

// runs ffmpeg the way cobalt does for a "remux" tunnel
const remux = (urls) => download((_, res) => ffmpeg.remux({
    type: "remux",
    service: "test",
    filename: "video.mp4",
    urls,
}, res));

const runFFmpeg = (args) => spawnSync(
    ffmpegPath, ["-hide_banner", "-loglevel", "error", ...args]
);

const tunnelServer = setupTunnelHandler();
await once(tunnelServer, "listening");

test.after(() => {
    tunnelServer.close();
    localAgent.close();
});

test("proxy tunnels go through the internal tunnel", async (t) => {
    const origin = await listen((req, res) => {
        res.setHeader("content-type", "image/jpeg");
        res.end("not really a jpeg");
    });
    t.after(() => origin.close());

    const streamInfo = {
        type: "proxy",
        service: "test",
        filename: "photo.jpg",
        urls: tunnel(originURL(origin, "/photo.jpg")),
    };

    const { status, body } = await download((_, res) => proxy(streamInfo, res));
    assert.equal(status, 200);
    assert.equal(body.toString(), "not really a jpeg");
});

test("proxy tunnels refuse urls that aren't internal tunnels", async (t) => {
    const secret = await startSecretServer();
    t.after(() => secret.server.close());

    // a registered internal tunnel id, but on another port
    const { searchParams } = new URL(tunnel("https://example.com/"));

    for (const url of [
        urlOf(secret.server, "/"),
        urlOf(secret.server, `/itunnel?${searchParams}`),
    ]) {
        const streamInfo = {
            type: "proxy",
            service: "test",
            filename: "secret.txt",
            urls: url,
        };

        const { status } = await download((_, res) => proxy(streamInfo, res));
        assert.equal(status, 500, url);
    }

    assert.deepEqual(secret.hits, []);
});

test("proxy tunnels don't follow redirects passed on by the internal tunnel", async (t) => {
    const secret = await startSecretServer();
    t.after(() => secret.server.close());

    // the internal tunnel follows 16 redirects, and passes the 17th on
    const origin = await listen((req, res) => {
        const n = Number(new URL(req.url, "http://x").searchParams.get("n"));
        res.statusCode = 302;
        res.setHeader("location",
            n < 16 ? `/?n=${n + 1}` : urlOf(secret.server, "/redirected")
        );
        res.end();
    });
    t.after(() => origin.close());

    const streamInfo = {
        type: "proxy",
        service: "test",
        filename: "file.bin",
        urls: tunnel(originURL(origin, "/?n=0")),
    };

    await download((_, res) => proxy(streamInfo, res));
    assert.deepEqual(secret.hits, []);
});

test("hls playlists are recognized like ffmpeg recognizes them", () => {
    const response = (type) => ({ headers: { "content-type": type } });
    const streamInfo = { service: "test", url: "https://example.com/video" };

    for (const type of [
        "application/vnd.apple.mpegurl",
        "application/x-mpegURL",
        "application/x-mpegurl",
        "APPLICATION/X-MPEGURL",
        "application/vnd.apple.mpegurl; charset=utf-8",
        "audio/mpegurl",
        "audio/x-mpegurl",
    ]) {
        assert.equal(isHlsResponse(response(type), streamInfo), true, type);
    }

    for (const type of ["video/mp4", "text/plain", undefined]) {
        assert.equal(isHlsResponse(response(type), streamInfo), false, type);
    }

    // playlist urls are known to be playlists, whatever their content-type
    assert.equal(
        isHlsResponse(response("text/plain"), { ...streamInfo, hlsPlaylist: true }),
        true
    );
});

const rewritePlaylist = async (url, playlist) => {
    const streamInfo = getInternalTunnelFromURL(tunnel(url, { isHLS: true }));

    let output;
    await handleHlsPlaylist(
        streamInfo,
        { body: { text: async () => playlist } },
        { send: (text) => output = text }
    );

    // uri attributes and uri lines
    const uris = [
        ...[...output.matchAll(/URI="([^"]+)"/g)].map(m => m[1]),
        ...output.split("\n").filter(line => line && !line.startsWith("#")),
    ];

    return { output, tunnels: uris.map(getInternalTunnelFromURL) };
}

test("every media playlist uri is tunneled exactly once", async () => {
    const { output, tunnels } = await rewritePlaylist(
        "https://cdn.example.com/video/playlist.m3u8",
        [
            "#EXTM3U",
            "#EXT-X-VERSION:7",
            "#EXT-X-TARGETDURATION:4",
            '#EXT-X-MAP:URI="init.mp4"',
            '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/key"',
            "#EXTINF:4,", "seg0.m4s",
            "#EXTINF:4,", "seg1.m4s",
            "#EXTINF:4,", "http://127.0.0.1:6379/seg2.m4s",
            "#EXT-X-ENDLIST",
        ].join("\n")
    );

    assert.ok(tunnels.every(Boolean), `not every uri is tunneled:\n${output}`);

    // one map and one key for all segments, each tunneled once. a tunnel to
    // a tunnel (on 127.0.0.1) would be refused by the ssrf blocklist.
    assert.deepEqual(tunnels.map(t => t.url).sort(), [
        "http://127.0.0.1:6379/seg2.m4s",
        "https://cdn.example.com/video/init.mp4",
        "https://cdn.example.com/video/seg0.m4s",
        "https://cdn.example.com/video/seg1.m4s",
        "https://keys.example.com/key",
    ]);
    assert.ok(tunnels.every(t => !t.hlsPlaylist));
});

test("every master playlist uri is tunneled as a playlist", async () => {
    const { output, tunnels } = await rewritePlaylist(
        "https://cdn.example.com/master.m3u8",
        [
            "#EXTM3U",
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",URI="audio.m3u8"',
            '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="en",URI="http://10.0.0.1/subs.m3u8"',
            '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="aud",SUBTITLES="sub"',
            "video.m3u8",
        ].join("\n")
    );

    assert.ok(tunnels.every(t => t?.hlsPlaylist), output);
    assert.deepEqual(tunnels.map(t => t.url).sort(), [
        "http://10.0.0.1/subs.m3u8",
        "https://cdn.example.com/audio.m3u8",
        "https://cdn.example.com/video.m3u8",
    ]);
});

test("ffmpeg can't reach urls that aren't internal tunnels", async (t) => {
    const secret = await startSecretServer();
    t.after(() => secret.server.close());

    const requested = [];
    const origin = await listen((req, res) => {
        const { pathname, searchParams } = new URL(req.url, "http://x");
        requested.push(pathname);

        if (pathname === "/manifest.mpd") {
            // dash manifests are detected by their contents, and
            // ffmpeg fetches the urls in them on its own
            res.setHeader("content-type", "application/dash+xml");
            return res.end(
                '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"'
                + ' profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static"'
                + ' mediaPresentationDuration="PT2S"><Period><AdaptationSet mimeType="video/mp4">'
                + '<Representation id="1" bandwidth="1000">'
                + `<BaseURL>${urlOf(secret.server, "/dash")}</BaseURL>`
                + '</Representation></AdaptationSet></Period></MPD>'
            );
        }

        if (pathname === "/redirect") {
            // the internal tunnel follows 16 redirects and passes the 17th
            // on to ffmpeg, which follows redirects on its own
            const n = Number(searchParams.get("n"));
            res.statusCode = 302;
            res.setHeader("location",
                n < 16 ? `/redirect?n=${n + 1}` : urlOf(secret.server, "/redirect")
            );
            return res.end();
        }

        res.statusCode = 404;
        res.end();
    });
    t.after(() => origin.close());

    await remux(tunnel(originURL(origin, "/manifest.mpd")));
    await remux(tunnel(originURL(origin, "/redirect?n=0")));

    // the origin was reached through the tunnels...
    assert.ok(requested.includes("/manifest.mpd"), requested.join());
    assert.ok(requested.includes("/redirect"), requested.join());
    // ...but ffmpeg never got to the urls it was handed
    assert.deepEqual(secret.hits, []);
});

const serveDirectory = async (dir, requested, playlistType) => listen(async (req, res) => {
    const name = new URL(req.url, "http://x").pathname.slice(1);
    requested.push(name);
    try {
        const file = await readFile(join(dir, name));
        if (name.endsWith(".m3u8")) {
            res.setHeader("content-type", playlistType);
        }
        res.end(file);
    } catch {
        res.statusCode = 404;
        res.end();
    }
});

// encrypts the init section and the media segments of an fmp4 playlist with
// aes-128, as ffmpeg's hls muxer can't encrypt fmp4 segments on its own.
// the key is declared before the map, so it applies to the init section
// too (hls-parser always writes the key first when re-serializing).
const encryptSegments = async (dir, playlist) => {
    const key = Buffer.alloc(16, 7);
    await writeFile(join(dir, "key.bin"), key);

    const segments = playlist.split("\n").filter(l => l.endsWith(".m4s"));
    const files = [ [ "init.mp4", 0 ], ...segments.map((name, i) => [ name, i ]) ];

    for (const [ name, sequence ] of files) {
        // without an IV attribute, the IV is the media sequence number
        const iv = Buffer.alloc(16);
        iv.writeUInt32BE(sequence, 12);

        const cipher = createCipheriv("aes-128-cbc", key, iv);
        const plain = await readFile(join(dir, name));
        await writeFile(join(dir, name), Buffer.concat([ cipher.update(plain), cipher.final() ]));
    }

    return playlist.replace(
        /(#EXT-X-MAP:[^\n]+\n)/,
        '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n$1'
    );
}

const testHlsRemux = async (t, { encrypt, playlistType, expectRequested }) => {
    const dir = await mkdtemp(join(tmpdir(), "cobalt-hls-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    // (ffmpeg-static 7.0.2 segfaults on hls with mpeg-ts segments,
    // even without cobalt in between, so these are fmp4)
    const encode = runFFmpeg([
        "-f", "lavfi", "-i", "testsrc=duration=4:size=160x90:rate=10",
        "-f", "lavfi", "-i", "sine=duration=4",
        "-c:v", "libx264", "-g", "10", "-c:a", "aac",
        "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod",
        "-hls_segment_type", "fmp4",
        "-hls_segment_filename", join(dir, "seg%d.m4s"),
        join(dir, "playlist.m3u8"),
    ]);
    assert.equal(encode.status, 0, encode.stderr.toString());

    let playlist = await readFile(join(dir, "playlist.m3u8"), "utf8");
    assert.match(playlist, /#EXT-X-MAP/);

    if (encrypt) {
        playlist = await encryptSegments(dir, playlist);
        assert.match(playlist, /#EXT-X-KEY:METHOD=AES-128/);
        await writeFile(join(dir, "playlist.m3u8"), playlist);
    }

    const requested = [];
    const origin = await serveDirectory(dir, requested, playlistType);
    t.after(() => origin.close());

    const { status, body } = await remux(
        tunnel(originURL(origin, "/playlist.m3u8"), { isHLS: true })
    );

    assert.equal(status, 200);
    for (const name of expectRequested) {
        assert.ok(requested.includes(name), `${name} wasn't requested: ${requested.join()}`);
    }

    await writeFile(join(dir, "out.mp4"), body);
    const decode = runFFmpeg(["-i", join(dir, "out.mp4"), "-f", "null", "-"]);
    assert.equal(decode.status, 0, decode.stderr.toString());
    assert.ok(body.length > 1000, `output is only ${body.length} bytes`);
}

test("ffmpeg remuxes fmp4 hls (EXT-X-MAP) through internal tunnels", (t) => testHlsRemux(t, {
    playlistType: "application/vnd.apple.mpegurl",
    expectRequested: ["playlist.m3u8", "init.mp4", "seg0.m4s", "seg3.m4s"],
}));

test("ffmpeg remuxes encrypted hls (EXT-X-KEY) through internal tunnels", (t) => testHlsRemux(t, {
    encrypt: true,
    // a content-type that cobalt didn't recognize as hls before
    playlistType: "application/x-mpegurl; charset=utf-8",
    expectRequested: ["playlist.m3u8", "init.mp4", "key.bin", "seg0.m4s", "seg3.m4s"],
}));
