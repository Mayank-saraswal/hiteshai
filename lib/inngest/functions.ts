import { inngest } from "./client";

export const helloWorld = inngest.createFunction(
  { 
    id: "hello-world",
    triggers: [{ event: "test/hello.world" }]
  },
  async ({ event, step }) => {
    await step.sleep("wait-a-moment", "1s");
    return { message: `Hello ${event.data.email || "Hitesh Sir"}!` };
  }
);

export const syncVideoTranscript = inngest.createFunction(
  { 
    id: "sync-video-transcript", 
    retries: 3,
    triggers: [{ event: "video/transcript.fetch" }]
  },
  async ({ event, step }) => {
    const { videoId } = event.data;

    const transcriptData = await step.run("fetch-transcript-json", async () => {
      // Future: fetch transcript via local script/proxy and return text chunks
      return { videoId, status: "fetched", chunkCount: 0 };
    });

    const embeddedData = await step.run("generate-embeddings", async () => {
      // Future: generate vector embeddings for chunks and insert to DigitalOcean pgvector
      return { videoId, embedded: true };
    });

    return { success: true, videoId, transcriptData, embeddedData };
  }
);

export const functions = [helloWorld, syncVideoTranscript];
