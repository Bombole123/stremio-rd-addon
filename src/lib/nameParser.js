const ptt = require('parse-torrent-title');

function parse(filename) {
    const info = ptt.parse(filename);

    let type = 'other';
    if (info.season !== undefined || info.episode !== undefined) {
        type = 'series';
    } else if (info.year) {
        type = 'movie';
    }

    // HDR detection — parse-torrent-title has no HDR handler; detect it manually
    let hdr = null;
    const hdrMatch = filename.match(/\b(DV|DoVi|Dolby[\s.]?Vision)\b/i);
    const hdr10Match = filename.match(/\b(HDR10\+?|HDR)\b/i);
    if (hdrMatch) hdr = 'DV';
    if (hdr10Match) hdr = hdr ? `${hdr} ${hdr10Match[1].toUpperCase()}` : hdr10Match[1].toUpperCase();

    return {
        title: info.title || filename,
        year: info.year || null,
        season: info.season !== undefined ? info.season : null,
        episode: info.episode !== undefined ? info.episode : null,
        quality: info.resolution || null,
        codec: info.codec || null,
        source: info.source || null,
        type,
        audio: info.audio || null,
        channels: info.channels || null,
        bitDepth: info.bitdepth || null,
        hdr: hdr,
        group: info.group || null,
        service: info.service || null,
        language: info.language || null,
        extended: info.extended || false,
        remux: info.remux || false,
        proper: info.proper || false,
        repack: info.repack || false,
        remastered: info.remastered || false,
    };
}

function parseEpisodeFromPath(filePath) {
    const filename = filePath.split('/').pop();
    const info = ptt.parse(filename);
    return {
        title: info.title || filename,
        season: info.season !== undefined ? info.season : null,
        episode: info.episode !== undefined ? info.episode : null,
    };
}

module.exports = { parse, parseEpisodeFromPath };
