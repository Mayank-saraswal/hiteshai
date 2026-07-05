import "dotenv/config";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { CohereClientV2 } from "cohere-ai";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const cohere = new CohereClientV2({ token: process.env.COHERE_API_KEY });

interface TranscriptItem {
  text: string;
  start: number;
  duration: number;
}

async function seedLiveStreams() {
  const liveDir = path.join(process.cwd(), "data/live_transcripts");
  if (!fs.existsSync(liveDir)) {
    console.error("❌ Live transcripts directory not found!");
    process.exit(1);
  }

  const files = fs.readdirSync(liveDir).filter(f => f.endsWith(".json"));
  console.log(`🚀 Starting RAG Seeding for ${files.length} Live Stream Transcripts...`);
  console.log("=" .repeat(70));

  let totalChunksInserted = 0;
  const startTime = Date.now();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const videoId = file.replace(".json", "");
    const filePath = path.join(liveDir, file);

    console.log(`\n📹 [${i + 1}/${files.length}] Processing Live Stream: ${videoId}`);

    // 1. Read transcript JSON
    const items: TranscriptItem[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!items || items.length === 0) {
      console.log(`  ⚠️ Empty transcript, skipping.`);
      continue;
    }

    // 2. Upsert Video record in PostgreSQL
    const video = await prisma.video.upsert({
      where: { youtubeId: videoId },
      update: { title: `Chai aur Code Live Stream (${videoId})` },
      create: {
        youtubeId: videoId,
        title: `Chai aur Code Live Stream (${videoId})`,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        publishedAt: new Date(),
        playlistName: "Live Streams",
        topicTags: ["live", "chaiaurcode", "qna", "hitesh sir"],
      },
    });

    // 3. Delete existing chunks for idempotency
    const deleted = await prisma.transcriptChunk.deleteMany({
      where: { videoId: video.id },
    });
    if (deleted.count > 0) {
      console.log(`  ♻️ Deleted ${deleted.count} old chunks for clean re-seeding.`);
    }

    // 4. Group lines into logical chunks (~200 words with 30% overlap)
    const chunks: { text: string; startSec: number; endSec: number }[] = [];
    let windowItems: TranscriptItem[] = [];
    let wordCount = 0;

    for (let j = 0; j < items.length; j++) {
      const item = items[j];
      windowItems.push(item);
      wordCount += item.text.split(/\s+/).length;

      if (wordCount >= 200 || j === items.length - 1) {
        const textHindi = windowItems
          .map(it => it.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();

        if (textHindi.length > 20) {
          chunks.push({
            text: textHindi,
            startSec: Math.round(windowItems[0].start),
            endSec: Math.round(windowItems[windowItems.length - 1].start + windowItems[windowItems.length - 1].duration),
          });
        }

        // Keep last 30% items for overlap
        const keepCount = Math.max(1, Math.floor(windowItems.length * 0.3));
        windowItems = windowItems.slice(-keepCount);
        wordCount = windowItems.reduce((acc, it) => acc + it.text.split(/\s+/).length, 0);
      }
    }

    console.log(`  📦 Created ${chunks.length} logical chunks from ${items.length} subtitle lines.`);

    // 5. Batch generate embeddings via Cohere API with rate limit retry logic
    const BATCH_SIZE = 35; // Keep batch under ~8,000 tokens
    for (let b = 0; b < chunks.length; b += BATCH_SIZE) {
      const batch = chunks.slice(b, b + BATCH_SIZE);
      const texts = batch.map(c => c.text);

      let success = false;
      let retries = 0;

      while (!success && retries < 5) {
        try {
          const res = await cohere.embed({
            texts: texts,
            model: "embed-multilingual-v3.0",
            inputType: "search_document",
            embeddingTypes: ["float"],
          });

          const floatEmbeddings = res.embeddings.float!;

          // Insert into database using raw SQL for pgvector column
          for (let k = 0; k < batch.length; k++) {
            const chunk = batch[k];
            const vecString = `[${floatEmbeddings[k].join(",")}]`;

            await prisma.$executeRawUnsafe(
              `INSERT INTO "TranscriptChunk" ("id", "videoId", "startSec", "endSec", "textHindi", "embedding") 
               VALUES ($1, $2, $3, $4, $5, $6::vector)`,
              randomUUID(),
              video.id,
              chunk.startSec,
              chunk.endSec,
              chunk.text,
              vecString
            );
          }

          totalChunksInserted += batch.length;
          console.log(`  ⚡ Embedded & saved batch: ${Math.min(b + BATCH_SIZE, chunks.length)}/${chunks.length} chunks`);
          success = true;

          // polite delay to avoid 100k tokens/min rate limit
          await new Promise(r => setTimeout(r, 3500));
        } catch (err: any) {
          const isRateLimit = err.status === 429 || (err.message && err.message.includes("rate limit"));
          if (isRateLimit) {
            retries++;
            console.log(`  ⏳ [Rate Limit Hit 429] Waiting 45 seconds for Cohere trial token bucket to reset (Retry ${retries}/5)...`);
            await new Promise(r => setTimeout(r, 45000));
          } else {
            console.error(`  ❌ Error embedding batch for ${videoId}:`, err.message || err);
            break;
          }
        }
      }
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n" + "=" .repeat(70));
  console.log(`🎉 SUCCESS! Seeded ${files.length} Live Streams (${totalChunksInserted} total chunks) in ${durationSec}s!`);
  console.log("=" .repeat(70));

  // 6. Test RAG Retrieval
  await testRetrieval();
  await prisma.$disconnect();
}

async function testRetrieval() {
  console.log("\n🧪 RUNNING LIVE RAG RETRIEVAL TEST ON DIGITALOCEAN DB...");
  const queries = [
    "college system aur education ke bare me kya views hain?",
    "system design ya backend kaise seekhe?",
    "software architect ka role kya hota hai?"
  ];

  for (const query of queries) {
    console.log(`\n❓ Query: "${query}"`);
    console.log("-" .repeat(60));

    const queryEmbed = await cohere.embed({
      texts: [query],
      model: "embed-multilingual-v3.0",
      inputType: "search_query",
      embeddingTypes: ["float"],
    });

    const qVec = `[${queryEmbed.embeddings.float![0].join(",")}]`;

    const results: any[] = await prisma.$queryRawUnsafe(
      `SELECT c."textHindi", c."startSec", c."endSec", v."title", v."url",
              1 - (c."embedding" <=> $1::vector) AS similarity
       FROM "TranscriptChunk" c
       JOIN "Video" v ON c."videoId" = v."id"
       ORDER BY c."embedding" <=> $1::vector
       LIMIT 2`,
      qVec
    );

    for (const r of results) {
      const matchPct = (r.similarity * 100).toFixed(1);
      console.log(`🔹 [Match: ${matchPct}%] ${r.title} (@ ${r.startSec}s):`);
      console.log(`   💬 "${r.textHindi.substring(0, 180)}..."`);
      console.log(`   🔗 Watch: ${r.url}&t=${r.startSec}s\n`);
    }
  }
}

seedLiveStreams().catch(err => {
  console.error("❌ Fatal Error:", err);
  prisma.$disconnect();
  process.exit(1);
});
