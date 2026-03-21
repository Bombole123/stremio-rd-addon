const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'torrents.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
    CREATE TABLE IF NOT EXISTS torrents (
        hash TEXT NOT NULL,
        imdb_id TEXT NOT NULL,
        title TEXT NOT NULL,
        size INTEGER DEFAULT 0,
        seeds INTEGER DEFAULT 0,
        source TEXT DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (hash, imdb_id)
    );
    CREATE INDEX IF NOT EXISTS idx_torrents_imdb ON torrents(imdb_id);
    CREATE INDEX IF NOT EXISTS idx_torrents_updated ON torrents(updated_at);
    CREATE INDEX IF NOT EXISTS idx_torrents_imdb_updated ON torrents(imdb_id, updated_at);

    CREATE TABLE IF NOT EXISTS video_hashes (
        cache_key TEXT PRIMARY KEY,
        video_hash TEXT NOT NULL,
        video_size INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hash_cache (
        hash TEXT PRIMARY KEY,
        availability TEXT NOT NULL,
        cached_at INTEGER NOT NULL
    );
`);

// Prepared statements for performance
const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO torrents (hash, imdb_id, title, size, seeds, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const selectByImdb = db.prepare(`
    SELECT hash, title, size, seeds, source, updated_at
    FROM torrents
    WHERE imdb_id = ?
    ORDER BY seeds DESC
`);

const getLastUpdated = db.prepare(`
    SELECT MAX(updated_at) as last_updated
    FROM torrents
    WHERE imdb_id = ?
`);

const deleteOldStmt = db.prepare('DELETE FROM torrents WHERE updated_at < ?');

// Video hash cache statements
const selectVideoHash = db.prepare('SELECT video_hash, video_size FROM video_hashes WHERE cache_key = ?');
const upsertVideoHash = db.prepare(`
    INSERT OR REPLACE INTO video_hashes (cache_key, video_hash, video_size, created_at)
    VALUES (?, ?, ?, ?)
`);
const deleteOldHashes = db.prepare('DELETE FROM video_hashes WHERE created_at < ?');

// RD hash availability cache statements
const selectHashCache = db.prepare('SELECT availability, cached_at FROM hash_cache WHERE hash = ?');
const upsertHashCache = db.prepare(`
    INSERT OR REPLACE INTO hash_cache (hash, availability, cached_at)
    VALUES (?, ?, ?)
`);
const deleteExpiredHashCache = db.prepare('DELETE FROM hash_cache WHERE cached_at < ?');

const insertMany = db.transaction((torrents, imdbId) => {
    const now = Date.now();
    for (const t of torrents) {
        insertStmt.run(t.hash, imdbId, t.title, t.size || 0, t.seeds || 0, t.source || '', now);
    }
});

// How old results can be before considered stale (6 hours)
const STALE_THRESHOLD = 6 * 60 * 60 * 1000;

function getTorrents(imdbId) {
    return selectByImdb.all(imdbId);
}

function isFresh(imdbId) {
    const row = getLastUpdated.get(imdbId);
    if (!row || !row.last_updated) return false;
    return (Date.now() - row.last_updated) < STALE_THRESHOLD;
}

function saveTorrents(imdbId, torrents) {
    if (!torrents || torrents.length === 0) return;
    insertMany(torrents, imdbId);
}

// Clean up old entries (older than 30 days for torrents/video_hashes, TTL-based for hash_cache)
function cleanup() {
    const start = Date.now();
    const cutoff = start - (30 * 24 * 60 * 60 * 1000);
    deleteOldStmt.run(cutoff);
    deleteOldHashes.run(cutoff);
    cleanExpiredHashCache();
    db.pragma('optimize');
    console.log(`[torrentDb] cleanup completed in ${Date.now() - start}ms`);
}

// Defer cleanup so it doesn't block module loading, then repeat every 24h
setTimeout(() => {
    cleanup();
    setInterval(cleanup, 24 * 60 * 60 * 1000).unref();
}, 0).unref();

function getVideoHash(cacheKey) {
    return selectVideoHash.get(cacheKey) || null;
}

function setVideoHash(cacheKey, videoHash, videoSize) {
    upsertVideoHash.run(cacheKey, videoHash, videoSize, Date.now());
}

function getCachedAvailability(hash) {
    const row = selectHashCache.get(hash.toLowerCase());
    if (!row) return null;
    const ttl = config.cacheTTL.hashCache || (6 * 60 * 60 * 1000);
    if (Date.now() - row.cached_at > ttl) return null;
    try {
        return JSON.parse(row.availability);
    } catch {
        return null;
    }
}

function setCachedAvailability(hash, availabilityObj) {
    upsertHashCache.run(hash.toLowerCase(), JSON.stringify(availabilityObj), Date.now());
}

function cleanExpiredHashCache() {
    const ttl = config.cacheTTL.hashCache || (6 * 60 * 60 * 1000);
    deleteExpiredHashCache.run(Date.now() - ttl);
}

module.exports = {
    getTorrents, isFresh, saveTorrents, getVideoHash, setVideoHash,
    getCachedAvailability, setCachedAvailability, cleanExpiredHashCache,
};
