import test from "node:test";
import dns from "node:dns";
import http from "node:http";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent, fetch, request } from "undici";

import {
    isPublicAddress,
    assertPublicURL,
    safeAgent,
    guardDispatcher,
    createProxyAgent,
} from "./ssrf.js";

const listen = async (handler) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return server;
}

// stands in for anything on the local network that must stay unreachable
const startSecretServer = async (t) => {
    const hits = [];
    const server = await listen((req, res) => {
        hits.push(req.url);
        res.end("secret");
    });
    t.after(() => server.close());
    return { port: server.address().port, hits };
}

// makes `host` look public to the preflight check (assertPublicURL),
// like a hostname whose dns answer changes between the check and the
// connection, or one that only a proxy resolves to a local address
const mockPublicHost = (t, host) => {
    const lookup = dns.promises.lookup;
    t.mock.method(dns.promises, "lookup", (name, ...args) =>
        name === host
            ? Promise.resolve([{ address: "93.184.215.14", family: 4 }])
            : lookup(name, ...args)
    );
}

// a dispatcher that connects every hostname to 127.0.0.1 without any checks,
// like a freebind socket or a proxy on the local network would
const localAgent = new Agent({
    connect: {
        lookup: (_, options, callback) => options.all
            ? callback(null, [{ address: "127.0.0.1", family: 4 }])
            : callback(null, "127.0.0.1", 4),
    },
});

test.after(() => localAgent.close());

test("non-public addresses are rejected", () => {
    for (const ip of [
        "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1",
        "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1",
        "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1",
        "[::1]", "2002:7f00:1::", "not-an-ip",
    ]) {
        assert.equal(isPublicAddress(ip), false, ip);
    }
});

test("public addresses are allowed", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:1.1.1.1"]) {
        assert.equal(isPublicAddress(ip), true, ip);
    }
});

test("assertPublicURL rejects local urls and other protocols", async () => {
    for (const url of [
        "http://127.0.0.1:6379/",
        "http://[::1]/",
        "http://169.254.169.254/latest/meta-data/",
        "http://localhost/",
        "file:///etc/passwd",
        "data:text/plain,hi",
    ]) {
        await assert.rejects(assertPublicURL(url), url);
    }
});

test("safeAgent refuses loopback ip literals and hostnames", async (t) => {
    const server = http.createServer((req, res) => {
        res.end("secret");
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    const { port } = server.address();

    await assert.rejects(
        request(`http://127.0.0.1:${port}/`, { dispatcher: safeAgent }),
        /non-public address/
    );

    await assert.rejects(
        request(`http://localhost:${port}/`, { dispatcher: safeAgent }),
        /non-public address/
    );
});

test("ipv6 addresses that lead to local networks are rejected", () => {
    for (const ip of [
        "::7f00:1", "::a00:1",          // ipv4-compatible
        "fec0::1",                      // site-local
        "64:ff9b:1::a00:1",             // local-use nat64
        "64:ff9b::7f00:1",              // nat64 of 127.0.0.1
        "64:ff9b::a9fe:a9fe",           // nat64 of 169.254.169.254
    ]) {
        assert.equal(isPublicAddress(ip), false, ip);
    }
});

test("nat64 addresses of public ipv4 addresses are allowed", () => {
    // dns64 networks (e.g. ipv6-only hosts) synthesize these for ipv4-only sites
    assert.equal(isPublicAddress("64:ff9b::808:808"), true);
});

test("guarded dispatchers check every redirect hop", async (t) => {
    const secret = await startSecretServer(t);
    mockPublicHost(t, "media.test");

    const origin = await listen((req, res) => {
        if (req.url === "/ok") {
            return res.end("media");
        }
        res.statusCode = 302;
        res.setHeader("location", `http://127.0.0.1:${secret.port}/redirected`);
        res.end();
    });
    t.after(() => origin.close());

    const mediaURL = `http://media.test:${origin.address().port}/`;
    const guarded = guardDispatcher(localAgent);

    // the url passes the preflight check, so legit requests still work
    const ok = await request(`${mediaURL}ok`, { dispatcher: guarded, maxRedirections: 16 });
    assert.equal(await ok.body.text(), "media");

    await assert.rejects(
        request(mediaURL, { dispatcher: guarded, maxRedirections: 16 }),
        /non-public address: 127\.0\.0\.1/
    );

    await assert.rejects(
        fetch(mediaURL, { dispatcher: guarded }),
        (e) => /non-public address/.test(e.cause?.message)
    );

    assert.deepEqual(secret.hits, []);
});

test("proxy agent checks requests that bypass the proxy", async (t) => {
    const secret = await startSecretServer(t);

    // the hostname looks public to the preflight check, but resolves to
    // 127.0.0.1 when connecting (dns rebinding)
    mockPublicHost(t, "localhost");
    const url = `http://localhost:${secret.port}/`;

    // only https is proxied, so http:// urls connect directly
    const httpsOnly = createProxyAgent({ httpsProxy: "http://127.0.0.1:1" });
    t.after(() => httpsOnly.close());
    await assert.rejects(request(url, { dispatcher: httpsOnly }), /non-public address/);
    await assert.rejects(
        request(`http://127.0.0.1:${secret.port}/`, { dispatcher: httpsOnly }),
        /non-public address/
    );

    // hosts in NO_PROXY connect directly too
    const noProxy = createProxyAgent({ httpProxy: "http://127.0.0.1:1", noProxy: "localhost" });
    t.after(() => noProxy.close());
    await assert.rejects(request(url, { dispatcher: noProxy }), /non-public address/);

    assert.deepEqual(secret.hits, []);
});

test("proxy agent checks proxied requests before sending them", async (t) => {
    const proxied = [];
    const proxy = await listen((req, res) => {
        proxied.push(req.url);
        res.statusCode = 502;
        res.end();
    });
    proxy.on("connect", (req, socket) => {
        proxied.push(req.url);
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    t.after(() => proxy.close());

    const dispatcher = createProxyAgent({
        httpProxy: `http://127.0.0.1:${proxy.address().port}`,
    });
    t.after(() => dispatcher.close());

    for (const url of [
        "http://127.0.0.1:6379/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "http://localhost/",
    ]) {
        await assert.rejects(request(url, { dispatcher }), /non-public address/, url);
    }

    assert.deepEqual(proxied, []);
});
