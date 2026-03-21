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
    settings: { ...defaultSettings, ...(localConfig.settings || {}) },
    cacheTTL: {
        torrentList: 2 * 60 * 1000,   // 2 minutes
        torrentInfo: 5 * 60 * 1000,   // 5 minutes
        unrestrict: 30 * 60 * 1000,   // 30 minutes
        hashCache: 6 * 60 * 60 * 1000, // 6 hours — known-cached hashes
    },
    localConfigPath: LOCAL_CONFIG_PATH,
    loadLocalConfig,
    saveLocalConfig,
};
