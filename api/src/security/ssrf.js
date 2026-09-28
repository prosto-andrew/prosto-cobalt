import dns from "node:dns";
import net from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, buildConnector } from "undici";

// guards outgoing tunnel requests against server-side request forgery:
// media urls come from third-party services (and from hls playlists and
// redirects they serve), so they must never be able to point cobalt at
// loopback, private, link-local (e.g. cloud metadata), or other
// non-public addresses.

const blockedError = (what) => {
    const error = new Error(`refusing to connect to non-public address: ${what}`);
    error.code = 'ERR_COBALT_SSRF_BLOCKED';
    return error;
}

const stripBrackets = (host) => host.replace(/^\[|\]$/g, '');

export const isPublicAddress = (address) => {
    try {
        let addr = ipaddr.parse(stripBrackets(String(address)));
        if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
            addr = addr.toIPv4Address();
        }
        return addr.range() === 'unicast';
    } catch {
        return false;
    }
}

// dns.lookup-compatible function that fails if any resolved address is non-public
export const safeLookup = (hostname, options, callback) => {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    } else if (typeof options === 'number') {
        options = { family: options };
    }

    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err);

        const blocked = addresses.find(a => !isPublicAddress(a.address));
        if (blocked || addresses.length === 0) {
            return callback(blockedError(`${hostname} -> ${blocked?.address}`));
        }

        if (options.all) {
            return callback(null, addresses);
        }

        callback(null, addresses[0].address, addresses[0].family);
    });
}

const baseConnect = buildConnector({ lookup: safeLookup });

// ip literals skip dns lookup entirely, so they're checked here
const safeConnect = (opts, callback) => {
    const host = stripBrackets(opts.hostname || '');
    if (net.isIP(host) && !isPublicAddress(host)) {
        return callback(blockedError(host), null);
    }
    return baseConnect(opts, callback);
}

// a dispatcher whose every connection (including ones made
// while following redirects) is checked against the blocklist
export const safeAgent = new Agent({ connect: safeConnect });

// preflight check used for code paths that can't use safeAgent
// (freebind dispatchers, outgoing http proxies)
export const assertPublicURL = async (url) => {
    const parsed = new URL(url);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw blockedError(parsed.protocol);
    }

    const host = stripBrackets(parsed.hostname);
    if (net.isIP(host)) {
        if (!isPublicAddress(host)) throw blockedError(host);
        return;
    }

    const addresses = await dns.promises.lookup(host, { all: true });
    const blocked = addresses.find(a => !isPublicAddress(a.address));
    if (blocked || addresses.length === 0) {
        throw blockedError(`${host} -> ${blocked?.address}`);
    }
}
