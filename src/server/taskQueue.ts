import { DownloadService } from "./downloader";
import { getSetting } from "./settings";

class TaskQueue {
  private queue: string[] = [];
  private activeCount = 0;
  private maxConcurrency = 3;

  constructor() {
    this.syncMaxConcurrency();
  }

  public async syncMaxConcurrency() {
    const limit = await getSetting<number>("maxConcurrentTasks");
    if (limit && limit > 0) {
      this.maxConcurrency = limit;
    }
  }

  public setConcurrency(limit: number) {
    if (limit > 0) {
      this.maxConcurrency = limit;
      this.processNext();
    }
  }

  public enqueue(downloadId: string) {
    if (!this.queue.includes(downloadId)) {
      this.queue.push(downloadId);
      this.processNext();
    }
  }

  private async processNext() {
    if (this.activeCount >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    const downloadId = this.queue.shift()!;
    this.activeCount++;

    try {
      const downloadDirectory = (await getSetting<string>("downloadDirectory")) || "./downloads";
      await DownloadService.startDownload(downloadId, downloadDirectory);
    } catch (err) {
      console.error(`Error processing task [${downloadId}] in queue:`, err);
    } finally {
      this.activeCount--;
      this.processNext();
    }
  }
}

export const taskQueue = new TaskQueue();

export function enqueueDownload(downloadId: string) {
  taskQueue.enqueue(downloadId);
}
