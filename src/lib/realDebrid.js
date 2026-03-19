const config = require('../config');
const Cache = require('./cache');

const cache = new Cache();

// Persistent-ish local cache of hashes known to be cached on RD (6-hour TTL)
const hashCache = new Cache();

// Use last 8 chars of token as cache key fingerprint
function tokenKey(token) {
    return token.slice(-8);
}

async function apiRequest(endpoint, token, options = {}) {
    const url = `${config.rdApiBase}${endpoint}`;
    const headers = {
        'Authorization': `Bearer ${token}`,
    };

    const fetchOptions = {
        method: options.method || 'GET',
        headers,
    };

    if (options.body) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        fetchOptions.body = new URLSearchParams(options.body).toString();
    }

    const res = await fetch(url, {
        ...fetchOptions,
        signal: AbortSignal.timeout(15000),
    });

    if (res.status === 401) {
        throw new Error('Invalid or expired Real-Debrid API token');
    }
    if (res.status === 403) {
        throw new Error('Forbidden/disabled endpoint');
    }
    if (res.status === 429) {
        throw new Error('Real-Debrid rate limit exceeded. Try again shortly.');
    }
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`RD API error ${res.status}: ${text}`);
    }

    if (res.status === 204 || res.headers.get('content-length') === '0') {
        return null;
    }

    return res.json();
}

async function getUser(token) {
    return apiRequest('/user', token);
}

async function getTorrents(token, page = 1, limit = 50) {
    const cacheKey = `torrents:${page}:${limit}:${tokenKey(token)}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const result = await apiRequest(`/torrents?page=${page}&limit=${limit}`, token);
    cache.set(cacheKey, result, config.cacheTTL.torrentList);
    return result;
}

async function getAllTorrents(token) {
    const cacheKey = `torrents:all:${tokenKey(token)}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    // Fetch up to 2500 torrents (50 pages of 50)
    let allTorrents = [];
    let page = 1;
    while (true) {
        const batch = await apiRequest(`/torrents?page=${page}&limit=50`, token);
        if (!batch || batch.length === 0) break;
        allTorrents = allTorrents.concat(batch);
        if (batch.length < 50) break;
        page++;
        if (page > 50) break;
    }

    cache.set(cacheKey, allTorrents, config.cacheTTL.torrentList);
    return allTorrents;
}

async function getTorrentInfo(token, torrentId, forceRefresh = false) {
    const cacheKey = `torrent_info:${torrentId}:${tokenKey(token)}`;
    if (!forceRefresh) {
        const cached = cache.get(cacheKey);
        if (cached) return cached;
    }

    const result = await apiRequest(`/torrents/info/${torrentId}`, token);
    cache.set(cacheKey, result, config.cacheTTL.torrentInfo);
    return result;
}

async function getDownloads(token, page = 1, limit = 50) {
    const cacheKey = `downloads:${page}:${limit}:${tokenKey(token)}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const result = await apiRequest(`/downloads?page=${page}&limit=${limit}`, token);
    cache.set(cacheKey, result, config.cacheTTL.torrentList);
    return result;
}

async function unrestrictLink(token, link) {
    const cacheKey = `unrestrict:${link}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const result = await apiRequest('/unrestrict/link', token, {
        method: 'POST',
        body: { link },
    });
    cache.set(cacheKey, result, config.cacheTTL.unrestrict);
    return result;
}

// Mark a hash as known-cached in the local hash cache
function markHashCached(hash) {
    hashCache.set(`known:${hash.toLowerCase()}`, true, config.cacheTTL.hashCache);
}

// Check if a hash is already known to be cached locally
function isHashKnownCached(hash) {
    return hashCache.get(`known:${hash.toLowerCase()}`) === true;
}

async function checkInstantAvailability(token, hashes) {
    if (!hashes || hashes.length === 0) return {};

    const result = {};

    // Step 1: Check local hash cache first — remove already-known hashes
    const toQuery = [];
    for (const hash of hashes) {
        if (isHashKnownCached(hash)) {
            result[hash] = { rd: [{ 1: { filename: 'cached', filesize: 0 } }] };
        } else {
            toQuery.push(hash);
        }
    }

    if (toQuery.length === 0) return result;

    // Step 2: Check cache by adding magnets to RD (limited to 10 hashes)
    const limitedHashes = toQuery.slice(0, 10);
    console.log(`[rd] Checking ${limitedHashes.length} hash(es) via add-magnet...`);
    try {
        const addResult = await checkViaAddFallback(token, limitedHashes);
        for (const [hash, val] of Object.entries(addResult)) {
            result[hash] = val;
            if (val && val.rd && val.rd.length > 0) {
                markHashCached(hash);
            }
        }
        const cached = Object.values(addResult).filter(v => v && v.rd && v.rd.length > 0).length;
        console.log(`[rd] Found ${cached} cached hash(es) out of ${limitedHashes.length}`);
    } catch (err) {
        console.error('[rd] Add-magnet cache check failed:', err.message);
    }

    return result;
}

// Fallback: Check cache by adding magnets sequentially with a delay to avoid
// rate-limiting. Stops early after 2 consecutive rate-limit errors.
async function checkViaAddFallback(token, hashes) {
    const result = {};
    let consecutiveRateLimits = 0;

    for (const rawHash of hashes) {
        if (consecutiveRateLimits >= 2) {
            console.log('[rd] Stopping add-magnet fallback — rate limited');
            break;
        }

        const hash = rawHash.toLowerCase();
        const cacheResult = await checkCacheViaAdd(token, hash);

        if (cacheResult === 'rate_limited') {
            consecutiveRateLimits++;
            continue;
        }
        consecutiveRateLimits = 0;

        if (!cacheResult) continue;

        const { info } = cacheResult;
        const variant = {};
        if (info && info.files && info.files.length > 0) {
            for (const file of info.files) {
                const fileId = file.id || 1;
                variant[fileId] = {
                    filename: file.path ? file.path.replace(/^\//, '') : `file_${fileId}`,
                    filesize: file.bytes || 0,
                };
            }
        } else {
            variant[1] = { filename: 'cached', filesize: 0 };
        }
        result[hash] = { rd: [variant] };

        // Small delay between requests to stay under rate limits
        await new Promise(r => setTimeout(r, 300));
    }

    return result;
}

// Add magnet, select all files, check if already cached via torrent status.
// Returns { torrentId, info } if cached, null if not cached, or 'rate_limited' on 429.
async function checkCacheViaAdd(token, hash) {
    let torrentId = null;
    try {
        const magnet = `magnet:?xt=urn:btih:${hash}`;
        const added = await addMagnet(token, magnet);
        if (!added || !added.id) return null;
        torrentId = added.id;

        await selectFiles(token, torrentId, 'all');

        const info = await getTorrentInfo(token, torrentId, true);
        if (info && info.status === 'downloaded') {
            markHashCached(hash);
            return { torrentId, info };
        }

        // Not cached — clean up
        await deleteTorrent(token, torrentId).catch(() => {});
        return null;
    } catch (err) {
        if (err.message && err.message.includes('rate limit')) {
            if (torrentId) await deleteTorrent(token, torrentId).catch(() => {});
            return 'rate_limited';
        }
        console.error(`[rd] checkCacheViaAdd failed for ${hash}:`, err.message);
        if (torrentId) await deleteTorrent(token, torrentId).catch(() => {});
        return null;
    }
}

async function addMagnet(token, magnet) {
    return apiRequest('/torrents/addMagnet', token, {
        method: 'POST',
        body: { magnet },
    });
}

async function selectFiles(token, torrentId, files) {
    return apiRequest(`/torrents/selectFiles/${torrentId}`, token, {
        method: 'POST',
        body: { files: files || 'all' },
    });
}

async function deleteTorrent(token, torrentId) {
    return apiRequest(`/torrents/delete/${torrentId}`, token, {
        method: 'DELETE',
    });
}

function clearCache() {
    cache.clear();
}

module.exports = {
    getUser,
    getTorrents,
    getAllTorrents,
    getTorrentInfo,
    getDownloads,
    unrestrictLink,
    checkInstantAvailability,
    checkCacheViaAdd,
    addMagnet,
    selectFiles,
    deleteTorrent,
    clearCache,
    markHashCached,
};
