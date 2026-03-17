const Cache = require('./cache');

const cache = new Cache();
const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours — titles don't change

async function getMetaByImdbId(type, imdbId) {
    const cacheKey = `cinemeta:${type}:${imdbId}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const url = `${CINEMETA_BASE}/meta/${type}/${imdbId}.json`;
    console.log(`[cinemeta] Fetching: ${url}`);

    const res = await fetch(url);
    if (!res.ok) {
        console.log(`[cinemeta] Failed: ${res.status}`);
        return null;
    }

    const data = await res.json();
    if (!data || !data.meta) return null;

    const result = {
        name: data.meta.name,
        year: data.meta.year ? parseInt(data.meta.year, 10) : null,
        imdbId: data.meta.imdb_id || imdbId,
        type: data.meta.type,
    };

    console.log(`[cinemeta] Resolved: "${result.name}" (${result.year})`);
    cache.set(cacheKey, result, CACHE_TTL);
    return result;
}

module.exports = { getMetaByImdbId };
