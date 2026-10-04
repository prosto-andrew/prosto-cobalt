import dns from "node:dns";
import net from "node:net";
import ipaddr from "ipaddr.js";
import {
    Agent,
    Dispatcher,
    EnvHttpProxyAgent,
    RedirectHandler,
    buildConnector,
} from "undici";

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

// ipv6 ranges that ipaddr.js reports as "unicast", but which are
// deprecated or can lead to local/private networks
const extraBlockedRanges = [
    '::/96',          // ipv4-compatible addresses (deprecated)
    'fec0::/10',      // site-local addresses (deprecated)
    '64:ff9b:1::/48', // local-use nat64 (rfc 8215)
].map(range => ipaddr.parseCIDR(range));

export const isPublicAddress = (address) => {
    try {
        let addr = ipaddr.parse(stripBrackets(String(address)));
        if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
            addr = addr.toIPv4Address();
        } else if (addr.kind() === 'ipv6' && addr.range() === 'rfc6052') {
            // nat64 (64:ff9b::/96): the gateway connects to the embedded
            // ipv4 address, so that's the one that has to be public
            addr = ipaddr.fromByteArray(addr.toByteArray().slice(12));
        }

        if (addr.kind() === 'ipv6'
            && extraBlockedRanges.some(([ range, bits ]) => addr.match(range, bits))) {
            return false;
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

// wraps a dispatcher whose connections can't be checked (freebind sockets,
// outgoing http proxies) so that every request is preflight-checked with
// assertPublicURL before it's sent. redirects are followed here instead of
// by the wrapped dispatcher, so every hop of a redirect chain goes through
// the check too. the address can still change between the check and the
// connection (dns rebinding), so prefer safeAgent wherever possible.
class PreflightDispatcher extends Dispatcher {
    #dispatcher;

    constructor(dispatcher) {
        super();
        this.#dispatcher = dispatcher;
    }

    dispatch(opts, handler) {
        if (opts.maxRedirections) {
            handler = new RedirectHandler(
                (opts, handler) => this.dispatch(opts, handler),
                opts.maxRedirections,
                opts,
                handler
            );
            opts = { ...opts, maxRedirections: 0 };
        }

        assertPublicURL(opts.origin)
            .then(() => this.#dispatcher.dispatch(opts, handler))
            .catch(err => handler.onError(err));

        return true;
    }

    close(...args) {
        return this.#dispatcher.close(...args);
    }

    destroy(...args) {
        return this.#dispatcher.destroy(...args);
    }
}

export const guardDispatcher = (dispatcher) => new PreflightDispatcher(dispatcher);

// proxy-aware dispatcher for tunnels (same proxy envs as the global one).
// requests that bypass the proxy (NO_PROXY, or a protocol that has no proxy
// configured, e.g. http:// with only HTTPS_PROXY set) connect directly and
// are checked like safeAgent's. proxied requests are resolved by the proxy,
// so they only get the preflight check.
export const createProxyAgent = (options = {}) => guardDispatcher(
    new EnvHttpProxyAgent({ ...options, connect: safeConnect })
);
