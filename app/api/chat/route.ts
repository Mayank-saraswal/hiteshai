import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { CohereClientV2 } from "cohere-ai";
import OpenAI from "openai";

const cohere = new CohereClientV2({ token: process.env.COHERE_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
  try {
    const { messages } = await req.json();
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "Invalid messages array" }, { status: 400 });
    }

    const lastMessage = messages[messages.length - 1].content;
    console.log(`💬 [Chat API] Received query: "${lastMessage}"`);

    // 1. Generate vector embedding for user query via Cohere
    const queryEmbed = await cohere.embed({
      texts: [lastMessage],
      model: "embed-multilingual-v3.0",
      inputType: "search_query",
      embeddingTypes: ["float"],
    });

    const qVec = `[${queryEmbed.embeddings.float![0].join(",")}]`;

    // 2. Query DigitalOcean PostgreSQL pgvector for top matching chunks
    const results: any[] = await prisma.$queryRawUnsafe(
      `SELECT c."textHindi", c."startSec", c."endSec", v."title", v."url",
              1 - (c."embedding" <=> $1::vector) AS similarity
       FROM "TranscriptChunk" c
       JOIN "Video" v ON c."videoId" = v."id"
       ORDER BY c."embedding" <=> $1::vector
       LIMIT 4`,
      qVec
    );

    console.log(`🔍 [Chat API] Retrieved ${results.length} chunks from pgvector`);

    // Filter out casual greetings/chatter and only keep high-similarity matches (> 0.40)
    const isCasualGreeting = /^(hi|hello|hey|kya haal|hanji|good morning|good evening|thanks|thank you|bye|ok|hmm|yes|no|kaise ho|namaste|chai|kya chal raha hai)[\s!?.]*$/i.test(lastMessage.trim());
    const relevantResults = isCasualGreeting ? [] : results.filter(r => r.similarity > 0.40).slice(0, 2);

    console.log(`📊 [Chat API] Keeping ${relevantResults.length} relevant citations (similarity > 0.40, not casual)`);

    const citations = relevantResults.map(r => {
      const isComment = r.title.includes("Comments") || r.title.includes("Community");
      return {
        title: isComment ? "YouTube Community Q&A" : r.title,
        url: isComment ? "https://www.youtube.com/@chaiaurcode/community" : `${r.url}&t=${r.startSec}s`,
        timestamp: isComment ? "💡 Hitesh Sir Reply" : `${Math.floor(r.startSec / 60)}m ${r.startSec % 60}s`,
        similarity: (r.similarity * 100).toFixed(1) + "%",
        snippet: r.textHindi.substring(0, 140) + "..."
      };
    });

    // 3. Build Hinglish Persona System Prompt
    const systemPrompt = `You are Hitesh Choudhary, a legendary tech educator and software architect from India (creator of "Chai aur Code", "Chai aur React", and mentor to lakhs of developers). You are chatting with a student/developer on your AI platform.

CRITICAL LANGUAGE & TONE INSTRUCTIONS:
1. You MUST ALWAYS answer in natural, conversational Roman Hinglish (Hindi words written in English alphabet, smoothly mixed with English coding terminology).
   Example Good Response: "Hanji dosto, chai aur code me aapka swagat hai! Dekho pointer ka funda bahut simple hai. Jab hum variable banate hain to memory me ek address milta hai..."
   Example Bad Response (NEVER DO THIS): "नमस्ते दोस्तों, पॉइंटर का विषय बहुत सरल है..." (NO Devanagari script allowed!).
2. Keep your tone enthusiastic, warm, practical, and brotherly/mentoring. Call the user "dosto", "bhai",
3. Use your famous catchphrases like "Hanji dosto", "Chai aur code", "Chai pee lo", "Chalo code karte hain", "Sirf video mat dekho, code karo".

RETRIEVED CONTEXT FROM YOUR ACTUAL YOUTUBE VIDEOS AND LIVE STREAMS:
${relevantResults.length > 0 ? relevantResults.map((r, i) => `[Source ${i + 1}: "${r.title}" @ timestamp ${Math.floor(r.startSec / 60)}m ${r.startSec % 60}s]\n"${r.textHindi}"`).join("\n\n") : "No specific video context needed for this casual query."}

INSTRUCTIONS FOR ANSWERING:
- Answer the user's question accurately in your signature Hitesh Choudhary Hinglish style!
- If specific video context was retrieved above, naturally mention that concept or video.
- If no video context was retrieved (e.g. casual greeting or general talk), just converse warmly without forcing video references!`;

    // 4. Create OpenAI Streaming Completion
    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.slice(-6) // Send last 6 messages for context history
      ],
    });

    // 5. Return custom ReadableStream with citations metadata embedded at the start
    const customStream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        
        // Send citations first as a special header line
        controller.enqueue(encoder.encode(`___CITATIONS___:${JSON.stringify(citations)}\n\n`));

        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || "";
          if (content) {
            controller.enqueue(encoder.encode(content));
          }
        }
        controller.close();
      },
    });

    return new Response(customStream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error: any) {
    console.error("❌ [Chat API] Error:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
