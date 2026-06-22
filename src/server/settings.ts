import { query, queryOne } from "./db";

export async function getSetting<T = any>(key: string): Promise<T | null> {
  const row = await queryOne("SELECT value FROM settings WHERE key = $1", [key]);
  return row ? (row.value as T) : null;
}

export async function setSetting(key: string, value: any): Promise<void> {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]
  );
}

export async function initSettings(): Promise<void> {
  const defaults: Record<string, any> = {
    downloadDirectory: "./downloads",
    maxConcurrentTasks: 3,
    defaultChunkCount: 4,
  };

  for (const [key, val] of Object.entries(defaults)) {
    const existing = await getSetting(key);
    if (existing === null) {
      await setSetting(key, val);
    }
  }
}
