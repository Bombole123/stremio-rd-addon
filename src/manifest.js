module.exports = {
    id: 'community.realdebrid.streams',
    version: '2.0.0',
    name: 'Real-Debrid Streams',
    description: 'Stream torrents from your Real-Debrid library for any movie or series in Stremio',
    logo: 'https://fcdn.real-debrid.com/0830/favicons/favicon.ico',
    resources: [
        {
            name: 'stream',
            types: ['movie', 'series'],
            idPrefixes: ['tt'],
        },
    ],
    types: ['movie', 'series'],
    catalogs: [],
    behaviorHints: {
        configurable: true,
        configurationRequired: false,
    },
};
