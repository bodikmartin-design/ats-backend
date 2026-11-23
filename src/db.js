import { config } from "./config.js";

/**
 * Database access. The app talks to Postgres (Supabase) through this small async interface:
 *
 *   db.all(sql, params)   -> rows
 *   db.get(sql, params)   -> first row, or undefined
 *   db.run(sql, params)   -> { changes, rows }
 *   db.insert(sql, params)-> the new row's id (adds RETURNING id)
 *   db.tx(async (t) => {}) -> runs t.all / t.get / t.run / t.insert inside one transaction (rolled back if it throws)
 *
 * SQL is written with `?` placeholders; they are turned into $1, $2, ... here (a `?` inside a quoted string is left alone).
 * The "pg" driver is used in production (Supabase); "pglite" is an in-process Postgres for tests and local trials.
 */

/** "a = ? AND b = ?" -> "a = $1 AND b = $2" */
export function toPgSql(sql) {
  let out = "";
  let n = 0;
  let quote = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") quote = !quote; // '' inside a string toggles twice, which keeps the state right
    if (c === "?" && !quote) out += `$${++n}`;
    else out += c;
  }
  return out;
}

function wrap(exec) {
  const self = {
    async all(sql, params = []) {
      return (await exec(toPgSql(sql), params)).rows;
    },
    async get(sql, params = []) {
      return (await exec(toPgSql(sql), params)).rows[0];
    },
    async run(sql, params = []) {
      const r = await exec(toPgSql(sql), params);
      return { changes: r.rowCount ?? r.rows.length, rows: r.rows };
    },
    async insert(sql, params = []) {
      const r = await exec(toPgSql(/\breturning\b/i.test(sql) ? sql : `${sql} RETURNING id`), params);
      return r.rows[0]?.id;
    },
  };
  return self;
}

async function createPgDriver() {
  const pg = (await import("pg")).default;
  // bigint (COUNT(*), epoch milliseconds) comes back as a number, like it did with SQLite. Nothing here gets near 2^53.
  pg.types.setTypeParser(20, (v) => Number(v));
  if (!config.db.url) {
    throw new Error("DATABASE_URL is not set. Copy the connection string from Supabase (Project Settings > Database).");
  }
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(config.db.url);
  const ssl = !config.db.ssl || local ? false : config.db.caCert ? { ca: config.db.caCert } : { rejectUnauthorized: false };
  const pool = new pg.Pool({
    connectionString: config.db.url,
    max: config.db.poolMax,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    ssl,
  });
  pool.on("error", (err) => console.error("[db] idle client error:", err.message));
  try {
    // Lets Vercel close idle connections before it freezes the instance (Fluid compute). Harmless elsewhere.
    const vf = await import("@vercel/functions");
    if (typeof vf.attachDatabasePool === "function") vf.attachDatabasePool(pool);
  } catch {
    /* not on Vercel */
  }

  const base = wrap((sql, params) => pool.query(sql, params));
  return {
    ...base,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(wrap((sql, params) => client.query(sql, params)));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function createPgliteDriver() {
  const { PGlite } = await import("@electric-sql/pglite");
  const lite = config.db.pgliteDir ? new PGlite(config.db.pgliteDir) : new PGlite();
  await lite.waitReady;
  const norm = (r) => ({ rows: r.rows, rowCount: r.affectedRows ?? r.rows.length });
  const base = wrap(async (sql, params) => norm(await lite.query(sql, params)));
  return {
    ...base,
    async tx(fn) {
      return lite.transaction(async (t) => fn(wrap(async (sql, params) => norm(await t.query(sql, params)))));
    },
    async exec(sql) {
      await lite.exec(sql);
    },
    async close() {
      await lite.close();
    },
  };
}

let driverPromise;
const driver = () => (driverPromise ??= config.db.driver === "pglite" ? createPgliteDriver() : createPgDriver());

/** The driver is created on first use, so importing this module never opens a connection. */
export const db = {
  all: async (sql, params) => (await driver()).all(sql, params),
  get: async (sql, params) => (await driver()).get(sql, params),
  run: async (sql, params) => (await driver()).run(sql, params),
  insert: async (sql, params) => (await driver()).insert(sql, params),
  tx: async (fn) => (await driver()).tx(fn),
  /** Several statements at once, no parameters (schema scripts). */
  exec: async (sql) => {
    const d = await driver();
    if (d.exec) return d.exec(sql);
    return d.run(sql); // pg runs a multi-statement string fine as long as it has no parameters
  },
  close: async () => {
    if (driverPromise) await (await driverPromise).close();
    driverPromise = undefined;
  },
};
