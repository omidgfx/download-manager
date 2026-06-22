import schedule from "node-schedule";
import { query } from "./db";
import { enqueueDownload } from "./taskQueue";

const scheduledJobs = new Map<string, schedule.Job>();

export async function initScheduler(): Promise<void> {
  const now = new Date().toISOString();

  // 1. Process downloads that were scheduled in the past but missed
  const due = await query(
    `SELECT id, status, scheduled_at FROM downloads
     WHERE status IN ('PENDING', 'SCHEDULED')
       AND scheduled_at <= $1`,
    [now]
  );

  for (const d of due) {
    enqueueDownload(d.id);
    if (d.status === "SCHEDULED") {
      await query("UPDATE downloads SET status = $1 WHERE id = $2", ["PENDING", d.id]);
    }
  }

  // 2. Schedule future downloads
  const future = await query(
    `SELECT id, scheduled_at FROM downloads
     WHERE status = 'SCHEDULED' AND scheduled_at > $1`,
    [now]
  );

  for (const d of future) {
    if (d.scheduledAt) {
      scheduleDownload(d.id, new Date(d.scheduledAt));
    }
  }
}

export function scheduleDownload(downloadId: string, date: Date): void {
  // Clear any existing job configuration
  cancelScheduledJob(downloadId);

  const job = schedule.scheduleJob(date, async () => {
    try {
      await query("UPDATE downloads SET status = $1, scheduled_at = NULL WHERE id = $2", ["PENDING", downloadId]);
      enqueueDownload(downloadId);
    } catch (err) {
      console.error(`Failed to execute scheduled trigger for task ${downloadId}:`, err);
    } finally {
      scheduledJobs.delete(downloadId);
    }
  });

  scheduledJobs.set(downloadId, job);
}

export function cancelScheduledJob(downloadId: string): void {
  const job = scheduledJobs.get(downloadId);
  if (job) {
    job.cancel();
    scheduledJobs.delete(downloadId);
  }
}
