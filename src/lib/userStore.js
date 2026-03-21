const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERS_PATH = path.join(__dirname, '..', '..', 'data', 'users.json');

function loadUsers() {
    try {
        if (fs.existsSync(USERS_PATH)) {
            return JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
        }
    } catch (err) {
        console.error('[userStore] Failed to read users.json:', err.message);
    }
    return {};
}

function saveUsers(users) {
    const dir = path.dirname(USERS_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 4) + '\n', 'utf-8');
}

function createUser(rdCredentials) {
    const users = loadUsers();
    const userId = crypto.randomUUID();
    users[userId] = {
        ...rdCredentials,
        created: new Date().toISOString(),
    };
    saveUsers(users);
    console.log(`[userStore] Created user ${userId} (${rdCredentials.username || 'unknown'})`);
    return userId;
}

function getUser(userId) {
    const users = loadUsers();
    return users[userId] || null;
}

function updateUser(userId, data) {
    const users = loadUsers();
    if (!users[userId]) return null;
    users[userId] = { ...users[userId], ...data };
    saveUsers(users);
    return users[userId];
}

function deleteUser(userId) {
    const users = loadUsers();
    if (!users[userId]) return false;
    delete users[userId];
    saveUsers(users);
    console.log(`[userStore] Deleted user ${userId}`);
    return true;
}

function listUsers() {
    const users = loadUsers();
    return Object.entries(users).map(([id, u]) => ({
        userId: id,
        username: u.username || null,
        created: u.created || null,
    }));
}

module.exports = { createUser, getUser, updateUser, deleteUser, listUsers };
