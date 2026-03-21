const Cache = require('./cache');

// Cache: "imdbId:season" -> { torrentId, hash, files, links }
const packCache = new Cache();
const PACK_TTL = 4 * 60 * 60 * 1000; // 4 hours

function getCachedPack(imdbId, season) {
    return packCache.get(`${imdbId}:${season}`);
}

function setCachedPack(imdbId, season, data) {
    packCache.set(`${imdbId}:${season}`, data, PACK_TTL);
}

module.exports = { getCachedPack, setCachedPack };
