import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

async function testConnection() {
  console.log("Connecting to DigitalOcean Managed Postgres...");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    const client = await pool.connect();
    console.log("✔️ Successfully connected to database!");
    
    console.log("Checking vector extension...");
    await client.query("CREATE EXTENSION IF NOT EXISTS vector;");
    const res = await client.query("SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';");
    console.log("✔️ Vector extension status:", res.rows);

    client.release();
    await pool.end();
    console.log("🎉 Database setup & connection test completed successfully!");
  } catch (error) {
    console.error("❌ Database connection error:", error);
    process.exit(1);
  }
}

testConnection();
