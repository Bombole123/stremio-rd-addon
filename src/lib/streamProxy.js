const https = require('https');
const http = require('http');
const { pipeline } = require('stream');

const MAX_REDIRECTS = 3;

/**
 * Proxy a video stream from RD CDN to the player.
 *
 * When the CDN returns an error (expired link, HTML error page), calls refreshUrl()
 * to get a fresh CDN URL and retries the request once. The player never sees the expiry.
 *
 * @param {http.IncomingMessage} req  - Player request (Express req)
 * @param {http.ServerResponse}  res  - Player response (Express res)
 * @param {string}               cdnUrl     - Current RD CDN download URL
 * @param {Function}             refreshUrl - async () => string — returns a fresh CDN URL
 */
function proxyStream(req, res, cdnUrl, refreshUrl) {
    const isHead = req.method === 'HEAD';

    // Single close handler slot — replaced each time a new live upstream is created.
    // Avoids accumulating one listener per redirect/retry on req.
    let activeCloseHandler = null;

    function setActiveUpstream(upstream) {
        if (activeCloseHandler) {
            req.removeListener('close', activeCloseHandler);
        }
        activeCloseHandler = () => {
            if (!upstream.destroyed) upstream.destroy();
        };
        req.on('close', activeCloseHandler);
    }

    function makeRequest(url, isRetry, redirectCount, baseUrl) {
        if (redirectCount > MAX_REDIRECTS) {
            console.error('[proxy] Too many redirects');
            if (!res.headersSent) res.status(502).json({ error: 'Too many redirects' });
            return;
        }

        // Resolve relative Location URLs against the URL that issued the redirect
        let parsedUrl;
        try {
            parsedUrl = new URL(url, baseUrl);
        } catch (err) {
            console.error('[proxy] Invalid URL:', err.message);
            if (!res.headersSent) res.status(502).json({ error: 'Invalid upstream URL' });
            return;
        }

        const transport = parsedUrl.protocol === 'https:' ? https : http;

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: isHead ? 'HEAD' : 'GET',
            headers: {},
        };

        // Forward Range header for seeking
        if (req.headers.range) {
            options.headers['Range'] = req.headers.range;
        }

        const upstream = transport.request(options, (upstreamRes) => {
            // Follow redirects (RD CDN sometimes 301/302s)
            if (upstreamRes.statusCode === 301 || upstreamRes.statusCode === 302) {
                const location = upstreamRes.headers.location;
                upstreamRes.resume(); // drain
                if (location) {
                    makeRequest(location, isRetry, redirectCount + 1, parsedUrl.href);
                } else {
                    console.error('[proxy] Redirect with no Location header');
                    if (!res.headersSent) res.status(502).json({ error: 'Bad redirect from upstream' });
                }
                return;
            }

            // Check if response indicates an expired link
            const contentType = upstreamRes.headers['content-type'] || '';
            const isExpired = upstreamRes.statusCode === 403 ||
                              upstreamRes.statusCode === 410 ||
                              upstreamRes.statusCode >= 500 ||
                              contentType.includes('text/html');

            if (isExpired && !isRetry && refreshUrl) {
                upstreamRes.resume(); // drain the error response
                console.log(`[proxy] CDN link expired (status=${upstreamRes.statusCode}, type=${contentType}), refreshing...`);
                refreshUrl().then((newUrl) => {
                    makeRequest(newUrl, true, 0, undefined);
                }).catch((err) => {
                    console.error('[proxy] Failed to refresh URL:', err.message);
                    if (!res.headersSent) res.status(502).json({ error: 'Stream unavailable' });
                });
                return;
            }

            // Forward response headers to the player
            const status = upstreamRes.statusCode;
            const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
            const headersToSet = {};
            for (const h of forwardHeaders) {
                if (upstreamRes.headers[h]) headersToSet[h] = upstreamRes.headers[h];
            }
            // Ensure accept-ranges is set so the player knows it can seek
            if (!headersToSet['accept-ranges']) {
                headersToSet['accept-ranges'] = 'bytes';
            }

            res.writeHead(status, headersToSet);

            if (isHead) {
                upstreamRes.resume();
                res.end();
                return;
            }

            // Pipe the video data to the player
            pipeline(upstreamRes, res, (err) => {
                if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && !res.destroyed) {
                    console.error('[proxy] Stream pipe error:', err.message);
                }
            });
        });

        upstream.on('error', (err) => {
            if (res.destroyed) return; // Client already disconnected

            if (!isRetry && refreshUrl) {
                console.log('[proxy] Upstream network error, refreshing URL...');
                refreshUrl().then((newUrl) => {
                    makeRequest(newUrl, true, 0, undefined);
                }).catch(() => {
                    if (!res.headersSent) res.status(502).json({ error: 'Stream unavailable' });
                });
            } else {
                console.error('[proxy] Upstream error (no retry):', err.message);
                if (!res.headersSent) res.status(502).json({ error: 'Stream unavailable' });
            }
        });

        // Track only the current live upstream — one close listener at a time
        setActiveUpstream(upstream);

        upstream.end();
    }

    makeRequest(cdnUrl, false, 0, undefined);
}

module.exports = { proxyStream };
