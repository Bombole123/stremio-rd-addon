const Cache = require('./cache');
const config = require('../config');
const { parse } = require('./nameParser');
const torrentDb = require('./torrentDb');

const cache = new Cache();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes — in-memory cache for dedup within session

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// --- Source reliability tracking ---
const sourceStats = {};

function recordSourceResult(name, success, resultCount, durationMs) {
    if (!sourceStats[name]) {
        sourceStats[name] = { successes: 0, failures: 0, totalResults: 0, totalMs: 0, consecutiveFailures: 0 };
    }
    const s = sourceStats[name];
    s.totalMs += durationMs;
    if (success) {
        s.successes++;
        s.totalResults += resultCount;
        s.consecutiveFailures = 0;
    } else {
        s.failures++;
        s.consecutiveFailures++;
    }
}

function isSourceDisabled(name) {
    const s = sourceStats[name];
    if (!s) return false;
    return s.consecutiveFailures >= 5;
}

// Re-enable all sources every 10 minutes so they get retried
setInterval(() => {
    for (const s of Object.values(sourceStats)) {
        s.consecutiveFailures = 0;
    }
}, 10 * 60 * 1000).unref();

function normalizeTitle(title) {
    return title.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Search ThePirateBay via apibay
async function searchTPB(query) {
    try {
        const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=200,205,207,208`;
        const res = await fetch(url, {
            headers: { 'User-Agent': BROWSER_UA },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return [];

        const data = await res.json();
        if (!Array.isArray(data) || (data.length === 1 && data[0].id === '0')) return [];

        return data.map((t) => ({
            hash: t.info_hash.toLowerCase(),
            title: t.name,
            size: parseInt(t.size, 10) || 0,
            seeds: parseInt(t.seeders, 10) || 0,
            source: 'TPB',
        }));
    } catch (err) {
        console.error('[search] TPB error:', err.message);
        return [];
    }
}

// Search EZTV by IMDB ID (TV shows)
async function searchEZTV(imdbId) {
    try {
        const imdbNum = imdbId.replace('tt', '');
        const url = `https://eztv.re/api/get-torrents?imdb_id=${imdbNum}&limit=100`;
        const res = await fetch(url, {
            headers: { 'User-Agent': BROWSER_UA },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return [];

        const data = await res.json();
        if (!data.torrents || !Array.isArray(data.torrents)) return [];

        return data.torrents
            .filter((t) => t.hash)
            .map((t) => ({
                hash: t.hash.toLowerCase(),
                title: t.title || t.filename,
                size: parseInt(t.size_bytes, 10) || 0,
                seeds: parseInt(t.seeds, 10) || 0,
                source: 'EZTV',
            }));
    } catch (err) {
        console.error('[search] EZTV error:', err.message);
        return [];
    }
}

// Search YTS by IMDB ID (movies)
async function searchYTS(imdbId) {
    const domains = ['https://yts.lt'];

    for (const domain of domains) {
        try {
            const url = `${domain}/api/v2/list_movies.json?query_term=${imdbId}`;
            const res = await fetch(url, {
                headers: { 'User-Agent': BROWSER_UA },
                redirect: 'follow',
                signal: AbortSignal.timeout(10000),
            });
            if (!res.ok) {
                console.error(`[search] YTS ${domain} returned ${res.status}, trying next`);
                continue;
            }

            const data = await res.json();
            if (!data.data || !data.data.movies) return [];

            const results = [];
            for (const movie of data.data.movies) {
                if (!movie.torrents) continue;
                for (const t of movie.torrents) {
                    if (!t.hash) continue;
                    results.push({
                        hash: t.hash.toLowerCase(),
                        title: `${movie.title} (${movie.year}) [${t.quality}] [${t.type}]`,
                        size: parseInt(t.size_bytes, 10) || 0,
                        seeds: parseInt(t.seeds, 10) || 0,
                        source: 'YTS',
                        quality: t.quality,
                    });
                }
            }
            return results;
        } catch (err) {
            console.error(`[search] YTS error (${domain}):`, err.message);
        }
    }

    return [];
}

// Search TorrentGalaxy via HTML scraping
async function searchTorrentGalaxy(query) {
    const domains = ['https://torrentgalaxy.one'];

    for (const domain of domains) {
        try {
            const url = `${domain}/torrents.php?search=${encodeURIComponent(query)}&sort=seeders&order=desc`;
            const res = await fetch(url, {
                headers: { 'User-Agent': BROWSER_UA },
                redirect: 'follow',
                signal: AbortSignal.timeout(10000),
            });
            if (!res.ok) {
                console.error(`[search] TorrentGalaxy ${domain} returned ${res.status}, trying next`);
                continue;
            }

            const html = await res.text();
            const results = [];

            // Extract magnet links directly from search results page
            const magnetRegex = /href="(magnet:\?xt=urn:btih:[^"]+)"/g;
            const magnets = [];
            let m;
            while ((m = magnetRegex.exec(html)) !== null) {
                magnets.push(m[1]);
            }

            // Extract titles — they appear in links with class "txlight"
            const titleRegex = /<a class="txlight"[^>]*title="([^"]+)"/g;
            const titles = [];
            while ((m = titleRegex.exec(html)) !== null) {
                titles.push(m[1].trim());
            }

            // Extract sizes — they appear in <span class="badge badge-secondary">
            const sizeRegex = /<span class="badge badge-secondary"[^>]*>([^<]+)<\/span>/g;
            const sizes = [];
            while ((m = sizeRegex.exec(html)) !== null) {
                const sizeStr = m[1].trim();
                if (/\d/.test(sizeStr) && /[GMKT]B/i.test(sizeStr)) {
                    sizes.push(sizeStr);
                }
            }

            // Extract seeders
            const seedRegex = /<font color="green"[^>]*>\[<b>(\d+)<\/b>\]<\/font>/g;
            const seeds = [];
            while ((m = seedRegex.exec(html)) !== null) {
                seeds.push(parseInt(m[1], 10) || 0);
            }

            function parseSizeStr(str) {
                const sm = str.match(/([\d.]+)\s*(GB|MB|KB|TB)/i);
                if (!sm) return 0;
                const val = parseFloat(sm[1]);
                const unit = sm[2].toUpperCase();
                if (unit === 'TB') return Math.round(val * 1099511627776);
                if (unit === 'GB') return Math.round(val * 1073741824);
                if (unit === 'MB') return Math.round(val * 1048576);
                if (unit === 'KB') return Math.round(val * 1024);
                return 0;
            }

            for (let i = 0; i < magnets.length; i++) {
                const magnetUri = magnets[i];
                const hashMatch = magnetUri.match(/btih:([a-fA-F0-9]{40})/i)
                    || magnetUri.match(/btih:([a-zA-Z2-7]{32})/i);
                if (!hashMatch) continue;

                results.push({
                    hash: hashMatch[1].toLowerCase(),
                    title: titles[i] || 'Unknown',
                    size: sizes[i] ? parseSizeStr(sizes[i]) : 0,
                    seeds: seeds[i] || 0,
                    source: 'TGx',
                });
            }

            return results;
        } catch (err) {
            console.error(`[search] TorrentGalaxy error (${domain}):`, err.message);
        }
    }

    return [];
}

// Search Knaben meta-search engine via JSON API
async function searchKnaben(query) {
    try {
        const url = 'https://api.knaben.org/v1';
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': BROWSER_UA,
            },
            body: JSON.stringify({
                query,
                order_by: 'seeders',
                order_direction: 'desc',
                size: 50,
            }),
            redirect: 'follow',
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
            console.error(`[search] Knaben returned ${res.status}`);
            return [];
        }

        const data = await res.json();
        if (!data.hits || !Array.isArray(data.hits)) return [];

        return data.hits
            .filter((t) => t.hash)
            .map((t) => ({
                hash: t.hash.toLowerCase(),
                title: t.title || 'Unknown',
                size: parseInt(t.bytes, 10) || 0,
                seeds: parseInt(t.seeders, 10) || 0,
                source: 'Knaben',
            }));
    } catch (err) {
        console.error('[search] Knaben error:', err.message);
        return [];
    }
}

// Search Torrents-CSV — open-source torrent database
async function searchTorrentsCSV(query) {
    try {
        const url = `https://torrents-csv.com/service/search?q=${encodeURIComponent(query)}&size=50`;
        const res = await fetch(url, {
            headers: { 'User-Agent': BROWSER_UA },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return [];

        const data = await res.json();
        if (!data.torrents || !Array.isArray(data.torrents)) return [];

        return data.torrents
            .filter(t => t.infohash)
            .map(t => ({
                hash: t.infohash.toLowerCase(),
                title: t.name || 'Unknown',
                size: parseInt(t.size_bytes || t.size, 10) || 0,
                seeds: parseInt(t.seeders, 10) || 0,
                source: 'CSV',
            }));
    } catch (err) {
        console.error('[search] Torrents-CSV error:', err.message);
        return [];
    }
}

// Search Zilean — DMM hashlist database (supports IMDB ID lookup)
async function searchZilean(imdbId, season, episode) {
    try {
        const params = new URLSearchParams({ ImdbId: imdbId });
        if (season !== null && season !== undefined) params.set('Season', season);
        if (episode !== null && episode !== undefined) params.set('Episode', episode);

        const url = `https://zilean.elfhosted.com/dmm/filtered?${params}`;
        const res = await fetch(url, {
            headers: { 'User-Agent': BROWSER_UA },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return [];

        const data = await res.json();
        if (!Array.isArray(data)) return [];

        return data
            .filter(t => t.infoHash)
            .map(t => ({
                hash: t.infoHash.toLowerCase(),
                title: t.rawTitle || t.filename || 'Unknown',
                size: parseInt(t.size, 10) || 0,
                seeds: config.thresholds.zileanSeedBoost || 50, // Zilean doesn't track seeders — boost so they sort competitively
                source: 'Zilean',
            }));
    } catch (err) {
        console.error('[search] Zilean error:', err.message);
        return [];
    }
}

// Filter torrents to matching episode/season
function filterEpisode(torrents, season, episode) {
    const filtered = torrents.filter(t => {
        const parsed = parse(t.title);
        if (parsed.season === season && parsed.episode === episode) return true;
        if (parsed.season === season && parsed.episode === null) return true;
        return false;
    });
    return filtered.length > 0 ? filtered : torrents;
}

// Filter torrents to matching title (reject "Paradise PD" when looking for "Paradise")
function filterByTitle(torrents, title, year, type) {
    const normalizedReq = normalizeTitle(title);

    const filtered = torrents.filter(t => {
        const parsed = parse(t.title);
        const normalizedTorrent = normalizeTitle(parsed.title);

        // Title must match exactly after normalization
        if (normalizedTorrent !== normalizedReq) return false;

        // For movies: if both have a year, they must match
        if (type === 'movie' && year && parsed.year && parsed.year !== year) return false;

        return true;
    });

    return filtered.length > 0 ? filtered : torrents;
}

// Live search — queries all sources in parallel
async function liveSearch(imdbId, type, title, year, season, episode) {
    // Build search query
    let query = title;
    if (type === 'movie' && year) {
        query = `${title} ${year}`;
    } else if (type === 'series' && season !== null) {
        const se = `S${String(season).padStart(2, '0')}`;
        const ep = episode !== null ? `E${String(episode).padStart(2, '0')}` : '';
        query = `${title} ${se}${ep}`;
    }

    // Define all sources with names for reliability tracking
    const sources = [
        { name: 'TPB', fn: () => searchTPB(query) },
        { name: 'Knaben', fn: () => searchKnaben(query) },
        { name: 'CSV', fn: () => searchTorrentsCSV(query) },
        { name: 'Zilean', fn: () => searchZilean(imdbId, season, episode) },
    ];

    if (type === 'series') {
        sources.push({ name: 'EZTV', fn: () => searchEZTV(imdbId) });
    } else {
        sources.push({ name: 'YTS', fn: () => searchYTS(imdbId) });
        sources.push({ name: 'TGx', fn: () => searchTorrentGalaxy(query) });
    }

    // Skip disabled sources, track timing and success/failure for the rest
    const activeSources = [];
    for (const src of sources) {
        if (isSourceDisabled(src.name)) {
            console.log(`[search] Skipping ${src.name} — disabled after consecutive failures`);
            continue;
        }
        activeSources.push(src);
    }

    const totalSources = activeSources.length;
    const startTime = Date.now();

    // Wrap each search so we can collect partial results on timeout
    // and record reliability stats per source.
    const results = new Array(totalSources).fill(null);
    const wrapped = activeSources.map((src, i) => {
        const t0 = Date.now();
        return src.fn()
            .then(v => {
                // A well-formed array response (even empty) means the source is reachable
                // and working — don't penalise it for a title with no results.
                // Only network errors / non-array responses count as failures.
                const ok = Array.isArray(v);
                recordSourceResult(src.name, ok, Array.isArray(v) ? v.length : 0, Date.now() - t0);
                results[i] = Array.isArray(v) ? v : [];
            })
            .catch(() => {
                recordSourceResult(src.name, false, 0, Date.now() - t0);
                results[i] = [];
            });
    });

    let timedOut = false;
    const allDone = Promise.all(wrapped);
    let timeoutHandle;
    const timer = new Promise(resolve => {
        timeoutHandle = setTimeout(resolve, config.thresholds.searchGlobalTimeout || 15000);
    }).then(() => { timedOut = true; });

    // Race: either all searches finish, or the global timeout fires
    await Promise.race([allDone, timer]);
    clearTimeout(timeoutHandle);

    // Collect results — fulfilled searches have their array in results[i], pending ones are still null
    let all = [];
    let responded = 0;
    for (let i = 0; i < totalSources; i++) {
        if (results[i] !== null) {
            responded++;
            all.push(...results[i]);
        }
    }

    const elapsed = Date.now() - startTime;
    if (timedOut) {
        console.log(`[search] Global timeout after ${elapsed}ms — ${responded}/${totalSources} sources responded`);
    } else {
        console.log(`[search] ${responded}/${totalSources} sources responded in ${elapsed}ms`);
    }

    // Deduplicate by hash
    const seen = new Set();
    all = all.filter(t => {
        if (seen.has(t.hash)) return false;
        seen.add(t.hash);
        return true;
    });

    // Filter to matching title (reject "Paradise PD" when looking for "Paradise")
    all = filterByTitle(all, title, year, type);

    // Sort by seeds
    all.sort((a, b) => (b.seeds || 0) - (a.seeds || 0));

    console.log(`[search] Found ${all.length} torrents for "${title}" from ${new Set(all.map(t => t.source)).size} sources`);
    return all;
}

// Background refresh — fire and forget
function refreshInBackground(imdbId, type, title, year, season, episode, cacheKey) {
    liveSearch(imdbId, type, title, year, season, episode).then(torrents => {
        torrentDb.saveTorrents(imdbId, torrents);
        // Update in-memory cache with fresh data
        let filtered = filterByTitle(torrents, title, year, type);
        if (type === 'series' && season !== null && episode !== null) {
            filtered = filterEpisode(filtered, season, episode);
        }
        if (torrents.length > 0) {
            cache.set(cacheKey, filtered, CACHE_TTL);
        }
        console.log(`[search] Background refresh complete: ${torrents.length} torrents for "${title}"`);
    }).catch(err => {
        console.error(`[search] Background refresh failed for "${title}":`, err.message);
    });
}

// Main search function — SQLite first, live search as fallback
async function searchTorrents(imdbId, type, title, year, season, episode) {
    const cacheKey = `search:${imdbId}:${season || ''}:${episode || ''}`;

    // Check in-memory cache first (avoids SQLite reads for rapid re-requests)
    const memCached = cache.get(cacheKey);
    if (memCached) return memCached;

    // Check SQLite for persistent cached results
    const dbResults = torrentDb.getTorrents(imdbId);
    const isFresh = torrentDb.isFresh(imdbId);

    if (dbResults.length > 0) {
        // Convert DB rows to torrent objects
        let torrents = dbResults.map(r => ({
            hash: r.hash,
            title: r.title,
            size: r.size,
            seeds: r.seeds,
            source: r.source,
        }));

        // Filter to matching title (DB may contain wrong-title results)
        torrents = filterByTitle(torrents, title, year, type);

        // For series: filter to matching episode
        if (type === 'series' && season !== null && episode !== null) {
            torrents = filterEpisode(torrents, season, episode);
        }

        // Cache in memory for this session
        cache.set(cacheKey, torrents, CACHE_TTL);

        if (isFresh) {
            console.log(`[search] DB hit (fresh): ${torrents.length} torrents for "${title}"`);
            return torrents;
        }

        // Stale — return immediately but refresh in background
        console.log(`[search] DB hit (stale): ${torrents.length} torrents for "${title}" — refreshing in background`);
        refreshInBackground(imdbId, type, title, year, season, episode, cacheKey);
        return torrents;
    }

    // No DB results — do live search
    console.log(`[search] DB miss for "${title}" — searching live`);
    const torrents = await liveSearch(imdbId, type, title, year, season, episode);

    // Save to DB and memory cache
    torrentDb.saveTorrents(imdbId, torrents);

    // Filter to matching title, then filter episode for series
    let filtered = filterByTitle(torrents, title, year, type);
    if (type === 'series' && season !== null && episode !== null) {
        filtered = filterEpisode(filtered, season, episode);
    }

    cache.set(cacheKey, filtered, CACHE_TTL);
    return filtered;
}

module.exports = { searchTorrents, sourceStats };
