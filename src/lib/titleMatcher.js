const { parse, parseEpisodeFromPath } = require('./nameParser');

// Normalize a title for comparison: lowercase, remove non-alphanumeric
function normalize(title) {
    return title
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]/g, '')
        .trim();
}

// Check if a torrent filename matches a target title/year
function matchesTorrent(torrent, targetTitle, targetYear) {
    const parsed = parse(torrent.filename);
    const normalizedTarget = normalize(targetTitle);
    const normalizedParsed = normalize(parsed.title);

    // Exact normalized match
    if (normalizedParsed === normalizedTarget) {
        // If both have years, they must match
        if (targetYear && parsed.year && parsed.year !== targetYear) return false;
        return true;
    }

    // Check if one contains the other (for titles with subtitles, etc.)
    if (normalizedParsed.includes(normalizedTarget) || normalizedTarget.includes(normalizedParsed)) {
        if (targetYear && parsed.year && parsed.year !== targetYear) return false;
        // Require year match for substring matches to avoid false positives
        if (targetYear && parsed.year && parsed.year === targetYear) return true;
        // If no year info, accept substring match only if lengths are close
        if (!targetYear || !parsed.year) {
            const lenRatio = Math.min(normalizedParsed.length, normalizedTarget.length) /
                             Math.max(normalizedParsed.length, normalizedTarget.length);
            return lenRatio > 0.7;
        }
    }

    return false;
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
