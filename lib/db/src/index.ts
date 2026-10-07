import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

try {
  process.loadEnvFile();
} catch {}

const databaseUrl = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/agent_coordination_hub";

const sql = neon(databaseUrl);
export const db = drizzle(sql, { schema });

export * from "./schema";
