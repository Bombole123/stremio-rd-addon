const { parse, parseEpisodeFromPath } = require('./nameParser');

// Normalize a title for comparison: lowercase, remove non-alphanumeric
function normalize(title) {
    return title
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]/g, '')
        .trim();
}

// Extract significant words from a title for fuzzy matching
const STOP_WORDS = new Set(['a', 'an']);
function titleWords(title) {
    return title.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9\s]/g, '').split(/\s+/)
        .filter(w => w.length > 0 && !STOP_WORDS.has(w));
}

// Check if a torrent filename matches a target title/year
function matchesTorrent(torrent, targetTitle, targetYear) {
    const parsed = parse(torrent.filename);

    // Year mismatch — reject early
    if (targetYear && parsed.year && parsed.year !== targetYear) return false;

    // Exact normalized match
    if (normalize(parsed.title) === normalize(targetTitle)) return true;

    // Word-overlap matching
    const reqWords = titleWords(targetTitle);
    if (reqWords.length === 0) return true;
    const torrentWords = new Set(titleWords(parsed.title));
    let matches = 0;
    for (const w of reqWords) {
        if (torrentWords.has(w)) matches++;
    }
    const overlap = matches / reqWords.length;

    // Short titles: all words must match, torrent word count must be close
    if (reqWords.length <= 2) {
        if (overlap < 1.0) return false;
        return torrentWords.size <= reqWords.length;
    }
    return overlap >= 0.7;
}

// Find video files in a torrent that match a specific season/episode
const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts)$/i;

function findEpisodeFiles(files, season, episode) {
    const selectedFiles = files
        .filter((f) => f.selected === 1 && VIDEO_EXTENSIONS.test(f.path))
        .sort((a, b) => a.id - b.id);

    if (season === null && episode === null) {
        // Movie — return all video files
        return selectedFiles;
    }

    // Series — find files matching season/episode
    const matches = selectedFiles.filter((f) => {
        const ep = parseEpisodeFromPath(f.path);
        if (season !== null && episode !== null) {
            return ep.season === season && ep.episode === episode;
        }
        if (season !== null) {
            return ep.season === season;
        }
        return true;
    });

    return matches;
}

module.exports = { normalize, matchesTorrent, findEpisodeFiles, VIDEO_EXTENSIONS };
