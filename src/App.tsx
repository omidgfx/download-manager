import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import {
    AlertTriangle,
    CheckCircle,
    ChevronDown,
    ChevronUp,
    Clock,
    Cpu,
    Download,
    ExternalLink,
    Folder,
    HelpCircle,
    Link,
    Pause,
    Play,
    Plus,
    RotateCcw,
    Search,
    Settings,
    Trash2
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

// Frontend interfaces mirroring database records
interface Chunk {
    id: string;
    downloadId: string;
    index: number;
    startByte: number;
    endByte: number | null;
    downloadedBytes: number;
    status: "PENDING" | "ACTIVE" | "DONE" | "ERROR";
}

interface DownloadItem {
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
    chunks: Chunk[];
}

interface SystemStats {
    activeThreads: number;
    totalDownloads: number;
    completedCount: number;
    totalSize: number;
    totalDownloaded: number;
}

interface UserSettings {
    downloadDirectory: string;
    maxConcurrentTasks: number;
    defaultChunkCount: number;
}

export function App() {
    // State variables
    const [downloads, setDownloads] = useState<DownloadItem[]>([]);
    const [stats, setStats] = useState<SystemStats>({
        activeThreads: 0,
        totalDownloads: 0,
        completedCount: 0,
        totalSize: 0,
        totalDownloaded: 0,
    });
    const [settings, setSettings] = useState<UserSettings>({
        downloadDirectory: "./downloads",
        maxConcurrentTasks: 3,
        defaultChunkCount: 4,
    });

    const [searchQuery, setSearchQuery] = useState("");
    const [activeTab, setActiveTab] = useState<"all" | "downloading" | "completed" | "scheduled" | "error">("all");
    const [expandedId, setExpandedId] = useState<string | null>(null);

    // Modals state
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
    const [isGuideOpen, setIsGuideOpen] = useState(false);

    // Form input states
    const [inputUrl, setInputUrl] = useState("");
    const [inputFilename, setInputFilename] = useState("");
    const [inputDirectory, setInputDirectory] = useState("");
    const [inputChunkCount, setInputChunkCount] = useState(4);
    const [inputScheduledAt, setInputScheduledAt] = useState("");

    // Speed measurement ref
    const lastProgressRef = useRef<Record<string, { bytes: number; time: number; speed: number }>>({});
    const socketRef = useRef<Socket | null>(null);
    const [wsConnected, setWsConnected] = useState(false);

    // Fetch initial data
    useEffect(() => {
        fetchDownloads();
        fetchStats();
        fetchSettings();

        // Setup Socket Connection
        const socket = io();
        socketRef.current = socket;

        socket.on("connect", () => {
            setWsConnected(true);
        });

        socket.on("disconnect", () => {
            setWsConnected(false);
        });

        // Real-time progress listener
        socket.on(
            "downloadProgress",
            (data: {
                downloadId: string;
                chunkId: string;
                chunkDownloadedBytes: number;
                downloadedBytes: number;
                total: number
            }) => {
                // Handle download state adjustments
                setDownloads((prev) =>
                    prev.map((d) => {
                        if (d.id === data.downloadId) {
                            // Update aggregate metrics
                            const updatedSize = data.downloadedBytes;

                            // Calculate speed
                            const now = Date.now();
                            const lastState = lastProgressRef.current[data.downloadId] || {
                                bytes: d.downloadedSize,
                                time: now - 1000,
                                speed: 0
                            };
                            const timeDiff = (now - lastState.time) / 1000; // seconds

                            let currentSpeed = lastState.speed;
                            if (timeDiff >= 0.5) { // Throttle calculations slightly to yield stable speed readouts
                                const progressDiff = updatedSize - lastState.bytes;
                                currentSpeed = Math.max(0, progressDiff / timeDiff);
                                lastProgressRef.current[data.downloadId] = {
                                    bytes: updatedSize,
                                    time: now,
                                    speed: currentSpeed
                                };
                            }

                            // Update matching chunk
                            const updatedChunks = (d.chunks || []).map((c) => {
                                if (c.id === data.chunkId) {
                                    const chunkTotalBytes = c.endByte ? c.endByte - c.startByte + 1 : null;
                                    const isDone = chunkTotalBytes !== null && data.chunkDownloadedBytes >= chunkTotalBytes;
                                    return {
                                        ...c,
                                        downloadedBytes: data.chunkDownloadedBytes,
                                        status: (isDone ? "DONE" : "ACTIVE") as "ACTIVE" | "DONE",
                                    };
                                }
                                return c;
                            });

                            return {
                                ...d,
                                downloadedSize: updatedSize,
                                status: "DOWNLOADING" as const,
                                chunks: updatedChunks,
                            };
                        }
                        return d;
                    })
                );
            }
        );

        // Forwarding specific server states
        socket.on("downloadStarted", (id: string) => {
            refreshItem(id);
            fetchStats();
        });

        socket.on("downloadPaused", (id: string) => {
            refreshItem(id);
            fetchStats();
        });

        socket.on("downloadComplete", (id: string) => {
            refreshItem(id);
            fetchStats();
        });

        socket.on("downloadError", (id: string) => {
            refreshItem(id);
            fetchStats();
        });

        socket.on("downloadResumed", (id: string) => {
            refreshItem(id);
            fetchStats();
        });

        // Periodic stats polling
        const timer = setInterval(() => {
            fetchStats();
        }, 5000);

        return () => {
            socket.disconnect();
            clearInterval(timer);
        };
    }, []);

    // Fetch functions
    const fetchDownloads = async () => {
        try {
            const res = await fetch("/api/downloads");
            if (res.ok) {
                const data = await res.json();
                setDownloads(data);
            }
        } catch (e) {
            console.error("Could not fetch downloads list", e);
        }
    };

    const fetchStats = async () => {
        try {
            const res = await fetch("/api/downloads/stats");
            if (res.ok) {
                const data = await res.json();
                setStats(data);
            }
        } catch (e) {
            console.error("Could not fetch database statistics", e);
        }
    };

    const fetchSettings = async () => {
        try {
            const res = await fetch("/api/settings");
            if (res.ok) {
                const data = await res.json();
                setSettings(data);
            }
        } catch (e) {
            console.error("Could not fetch config settings", e);
        }
    };

    const refreshItem = async (id: string) => {
        try {
            const res = await fetch(`/api/downloads`);
            if (res.ok) {
                const data: DownloadItem[] = await res.json();
                const updated = data.find((d) => d.id === id);
                if (updated) {
                    setDownloads((prev) => prev.map((item) => (item.id === id ? {...updated} : item)));
                } else {
                    // If deleted
                    setDownloads((prev) => prev.filter((item) => item.id !== id));
                }
            }
        } catch (e) {
            console.error("Refresh item failed", e);
        }
    };

    // UI Interactive Triggers
    const handlePause = async (id: string) => {
        try {
            await fetch(`/api/downloads/${id}/pause`, { method: "POST" });
            refreshItem(id);
        } catch (e) {
            console.error("Pause job failure", e);
        }
    };

    const handleResume = async (id: string) => {
        try {
            await fetch(`/api/downloads/${id}/resume`, { method: "POST" });
            refreshItem(id);
        } catch (e) {
            console.error("Resume job failure", e);
        }
    };

    const handleRetry = async (id: string) => {
        try {
            await fetch(`/api/downloads/${id}/retry`, { method: "POST" });
            refreshItem(id);
        } catch (e) {
            console.error("Retry job failure", e);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm("Are you sure you want to delete this download and clean its cache files?")) return;
        try {
            const res = await fetch(`/api/downloads/${id}`, { method: "DELETE" });
            if (res.ok) {
                setDownloads((prev) => prev.filter((d) => d.id !== id));
                fetchStats();
            }
        } catch (e) {
            console.error("Deletion task failed", e);
        }
    };

    // Submit new download
    const handleAddSubmit = async (e: FormEvent) => {
        e.preventDefault();
        if (!inputUrl) return;

        try {
            const res = await fetch("/api/downloads", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    url: inputUrl,
                    filename: inputFilename,
                    directory: inputDirectory,
                    chunkCount: inputChunkCount,
                    scheduledAt: inputScheduledAt,
                }),
            });

            if (res.ok) {
                setIsAddModalOpen(false);
                // Clear forms
                setInputUrl("");
                setInputFilename("");
                setInputDirectory("");
                setInputChunkCount(4);
                setInputScheduledAt("");

                fetchDownloads();
                fetchStats();
            } else {
                const err = await res.json();
                alert(`Error queuing download: ${err.error || "Please verify credentials"}`);
            }
        } catch (e) {
            console.error("Submit task failed", e);
        }
    };

    // Save Settings
    const handleSettingsSave = async (e: FormEvent) => {
        e.preventDefault();
        try {
            const res = await fetch("/api/settings", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(settings),
            });

            if (res.ok) {
                setIsSettingsModalOpen(false);
                fetchDownloads();
                fetchStats();
            }
        } catch (e) {
            console.error("Could not persist configuration adjustments", e);
        }
    };

    // Dynamic values computation
    const filteredDownloads = useMemo(() => {
        return downloads.filter((d) => {
            // Tab filter
            if (activeTab === "downloading" && d.status !== "DOWNLOADING") return false;
            if (activeTab === "completed" && d.status !== "COMPLETED") return false;
            if (activeTab === "scheduled" && d.status !== "SCHEDULED") return false;
            if (activeTab === "error" && d.status !== "ERROR") return false;

            // Search matching
            const queryLower = searchQuery.toLowerCase();
            return (
                d.filename.toLowerCase().includes(queryLower) ||
                d.url.toLowerCase().includes(queryLower) ||
                d.directory.toLowerCase().includes(queryLower)
            );
        });
    }, [downloads, activeTab, searchQuery]);

    // General sizing helpers
    const formatBytes = (bytes: number | null | undefined): string => {
        if (bytes === null || bytes === undefined) return "Unknown size";
        if (bytes === 0) return "0 B";
        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB", "TB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    };

    const formatSpeed = (bytesPerSecond: number | undefined): string => {
        if (!bytesPerSecond) return "0 B/s";
        return formatBytes(bytesPerSecond) + "/s";
    };

    return (
        <div id="app" className="min-h-screen bg-slate-950 text-slate-100 font-sans antialiased pb-20">
            {/* 1. TOP HEADER NAVIGATION BAR */}
            <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur sticky top-0 z-40 px-6 py-4">
                <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <div className="bg-emerald-500/15 text-emerald-400 p-2.5 rounded-xl border border-emerald-500/20 shadow-md">
                            <Download className="w-6 h-6 animate-pulse" />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h1 className="font-sans font-bold text-xl tracking-tight text-white">
                                    Fletch Downloader
                                </h1>
                                <span className="text-[10px] font-mono bg-emerald-500/10 border border-emerald-400/20 text-emerald-400 px-2 py-0.5 rounded-full uppercase tracking-wider">
                  v2.0 Fullstack
                </span>
                            </div>
                            <p className="text-xs text-slate-400 mt-0.5">Multiparts Smart Downloading Engine</p>
                        </div>
                    </div>

                    <div className="flex items-center flex-wrap gap-3">
                        {/* Server Connection Badge */}
                        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-300">
                            <div className={`w-2.5 h-2.5 rounded-full ${wsConnected ? "bg-emerald-400 animate-ping" : "bg-rose-400"}`} />
                            <span className="font-mono text-[11px]">
                {wsConnected ? "Live Socket Active" : "Socket Reconnecting"}
              </span>
                        </div>

                        {/* Guide Button */}
                        <button
                            onClick={() => setIsGuideOpen(true)}
                            className="btn flex items-center gap-2 border border-slate-700 hover:border-slate-600 bg-slate-800 text-slate-300 hover:text-white text-xs px-3 py-1.5 rounded-lg transition"
                        >
                            <HelpCircle className="w-4 h-4" />
                            <span>Firefox Integration</span>
                        </button>

                        {/* Config Button */}
                        <button
                            onClick={() => setIsSettingsModalOpen(true)}
                            className="btn flex items-center gap-2 border border-slate-700 hover:border-slate-600 bg-slate-800 text-slate-300 hover:text-white text-xs px-3 py-1.5 rounded-lg transition"
                        >
                            <Settings className="w-4 h-4" />
                            <span>Settings</span>
                        </button>

                        {/* New Task Trigger */}
                        <button
                            onClick={() => setIsAddModalOpen(true)}
                            className="btn flex items-center gap-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs px-4 py-2 rounded-lg transition shadow-lg shadow-emerald-500/10"
                        >
                            <Plus className="w-4 h-4" />
                            <span>Add Download</span>
                        </button>
                    </div>
                </div>
            </header>

            <main className="max-w-7xl mx-auto px-6 mt-8">
                {/* 2. STATS OVERVIEW BENTO GRID */}
                <section className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                    <div className="bg-slate-900 border border-slate-800/80 rounded-2xl p-5 shadow-sm relative overflow-hidden">
                        <div className="absolute top-0 right-0 p-5 opacity-5 text-white">
                            <Download className="w-16 h-16" />
                        </div>
                        <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Active Concurrency Dev</p>
                        <h3 className="font-sans font-bold text-3xl text-white mt-1.5">{stats.activeThreads} <span className="text-xs text-slate-400">threads</span></h3>
                        <p className="text-xs text-emerald-400 mt-2 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            Processing tasks simultaneously
                        </p>
                    </div>

                    <div className="bg-slate-900 border border-slate-800/80 rounded-2xl p-5 shadow-sm relative overflow-hidden">
                        <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Completed Downloads</p>
                        <h3 className="font-sans font-bold text-3xl text-white mt-1.5">{stats.completedCount} <span className="text-xs text-slate-400">/ {stats.totalDownloads}</span></h3>
                        <p className="text-xs text-slate-400 mt-2">
                            Finished files saved securely
                        </p>
                    </div>

                    <div className="bg-slate-900 border border-slate-800/80 rounded-2xl p-5 shadow-sm relative overflow-hidden">
                        <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Aggregate File Size</p>
                        <h3 className="font-sans font-bold text-3xl text-white mt-1.5">{formatBytes(stats.totalSize)}</h3>
                        <p className="text-xs text-slate-400 mt-2">
                            Including partial buffers
                        </p>
                    </div>

                    <div className="bg-slate-900 border border-slate-800/80 rounded-2xl p-5 shadow-sm relative overflow-hidden">
                        <p className="text-xs font-medium text-slate-400 uppercase tracking-wider font-semibold">Total Storage Bound</p>
                        <h3 className="font-sans font-bold text-3xl text-sky-400 mt-1.5">{formatBytes(stats.totalDownloaded)}</h3>
                        <p className="text-xs text-slate-400 mt-2">
                            Actual disk allocation used
                        </p>
                    </div>
                </section>

                {/* 3. TASK CONTROLLER BAR (Filter & Search) */}
                <section className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-6 flex flex-col md:flex-row items-center gap-4 justify-between">
                    {/* Tabs Filter */}
                    <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800/60 overflow-x-auto w-full md:w-auto">
                        {(["all", "downloading", "completed", "scheduled", "error"] as const).map((tab) => (
                            <button
                                key={tab}
                                onClick={() => setActiveTab(tab)}
                                className={`px-4 py-2 text-xs font-medium rounded-lg transition capitalize whitespace-nowrap ${
                                    activeTab === tab
                                        ? "bg-slate-800 text-white font-semibold shadow-sm"
                                        : "text-slate-400 hover:text-slate-200"
                                }`}
                            >
                                {tab}
                            </button>
                        ))}
                    </div>

                    {/* Search box */}
                    <div className="relative w-full md:w-80">
                        <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                        <input
                            type="text"
                            placeholder="Search downloads by filename..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-800/80 focus:border-slate-600 text-slate-100 text-xs px-10 py-2.5 rounded-xl outline-none transition"
                        />
                    </div>
                </section>

                {/* 4. MAIN DOWNLOADS LIST CONTAINER */}
                <section className="space-y-4">
                    <AnimatePresence mode="popLayout">
                        {filteredDownloads.length === 0 ? (
                            <motion.div
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0 }}
                                className="bg-slate-900/40 border border-dashed border-slate-800 rounded-2xl p-12 text-center"
                            >
                                <div className="mx-auto w-12 h-12 bg-slate-800/60 rounded-xl flex items-center justify-center text-slate-400 border border-slate-700 mb-4">
                                    <Download className="w-5 h-5" />
                                </div>
                                <h4 className="font-semibold text-slate-200 text-sm">No download records found</h4>
                                <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                                    Try adding a target download link or checking other tabs for active/completed/scheduled items.
                                </p>
                            </motion.div>
                        ) : (
                            filteredDownloads.map((item) => {
                                const isExpanded = expandedId === item.id;
                                const progressPercent = item.totalSize
                                    ? Math.min(100, Math.round((item.downloadedSize / item.totalSize) * 100))
                                    : 0;

                                const trackingSpeed = lastProgressRef.current[item.id]?.speed || 0;

                                return (
                                    <motion.div
                                        key={item.id}
                                        layout
                                        initial={{ opacity: 0, y: 10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0 }}
                                        transition={{ duration: 0.2 }}
                                        className={`bg-slate-900 border transition-all ${
                                            isExpanded ? "border-slate-700 ring-1 ring-slate-800" : "border-slate-800 hover:border-slate-700"
                                        } rounded-2xl overflow-hidden`}
                                    >
                                        {/* CARD BODY HEADER */}
                                        <div className="p-4 md:p-5 flex flex-col md:flex-row items-center justify-between gap-4">
                                            <div className="flex items-start gap-4 w-full md:w-3/5">
                                                {/* Status Icon Indicator */}
                                                <div className="mt-1">
                                                    {item.status === "COMPLETED" && (
                                                        <div className="bg-emerald-500/10 text-emerald-405 p-2 rounded-lg border border-emerald-500/10">
                                                            <CheckCircle className="w-5 h-5 text-emerald-400" />
                                                        </div>
                                                    )}
                                                    {item.status === "DOWNLOADING" && (
                                                        <div className="bg-sky-500/10 text-sky-400 p-2 rounded-lg border border-sky-500/10 animate-pulse">
                                                            <Cpu className="w-5 h-5 text-sky-400" />
                                                        </div>
                                                    )}
                                                    {item.status === "PAUSED" && (
                                                        <div className="bg-zinc-500/10 text-zinc-400 p-2 rounded-lg border border-zinc-500/10">
                                                            <Pause className="w-5 h-5 text-zinc-400" />
                                                        </div>
                                                    )}
                                                    {item.status === "SCHEDULED" && (
                                                        <div className="bg-amber-500/10 text-amber-450 p-2 rounded-lg border border-amber-500/10">
                                                            <Clock className="w-5 h-5 text-amber-400" />
                                                        </div>
                                                    )}
                                                    {item.status === "ERROR" && (
                                                        <div className="bg-rose-500/10 text-rose-450 p-2 rounded-lg border border-rose-500/10">
                                                            <AlertTriangle className="w-5 h-5 text-rose-500" />
                                                        </div>
                                                    )}
                                                    {item.status === "PENDING" && (
                                                        <div className="bg-slate-800 text-slate-400 p-2 rounded-lg border border-slate-700">
                                                            <Clock className="w-5 h-5" />
                                                        </div>
                                                    )}
                                                </div>

                                                {/* File Details */}
                                                <div className="min-w-0 flex-1">
                                                    <h4 className="font-semibold text-white text-sm truncate uppercase tracking-wide">
                                                        {item.filename}
                                                    </h4>
                                                    <p className="text-xs text-slate-400 truncate mt-0.5 flex items-center gap-1.5">
                                                        <Link className="w-3.5 h-3.5 shrink-0 text-slate-500" />
                                                        <span className="truncate hover:text-slate-300 transition" title={item.url}>
                              {item.url}
                            </span>
                                                    </p>
                                                    <div className="flex flex-wrap items-center gap-2 mt-2">
                            <span className="text-[10px] font-mono bg-slate-950 border border-slate-800 text-slate-400 px-2 py-0.5 rounded-md flex items-center gap-1">
                              <Folder className="w-3 h-3 text-slate-500" />
                                {item.directory || "downloads"}
                            </span>
                                                        <span className="text-[10px] font-mono bg-slate-950 border border-slate-800 text-slate-400 px-2 py-0.5 rounded-md">
                              {item.chunkCount} {item.chunkCount > 1 ? "slices" : "slice"}
                            </span>
                                                        {item.scheduledAt && (
                                                            <span className="text-[10px] font-mono bg-amber-500/5 border border-amber-500/10 text-amber-400 px-2 py-0.5 rounded-md flex items-center gap-1">
                                <Clock className="w-3 h-3 text-amber-500" />
                                Sch: {new Date(item.scheduledAt).toLocaleString()}
                              </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Right Sizing & Progressive info */}
                                            <div className="w-full md:w-2/5 flex flex-col items-stretch md:items-end justify-between gap-3 text-right">
                                                <div className="flex items-center justify-between md:justify-end gap-6 w-full">
                                                    {/* Sizes / Slices info */}
                                                    <div className="text-left md:text-right">
                            <span className="text-xs text-slate-450 block font-medium">
                              {formatBytes(item.downloadedSize)} of {formatBytes(item.totalSize)}
                            </span>
                                                        <span className="text-[11px] text-slate-500 font-mono block mt-0.5">
                              {item.status === "DOWNLOADING" && `Speed: ${formatSpeed(trackingSpeed)}`}
                                                            {item.status === "COMPLETED" && "Completed downloading successfully"}
                                                            {item.status === "PAUSED" && "Paused"}
                                                            {item.status === "ERROR" && "Downloading failed with errors"}
                                                            {item.status === "SCHEDULED" && "Awaiting scheduled timestamp"}
                                                            {item.status === "PENDING" && "Waiting in task queue..."}
                            </span>
                                                    </div>

                                                    {/* Percent Indicator ring/block */}
                                                    <div className="text-right">
                            <span className="text-lg font-mono font-bold text-white">
                              {progressPercent}%
                            </span>
                                                    </div>
                                                </div>

                                                {/* Action buttons list */}
                                                <div className="flex items-center justify-end gap-2 w-full mt-1.5 border-t border-slate-800/40 md:border-0 pt-3 md:pt-0">
                                                    {/* Toggle expand slices map */}
                                                    <button
                                                        onClick={() => setExpandedId(isExpanded ? null : item.id)}
                                                        className="btn hover:bg-slate-800 text-slate-400 hover:text-slate-200 p-2 rounded-lg transition"
                                                        title="Inspect multi-chunk parallel slots progress"
                                                    >
                                                        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                                    </button>

                                                    {/* Pause and Play logic triggers */}
                                                    {item.status === "DOWNLOADING" && (
                                                        <button
                                                            onClick={() => handlePause(item.id)}
                                                            className="btn bg-slate-800 border border-slate-700 hover:border-slate-600 text-slate-300 hover:bg-slate-700 p-2 rounded-lg transition"
                                                            title="Pause download task"
                                                        >
                                                            <Pause className="w-4 h-4" />
                                                        </button>
                                                    )}
                                                    {(item.status === "PAUSED" || item.status === "PENDING") && (
                                                        <button
                                                            onClick={() => handleResume(item.id)}
                                                            className="btn bg-sky-500/10 hover:bg-sky-500/20 text-sky-450 border border-sky-500/20 p-2 rounded-lg transition"
                                                            title="Resume download task"
                                                        >
                                                            <Play className="w-4 h-4 text-sky-400" />
                                                        </button>
                                                    )}

                                                    {item.status === "ERROR" && (
                                                        <button
                                                            onClick={() => handleRetry(item.id)}
                                                            className="btn bg-amber-500/10 hover:bg-amber-500/20 text-amber-450 border border-amber-500/20 p-2 rounded-lg transition"
                                                            title="Retry connection/download"
                                                        >
                                                            <RotateCcw className="w-4 h-4 text-amber-400" />
                                                        </button>
                                                    )}

                                                    {/* Delete Item always safe */}
                                                    <button
                                                        onClick={() => handleDelete(item.id)}
                                                        className="btn bg-slate-800 border border-slate-700 hover:bg-rose-950 hover:border-rose-900 border-slate-700 hover:text-rose-450 text-slate-400 p-2 rounded-lg transition"
                                                        title="Remove download record"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Progress slider bar */}
                                        <div className="h-1 w-full bg-slate-950 relative overflow-hidden">
                                            <div
                                                style={{ width: `${progressPercent}%` }}
                                                className={`h-full transition-all duration-300 ${
                                                    item.status === "COMPLETED"
                                                        ? "bg-emerald-550 bg-gradient-to-r from-emerald-500 to-teal-500"
                                                        : item.status === "ERROR"
                                                            ? "bg-rose-500"
                                                            : item.status === "PAUSED"
                                                                ? "bg-zinc-500"
                                                                : "bg-sky-500 bg-gradient-to-r from-sky-500 to-emerald-500 animate-pulse"
                                                }`}
                                            />
                                        </div>

                                        {/* EXPANDED INTERACTIVE SLICES MAP */}
                                        <AnimatePresence>
                                            {isExpanded && (
                                                <motion.div
                                                    initial={{ height: 0, opacity: 0 }}
                                                    animate={{ height: "auto", opacity: 1 }}
                                                    exit={{ height: 0, opacity: 0 }}
                                                    transition={{ duration: 0.2 }}
                                                    className="bg-slate-950/60 border-t border-slate-800/80 px-5 py-4"
                                                >
                                                    <div className="flex items-center justify-between mb-3">
                                                        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-350 tracking-wider uppercase">
                                                            <Cpu className="w-3.5 h-3.5 text-sky-400" />
                                                            <span>Direct Byte Chunks Allocation Map (Parallel Slices)</span>
                                                        </div>
                                                        <span className="text-[10px] font-mono text-slate-500">
                              Each chunk stream operates concurrently in secondary threads
                            </span>
                                                    </div>

                                                    {/* Parallel meters container */}
                                                    {(!item.chunks || item.chunks.length === 0) ? (
                                                        <p className="text-xs text-slate-500 font-mono italic">
                                                            Initial download ranges are calculated dynamically when downloading initiates.
                                                        </p>
                                                    ) : (
                                                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                                                            {item.chunks.map((ch, idx) => {
                                                                const chunkTotalBytes = ch.endByte ? ch.endByte - ch.startByte + 1 : null;
                                                                const chunkPercent = chunkTotalBytes
                                                                    ? Math.min(100, Math.round((ch.downloadedBytes / chunkTotalBytes) * 100))
                                                                    : ch.status === "DONE"
                                                                        ? 100
                                                                        : 0;

                                                                return (
                                                                    <div
                                                                        key={ch.id}
                                                                        className="bg-slate-900 border border-slate-800/60 p-3 rounded-xl flex flex-col justify-between"
                                                                    >
                                                                        <div className="flex items-center justify-between text-[10px] font-mono mb-1.5">
                                                                            <span className="text-slate-400 font-bold">Slice-{(idx + 1)}</span>
                                                                            <span
                                                                                className={`px-1.5 py-0.5 rounded text-[9px] ${
                                                                                    ch.status === "DONE"
                                                                                        ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/10"
                                                                                        : ch.status === "ACTIVE"
                                                                                            ? "bg-sky-500/10 text-sky-400 border border-sky-400/20"
                                                                                            : "bg-slate-950 text-slate-500"
                                                                                }`}
                                                                            >
                                        {ch.status}
                                      </span>
                                                                        </div>

                                                                        {/* Inline visual meters */}
                                                                        <div className="space-y-1">
                                                                            <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono">
                                                                                <span>{formatBytes(ch.downloadedBytes)}</span>
                                                                                <span>
                                          {chunkTotalBytes ? `${chunkPercent}%` : "Streaming"}
                                        </span>
                                                                            </div>
                                                                            <div className="h-1.5 w-full bg-slate-950 rounded-full overflow-hidden">
                                                                                <div
                                                                                    style={{ width: `${chunkPercent}%` }}
                                                                                    className={`h-full rounded-full transition-all duration-300 ${
                                                                                        ch.status === "DONE" ? "bg-emerald-500" : "bg-sky-400"
                                                                                    }`}
                                                                                />
                                                                            </div>
                                                                            <div className="text-[9px] text-slate-500/80 font-mono text-center pt-1 truncate">
                                                                                Range: {ch.startByte} - {ch.endByte ? ch.endByte : "EOF"}
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    )}
                                                </motion.div>
                                            )}
                                        </AnimatePresence>
                                    </motion.div>
                                );
                            })
                        )}
                    </AnimatePresence>
                </section>
            </main>

            {/* 5. ADD TASK MODAL DIALOG */}
            <AnimatePresence>
                {isAddModalOpen && (
                    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-xl overflow-hidden shadow-2xl relative"
                        >
                            <div className="p-6 border-b border-slate-800">
                                <div className="flex items-center gap-2">
                                    <div className="bg-emerald-500/10 text-emerald-400 p-2 rounded-xl border border-emerald-500/10">
                                        <Plus className="w-5 h-5 text-emerald-400" />
                                    </div>
                                    <div>
                                        <h3 className="font-sans font-bold text-lg text-white">Create New Download Task</h3>
                                        <p className="text-xs text-slate-400 mt-0.5">Initialize a single or multithreaded downloading pipeline</p>
                                    </div>
                                </div>
                            </div>

                            <form onSubmit={handleAddSubmit} className="p-6 space-y-4">
                                {/* Destination URL */}
                                <div className="form-control">
                                    <label className="text-xs font-semibold text-slate-300 uppercase tracking-widest flex items-center gap-1">
                                        Target Resource Link <span className="text-rose-500">*</span>
                                    </label>
                                    <input
                                        type="url"
                                        placeholder="https://example.com/files/document.pdf"
                                        value={inputUrl}
                                        onChange={(e) => setInputUrl(e.target.value)}
                                        required
                                        className="w-full bg-slate-950 border border-slate-800 focus:border-slate-600 text-slate-100 text-xs px-4 py-3 rounded-xl outline-none transition"
                                    />
                                </div>

                                {/* Target Filename (Optional) */}
                                <div className="form-control">
                                    <label className="text-xs font-semibold text-slate-300 uppercase tracking-widest block mb-1.5">
                                        Descriptive Filename (Optional)
                                    </label>
                                    <input
                                        type="text"
                                        placeholder="Auto-populated from URL if left empty"
                                        value={inputFilename}
                                        onChange={(e) => setInputFilename(e.target.value)}
                                        className="w-full bg-slate-950 border border-slate-800 focus:border-slate-600 text-slate-100 text-xs px-4 py-3 rounded-xl outline-none transition"
                                    />
                                </div>

                                {/* Extra parameters Grid */}
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {/* Destination Directory */}
                                    <div className="form-control">
                                        <label className="text-xs font-semibold text-slate-300 uppercase tracking-widest block mb-1.5">
                                            Relative Directory Path
                                        </label>
                                        <input
                                            type="text"
                                            placeholder="e.g. video / documents"
                                            value={inputDirectory}
                                            onChange={(e) => setInputDirectory(e.target.value)}
                                            className="w-full bg-slate-950 border border-slate-800 focus:border-slate-600 text-slate-100 text-xs px-4 py-3 rounded-xl outline-none transition font-sans"
                                        />
                                    </div>

                                    {/* Splits Chunks */}
                                    <div className="form-control">
                                        <label className="text-xs font-semibold text-slate-300 uppercase tracking-widest block mb-1.5">
                                            Split Partition Connections
                                        </label>
                                        <input
                                            type="number"
                                            min="1"
                                            max="16"
                                            value={inputChunkCount}
                                            onChange={(e) => setInputChunkCount(parseInt(e.target.value, 10))}
                                            className="w-full bg-slate-950 border border-slate-800 focus:border-slate-600 text-slate-100 text-xs px-4 py-3 rounded-xl outline-none transition"
                                        />
                                    </div>
                                </div>

                                {/* Schedule details */}
                                <div className="form-control">
                                    <label className="text-xs font-semibold text-slate-300 uppercase tracking-widest block mb-1.5">
                                        Smart Download Schedule (Optional)
                                    </label>
                                    <input
                                        type="datetime-local"
                                        value={inputScheduledAt}
                                        onChange={(e) => setInputScheduledAt(e.target.value)}
                                        className="w-full bg-slate-950 border border-slate-800 focus:border-slate-600 text-slate-100 text-xs px-4 py-3 rounded-xl outline-none transition"
                                    />
                                    <span className="text-[10px] text-slate-500 block mt-1">
                    Set a future calendar date. Great for auto-enqueuing files at night.
                  </span>
                                </div>

                                {/* Action buttons footer */}
                                <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
                                    <button
                                        type="button"
                                        onClick={() => setIsAddModalOpen(false)}
                                        className="btn bg-slate-800 border border-slate-700 hover:border-slate-600 text-slate-300 text-xs px-4 py-2.5 rounded-xl transition"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="submit"
                                        className="btn bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs px-5 py-2.5 rounded-xl transition"
                                    >
                                        Launch Queue
                                    </button>
                                </div>
                            </form>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

            {/* 6. SETTINGS MODAL DIALOG */}
            <AnimatePresence>
                {isSettingsModalOpen && (
                    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md overflow-hidden shadow-2xl"
                        >
                            <div className="p-6 border-b border-slate-800 flex items-center gap-2">
                                <div className="bg-slate-800 text-slate-300 p-2 rounded-xl">
                                    <Settings className="w-5 h-5" />
                                </div>
                                <div>
                                    <h3 className="font-sans font-bold text-lg text-white">System Settings</h3>
                                    <p className="text-xs text-slate-400 mt-0.5">Adjust downloader backend parameters</p>
                                </div>
                            </div>

                            <form onSubmit={handleSettingsSave} className="p-6 space-y-4">
                                <div className="form-control">
                                    <label className="text-xs font-semibold text-slate-300 uppercase tracking-widest block mb-1.5">
                                        Storage Downloads Directory
                                    </label>
                                    <input
                                        type="text"
                                        value={settings.downloadDirectory}
                                        onChange={(e) => setSettings({ ...settings, downloadDirectory: e.target.value })}
                                        required
                                        className="w-full bg-slate-950 border border-slate-800 focus:border-slate-600 text-slate-100 text-xs px-4 py-3 rounded-xl outline-none transition"
                                    />
                                    <span className="text-[10px] text-slate-550 block mt-1 text-slate-500">
                    Disk directory where packages and completed downloads are stored.
                  </span>
                                </div>

                                <div className="form-control">
                                    <label className="text-xs font-semibold text-slate-300 uppercase tracking-widest block mb-1.5">
                                        Max Concurrent Download Jobs
                                    </label>
                                    <input
                                        type="number"
                                        min="1"
                                        max="10"
                                        value={settings.maxConcurrentTasks}
                                        onChange={(e) => setSettings({ ...settings, maxConcurrentTasks: parseInt(e.target.value, 10) })}
                                        required
                                        className="w-full bg-slate-950 border border-slate-800 focus:border-slate-600 text-slate-100 text-xs px-4 py-3 rounded-xl outline-none transition"
                                    />
                                    <span className="text-[10px] text-slate-500 block mt-1">
                    Limits parallel downloads. Higher is faster, lower reduces congestion.
                  </span>
                                </div>

                                <div className="form-control">
                                    <label className="text-xs font-semibold text-slate-300 uppercase tracking-widest block mb-1.5">
                                        Default Chunk Splitting Ratio
                                    </label>
                                    <input
                                        type="number"
                                        min="1"
                                        max="16"
                                        value={settings.defaultChunkCount}
                                        onChange={(e) => setSettings({ ...settings, defaultChunkCount: parseInt(e.target.value, 10) })}
                                        required
                                        className="w-full bg-slate-950 border border-slate-800 focus:border-slate-600 text-slate-100 text-xs px-4 py-3 rounded-xl outline-none transition"
                                    />
                                </div>

                                <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
                                    <button
                                        type="button"
                                        onClick={() => setIsSettingsModalOpen(false)}
                                        className="btn bg-slate-800 border border-slate-700 hover:border-slate-600 text-slate-300 text-xs px-4 py-2.5 rounded-xl transition"
                                    >
                                        Close
                                    </button>
                                    <button
                                        type="submit"
                                        className="btn bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs px-5 py-2.5 rounded-xl transition"
                                    >
                                        Save Changes
                                    </button>
                                </div>
                            </form>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

            {/* 7. EXTENSION USERS GUIDE MODAL */}
            <AnimatePresence>
                {isGuideOpen && (
                    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-lg overflow-hidden shadow-2xl"
                        >
                            <div className="p-6 border-b border-slate-800 flex items-center gap-2">
                                <div className="bg-emerald-500/10 text-emerald-400 p-2 rounded-xl">
                                    <ExternalLink className="w-5 h-5 text-emerald-400" />
                                </div>
                                <div>
                                    <h3 className="font-sans font-bold text-lg text-white">Browser Extension Integration</h3>
                                    <p className="text-xs text-slate-400 mt-0.5">Integrate right-click download helpers instantly</p>
                                </div>
                            </div>

                            <div className="p-6 space-y-4 text-xs leading-relaxed text-slate-300">
                                <p>
                                    <strong>Fletch Downloader</strong> includes a silent API endpoint that intercepts links sent by browser extensions (like Firefox Custom Actions or Chrome Context Menu triggers) specifically tailored to catch your:
                                </p>

                                <div className="bg-slate-950 text-slate-300 p-3 rounded-xl border border-slate-800/80 font-mono text-[11px] block text-center">
                                    http://localhost:3000/?url=URL_TO_DOWNLOAD
                                </div>

                                <h4 className="font-bold text-white text-xs uppercase tracking-wider pt-2">
                                    How to configure Firefox Right-Click extension:
                                </h4>
                                <ol className="list-decimal pl-4 space-y-2">
                                    <li>
                                        Open your Firefox Right-Click custom action extension preferences.
                                    </li>
                                    <li>
                                        Register a new custom Right-Click menu option, named e.g.,{" "}
                                        <span className="text-emerald-400">"Downloader Grab Link"</span>.
                                    </li>
                                    <li>
                                        Set the target redirect API action path to forward the selected hyperlink directly to:
                                        <br />
                                        <code className="text-[11px] text-sky-455 font-mono select-all bg-slate-950 px-2 py-1 rounded inline-block mt-1 text-sky-400 border border-slate-800">
                                            http://localhost:3000/?url=%s
                                        </code>
                                        <br />
                                        <span className="text-[10px] text-slate-500">
                      (Where <code className="font-mono">%s</code> corresponds to the right-clicked target URL placeholder)
                    </span>
                                    </li>
                                    <li>
                                        Now, right-click on any hyperlink on any online page and click "Downloader Grab Link".
                                        The link will be processed and enqueued silently into your download dashboard immediately!
                                    </li>
                                </ol>

                                <div className="flex items-center justify-end pt-4 border-t border-slate-800">
                                    <button
                                        type="button"
                                        onClick={() => setIsGuideOpen(false)}
                                        className="btn bg-slate-800 hover:bg-slate-700 text-white font-medium text-xs px-5 py-2.5 rounded-xl transition"
                                    >
                                        Understood
                                    </button>
                                </div>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </div>
    );
}