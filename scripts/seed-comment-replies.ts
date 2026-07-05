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

interface CommentQA {
  id: string;
  videoId: string;
  videoTitle: string;
  question: string;
  author: string;
  reply: string;
  likes?: number;
}

async function seedCommentReplies() {
  const filePath = path.join(process.cwd(), "data/comment_replies.json");
  if (!fs.existsSync(filePath)) {
    console.error("❌ comment_replies.json not found! Run fetch_youtube_comments.py first.");
    process.exit(1);
  }

  const items: CommentQA[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  console.log(`🚀 Starting RAG Seeding for ${items.length} YouTube Comment Q&A Replies...`);
  console.log("=".repeat(70));

  // 1. Upsert canonical Video source record for Comments Q&A
  const videoId = "youtube_comments_qa_archive";
  const video = await prisma.video.upsert({
    where: { youtubeId: videoId },
    update: { title: "Chai aur Code YouTube Comments & Community Q&A" },
    create: {
      youtubeId: videoId,
      title: "Chai aur Code YouTube Comments & Community Q&A",
      url: "https://www.youtube.com/@chaiaurcode/community",
      publishedAt: new Date(),
      playlistName: "Community Q&A",
      topicTags: ["comments", "qna", "hitesh sir", "mentorship", "advice", "chaiaurcode"],
    },
  });

  console.log(`📌 Upserted canonical archive record: "${video.title}" (${video.id})`);

  // 2. Delete old chunks for idempotency
  const deleted = await prisma.transcriptChunk.deleteMany({
    where: { videoId: video.id },
  });
  if (deleted.count > 0) {
    console.log(`♻️ Deleted ${deleted.count} old comment Q&A chunks for clean seeding.`);
  }

  // 3. Format chunks (1 chunk per Q&A pair)
  const chunks = items.map((item, idx) => ({
    id: randomUUID(),
    textHindi: `[YouTube Comment Q&A on "${item.videoTitle}"]\nStudent Question: "${item.question}"\n\nHitesh Sir Reply (${item.author}): "${item.reply}"`,
    startSec: idx * 10, // dummy timestamp ordering for comments
    endSec: idx * 10 + 5,
  }));

  console.log(`📦 Prepared ${chunks.length} structured textual chunks for Cohere embedding.`);

  // 4. Batch generate embeddings via Cohere
  const BATCH_SIZE = 20;
  let totalInserted = 0;

  for (let b = 0; b < chunks.length; b += BATCH_SIZE) {
    const batch = chunks.slice(b, b + BATCH_SIZE);
    const texts = batch.map(c => c.textHindi);

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
            chunk.id,
            video.id,
            chunk.startSec,
            chunk.endSec,
            chunk.textHindi,
            vecString
          );
        }

        totalInserted += batch.length;
        console.log(`⚡ Embedded & inserted batch: ${Math.min(b + BATCH_SIZE, chunks.length)}/${chunks.length} Q&A chunks`);
        success = true;

        await new Promise(r => setTimeout(r, 3000));
      } catch (err: any) {
        const isRateLimit = err.status === 429 || (err.message && err.message.includes("rate limit"));
        if (isRateLimit) {
          retries++;
          console.log(`⏳ [Rate Limit Hit 429] Waiting 45s for Cohere token bucket reset (Retry ${retries}/5)...`);
          await new Promise(r => setTimeout(r, 45000));
        } else {
          console.error("❌ Error embedding comment batch:", err.message || err);
          break;
        }
      }
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log(`🎉 SUCCESS! Seeded ${totalInserted} YouTube Comment Q&A replies into DigitalOcean pgvector!`);
  console.log("=".repeat(70));

  await prisma.$disconnect();
}

seedCommentReplies().catch(err => {
  console.error("❌ Fatal Error:", err);
  prisma.$disconnect();
  process.exit(1);
});
