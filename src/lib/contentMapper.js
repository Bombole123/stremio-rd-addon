const LANGUAGE_FLAGS = {
    english: '🇬🇧', spanish: '🇪🇸', french: '🇫🇷', german: '🇩🇪',
    italian: '🇮🇹', portuguese: '🇵🇹', russian: '🇷🇺', japanese: '🇯🇵',
    chinese: '🇨🇳', korean: '🇰🇷', hindi: '🇮🇳', arabic: '🇸🇦',
    dutch: '🇳🇱', swedish: '🇸🇪', danish: '🇩🇰', norwegian: '🇳🇴',
    finnish: '🇫🇮', polish: '🇵🇱', turkish: '🇹🇷', thai: '🇹🇭',
    czech: '🇨🇿', hungarian: '🇭🇺', romanian: '🇷🇴', greek: '🇬🇷',
    hebrew: '🇮🇱', indonesian: '🇮🇩', malay: '🇲🇾', vietnamese: '🇻🇳',
    ukrainian: '🇺🇦', bulgarian: '🇧🇬', croatian: '🇭🇷', serbian: '🇷🇸',
    slovak: '🇸🇰', slovenian: '🇸🇮', latvian: '🇱🇻', lithuanian: '🇱🇹',
    estonian: '🇪🇪', filipino: '🇵🇭', tamil: '🇮🇳', telugu: '🇮🇳',
    bengali: '🇧🇩', multi: '🌐',
    // 3-letter ISO 639-2/B and 639-2/T codes
    eng: '🇬🇧', spa: '🇪🇸', fra: '🇫🇷', fre: '🇫🇷', deu: '🇩🇪', ger: '🇩🇪',
    ita: '🇮🇹', por: '🇵🇹', rus: '🇷🇺', jpn: '🇯🇵', zho: '🇨🇳', chi: '🇨🇳',
    kor: '🇰🇷', hin: '🇮🇳', ara: '🇸🇦', nld: '🇳🇱', swe: '🇸🇪', dan: '🇩🇰',
    nor: '🇳🇴', fin: '🇫🇮', pol: '🇵🇱', tur: '🇹🇷', tha: '🇹🇭', ces: '🇨🇿',
    cze: '🇨🇿', hun: '🇭🇺', ron: '🇷🇴', rum: '🇷🇴', ell: '🇬🇷', gre: '🇬🇷',
    heb: '🇮🇱', ind: '🇮🇩', msa: '🇲🇾', may: '🇲🇾', vie: '🇻🇳', ukr: '🇺🇦',
    bul: '🇧🇬', hrv: '🇭🇷', srp: '🇷🇸', slk: '🇸🇰', slo: '🇸🇰', slv: '🇸🇮',
    lav: '🇱🇻', lit: '🇱🇹', est: '🇪🇪', fil: '🇵🇭', tam: '🇮🇳', tel: '🇮🇳',
    ben: '🇧🇩',
    // 2-letter codes PTT sometimes emits
    en: '🇬🇧', es: '🇪🇸', fr: '🇫🇷', de: '🇩🇪', it: '🇮🇹', pt: '🇵🇹',
    ru: '🇷🇺', ja: '🇯🇵', zh: '🇨🇳', ko: '🇰🇷', nl: '🇳🇱', sv: '🇸🇪',
    da: '🇩🇰', no: '🇳🇴', fi: '🇫🇮', pl: '🇵🇱', tr: '🇹🇷', th: '🇹🇭',
    cs: '🇨🇿', hu: '🇭🇺', ro: '🇷🇴', el: '🇬🇷', he: '🇮🇱', uk: '🇺🇦',
    bg: '🇧🇬', hr: '🇭🇷', sr: '🇷🇸', sk: '🇸🇰', sl: '🇸🇮',
};

const AUDIO_DISPLAY = {
    'dts-hd-ma': 'DTS-HD MA',
    'dts-hd': 'DTS-HD',
    'truehd': 'TrueHD',
    'atmos': 'Atmos',
    'dts': 'DTS',
    'eac3': 'DD+',
    'ac3': 'DD',
    'ddp': 'DD+',
    'dd': 'DD',
    'aac': 'AAC',
    'flac': 'FLAC',
    'mp3': 'MP3',
    'pcm': 'PCM',
    'opus': 'Opus',
};

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.min(
        Math.floor(Math.log(bytes) / Math.log(1024)),
        units.length - 1
    );
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatStreamName(parsed) {
    const parts = [parsed.quality];
    if (parsed.hdr) parts.push(parsed.hdr);
    const suffix = parts.filter(Boolean).join(' ');
    return suffix ? `RD⚡ ${suffix}` : 'RD⚡';
}

function formatStreamDescriptionFromSearch(torrentTitle, parsed, torrent, fileSize) {
    const lines = [];

    const displayTitle = torrentTitle.length > 80 ? torrentTitle.slice(0, 77) + '...' : torrentTitle;
    lines.push(`📄 ${displayTitle}`);

    const videoParts = [];
    if (parsed.quality) videoParts.push(parsed.quality);
    if (parsed.codec) videoParts.push(parsed.codec);
    if (parsed.source) videoParts.push(parsed.source);
    if (parsed.hdr) videoParts.push(parsed.hdr);
    if (parsed.bitDepth) videoParts.push(`${parsed.bitDepth}-bit`);
    if (parsed.remux) videoParts.push('REMUX');
    if (videoParts.length > 0) lines.push(`📹 ${videoParts.join(' | ')}`);

    const audioParts = [];
    if (parsed.audio) {
        const audioKey = parsed.audio.toLowerCase();
        let audioDisplay = AUDIO_DISPLAY[audioKey] || parsed.audio;
        if (parsed.channels) audioDisplay += ` ${parsed.channels}`;
        audioParts.push(audioDisplay);
    }
    const langs = parsed.language;
    if (langs) {
        const langArr = Array.isArray(langs) ? langs : [langs];
        const flags = langArr.map(l => LANGUAGE_FLAGS[l.toLowerCase()] || l);
        audioParts.push(flags.join(' '));
    }
    if (audioParts.length > 0) lines.push(`🔊 ${audioParts.join(' | ')}`);

    const statParts = [];
    if (torrent && torrent.seeds > 0) statParts.push(`👤 ${torrent.seeds}`);
    if (fileSize) statParts.push(`💾 ${formatBytes(fileSize)}`);
    if (torrent && torrent.source) statParts.push(`🔎 ${torrent.source}`);
    if (statParts.length > 0) lines.push(statParts.join(' | '));

    const tagParts = [];
    if (parsed.group) tagParts.push(parsed.group);
    if (parsed.extended) tagParts.push('EXTENDED');
    if (parsed.proper) tagParts.push('PROPER');
    if (parsed.repack) tagParts.push('REPACK');
    if (parsed.remastered) tagParts.push('REMASTERED');
    if (tagParts.length > 0) lines.push(`🏷️ ${tagParts.join(' | ')}`);

    return lines.join('\n');
}

module.exports = { formatBytes, formatStreamName, formatStreamDescriptionFromSearch };
