import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Thin persistence layer on Node's built-in SQLite (no native addon to build).
 * Everything here is small: processed message cache, live tracks for restarts,
 * and push subscriptions.
 */
export interface StoredMessage {
  channel: string
  id: number
  date: number
  editDate: number | null
  text: string
  replyToId: number | null
  extraction: string | null
  trackIds: string[]
}

export interface RouteRecord {
  id: string
  type: string
  model: string | null
  startedAt: number
  endedAt: number
  /** destroyed / lost / expired. */
  outcome: string
  path: { lat: number; lon: number; at: number; place: string }[]
}

export class Store {
  readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS messages (
        channel TEXT NOT NULL,
        id INTEGER NOT NULL,
        date INTEGER NOT NULL,
        edit_date INTEGER,
        text TEXT NOT NULL,
        reply_to_id INTEGER,
        extraction TEXT,
        track_ids TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (channel, id)
      );
      CREATE INDEX IF NOT EXISTS messages_date ON messages(date);
      CREATE TABLE IF NOT EXISTS tracks (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observations (
        at INTEGER NOT NULL,
        place TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        type TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS observations_at ON observations(at);
      CREATE TABLE IF NOT EXISTS routes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        model TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        path TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS routes_started ON routes(started_at);
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
  }

  getMessage(channel: string, id: number): StoredMessage | null {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE channel = ? AND id = ?')
      .get(channel, id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      channel: row.channel as string,
      id: row.id as number,
      date: row.date as number,
      editDate: (row.edit_date as number | null) ?? null,
      text: row.text as string,
      replyToId: (row.reply_to_id as number | null) ?? null,
      extraction: (row.extraction as string | null) ?? null,
      trackIds: JSON.parse(row.track_ids as string) as string[],
    }
  }

  saveMessage(m: StoredMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (channel, id, date, edit_date, text, reply_to_id, extraction, track_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel, id) DO UPDATE SET
           edit_date = excluded.edit_date, text = excluded.text, reply_to_id = excluded.reply_to_id,
           extraction = excluded.extraction, track_ids = excluded.track_ids`,
      )
      .run(
        m.channel,
        m.id,
        m.date,
        m.editDate,
        m.text,
        m.replyToId,
        m.extraction,
        JSON.stringify(m.trackIds),
      )
  }

  pruneMessages(olderThan: number): number {
    return Number(this.db.prepare('DELETE FROM messages WHERE date < ?').run(olderThan).changes)
  }

  loadTracks<T>(): T[] {
    const rows = this.db.prepare('SELECT data FROM tracks').all() as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as T)
  }

  saveTrack(id: string, data: unknown, updatedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO tracks (id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(id, JSON.stringify(data), updatedAt)
  }

  deleteTrack(id: string): void {
    this.db.prepare('DELETE FROM tracks WHERE id = ?').run(id)
  }

  listSubscriptions<T>(): T[] {
    const rows = this.db.prepare('SELECT data FROM push_subscriptions').all() as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as T)
  }

  saveSubscription(endpoint: string, data: unknown): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, data, created_at) VALUES (?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET data = excluded.data`,
      )
      .run(endpoint, JSON.stringify(data), Date.now())
  }

  deleteSubscription(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
  }

  addObservation(o: { at: number; place: string; lat: number; lon: number; type: string }): void {
    this.db
      .prepare('INSERT INTO observations (at, place, lat, lon, type) VALUES (?, ?, ?, ?, ?)')
      .run(o.at, o.place, o.lat, o.lon, o.type)
  }

  /** Most reported places since `since` (routes and impact areas repeat). */
  hotspots(
    since: number,
    limit = 200,
    types?: string[],
  ): { name: string; lat: number; lon: number; count: number }[] {
    const filter = types?.length ? `AND type IN (${types.map(() => '?').join(',')})` : ''
    return this.db
      .prepare(
        `SELECT place AS name, AVG(lat) AS lat, AVG(lon) AS lon, COUNT(*) AS count
         FROM observations WHERE at >= ? ${filter}
         GROUP BY place ORDER BY count DESC LIMIT ?`,
      )
      .all(since, ...(types ?? []), limit) as {
      name: string
      lat: number
      lon: number
      count: number
    }[]
  }

  pruneObservations(olderThan: number): void {
    this.db.prepare('DELETE FROM observations WHERE at < ?').run(olderThan)
  }

  saveRoute(r: RouteRecord): void {
    this.db
      .prepare(
        `INSERT INTO routes (id, type, model, started_at, ended_at, outcome, path) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, outcome = excluded.outcome, path = excluded.path`,
      )
      .run(r.id, r.type, r.model, r.startedAt, r.endedAt, r.outcome, JSON.stringify(r.path))
  }

  routes(since: number): RouteRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM routes WHERE started_at >= ? ORDER BY started_at')
      .all(since) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as string,
      type: r.type as string,
      model: (r.model as string | null) ?? null,
      startedAt: r.started_at as number,
      endedAt: r.ended_at as number,
      outcome: r.outcome as string,
      path: JSON.parse(r.path as string) as RouteRecord['path'],
    }))
  }

  getJson<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row ? (JSON.parse(row.value) as T) : null
  }

  setJson(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value))
  }

  close(): void {
    this.db.close()
  }
}
