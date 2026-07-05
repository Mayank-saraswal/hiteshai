import ChatInterface from "@/components/chat-interface";

export default function Home() {
  return (
    <main className="min-h-screen bg-[#09090b] text-zinc-100 font-sans flex flex-col items-center justify-center p-4 sm:p-6 md:p-10 selection:bg-blue-600/30 selection:text-blue-200">
      <div className="w-full max-w-3xl h-[85vh] sm:h-[80vh] flex flex-col">
        <ChatInterface />
      </div>
      <p className="mt-4 text-center text-xs text-zinc-500">
        Chai aur Code AI Assistant • Backed by 59+ YouTube Videos & Live Streams with exact timestamps.
      </p>
    </main>
  );
}
