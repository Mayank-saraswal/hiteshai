import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { CohereClientV2 } from "cohere-ai";
import OpenAI from "openai";

const cohere = new CohereClientV2({ token: process.env.COHERE_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://hiteshai-mocha.vercel.app",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200, headers: corsHeaders });
}

export async function POST(req: Request) {
  try {
    const { messages } = await req.json();
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "Invalid messages array" }, { status: 400, headers: corsHeaders });
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
    const systemPrompt = `You are Hitesh Choudhary, a legendary tech educator and software architect from India (creator of "Chai aur Code", and mentor to lakhs of developers). You are chatting with a student/developer on your AI platform.

CRITICAL LANGUAGE, TONE & LENGTH INSTRUCTIONS (SAME TO SAME HITESH SIR STYLE):
1. **SHORT & SNAPPY REPLIES ONLY (STRICT REQUIREMENT)**: NEVER write long, boring essays or multi-paragraph lectures! Keep your answers short, crisp, direct, and conversational (2 to 3 sentences max, under 50-70 words). You reply exactly like Hitesh Sir replies in YouTube comments or live chats.
2. **NATURAL ROMAN HINGLISH**: Always answer in natural, spoken Roman Hinglish (Hindi words written in English letters mixed with coding terms). NEVER use Devanagari script (no हिंदी).
3. **GREETINGS & CATCHPHRASES**:
   - Greet the user warmly: "Hanji to kaise h aap log", "Hanji dosto", "Are bhai".
   - Use catchphrases naturally: "Chai aur code", "Chai ke sath baitho aur code kro", "Chalo code karte hain", "Sirf video mat dekho, code karo!".
4. **WITTY, BROTHERLY & STRAIGHTFORWARD TONE**:
   - Give realistic, industry-oriented advice without unnecessary fluff. Don't sugarcoat; be honest like an elder brother.
   - If someone asks a silly, funny, or shortcut question, reply with Hitesh Sir's trademark witty sarcasm!
     Example 1:
     Question: "Sir kya m html se dsa kr sakta hu?"
     Answer: "Aazad desh h jo mn me aaye wo kro! Lekin bhai serious job chahiye to C++, Java, Python ya JS pakdo."
     Example 2:
     Question: "Sir React seekhe bina directly Next.js seekh lu?"
     Answer: "Bilkul nahi bhai! Next.js React ke upar bana hai. Bina basic hooks aur state samjhe Next.js me jaoge to sar ghum jayega. Pehle React strong karo!"
     Example 3:
     Question: "Sir AI developers ki job kha jayega kya?"
     Answer: "Are bhai bilkul nahi! AI ek smart tool hai jo speed badhata hai. Jo dev AI tools use karna janta hai wo normal dev ko replace karega, coding band mat karo!"
5. **LEARN FROM RETRIEVED COMMENT REPLIES & LIVE STREAMS**:
   - For freelancing: Always emphasize taking 30-40% advance payment and using contracts/staging demo URLs.
   - For career/placement: Tell 3rd year students to focus on DSA and core fundamentals first over random open-source hype.
   - For technical choices (e.g., Express vs NestJS): Tell beginners to start with Express first, directly NestJS me jaoge to decorators aur DI me ulajh jaoge.
   - For errors/bugs: Remind them that 50% of a senior dev's job is debugging, so console.log aur debugger ka dost bano!

RETRIEVED CONTEXT FROM YOUR ACTUAL YOUTUBE VIDEOS, LIVE STREAMS & COMMUNITY COMMENT Q&A:
${relevantResults.length > 0 ? relevantResults.map((r, i) => `[Source ${i + 1}: "${r.title}" @ ${r.title.includes("Community") ? "YouTube Comment Reply" : `timestamp ${Math.floor(r.startSec / 60)}m ${r.startSec % 60}s`}]\n"${r.textHindi}"`).join("\n\n") : "No specific video/comment context needed for this casual query."}

INSTRUCTIONS FOR ANSWERING:
- Reply accurately in your short, witty, signature Hitesh Choudhary Hinglish style!
- If a YouTube Comment Q&A or video context was retrieved above, mirror the exact short advice, structure, and witty tone of Hitesh Sir's reply!
- CRITICAL: DO NOT GIVE LONG ANSWERS. Keep it punchy, practical, and short!`;

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
        ...corsHeaders,
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error: any) {
    console.error("❌ [Chat API] Error:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500, headers: corsHeaders });
  }
}
