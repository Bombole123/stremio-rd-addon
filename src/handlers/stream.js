const config = require('../config');
const rd = require('../lib/realDebrid');
const { getMetaByImdbId } = require('../lib/cinemeta');
const { parse, parseEpisodeFromPath } = require('../lib/nameParser');
const { formatStreamName, formatStreamDescriptionFromSearch } = require('../lib/contentMapper');
const { searchTorrents } = require('../lib/torrentSearch');
const { getVideoHash } = require('../lib/torrentDb');
const { getCachedPack } = require('../lib/seasonPackCache');

// Single-flight deduplication for concurrent stream requests
const pendingStreams = new Map();

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
    const langAliases = {
        english: ['english', 'eng', 'en'],
        spanish: ['spanish', 'spa', 'es', 'español'],
        french: ['french', 'fra', 'fr', 'français'],
        german: ['german', 'ger', 'de', 'deu', 'deutsch'],
        italian: ['italian', 'ita', 'it'],
        portuguese: ['portuguese', 'por', 'pt'],
        russian: ['russian', 'rus', 'ru'],
        multi: ['multi', 'dual'],
    };
    function isLanguageMatch(lang, preferred) {
        const codes = langAliases[preferred] || [preferred];
        return codes.includes(lang);
    }
    function langRank(lang) {
        const preferred = (config.settings.preferredLanguage || 'english').toLowerCase();
        if (preferred === 'any') return 1;
        if (!lang) {
            // No language tag — if preferred is English, assume English (rank 3)
            return preferred === 'english' ? 3 : 0;
        }
        const l = Array.isArray(lang) ? lang[0] : lang;
        if (!l) return preferred === 'english' ? 3 : 0;
        const lower = l.toLowerCase();
        if (isLanguageMatch(lower, preferred)) return 3;
        if (lower === 'multi') return 2;
        // English still gets a small boost above other languages when not preferred
        if (preferred !== 'english' && (lower === 'english' || lower === 'eng' || lower === 'en')) return 1.5;
        return 1;
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

async function streamHandlerCore(type, id, options = {}) {
    const startTime = Date.now();
    const rdToken = options.rdToken || config.rdApiToken;
    const userId = options.userId || null;
    console.log(`[stream] Request: type=${type} id=${id}${userId ? ` user=${userId.slice(0, 8)}...` : ''}`);

    const parts = id.split(':');
    const imdbId = parts[0];
    const season = parts[1] ? parseInt(parts[1], 10) : null;
    const episode = parts[2] ? parseInt(parts[2], 10) : null;

    if (!imdbId.startsWith('tt')) {
        console.log(`[stream] Not an IMDB ID: ${imdbId}`);
        return { streams: [] };
    }

    // Step 1: Resolve IMDB ID to title via Cinemeta
    const metaStart = Date.now();
    const meta = await getMetaByImdbId(type, imdbId);
    const metaMs = Date.now() - metaStart;
    if (!meta) {
        console.log(`[stream] Could not resolve IMDB ID: ${imdbId}`);
        return { streams: [] };
    }

    if (!rdToken) {
        console.log('[stream] No RD token configured');
        return { streams: [] };
    }

    const label = season !== null
        ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
        : '';
    console.log(`[stream] Looking for: "${meta.name}" (${meta.year}) ${label}`);

    // Check season pack cache for instant results (already in RD from previous episode)
    let packStream = null;
    if (type === 'series' && season !== null && episode !== null) {
        const pack = getCachedPack(imdbId, season);
        if (pack && pack.files && pack.links) {
            const VIDEO_EXT = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|ts)$/i;
            const videoFiles = (pack.files || [])
                .filter(f => f.selected === 1 && VIDEO_EXT.test(f.path));
            const epFiles = videoFiles.filter(f => {
                const ep = parseEpisodeFromPath(f.path);
                return ep.season === season && ep.episode === episode;
            });
            if (epFiles.length > 0) {
                console.log(`[stream] Season pack hit for ${imdbId} S${season}`);
                const target = epFiles.reduce((best, f) =>
                    (f.bytes || 0) > (best.bytes || 0) ? f : best
                );
                // Map file to its link by position among selected files
                const selectedFiles = (pack.files || [])
                    .filter(f => f.selected === 1)
                    .sort((a, b) => a.id - b.id);
                const linkIndex = selectedFiles.findIndex(f => f.id === target.id);
                if (linkIndex !== -1 && linkIndex < pack.links.length) {
                    const resolveBase = userId ? `${config.tunnelUrl}/${userId}` : config.tunnelUrl;
                    const queryParams = [`type=${type}`, `imdbId=${imdbId}`, `season=${season}`, `episode=${episode}`];
                    const resolveUrl = `${resolveBase}/resolve/${pack.hash}?${queryParams.join('&')}`;
                    const parsed = parse(target.path.split('/').pop() || pack.hash);
                    const hints = {
                        filename: target.path.split('/').pop() || pack.hash,
                        bingeGroup: `rd-${pack.hash}`,
                    };
                    const hashKey = `${pack.hash}:${season}:${episode}`;
                    const cachedHash = getVideoHash(hashKey);
                    if (cachedHash) {
                        hints.videoHash = cachedHash.video_hash;
                        hints.videoSize = cachedHash.video_size;
                    } else if (target.bytes) {
                        hints.videoSize = target.bytes;
                    }
                    packStream = {
                        url: resolveUrl,
                        name: formatStreamName(parsed),
                        description: `${formatStreamDescriptionFromSearch(target.path.split('/').pop(), parsed, {}, target.bytes || 0)}\n[Instant - Season Pack]`,
                        behaviorHints: hints,
                        _quality: parsed.quality || null,
                        _size: target.bytes || 0,
                        _seeds: 9999, // Sort to top — already in RD
                        _codec: parsed.codec || null,
                        _source: parsed.source || null,
                        _language: parsed.language || null,
                    };
                }
            }
        }
    }

    // Step 2: Search torrent indexers for hashes
    const searchStart = Date.now();
    const torrents = await searchTorrents(imdbId, type, meta.name, meta.year, season, episode);
    const searchMs = Date.now() - searchStart;
    if (torrents.length === 0) {
        console.log(`[stream] No torrents found from indexers`);
        if (packStream) {
            const { _quality, _size, _seeds, _codec, _source, _language, ...packCleaned } = packStream;
            return { streams: [packCleaned] };
        }
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

    // Sort torrents by likelihood of being cached on RD before hash extraction
    uniqueTorrents.sort((a, b) => {
        // Highest seeds first
        const seedDiff = (b.seeds || 0) - (a.seeds || 0);
        if (seedDiff !== 0) return seedDiff;
        // Then by size descending
        return (b.size || 0) - (a.size || 0);
    });

    // Build torrent map with parsed quality for prioritized cache checking
    const torrentMap = new Map();
    for (const t of uniqueTorrents) {
        const parsed = parse(t.title);
        torrentMap.set(t.hash, { ...t, _parsedQuality: parsed.quality || 'unknown' });
    }

    const hashes = uniqueTorrents.map((t) => t.hash);
    console.log(`[stream] Checking ${hashes.length} hashes against RD cache`);

    // Step 3: Check which hashes are cached (parallel + prioritized + early termination)
    const cacheStart = Date.now();
    const availability = await rd.checkInstantAvailability(rdToken, hashes, torrentMap);
    const cacheMs = Date.now() - cacheStart;
    const streams = [];

    for (const hash of hashes) {
        const info = availability[hash];
        if (!info || !info.rd || info.rd.length === 0) continue;

        const torrent = torrentMap.get(hash);
        if (!torrent) continue;

        const parsed = parse(torrent.title);

        // Build resolve URL — include userId prefix for per-user routing
        const resolveBase = userId ? `${config.tunnelUrl}/${userId}` : config.tunnelUrl;
        let resolveUrl = `${resolveBase}/resolve/${torrent.hash}`;
        const queryParams = [`type=${type}`, `imdbId=${imdbId}`];
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
        }
        // Don't set videoSize from torrent.size — it's the whole torrent, not the video file.
        // Incorrect videoSize causes ExoPlayer audio desync. Only use the real file size
        // from OpenSubtitles hash computation (cachedHash above).

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

    // Filter by language preference
    const languageFilter = config.settings.languageFilter || 'all';
    if (languageFilter !== 'all') {
        const beforeLang = filtered.length;
        const langFiltered = filtered.filter((s) => {
            const langs = s._language;
            if (!langs || (Array.isArray(langs) && langs.length === 0)) return true; // keep unknown
            const langArr = Array.isArray(langs) ? langs : [langs];
            const lower = langArr.map(l => l.toLowerCase());
            if (languageFilter === 'english') {
                return lower.some(l => l === 'english' || l === 'eng' || l === 'en');
            }
            if (languageFilter === 'multi') {
                return lower.includes('multi') || langArr.length > 1;
            }
            return lower.some(l => l === languageFilter.toLowerCase());
        });
        if (langFiltered.length > 0) filtered = langFiltered;
        console.log(`[stream] Language filter: ${beforeLang - filtered.length} streams removed`);
    }

    // Filter by codec preference
    if (preferredCodec && preferredCodec !== 'all') {
        const codecFiltered = filtered.filter((s) => {
            if (!s._codec) return true; // keep streams with no detected codec
            const c = s._codec.toLowerCase();
            if (preferredCodec === 'x265') return c === 'x265' || c === 'h.265' || c === 'h265' || c === 'hevc';
            if (preferredCodec === 'x264') return c === 'x264' || c === 'h.264' || c === 'h264' || c === 'avc';
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

    // Prepend the season pack instant stream if we have one (already in RD)
    if (packStream) {
        const { _quality, _size, _seeds, _codec, _source, _language, ...packCleaned } = packStream;
        // Avoid duplicate if the same hash is already in the list
        const isDuplicate = cleaned.some(s => s.url === packCleaned.url);
        if (!isDuplicate) {
            cleaned.unshift(packCleaned);
        }
    }

    console.log(`[stream] Returning ${cleaned.length} of ${streams.length} streams`);
    console.log(`[stream] ${type}/${imdbId} | ${metaMs}ms meta | ${searchMs}ms search (${uniqueTorrents.length} torrents) | ${cacheMs}ms cache | ${streams.length} streams | ${Date.now() - startTime}ms total`);

    return { streams: cleaned };
}

async function streamHandler(type, id, options = {}) {
    const userId = options.userId || 'default';
    const dedupKey = `${userId}:${type}:${id}`;

    if (pendingStreams.has(dedupKey)) {
        console.log(`[stream] Dedup hit for ${dedupKey}`);
        return pendingStreams.get(dedupKey);
    }

    const promise = streamHandlerCore(type, id, options);
    pendingStreams.set(dedupKey, promise);
    promise.finally(() => pendingStreams.delete(dedupKey));

    return promise;
}

module.exports = streamHandler;
