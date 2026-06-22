const { Pool } = require('pg');
const config = require('./config');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
    connectionString: config.databaseUrl,
});

// Convert snake_case to camelCase
function toCamel(row) {
    if (!row) return row;
    const result = {};
    for (const [key, value] of Object.entries(row)) {
        const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        result[camelKey] = value;
    }
    return result;
}

async function query(sql, params = []) {
    const res = await pool.query(sql, params);
    return res.rows.map(row => toCamel(row));
}

async function queryOne(sql, params = []) {
    const rows = await query(sql, params);
    return rows.length ? rows[0] : null;
}

async function queryRaw(sql, params = []) {
    return pool.query(sql, params);
}

function generateId() {
    return uuidv4();
}

module.exports = { query, queryOne, queryRaw, pool, generateId };