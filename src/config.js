require('dotenv').config();
const path = require('path');
const fs = require('fs');

const LOCAL_CONFIG_PATH = path.join(__dirname, '..', 'config.local.json');

function loadLocalConfig() {
    try {
        if (fs.existsSync(LOCAL_CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf-8'));
        }
    } catch (err) {
        console.error('[config] Failed to read config.local.json:', err.message);
    }
    return {};
}

function saveLocalConfig(data) {
    const existing = loadLocalConfig();
    const merged = { ...existing, ...data };
    fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(merged, null, 4) + '\n', 'utf-8');
    return merged;
}

const localConfig = loadLocalConfig();

const defaultSettings = {
    sortPriority: ['quality', 'language', 'size', 'seeders', 'codec', 'source'],
    maxPerQuality: 5,
    qualities: ['2160p', '1080p', '720p', '480p'],
    preferredCodec: 'all',
    languageFilter: 'all',
    maxFileSize: 0,
};

module.exports = {
    port: parseInt(process.env.PORT, 10) || 7000,
    hostIP: process.env.HOST_IP || localConfig.hostIP || '192.168.1.72',
    rdApiToken: process.env.RD_API_TOKEN || localConfig.rdApiToken || null,
    rdRefreshToken: localConfig.rdRefreshToken || null,
    rdClientId: localConfig.rdClientId || null,
    rdClientSecret: localConfig.rdClientSecret || null,
    rdTokenExpiry: localConfig.rdTokenExpiry || null,
    tunnelUrl: process.env.TUNNEL_URL || localConfig.tunnelUrl || 'https://stremio.bombole.org',
    rdApiBase: 'https://api.real-debrid.com/rest/1.0',
    tmdbApiKey: process.env.TMDB_API_KEY || localConfig.tmdbApiKey || null,
    settings: { ...defaultSettings, ...(localConfig.settings || {}) },
    cacheTTL: {
        torrentList: 2 * 60 * 1000,   // 2 minutes
        torrentInfo: 5 * 60 * 1000,   // 5 minutes
        unrestrict: 15 * 60 * 1000,   // 15 minutes — RD CDN links expire after ~30-60 min
        hashCache: 6 * 60 * 60 * 1000, // 6 hours — known-cached hashes
    },
    thresholds: {
        searchTimeout: 10000,        // ms — per-indexer fetch timeout
        searchGlobalTimeout: 15000,  // ms — max total time for all searches
        rdApiTimeout: 15000,         // ms — RD API request timeout
        rdRetryDelayMs: 1000,        // ms — initial delay for RD retry backoff
        rdMaxRetries: 3,             // max retries on 429/5xx
        magnetCheckLimit: 10,        // max hashes for add-magnet fallback
        magnetConcurrency: 3,        // parallel add-magnet checks at once
        maxPerTierCheck: 3,          // max hashes to check per quality tier
        minResultsPerTier: 2,        // stop early once we have this many per tier
        zileanSeedBoost: 50,         // synthetic seed count for Zilean results
    },
    localConfigPath: LOCAL_CONFIG_PATH,
    loadLocalConfig,
    saveLocalConfig,
};
