const CHUNK_SIZE = 65536; // 64 KB

/**
 * Compute the OpenSubtitles hash for a remote file.
 * Algorithm: sum of 64-bit LE ints from first 64KB + last 64KB + file size,
 * truncated to 64 bits, returned as 16-char hex string.
 */
async function computeOpenSubHash(url, fileSize) {
    if (!fileSize || fileSize < CHUNK_SIZE * 2) return null;

    // Fetch first and last 64 KB in parallel
    const [firstResp, lastResp] = await Promise.all([
        fetch(url, { headers: { Range: `bytes=0-${CHUNK_SIZE - 1}` } }),
        fetch(url, { headers: { Range: `bytes=${fileSize - CHUNK_SIZE}-${fileSize - 1}` } }),
    ]);
    if (!firstResp.ok || !lastResp.ok) return null;
    const [firstBuf, lastBuf] = await Promise.all([
        firstResp.arrayBuffer().then(Buffer.from),
        lastResp.arrayBuffer().then(Buffer.from),
    ]);
    if (firstBuf.length < CHUNK_SIZE || lastBuf.length < CHUNK_SIZE) return null;

    // Sum all 64-bit LE integers from both chunks + file size
    let hash = BigInt(fileSize);
    for (let i = 0; i < CHUNK_SIZE; i += 8) {
        hash += firstBuf.readBigUInt64LE(i);
        hash += lastBuf.readBigUInt64LE(i);
    }
    hash = hash & 0xFFFFFFFFFFFFFFFFn;

    return hash.toString(16).padStart(16, '0');
}

module.exports = { computeOpenSubHash };
