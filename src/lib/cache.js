class Cache {
    constructor(defaultTTL = 120000) {
        this.store = new Map();
        this.defaultTTL = defaultTTL;
    }

    get(key) {
        const entry = this.store.get(key);
        if (!entry) return undefined;
        if (Date.now() > entry.expires) {
            this.store.delete(key);
            return undefined;
        }
        return entry.value;
    }

    set(key, value, ttl) {
        this.store.set(key, {
            value,
            expires: Date.now() + (ttl || this.defaultTTL),
        });
    }

    invalidate(key) {
        this.store.delete(key);
    }

    clear() {
        this.store.clear();
    }
}

module.exports = Cache;
