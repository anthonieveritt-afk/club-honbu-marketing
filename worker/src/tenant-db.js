import pg from "pg";

// Per-club database on the shared tenant Postgres: one role + one database per club,
// owned by that role, with CONNECT revoked from PUBLIC so clubs can't reach each other.
const IDENT_RE = /^[a-z][a-z0-9_]{2,62}$/;

export function createTenantDb({ adminUrl, ClientImpl = pg.Client }) {
  async function withClient(fn) {
    const c = new ClientImpl({ connectionString: adminUrl });
    await c.connect();
    try { return await fn(c); } finally { await c.end(); }
  }
  return {
    /** Idempotent. Returns true if the database was created in this call. */
    async ensureDatabase({ dbName, roleName, password }) {
      if (!IDENT_RE.test(dbName) || !IDENT_RE.test(roleName)) throw new Error(`Unsafe identifier ${dbName}/${roleName}`);
      if (!/^[A-Za-z0-9]{16,}$/.test(password)) throw new Error("Unsafe password");
      return withClient(async (c) => {
        const role = await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [roleName]);
        if (!role.rowCount) await c.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}'`);
        else await c.query(`ALTER ROLE "${roleName}" LOGIN PASSWORD '${password}'`);
        const db = await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
        let created = false;
        if (!db.rowCount) {
          try {
            await c.query(`CREATE DATABASE "${dbName}" OWNER "${roleName}"`);
            created = true;
          } catch (err) {
            if (err.code !== "42P04") throw err; // created concurrently: fine
          }
        }
        await c.query(`REVOKE CONNECT ON DATABASE "${dbName}" FROM PUBLIC`);
        await c.query(`GRANT CONNECT ON DATABASE "${dbName}" TO "${roleName}"`);
        return created;
      });
    },

    /** Read-only: does the club database / role exist? (dry runs and teardown logging) */
    async inspect({ dbName, roleName }) {
      return withClient(async (c) => ({
        database: (await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName])).rowCount > 0,
        role: (await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [roleName])).rowCount > 0,
      }));
    },

    /**
     * Teardown. Idempotent: returns what was actually dropped in this call.
     * Only ever touches HQ-named club databases (club_<slug> owned by club_<slug>_app).
     */
    async dropDatabase({ dbName, roleName }) {
      if (!IDENT_RE.test(dbName) || !IDENT_RE.test(roleName)) throw new Error(`Unsafe identifier ${dbName}/${roleName}`);
      if (!dbName.startsWith("club_") || roleName !== `${dbName}_app`) throw new Error(`Refusing to drop ${dbName}/${roleName}: not an HQ club database`);
      return withClient(async (c) => {
        const db = await c.query("SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1", [dbName]);
        if (db.rowCount && db.rows[0].owner !== roleName) {
          throw new Error(`Refusing to drop ${dbName}: owned by ${db.rows[0].owner}, not ${roleName}`);
        }
        let droppedDb = false, droppedRole = false;
        if (db.rowCount) {
          await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
          droppedDb = true;
        }
        const role = await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [roleName]);
        if (role.rowCount) {
          await c.query(`DROP ROLE IF EXISTS "${roleName}"`);
          droppedRole = true;
        }
        return { droppedDb, droppedRole };
      });
    },
  };
}

export function tenantDatabaseUrl({ appHost, dbName, roleName, password }) {
  return `postgresql://${roleName}:${password}@${appHost}/${dbName}`;
}
