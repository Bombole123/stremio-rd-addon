const Cache = require('./cache');
const { getCachedSeasonPack, setCachedSeasonPack } = require('./torrentDb');

// L1: in-memory cache for fast access
// L2: SQLite via torrentDb for persistence across restarts
const packCache = new Cache();
const PACK_TTL = 4 * 60 * 60 * 1000; // 4 hours

function getCachedPack(imdbId, season) {
    const key = `${imdbId}:${season}`;

    // L1: check in-memory first
    const memCached = packCache.get(key);
    if (memCached) return memCached;

    // L2: check SQLite
    const dbCached = getCachedSeasonPack(key);
    if (dbCached) {
        // Promote to L1
        packCache.set(key, dbCached, PACK_TTL);
        return dbCached;
    }

    return null;
}

function setCachedPack(imdbId, season, data) {
    const key = `${imdbId}:${season}`;

    // Write to both L1 and L2
    packCache.set(key, data, PACK_TTL);
    setCachedSeasonPack(key, data);
}

module.exports = { getCachedPack, setCachedPack };
