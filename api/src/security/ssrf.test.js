import test from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { request } from "undici";

import { isPublicAddress, assertPublicURL, safeAgent } from "./ssrf.js";

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
