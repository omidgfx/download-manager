import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import cors from "cors";
import axios from "axios";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";

import { initializeDatabase, query, queryOne, generateId } from "./src/server/db";
import { initSettings, getSetting, setSetting } from "./src/server/settings";
import { initScheduler, scheduleDownload, cancelScheduledJob } from "./src/server/scheduler";
import { DownloadService } from "./src/server/downloader";
import { enqueueDownload, taskQueue } from "./src/server/taskQueue";
import { sanitizeDirectory, ensureUniqueFilename, configureDownloadDirectory } from "./src/server/pathSanitizer";

// Helper to get filename from URL
function getFilenameFromUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const base = path.basename(parsed.pathname);
        return base || "download.bin";
    } catch {
        return "download.bin";
    }
}

const PORT = 3000;

async function start() {
    const app = express();
    const server = http.createServer(app);

    // Initialize Socket.io server
    const io = new Server(server, {
        cors: {
            origin: "*",
        },
    });

    app.use(cors());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Initialize Database, Settings and Scheduler
    await initializeDatabase();
    await initSettings();

    const savedDownloadDir = (await getSetting<string>("downloadDirectory")) || "./downloads";
    configureDownloadDirectory(savedDownloadDir);

    await initScheduler();

    // Socket event forwarding from download activities
    DownloadService.eventEmitter.on("progress", (downloadId, data) => {
        io.emit("downloadProgress", {
            downloadId,
            chunkId: data.chunkId,
            chunkDownloadedBytes: data.chunkDownloadedBytes,
            downloadedBytes: data.downloadedBytes,
            total: data.total,
        });
    });

    DownloadService.eventEmitter.on("downloadStarted", (downloadId) => {
        io.emit("downloadStarted", downloadId);
    });

    DownloadService.eventEmitter.on("downloadPaused", (downloadId) => {
        io.emit("downloadPaused", downloadId);
    });

    DownloadService.eventEmitter.on("downloadComplete", (downloadId) => {
        io.emit("downloadComplete", downloadId);
    });

    DownloadService.eventEmitter.on("downloadError", (downloadId) => {
        io.emit("downloadError", downloadId);
    });

    DownloadService.eventEmitter.on("downloadResumed", (downloadId) => {
        io.emit("downloadResumed", downloadId);
    });

    io.on("connection", (socket) => {
        console.log(`Socket client connected: ${socket.id}`);
        socket.emit("connected", { status: "Ready" });

        socket.on("disconnect", () => {
            console.log(`Socket client disconnected: ${socket.id}`);
        });
    });

    // --- 1. SILENT URL PARSER / INTERCEPTOR ROUTE ---
    app.get("/", async (req, res, next) => {
        const urlParam = req.query.url;
        if (!urlParam) {
            return next(); // Fall through to Vite/SPA handler
        }

        try {
            const targetUrl = decodeURIComponent(urlParam as string).trim();
            new URL(targetUrl); // Try to validate URI

            const nameParam = req.query.name as string | undefined;
            const indexParam = req.query.dir as string | undefined;

            // Simple filename from URL or provided name
            let filename = nameParam || getFilenameFromUrl(targetUrl);
            const targetDir = indexParam ? sanitizeDirectory(indexParam) : sanitizeDirectory("");
            const resolvedDir = targetDir ? path.relative(savedDownloadDir, path.resolve(savedDownloadDir, targetDir)) : "";

            const activeBaseDir = path.resolve(savedDownloadDir, resolvedDir);
            await fs.promises.mkdir(activeBaseDir, { recursive: true });

            const { finalName } = await ensureUniqueFilename(activeBaseDir, filename);

            // C. Content discovery HEAD request check
            let totalSize: number | null = null;
            let supportsRange = false;
            try {
                const headRes = await axios.head(targetUrl, { timeout: 3000 });
                const contentLength = headRes.headers["content-length"];
                totalSize = contentLength ? parseInt(String(contentLength), 10) : null;
                supportsRange = String(headRes.headers["accept-ranges"] || "") === "bytes";
            } catch {
                // Safe standard fallback
            }

            const optimalChunkCount = supportsRange && totalSize ? 4 : 1;
            const id = generateId();

            await query(
                `INSERT INTO downloads (id, url, filename, directory, total_size, downloaded_size, chunk_count, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     RETURNING *`,
                [id, targetUrl, finalName, resolvedDir, totalSize, 0, optimalChunkCount, "PENDING"]
            );

            enqueueDownload(id);

            // Respond directly for Extension compatibility
            res.json({
                success: true,
                taskId: id,
                filename: finalName,
                directory: resolvedDir || "downloads",
                message: "Silent download initialized and added to queue.",
            });
        } catch (err: any) {
            console.error("Silent direct downloader error:", err.message);
            res.status(400).json({
                success: false,
                error: "Failed to initialize silent download",
                message: err.message,
            });
        }
    });

    // --- 2. API ENDPOINTS ---

    // Get all downloads with chunks
    app.get("/api/downloads", async (req, res) => {
        try {
            const records = await query(`
                SELECT d.*, json_agg(c.*) as chunks
                FROM downloads d
                         LEFT JOIN chunks c ON d.id = c.download_id
                GROUP BY d.id
                ORDER BY d.created_at DESC
            `);

            // Clean up empty chunk aggregates from postgres or mock returns
            const cleaned = records.map((r) => {
                if (r.chunks && r.chunks[0] === null) {
                    r.chunks = [];
                }
                return r;
            });

            res.json(cleaned);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get active system stats
    app.get("/api/downloads/stats", async (req, res) => {
        try {
            const list = await query("SELECT status, total_size, downloaded_size FROM downloads");
            const activeCount = DownloadService.activeDownloads.size;
            const totalSize = list.reduce((acc, d) => acc + (Number(d.totalSize) || 0), 0);
            const totalDownloaded = list.reduce((acc, d) => acc + (Number(d.downloadedSize) || 0), 0);
            res.json({
                activeThreads: activeCount,
                totalDownloads: list.length,
                completedCount: list.filter((l) => l.status === "COMPLETED").length,
                totalSize,
                totalDownloaded,
            });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // Add a new download task
    app.post("/api/downloads", async (req, res) => {
        const { url, filename, directory, chunkCount, scheduledAt } = req.body;
        if (!url) return res.status(400).json({ error: "Destination URL is required" });

        try {
            const finalUrl = url.trim();

            // Simple filename fallback
            let finalFilename = filename || getFilenameFromUrl(finalUrl);

            let scheduleDate: Date | null = null;
            if (scheduledAt) {
                scheduleDate = new Date(scheduledAt);
                if (isNaN(scheduleDate.getTime())) {
                    return res.status(400).json({ error: "Provided execution date is invalid" });
                }
            }

            const resolvedDir = directory
                ? path.relative(savedDownloadDir, sanitizeDirectory(directory))
                : "";

            const activeBaseDir = path.resolve(savedDownloadDir, resolvedDir);
            await fs.promises.mkdir(activeBaseDir, { recursive: true });

            const { finalName } = await ensureUniqueFilename(activeBaseDir, finalFilename);

            // Perform range investigation
            let totalSize: number | null = null;
            let supportsRange = false;
            try {
                const headRes = await axios.head(finalUrl, { timeout: 3000 });
                const contentLength = headRes.headers["content-length"];
                totalSize = contentLength ? parseInt(String(contentLength), 10) : null;
                supportsRange = String(headRes.headers["accept-ranges"] || "") === "bytes";
            } catch (err) {
                // Fall back gracefully
            }

            let partitions = parseInt(chunkCount, 10) || 4;
            partitions = Math.max(1, Math.min(16, partitions));
            if (!supportsRange || !totalSize) {
                partitions = 1;
            }

            const id = generateId();
            const statusValue = scheduleDate ? "SCHEDULED" : "PENDING";

            const records = await query(
                `INSERT INTO downloads (id, url, filename, directory, total_size, downloaded_size, chunk_count, status, scheduled_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                     RETURNING *`,
                [id, finalUrl, finalName, resolvedDir, totalSize, 0, partitions, statusValue, scheduleDate]
            );

            const download = records[0];

            if (scheduleDate) {
                scheduleDownload(download.id, scheduleDate);
            } else {
                enqueueDownload(download.id);
            }

            res.status(201).json(download);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // Pause an active download
    app.post("/api/downloads/:id/pause", async (req, res) => {
        const { id } = req.params;
        try {
            await DownloadService.pauseDownload(id);
            res.json({ success: true, message: "Task active download paused" });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // Resume a paused download
    app.post("/api/downloads/:id/resume", async (req, res) => {
        const { id } = req.params;
        try {
            await DownloadService.resumeDownload(id, savedDownloadDir);
            res.json({ success: true, message: "Task download resume requested" });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // Retry an errored download
    app.post("/api/downloads/:id/retry", async (req, res) => {
        const { id } = req.params;
        try {
            const download = await queryOne("SELECT * FROM downloads WHERE id = $1", [id]);
            if (!download) return res.status(404).json({ error: "Task not found." });

            await query("UPDATE chunks SET downloaded_bytes = 0, status = 'PENDING' WHERE download_id = $1", [id]);
            await query("UPDATE downloads SET downloaded_size = 0, status = 'PENDING' WHERE id = $1", [id]);

            enqueueDownload(id);
            res.json({ success: true, message: "Task enqueued for re-evaluation" });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // Update scheduling or general properties
    app.put("/api/downloads/:id", async (req, res) => {
        const { id } = req.params;
        const { filename, chunkCount, scheduledAt } = req.body;

        try {
            const download = await queryOne("SELECT * FROM downloads WHERE id = $1", [id]);
            if (!download) return res.status(404).json({ error: "Task not found" });

            if (download.status === "DOWNLOADING") {
                return res.status(400).json({ error: "Properties cannot be modified while downloading. Pause first." });
            }

            if (filename) {
                const destDir = path.resolve(savedDownloadDir, download.directory);
                const { finalName } = await ensureUniqueFilename(destDir, filename);
                await query("UPDATE downloads SET filename = $1 WHERE id = $2", [finalName, id]);
            }

            if (chunkCount) {
                const existingChunks = await query("SELECT * FROM chunks WHERE download_id = $1", [id]);
                if (existingChunks.length > 0 && download.chunkCount !== chunkCount) {
                    return res.status(400).json({ error: "Cannot modify partitions for started tasks. Delete and restart instead." });
                }
                await query("UPDATE downloads SET chunk_count = $1 WHERE id = $2", [Math.max(1, Math.min(16, chunkCount)), id]);
            }

            if (scheduledAt !== undefined) {
                if (!scheduledAt) {
                    cancelScheduledJob(id);
                    await query("UPDATE downloads SET scheduled_at = NULL, status = 'PENDING' WHERE id = $1", [id]);
                } else {
                    const date = new Date(scheduledAt);
                    if (isNaN(date.getTime())) {
                        return res.status(400).json({ error: "Provided schedule date parsing failed." });
                    }
                    await query("UPDATE downloads SET scheduled_at = $1, status = 'SCHEDULED' WHERE id = $2", [date.toISOString(), id]);
                    scheduleDownload(id, date);
                }
            }

            const updated = await queryOne("SELECT * FROM downloads WHERE id = $1", [id]);
            res.json(updated);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // Delete a download and clean its parts
    app.delete("/api/downloads/:id", async (req, res) => {
        const { id } = req.params;
        try {
            const download = await queryOne("SELECT * FROM downloads WHERE id = $1", [id]);
            if (!download) return res.status(404).json({ error: "Task not found" });

            await DownloadService.stopDownload(id);
            cancelScheduledJob(id);

            const resolvedFolder = path.resolve(savedDownloadDir, download.directory);
            const finishedPath = path.join(resolvedFolder, download.filename);
            const partPath = finishedPath + ".part";

            // File cleanup
            await fs.promises.unlink(finishedPath).catch(() => {});
            await fs.promises.unlink(partPath).catch(() => {});

            await query("DELETE FROM downloads WHERE id = $1", [id]);
            res.status(200).json({ success: true, message: "Download record removed and partition files wiped clean" });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // Fetch all server system settings
    app.get("/api/settings", async (req, res) => {
        try {
            const downloadDirectory = (await getSetting<string>("downloadDirectory")) || "./downloads";
            const maxConcurrentTasks = (await getSetting<number>("maxConcurrentTasks")) || 3;
            const defaultChunkCount = (await getSetting<number>("defaultChunkCount")) || 4;
            res.json({ downloadDirectory, maxConcurrentTasks, defaultChunkCount });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // Modify server system settings
    app.put("/api/settings", async (req, res) => {
        const { downloadDirectory, maxConcurrentTasks, defaultChunkCount } = req.body;
        try {
            if (downloadDirectory) {
                const fullPath = path.resolve(downloadDirectory);
                await setSetting("downloadDirectory", fullPath);
                configureDownloadDirectory(fullPath);
            }
            if (maxConcurrentTasks !== undefined) {
                const num = parseInt(maxConcurrentTasks, 10);
                if (num > 0) {
                    await setSetting("maxConcurrentTasks", num);
                    taskQueue.setConcurrency(num);
                }
            }
            if (defaultChunkCount !== undefined) {
                const count = parseInt(defaultChunkCount, 10);
                if (count > 0 && count <= 16) {
                    await setSetting("defaultChunkCount", count);
                }
            }
            res.json({ success: true, message: "Settings configuration successfully adjusted." });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- 3. FRONTEND SERVING (VITE MODE vs STATIC MODE) ---
    if (process.env.NODE_ENV !== "production") {
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: "spa",
        });
        app.use(vite.middlewares);
    } else {
        // Production compiled asset directory
        const distPath = path.join(process.cwd(), "dist");
        app.use(express.static(distPath));
        app.get("*", (req, res) => {
            res.sendFile(path.join(distPath, "index.html"));
        });
    }

    server.listen(PORT, "0.0.0.0", () => {
        console.log(`Fletch Downloader fully operating on Server Port ${PORT}`);
    });
}

start().catch((err) => {
    console.error("FATAL SYSTEM STOP: Downloader engine crashed during boot execution:", err);
    process.exit(1);
});