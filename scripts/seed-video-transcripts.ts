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

interface VideoMeta {
  id: string;
  title: string;
  playlist: string;
}

async function seedVideoTranscripts() {
  const videoDir = path.join(process.cwd(), "data/video_transcripts");
  const masterListPath = path.join(process.cwd(), "data/master_video_list.json");

  if (!fs.existsSync(videoDir)) {
    console.error("❌ Video transcripts directory not found!");
    process.exit(1);
  }

  let metaMap: Record<string, { title: string; playlist: string }> = {};
  if (fs.existsSync(masterListPath)) {
    const masterList: VideoMeta[] = JSON.parse(fs.readFileSync(masterListPath, "utf-8"));
    for (const item of masterList) {
      metaMap[item.id] = { title: item.title, playlist: item.playlist || "Chai aur Code Tutorials" };
    }
    console.log(`📚 Loaded metadata for ${Object.keys(metaMap).length} videos from master_video_list.json`);
  }

  const files = fs.readdirSync(videoDir).filter(f => f.endsWith(".json"));
  console.log(`🚀 Starting RAG Seeding for ${files.length} Regular Video Transcripts...`);
  console.log("=".repeat(70));

  let totalChunksInserted = 0;
  const startTime = Date.now();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const videoId = file.replace(".json", "");
    const filePath = path.join(videoDir, file);

    const meta = metaMap[videoId] || {
      title: `Chai aur Code Tutorial (${videoId})`,
      playlist: "Chai aur Code Tutorials"
    };

    console.log(`\n📹 [${i + 1}/${files.length}] Processing Video: "${meta.title}" (${videoId})`);

    // 1. Read transcript JSON
    let items: TranscriptItem[] = [];
    try {
      items = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (err) {
      console.log(`  ⚠️ Error reading JSON file ${file}, skipping.`);
      continue;
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      console.log(`  ⚠️ Empty transcript for ${videoId}, skipping.`);
      continue;
    }

    // 2. Upsert Video record in PostgreSQL
    const video = await prisma.video.upsert({
      where: { youtubeId: videoId },
      update: { title: meta.title, playlistName: meta.playlist },
      create: {
        youtubeId: videoId,
        title: meta.title,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        publishedAt: new Date(),
        playlistName: meta.playlist,
        topicTags: [meta.playlist.toLowerCase(), "chaiaurcode", "tutorial", "hitesh sir"],
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
            endSec: Math.round(windowItems[windowItems.length - 1].start + (windowItems[windowItems.length - 1].duration || 0)),
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
    const BATCH_SIZE = 35;
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
  console.log("\n" + "=".repeat(70));
  console.log(`🎉 SUCCESS! Seeded ${files.length} Regular Videos (${totalChunksInserted} total chunks) in ${durationSec}s!`);
  console.log("=".repeat(70));

  await prisma.$disconnect();
}

seedVideoTranscripts().catch(err => {
  console.error("❌ Fatal Error:", err);
  prisma.$disconnect();
  process.exit(1);
});
