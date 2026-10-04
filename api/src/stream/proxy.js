import { Agent, request } from "undici";
import { create as contentDisposition } from "content-disposition-header";

import { env } from "../config.js";
import { destroyInternalStream, getInternalTunnelFromURL } from "./manage.js";
import { getHeaders, closeRequest, closeResponse, pipe } from "./shared.js";

// proxy tunnels only ever connect to cobalt's own internal tunnel on
// 127.0.0.1 (see wrapStream in manage.js). the internal tunnel is what
// fetches the actual media url, and it does so through the ssrf-safe
// dispatchers, so the url itself can't be checked against the ssrf
// blocklist here.
const internalAgent = new Agent();

const isInternalTunnel = (url) => {
    const { origin, pathname } = new URL(url);
    return origin === `http://127.0.0.1:${env.tunnelPort}`
        && pathname === '/itunnel'
        && !!getInternalTunnelFromURL(url);
}

export default async function (streamInfo, res) {
    const abortController = new AbortController();
    const shutdown = () => (
        closeRequest(abortController),
        closeResponse(res),
        destroyInternalStream(streamInfo.urls)
    );

    try {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Content-disposition', contentDisposition(streamInfo.filename));

        if (!isInternalTunnel(streamInfo.urls)) {
            return shutdown();
        }

        const { body: stream, headers, statusCode } = await request(streamInfo.urls, {
            headers: {
                ...getHeaders(streamInfo.service),
                Range: streamInfo.range
            },
            signal: abortController.signal,
            // the internal tunnel has already followed every redirect it
            // allows, so a redirect it passes on must not be followed here
            maxRedirections: 0,
            dispatcher: internalAgent,
        });

        res.status(statusCode);

        for (const headerName of ['accept-ranges', 'content-type', 'content-length']) {
            if (headers[headerName]) {
                res.setHeader(headerName, headers[headerName]);
            }
        }

        pipe(stream, res, shutdown);
    } catch {
        shutdown();
    }
}
