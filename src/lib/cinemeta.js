const Cache = require('./cache');
const config = require('../config');

const cache = new Cache();
const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours — titles don't change

async function fetchFromCinemeta(type, imdbId) {
    const url = `${CINEMETA_BASE}/meta/${type}/${imdbId}.json`;
    console.log(`[cinemeta] Fetching: ${url}`);

    const res = await fetch(url);
    if (!res.ok) {
        console.log(`[cinemeta] Failed: ${res.status}`);
        return null;
    }

    const data = await res.json();
    if (!data || !data.meta) return null;

    return {
        name: data.meta.name,
        year: data.meta.year ? parseInt(data.meta.year, 10) : null,
        imdbId: data.meta.imdb_id || imdbId,
        type: data.meta.type,
    };
}

async function fetchFromTMDB(type, imdbId) {
    const apiKey = config.tmdbApiKey;
    if (!apiKey) return null;

    const url = `${TMDB_BASE}/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id`;
    console.log(`[meta] Fetching TMDB: ${url.replace(apiKey, '***')}`);

    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
        console.log(`[meta] TMDB failed: ${res.status}`);
        return null;
    }

    const data = await res.json();

    // Try movie results first, then TV
    const movie = data.movie_results && data.movie_results[0];
    if (movie) {
        const year = movie.release_date ? parseInt(movie.release_date.slice(0, 4), 10) : null;
        return {
            name: movie.title,
            year,
            imdbId,
            type: 'movie',
        };
    }

    const tv = data.tv_results && data.tv_results[0];
    if (tv) {
        const year = tv.first_air_date ? parseInt(tv.first_air_date.slice(0, 4), 10) : null;
        return {
            name: tv.name,
            year,
            imdbId,
            type: 'series',
        };
    }

    return null;
}

async function getMetaByImdbId(type, imdbId) {
    const cacheKey = `cinemeta:${type}:${imdbId}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    // Try Cinemeta first
    let result = null;
    try {
        result = await fetchFromCinemeta(type, imdbId);
    } catch (err) {
        console.log(`[cinemeta] Error: ${err.message}`);
    }

    if (result) {
        console.log(`[cinemeta] Resolved: "${result.name}" (${result.year})`);
        cache.set(cacheKey, result, CACHE_TTL);
        return result;
    }

    // Cinemeta failed — try TMDB if API key is configured
    if (config.tmdbApiKey) {
        console.log('[meta] Cinemeta failed, falling back to TMDB');
        try {
            result = await fetchFromTMDB(type, imdbId);
        } catch (err) {
            console.log(`[meta] TMDB error: ${err.message}`);
        }

        if (result) {
            console.log(`[meta] TMDB resolved: "${result.name}" (${result.year})`);
            cache.set(cacheKey, result, CACHE_TTL);
            return result;
        }
    }

    return null;
}

module.exports = { getMetaByImdbId };
