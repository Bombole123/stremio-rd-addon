const config = require('../config');
const rd = require('../lib/realDebrid');
const { getMetaByImdbId } = require('../lib/cinemeta');
const { parse } = require('../lib/nameParser');
const { formatStreamName, formatStreamDescriptionFromSearch } = require('../lib/contentMapper');
const { searchTorrents } = require('../lib/torrentSearch');
const { getVideoHash } = require('../lib/torrentDb');

function buildMultiCriteriaComparator(sortPriority) {
    const priority = sortPriority || ['quality', 'language', 'size', 'seeders', 'codec', 'source'];
    const qualityRank = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 };
    function codecRank(codec) {
        if (!codec) return 0;
        const c = codec.toLowerCase();
        if (c === 'x265' || c === 'hevc' || c === 'h.265' || c === 'h265') return 2;
        if (c === 'x264' || c === 'avc' || c === 'h.264' || c === 'h264') return 1;
        return 0;
    }
    const sourceRank = {
        'blu-ray': 5, 'bluray': 5, 'remux': 5,
        'web-dl': 4, 'webdl': 4,
        'webrip': 3, 'web': 3,
        'hdtv': 2, 'hdrip': 2,
        'dvdrip': 1, 'dvd': 1,
        'cam': 0, 'ts': 0, 'tc': 0, 'scr': 0,
    };
    function getSourceRank(source) {
        if (!source) return -1;
        return sourceRank[source.toLowerCase().replace(/[\s.]/g, '')] ?? -1;
    }
    function langRank(lang) {
        if (!lang) return 0;
        const l = Array.isArray(lang) ? lang[0] : lang;
        if (!l) return 0;
        const lower = l.toLowerCase();
        if (lower === 'english' || lower === 'eng' || lower === 'en') return 3;
        if (lower === 'multi') return 2;
        return 1; // other known language
    }
    const comparators = {
        quality: (a, b) => (qualityRank[b._quality] || 0) - (qualityRank[a._quality] || 0),
        language: (a, b) => langRank(b._language) - langRank(a._language),
        size: (a, b) => (b._size || 0) - (a._size || 0),
        seeders: (a, b) => (b._seeds || 0) - (a._seeds || 0),
        codec: (a, b) => codecRank(b._codec) - codecRank(a._codec),
        source: (a, b) => getSourceRank(b._source) - getSourceRank(a._source),
    };
    return (a, b) => {
        for (const criterion of priority) {
            const cmp = comparators[criterion];
            if (!cmp) continue;
            const result = cmp(a, b);
            if (result !== 0) return result;
        }
        return 0;
    };
}

async function streamHandler(type, id) {
    console.log(`[stream] Request: type=${type} id=${id}`);

    const parts = id.split(':');
    const imdbId = parts[0];
    const season = parts[1] ? parseInt(parts[1], 10) : null;
    const episode = parts[2] ? parseInt(parts[2], 10) : null;

    if (!imdbId.startsWith('tt')) {
        console.log(`[stream] Not an IMDB ID: ${imdbId}`);
        return { streams: [] };
    }

    // Step 1: Resolve IMDB ID to title via Cinemeta
    const meta = await getMetaByImdbId(type, imdbId);
    if (!meta) {
        console.log(`[stream] Could not resolve IMDB ID: ${imdbId}`);
        return { streams: [] };
    }

    if (!config.rdApiToken) {
        console.log('[stream] No RD token configured');
        return { streams: [] };
    }

    const label = season !== null
        ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
        : '';
    console.log(`[stream] Looking for: "${meta.name}" (${meta.year}) ${label}`);

    // Step 2: Search torrent indexers for hashes
    const torrents = await searchTorrents(imdbId, type, meta.name, meta.year, season, episode);
    if (torrents.length === 0) {
        console.log(`[stream] No torrents found from indexers`);
        return { streams: [] };
    }

    // Deduplicate by hash — keep the torrent with highest seed count
    const deduped = new Map();
    for (const torrent of torrents) {
        const existing = deduped.get(torrent.hash);
        if (!existing || (torrent.seeds || 0) > (existing.seeds || 0)) {
            deduped.set(torrent.hash, torrent);
        }
    }
    const uniqueTorrents = [...deduped.values()];
    console.log(`[stream] ${torrents.length} torrents deduplicated to ${uniqueTorrents.length}`);

    const hashes = uniqueTorrents.map((t) => t.hash);
    console.log(`[stream] Checking ${hashes.length} hashes against RD cache`);

    // Step 3: Check which hashes are cached
    const availability = await rd.checkInstantAvailability(config.rdApiToken, hashes);
    const torrentMap = new Map(uniqueTorrents.map((t) => [t.hash, t]));
    const streams = [];

    for (const hash of hashes) {
        const info = availability[hash];
        if (!info || !info.rd || info.rd.length === 0) continue;

        const torrent = torrentMap.get(hash);
        if (!torrent) continue;

        const parsed = parse(torrent.title);

        // Build resolve URL
        let resolveUrl = `${config.tunnelUrl}/resolve/${torrent.hash}`;
        const queryParams = [`type=${type}`];
        if (type === 'series' && season !== null && episode !== null) {
            queryParams.push(`season=${season}`);
            queryParams.push(`episode=${episode}`);
        }
        resolveUrl += '?' + queryParams.join('&');

        // Look up pre-computed OpenSubtitles hash for instant subtitle loading
        const hashKey = `${torrent.hash}:${season || ''}:${episode || ''}`;
        const cachedHash = getVideoHash(hashKey);

        const hints = {
            filename: torrent.title,
            bingeGroup: season !== null ? `rd-${torrent.hash}` : undefined,
        };
        if (cachedHash) {
            hints.videoHash = cachedHash.video_hash;
            hints.videoSize = cachedHash.video_size;
        } else if (torrent.size && type !== 'series') {
            // Only use torrent size for movies — for series, torrent.size is the whole pack
            hints.videoSize = torrent.size;
        }

        streams.push({
            url: resolveUrl,
            name: formatStreamName(parsed),
            description: formatStreamDescriptionFromSearch(torrent.title, parsed, torrent, torrent.size),
            behaviorHints: hints,
            _quality: parsed.quality || null,
            _size: torrent.size || 0,
            _seeds: torrent.seeds || 0,
            _codec: parsed.codec || null,
            _source: parsed.source || null,
            _language: parsed.language || null,
        });
    }

    console.log(`[stream] ${streams.length} cached streams found`);

    // Apply settings
    const { qualities, preferredCodec, maxFileSize } = config.settings;
    const enabledQualities = qualities || ['2160p', '1080p', '720p', '480p'];

    // Filter by enabled qualities
    let filtered = streams.filter((s) => {
        const q = s._quality || 'unknown';
        if (q === 'unknown') return true;
        return enabledQualities.includes(q);
    });
    if (filtered.length === 0) filtered = streams;

    // Filter by codec preference
    if (preferredCodec && preferredCodec !== 'all') {
        const codecFiltered = filtered.filter((s) => {
            const desc = (s.description || '').toLowerCase();
            if (preferredCodec === 'x265') return desc.includes('x265') || desc.includes('hevc');
            if (preferredCodec === 'x264') return desc.includes('x264') || desc.includes('avc');
            return true;
        });
        if (codecFiltered.length > 0) filtered = codecFiltered;
    }

    // Filter by max file size
    if (maxFileSize && maxFileSize > 0) {
        const maxBytes = maxFileSize * 1024 * 1024 * 1024;
        const sizeFiltered = filtered.filter((s) => !s._size || s._size <= maxBytes);
        if (sizeFiltered.length > 0) filtered = sizeFiltered;
    }

    // Sort with multi-criteria comparator and limit
    filtered.sort(buildMultiCriteriaComparator(config.settings.sortPriority));

    // Group by quality and limit per tier
    const perQuality = config.settings.maxPerQuality || 5;
    const qualityOrder = ['2160p', '1080p', '720p', '480p'];
    const grouped = {};
    for (const s of filtered) {
        const q = s._quality || 'unknown';
        if (!grouped[q]) grouped[q] = [];
        grouped[q].push(s);
    }
    const limited = [];
    for (const q of qualityOrder) {
        if (grouped[q]) limited.push(...grouped[q].slice(0, perQuality));
    }
    if (grouped['unknown']) limited.push(...grouped['unknown'].slice(0, perQuality));

    const cleaned = limited.map(({ _quality, _size, _seeds, _codec, _source, _language, ...rest }) => rest);

    console.log(`[stream] Returning ${cleaned.length} of ${streams.length} streams`);

    return { streams: cleaned };
}

module.exports = streamHandler;
