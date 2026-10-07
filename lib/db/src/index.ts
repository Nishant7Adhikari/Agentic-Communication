import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

try {
  process.loadEnvFile();
} catch {}

const databaseUrl = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/agent_coordination_hub";

const { Pool } = pg;
export const pool = new Pool({ connectionString: databaseUrl, ssl: true });
export const db = drizzle(pool, { schema });

export * from "./schema";
