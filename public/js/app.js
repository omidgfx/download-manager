const socket = io();

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function getStatusBadge(status) {
    const map = {
        PENDING: 'badge-ghost',
        DOWNLOADING: 'badge-primary',
        PAUSED: 'badge-warning',
        COMPLETED: 'badge-success',
        ERROR: 'badge-error',
        SCHEDULED: 'badge-info',
    };
    return `badge ${map[status] || 'badge-ghost'}`;
}

// Helper: compute chunk size from download and chunk index
function getChunkSize(download, chunkIndex) {
    const total = Number(download.totalSize) || 0;
    const count = download.chunkCount || 1;
    if (total === 0) return 0; // unknown
    const base = Math.floor(total / count);
    // last chunk gets the remainder
    if (chunkIndex === count - 1) {
        return total - (base * (count - 1));
    }
    return base;
}

async function fetchDownloads() {
    const res = await fetch('/api/downloads');
    const downloads = await res.json();
    const container = document.getElementById('downloadList');
    container.innerHTML = downloads.map(d => {
        const total = Number(d.totalSize) || 0;
        const downloaded = Number(d.downloadedSize);
        const percent = total > 0 ? Math.min(100, (downloaded / total) * 100) : 0;
        const scheduled = d.scheduledAt ? new Date(d.scheduledAt).toLocaleString() : '';

        let chunkBars = '';
        if (d.chunks && d.chunks.length > 0) {
            chunkBars = `<div class="mt-2 space-y-1 text-xs">
                ${d.chunks.map(chunk => {
                const index = chunk.index;
                // Compute chunk size reliably
                let chunkSize = 0;
                if (chunk.endByte !== null && chunk.endByte !== undefined) {
                    chunkSize = Number(chunk.endByte) - Number(chunk.startByte) + 1;
                } else {
                    // fallback using total size and chunk count
                    chunkSize = getChunkSize(d, index);
                }
                const downloadedChunk = Number(chunk.downloadedBytes);
                const chunkPercent = chunkSize > 0 ? Math.min(100, (downloadedChunk / chunkSize) * 100) : 0;
                const statusColor = chunk.status === 'DONE' ? 'bg-success' : chunk.status === 'ACTIVE' ? 'bg-primary' : 'bg-gray-300';
                return `<div class="flex items-center gap-2">
                        <span class="w-12 text-right">#${index}</span>
                        <div class="flex-1 bg-gray-200 rounded-full h-2 relative">
                            <div class="chunk-bar ${statusColor} h-2 rounded-full transition-all duration-300" 
                                 data-chunk-id="${chunk.id}" 
                                 data-chunk-size="${chunkSize}"
                                 style="width: ${chunkPercent}%"></div>
                        </div>
                        <span class="w-20 text-right chunk-text-${chunk.id}">${formatBytes(downloadedChunk)} / ${chunkSize > 0 ? formatBytes(chunkSize) : '?'}</span>
                        <span class="badge badge-xs ${chunk.status === 'DONE' ? 'badge-success' : chunk.status === 'ACTIVE' ? 'badge-primary' : 'badge-ghost'}">${chunk.status}</span>
                    </div>`;
            }).join('')}
            </div>`;
        }

        return `
            <div class="card bg-base-100 shadow-xl" data-download-id="${d.id}">
                <div class="card-body">
                    <div class="flex justify-between items-start">
                        <div>
                            <h2 class="card-title">${d.filename}</h2>
                            <p class="text-sm text-gray-500 truncate max-w-md">${d.url}</p>
                        </div>
                        <span class="${getStatusBadge(d.status)}">${d.status}</span>
                    </div>
                    <div class="flex flex-wrap gap-2 text-sm">
                        <span>📁 ${d.directory || '/'}</span>
                        <span>🧩 ${d.chunkCount} parts</span>
                        ${scheduled ? `<span>⏰ ${scheduled}</span>` : ''}
                        <span>📦 ${formatBytes(downloaded)} / ${total > 0 ? formatBytes(total) : '?'}</span>
                    </div>
                    <div class="w-full bg-gray-200 rounded-full h-4 relative">
                        <div class="progress-bar bg-primary h-4 rounded-full transition-all duration-300" style="width: ${percent}%">
                            <span class="absolute inset-0 flex items-center justify-center text-xs text-white font-bold">${Math.round(percent)}%</span>
                        </div>
                    </div>
                    ${chunkBars}
                    <div class="card-actions justify-end mt-2">
                        ${d.status === 'DOWNLOADING' ? `<button class="btn btn-xs btn-outline" onclick="pauseDownload('${d.id}')">⏸️ Pause</button>` : ''}
                        ${d.status === 'PAUSED' ? `<button class="btn btn-xs btn-outline" onclick="resumeDownload('${d.id}')">▶️ Resume</button>` : ''}
                        ${d.status === 'ERROR' ? `<button class="btn btn-xs btn-outline" onclick="retryDownload('${d.id}')">🔄 Retry</button>` : ''}
                        ${['PENDING','PAUSED','SCHEDULED'].includes(d.status) ? `<button class="btn btn-xs btn-outline" onclick="editDownload('${d.id}')">✏️ Edit</button>` : ''}
                        <button class="btn btn-xs btn-outline btn-error" onclick="deleteDownload('${d.id}')">🗑️ Delete</button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// ----- Socket.IO events -----
socket.on('downloadProgress', (data) => {
    const { downloadId, chunkId, downloadedBytes, totalSize, chunkDownloadedBytes } = data;
    const card = document.querySelector(`[data-download-id="${downloadId}"]`);
    if (!card) return;

    // Overall progress
    const progressBar = card.querySelector('.progress-bar');
    if (totalSize && totalSize > 0) {
        const percent = Math.min(100, (downloadedBytes / totalSize) * 100);
        progressBar.style.width = percent + '%';
        progressBar.innerHTML = `<span class="absolute inset-0 flex items-center justify-center text-xs text-white font-bold">${Math.round(percent)}%</span>`;
    } else {
        progressBar.innerHTML = `<span class="absolute inset-0 flex items-center justify-center text-xs text-white font-bold">${formatBytes(downloadedBytes)}</span>`;
    }

    // Chunk bar
    const chunkBar = card.querySelector(`.chunk-bar[data-chunk-id="${chunkId}"]`);
    if (chunkBar) {
        let chunkSize = parseInt(chunkBar.dataset.chunkSize, 10);
        // If chunk size is still 0, we cannot show percentage; keep bar gray or use downloaded relative to something?
        // We'll set width to 0 if unknown.
        const chunkPercent = chunkSize > 0 ? Math.min(100, (chunkDownloadedBytes / chunkSize) * 100) : 0;
        chunkBar.style.width = chunkPercent + '%';
        const textSpan = card.querySelector(`.chunk-text-${chunkId}`);
        if (textSpan) {
            textSpan.textContent = `${formatBytes(chunkDownloadedBytes)} / ${chunkSize > 0 ? formatBytes(chunkSize) : '?'}`;
        }
        // Update status badge
        const badge = chunkBar.closest('.flex').querySelector('.badge');
        if (badge) {
            if (chunkPercent >= 100) {
                badge.className = 'badge badge-xs badge-success';
                badge.textContent = 'DONE';
            } else if (chunkPercent > 0) {
                badge.className = 'badge badge-xs badge-primary';
                badge.textContent = 'ACTIVE';
            } else {
                badge.className = 'badge badge-xs badge-ghost';
                badge.textContent = 'PENDING';
            }
        }
    }
});

socket.on('downloadComplete', (downloadId) => fetchDownloads());
socket.on('downloadError', (downloadId) => fetchDownloads());
socket.on('downloadStarted', (downloadId) => fetchDownloads());
socket.on('downloadResumed', (downloadId) => fetchDownloads());

// ----- API actions -----
async function pauseDownload(id) {
    await fetch(`/api/downloads/${id}/pause`, { method: 'POST' });
    fetchDownloads();
}
async function resumeDownload(id) {
    await fetch(`/api/downloads/${id}/resume`, { method: 'POST' });
    fetchDownloads();
}
async function retryDownload(id) {
    await fetch(`/api/downloads/${id}/retry`, { method: 'POST' });
    fetchDownloads();
}
async function deleteDownload(id) {
    if (confirm('Delete this download?')) {
        await fetch(`/api/downloads/${id}`, { method: 'DELETE' });
        fetchDownloads();
    }
}

// ----- Modal handling -----
function showAddModal() {
    document.getElementById('modalTitle').textContent = 'New Download';
    document.getElementById('editId').value = '';
    document.getElementById('addForm').reset();
    document.getElementById('addModal').showModal();
}

async function editDownload(id) {
    const res = await fetch(`/api/downloads/${id}`);
    const d = await res.json();
    document.getElementById('modalTitle').textContent = 'Edit Download';
    document.getElementById('editId').value = d.id;
    document.getElementById('urlInput').value = d.url;
    document.getElementById('filenameInput').value = d.filename;
    document.getElementById('dirInput').value = d.directory;
    document.getElementById('chunkInput').value = d.chunkCount;
    if (d.scheduledAt) {
        const date = new Date(d.scheduledAt);
        document.getElementById('scheduleInput').value = date.toISOString().slice(0, 16);
    } else {
        document.getElementById('scheduleInput').value = '';
    }
    document.getElementById('addModal').showModal();
}

document.getElementById('addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('editId').value;
    const url = document.getElementById('urlInput').value;
    const filename = document.getElementById('filenameInput').value;
    const directory = document.getElementById('dirInput').value;
    const chunkCount = parseInt(document.getElementById('chunkInput').value) || 4;
    const scheduledAt = document.getElementById('scheduleInput').value || null;

    const payload = { url, filename, directory, chunkCount, scheduledAt };
    const method = id ? 'PUT' : 'POST';
    const endpoint = id ? `/api/downloads/${id}` : '/api/downloads';

    const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (res.ok) {
        document.getElementById('addModal').close();
        fetchDownloads();
    } else {
        const err = await res.json();
        alert('Error: ' + err.error);
    }
});

// ----- Settings modal -----
async function showSettingsModal() {
    const res = await fetch('/api/settings');
    const settings = await res.json();
    document.getElementById('downloadDirInput').value = settings.downloadDirectory || '';
    document.getElementById('maxTasksInput').value = settings.maxConcurrentTasks || 3;
    document.getElementById('settingsModal').showModal();
}

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const downloadDirectory = document.getElementById('downloadDirInput').value;
    const maxConcurrentTasks = parseInt(document.getElementById('maxTasksInput').value) || 3;
    await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ downloadDirectory, maxConcurrentTasks }),
    });
    document.getElementById('settingsModal').close();
    fetchDownloads();
});

// ----- Initial load -----
fetchDownloads();