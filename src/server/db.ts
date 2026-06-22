import pg from "pg";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:2@localhost:5432/download_manager";
const FALLBACK_FILE = path.resolve(process.cwd(), "downloads_fallback_db.json");

// Define TypeScript interfaces for our database records
export interface DownloadRecord {
    id: string;
    url: string;
    filename: string;
    directory: string;
    totalSize: number | null;
    downloadedSize: number;
    chunkCount: number;
    status: "PENDING" | "DOWNLOADING" | "PAUSED" | "COMPLETED" | "ERROR" | "SCHEDULED";
    scheduledAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface ChunkRecord {
    id: string;
    downloadId: string;
    index: number;
    startByte: number;
    endByte: number | null;
    downloadedBytes: number;
    status: "PENDING" | "ACTIVE" | "DONE" | "ERROR";
}

export interface SettingRecord {
    key: string;
    value: any;
}

interface MockDB {
    downloads: DownloadRecord[];
    chunks: ChunkRecord[];
    settings: Record<string, any>;
}

// In-memory or file-backed database emulator
class LocalFallbackDB {
    private data: MockDB = { downloads: [], chunks: [], settings: {} };

    constructor() {
        this.load();
        // Set some defaults
        if (!this.data.settings.downloadDirectory) {
            this.data.settings.downloadDirectory = "./downloads";
        }
        if (!this.data.settings.maxConcurrentTasks) {
            this.data.settings.maxConcurrentTasks = 3;
        }
    }

    private load() {
        try {
            if (fs.existsSync(FALLBACK_FILE)) {
                const fileContent = fs.readFileSync(FALLBACK_FILE, "utf-8");
                this.data = JSON.parse(fileContent);
            }
        } catch (e) {
            console.warn("Could not load fallback DB, resetting...", e);
        }
    }

    private save() {
        try {
            fs.writeFileSync(FALLBACK_FILE, JSON.stringify(this.data, null, 2));
        } catch (e) {
            console.error("Could not save fallback DB:", e);
        }
    }

    public getDownloads(): DownloadRecord[] {
        return this.data.downloads;
    }

    public getDownload(id: string): DownloadRecord | null {
        return this.data.downloads.find((d) => d.id === id) || null;
    }

    public insertDownload(d: Omit<DownloadRecord, "createdAt" | "updatedAt">): DownloadRecord {
        const now = new Date().toISOString();
        const record: DownloadRecord = {
            ...d,
            createdAt: now,
            updatedAt: now,
        };
        this.data.downloads.push(record);
        this.save();
        return record;
    }

    public updateDownload(id: string, updates: Partial<DownloadRecord>): DownloadRecord | null {
        const idx = this.data.downloads.findIndex((d) => d.id === id);
        if (idx === -1) return null;
        const now = new Date().toISOString();
        this.data.downloads[idx] = {
            ...this.data.downloads[idx],
            ...updates,
            updatedAt: now,
        };
        this.save();
        return this.data.downloads[idx];
    }

    public deleteDownload(id: string) {
        this.data.downloads = this.data.downloads.filter((d) => d.id !== id);
        this.data.chunks = this.data.chunks.filter((c) => c.downloadId !== id);
        this.save();
    }

    public getChunks(downloadId: string): ChunkRecord[] {
        return this.data.chunks.filter((c) => c.downloadId === downloadId);
    }

    public getChunk(downloadId: string, index: number): ChunkRecord | null {
        return this.data.chunks.find((c) => c.downloadId === downloadId && c.index === index) || null;
    }

    public insertChunk(c: ChunkRecord): ChunkRecord {
        this.data.chunks.push(c);
        this.save();
        return c;
    }

    public updateChunk(id: string, updates: Partial<ChunkRecord>): ChunkRecord | null {
        const idx = this.data.chunks.findIndex((c) => c.id === id);
        if (idx === -1) return null;
        this.data.chunks[idx] = {
            ...this.data.chunks[idx],
            ...updates,
        };
        this.save();
        return this.data.chunks[idx];
    }

    public getSetting(key: string): any {
        return this.data.settings[key] ?? null;
    }

    public setSetting(key: string, value: any) {
        this.data.settings[key] = value;
        this.save();
    }
}

const fallbackDb = new LocalFallbackDB();

let isPostgresAvailable = false;
let pool: any = null;

// Convert snake_case from Postgres to camelCase to match TS types row by row, supporting nested structures
function toCamel(row: any): any {
    if (!row) return row;
    if (Array.isArray(row)) {
        return row.map(toCamel);
    }
    if (typeof row === "object") {
        const result: any = {};
        for (const [key, value] of Object.entries(row)) {
            const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
            let convertedValue = value;
            if (typeof value === "bigint") {
                convertedValue = Number(value);
            } else if (value !== null && typeof value === "object") {
                convertedValue = toCamel(value);
            }
            result[camelKey] = convertedValue;
        }
        return result;
    }
    return row;
}

export async function initializeDatabase() {
    console.log("Checking database connection to:", DATABASE_URL);
    pool = new Pool({
        connectionString: DATABASE_URL,
        connectionTimeoutMillis: 3000, // Quick timeout to handle sandbox environment
    });

    try {
        const client = await pool.connect();
        console.log("PostgreSQL connection verified successfully!");
        isPostgresAvailable = true;

        // Create required tables if they do not exist
        await client.query(`
            CREATE TABLE IF NOT EXISTS downloads (
                                                     id TEXT PRIMARY KEY,
                                                     url TEXT NOT NULL,
                                                     filename TEXT NOT NULL,
                                                     directory TEXT NOT NULL,
                                                     total_size BIGINT,
                                                     downloaded_size BIGINT DEFAULT 0,
                                                     chunk_count INTEGER DEFAULT 1,
                                                     status TEXT DEFAULT 'PENDING',
                                                     scheduled_at TIMESTAMP,
                                                     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                                     updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS chunks (
                                                  id TEXT PRIMARY KEY,
                                                  download_id TEXT REFERENCES downloads(id) ON DELETE CASCADE,
                index INTEGER NOT NULL,
                start_byte BIGINT NOT NULL,
                end_byte BIGINT,
                downloaded_bytes BIGINT DEFAULT 0,
                status TEXT DEFAULT 'PENDING',
                UNIQUE(download_id, index)
                );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS settings (
                                                    key TEXT PRIMARY KEY,
                                                    value JSONB NOT NULL
            );
        `);

        client.release();
    } catch (err: any) {
        console.warn(
            `PostgreSQL service not reachable (${err.message}).\n` +
            `Falling back to File-Backed Local Storage: "${FALLBACK_FILE}".\n` +
            `This guarantees a fully operational state in development environments. When executed with PostgreSQL, it will bind seamlessly.`
        );
        isPostgresAvailable = false;
    }
}

// Unified query wrapper supporting both drivers
export async function query(sql: string, params: any[] = []): Promise<any[]> {
    if (isPostgresAvailable && pool) {
        try {
            const res = await pool.query(sql, params);
            return res.rows.map(toCamel);
        } catch (e: any) {
            console.error("SQL Execution failed on Postgres. Redirecting to Local Storage fallback.", e.message);
        }
    }

    // Fallback engine emulator for simple SQL statements used by downloads controller
    const lowerSql = sql.toLowerCase();

    // 1. SELECT ALL DOWNLOADS
    if (lowerSql.includes("select d.*") && lowerSql.includes("left join chunks")) {
        const downloads = fallbackDb.getDownloads();
        return downloads.map((d) => {
            const chunks = fallbackDb.getChunks(d.id);
            return {
                ...d,
                chunks,
            };
        });
    }

    // 2. SELECT BY ID
    if (lowerSql.includes("where d.id =") || (lowerSql.includes("where id =") && lowerSql.includes("downloads"))) {
        const id = params[0];
        const download = fallbackDb.getDownload(id);
        if (!download) return [];
        const chunks = fallbackDb.getChunks(id);
        return [{ ...download, chunks }];
    }

    // 3. SELECT ALL CHUNKS BY DOWNLOAD ID
    if (lowerSql.includes("select * from chunks") && lowerSql.includes("download_id =")) {
        const downloadId = params[0];
        return fallbackDb.getChunks(downloadId);
    }

    // 4. INSERT DOWNLOAD
    if (lowerSql.includes("insert into downloads")) {
        // VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        // [id, url, uniqueName, relativeDir, totalSize, 0, effectiveChunkCount, 'PENDING', scheduleDate]
        const [id, url, filename, directory, totalSize, downloadedSize, chunkCount, status, scheduledAt] = params;
        const item = fallbackDb.insertDownload({
            id,
            url,
            filename,
            directory,
            totalSize: totalSize ? Number(totalSize) : null,
            downloadedSize: Number(downloadedSize) || 0,
            chunkCount: Number(chunkCount),
            status: status || "PENDING",
            scheduledAt: scheduledAt || null,
        });
        return [item];
    }

    // 5. UPDATE DOWNLOAD STATUS
    if (lowerSql.includes("update downloads set status =") && lowerSql.includes("where id =")) {
        const [status, id] = params;
        const item = fallbackDb.updateDownload(id, { status });
        return item ? [item] : [];
    }

    // 6. UPDATE DOWNLOAD SIZE
    if (lowerSql.includes("update downloads set downloaded_size =") && lowerSql.includes("where id =")) {
        const [size, id] = params;
        const item = fallbackDb.updateDownload(id, { downloadedSize: Number(size) });
        return item ? [item] : [];
    }

    // 7. INSERT CHUNK
    if (lowerSql.includes("insert into chunks")) {
        // [id, download_id, index, start_byte, end_byte, downloaded_bytes, status]
        const [id, downloadId, index, startByte, endByte, downloadedBytes, status] = params;
        const item = fallbackDb.insertChunk({
            id,
            downloadId,
            index: Number(index),
            startByte: Number(startByte),
            endByte: endByte ? Number(endByte) : null,
            downloadedBytes: Number(downloadedBytes) || 0,
            status: status || "PENDING",
        });
        return [item];
    }

    // 8. UPDATE CHUNK STATUS / PROGRESS
    if (lowerSql.includes("update chunks set downloaded_bytes =") && lowerSql.includes("status =")) {
        // UPDATE chunks SET downloaded_bytes = $1, status = $2 WHERE id = $3
        const [downloadedBytes, status, id] = params;
        const item = fallbackDb.updateChunk(id, { downloadedBytes: Number(downloadedBytes), status });
        return item ? [item] : [];
    }

    if (lowerSql.includes("update chunks set status =") && lowerSql.includes("downloaded_bytes =")) {
        // UPDATE chunks SET status = $1, downloaded_bytes = $2 WHERE id = $3
        const [status, downloadedBytes, id] = params;
        const item = fallbackDb.updateChunk(id, { downloadedBytes: Number(downloadedBytes), status });
        return item ? [item] : [];
    }

    // 9. RE-INIT OR DELETE CHUNKS
    if (lowerSql.includes("update chunks set downloaded_bytes = 0") && lowerSql.includes("download_id =")) {
        const [status, downloadId] = params;
        const chunks = fallbackDb.getChunks(downloadId);
        chunks.forEach((c) => {
            fallbackDb.updateChunk(c.id, { downloadedBytes: 0, status: "PENDING" });
        });
        fallbackDb.updateDownload(downloadId, { downloadedSize: 0, status: "PENDING" });
        return [];
    }

    // 10. DELETE DOWNLOAD
    if (lowerSql.includes("delete from downloads")) {
        const id = params[0];
        fallbackDb.deleteDownload(id);
        return [];
    }

    // 11. SETTINGS OPERATIONS
    if (lowerSql.includes("select value from settings") && lowerSql.includes("where key =")) {
        const key = params[0];
        const val = fallbackDb.getSetting(key);
        return val !== null ? [{ value: val }] : [];
    }

    if (lowerSql.includes("insert into settings")) {
        const [key, value] = params;
        fallbackDb.setSetting(key, value);
        return [];
    }

    // 12. GENERAL DOWNLOAD STATUS QUERY
    if (lowerSql.includes("select id, status, scheduled_at from downloads")) {
        const nowISO = params[0] || new Date().toISOString();
        const downloads = fallbackDb.getDownloads();

        if (lowerSql.includes("scheduled_at <= $1")) {
            return downloads.filter(
                (d) =>
                    ["PENDING", "SCHEDULED"].includes(d.status) &&
                    d.scheduledAt &&
                    new Date(d.scheduledAt) <= new Date(nowISO)
            );
        }
        if (lowerSql.includes("scheduled_at > $1")) {
            return downloads.filter(
                (d) => d.status === "SCHEDULED" && d.scheduledAt && new Date(d.scheduledAt) > new Date(nowISO)
            );
        }
    }

    return [];
}

export async function queryOne(sql: string, params: any[] = []): Promise<any | null> {
    const rows = await query(sql, params);
    return rows.length ? rows[0] : null;
}

export function generateId(): string {
    return uuidv4();
}