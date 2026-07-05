"use client";

import React, { useState, useRef, useEffect } from "react";
import { ArrowUp, Plus, RefreshCw, MessageSquare, Video, ExternalLink, Bot, User } from "lucide-react";

interface Citation {
  title: string;
  url: string;
  timestamp: string;
  similarity: string;
  snippet: string;
}

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  isStreaming?: boolean;
}

export default function ChatInterface() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: ChatMsg = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim()
    };

    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setIsLoading(true);

    const assistantId = (Date.now() + 1).toString();
    setMessages(prev => [
      ...prev,
      {
        id: assistantId,
        role: "assistant",
        content: "",
        isStreaming: true
      }
    ]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages.map(m => ({ role: m.role, content: m.content }))
        })
      });

      if (!response.ok || !response.body) {
        throw new Error("Network response was not ok");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let accumulatedText = "";
      let parsedCitations: Citation[] = [];
      let firstLineChecked = false;
      let buffer = "";

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          buffer += decoder.decode(value, { stream: !done });
          
          if (!firstLineChecked && buffer.includes("\n\n")) {
            const parts = buffer.split("\n\n");
            const firstPart = parts[0];
            if (firstPart.startsWith("___CITATIONS___:")) {
              try {
                const jsonStr = firstPart.replace("___CITATIONS___:", "");
                parsedCitations = JSON.parse(jsonStr);
              } catch (e) {
                console.error("Failed to parse citations", e);
              }
              buffer = parts.slice(1).join("\n\n");
            }
            firstLineChecked = true;
          }

          if (firstLineChecked || !buffer.startsWith("___CITATIONS___:")) {
            accumulatedText = buffer;
            setMessages(prev => 
              prev.map(msg => 
                msg.id === assistantId 
                  ? { ...msg, content: accumulatedText, citations: parsedCitations } 
                  : msg
              )
            );
          }
        }
      }

      setMessages(prev => 
        prev.map(msg => 
          msg.id === assistantId 
            ? { ...msg, isStreaming: false } 
            : msg
        )
      );
    } catch (error) {
      console.error("Error sending message:", error);
      setMessages(prev => 
        prev.map(msg => 
          msg.id === assistantId 
            ? { ...msg, content: "Are bhai, server connect karne me technical दिक्कत aagayi! Thodi der me wapas try karo.", isStreaming: false } 
            : msg
        )
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full w-full bg-[#18181b] border border-zinc-800/80 rounded-[28px] shadow-2xl overflow-hidden text-zinc-100 font-sans">
      {/* Top Header Card */}
      <div className="flex items-center justify-between px-6 py-4.5 border-b border-zinc-800/60 bg-[#18181b]">
        <div>
          <h1 className="text-base sm:text-lg font-bold text-zinc-100 tracking-tight">New Chat</h1>
          <p className="text-xs sm:text-sm text-zinc-400 mt-0.5 font-medium">How can I help you today?</p>
        </div>
        <button
          onClick={() => setMessages([])}
          title="Start new conversation"
          className="w-9 h-9 rounded-full border border-zinc-800 bg-zinc-900/80 hover:bg-zinc-800 flex items-center justify-center text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer shadow-sm"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Center Chat Area / Empty State */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-7 space-y-7 scrollbar-thin scrollbar-thumb-zinc-800">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-4 my-auto py-12">
            <div className="w-12 h-12 rounded-2xl bg-zinc-800/60 border border-zinc-700/50 flex items-center justify-center text-zinc-400 mb-4 shadow-inner">
              <MessageSquare className="w-6 h-6" />
            </div>
            <h2 className="text-xl sm:text-2xl font-bold text-zinc-100 tracking-tight">Morning, Hitesh Sir!</h2>
            <p className="text-sm sm:text-base text-zinc-400 max-w-md mt-2 leading-relaxed font-medium">
              What are we working on today? Press send to start a new conversation in Hinglish.
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex items-end gap-3 max-w-[88%] sm:max-w-[78%] ${
                msg.role === "user" ? "ml-auto flex-row-reverse" : "mr-auto"
              }`}
            >
              {/* Avatar Icon */}
              <div
                className={`w-8 h-8 rounded-full shrink-0 flex items-center justify-center shadow-sm ${
                  msg.role === "user"
                    ? "bg-zinc-800 text-zinc-300 border border-zinc-700/80"
                    : "bg-zinc-800 text-blue-400 border border-zinc-700/80"
                }`}
              >
                {msg.role === "user" ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
              </div>

              {/* Message Bubble - Larger Font (16px-17px) */}
              <div
                className={`rounded-3xl px-5 py-3.5 text-[16px] sm:text-[17px] leading-relaxed font-normal shadow-md ${
                  msg.role === "user"
                    ? "bg-[#2563eb] text-white rounded-br-xs font-medium"
                    : "bg-[#27272a] text-zinc-100 rounded-bl-xs border border-zinc-800/60"
                }`}
              >
                {msg.content ? (
                  <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                ) : (
                  <div className="py-1 text-zinc-400 italic text-sm animate-pulse">
                    Thinking...
                  </div>
                )}

                {/* Minimalist Timestamp Citations inside Bot Bubble */}
                {msg.role === "assistant" && msg.citations && msg.citations.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-zinc-700/60 space-y-2.5">
                    <div className="text-xs sm:text-sm font-semibold text-zinc-300 flex items-center gap-1.5">
                      <Video className="w-4 h-4 text-blue-400 shrink-0" />
                      <span>Video Timestamps:</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {msg.citations.slice(0, 3).map((cit, idx) => (
                        <a
                          key={idx}
                          href={cit.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900/95 border border-zinc-700/80 text-xs sm:text-sm text-zinc-200 hover:text-white hover:border-blue-500 hover:bg-zinc-900 transition-all shadow-sm"
                        >
                          <span className="truncate max-w-[160px] font-medium">{cit.title}</span>
                          <span className="text-blue-400 font-bold shrink-0">{cit.timestamp}</span>
                          <ExternalLink className="w-3 h-3 opacity-70 shrink-0" />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))
        )}

        {isLoading && messages.length > 0 && messages[messages.length - 1]?.content !== "" && (
          <div className="flex items-center gap-2 text-sm text-zinc-400 italic pl-11 font-medium">
            <span>Hitesh Sir is typing...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Bottom Input Area - Larger Font & Clear Spacing */}
      <div className="p-4 sm:p-5 bg-[#18181b] border-t border-zinc-800/60">
        <div className="flex items-center gap-2.5 bg-[#27272a]/90 border border-zinc-700/60 focus-within:border-zinc-500 rounded-2xl p-2 pl-3.5 transition-colors">
          <button
            type="button"
            className="w-8 h-8 rounded-full bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center text-zinc-400 hover:text-zinc-200 transition-colors shrink-0 cursor-pointer"
            title="Add attachment (demo)"
          >
            <Plus className="w-4 h-4" />
          </button>
          
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="I'm building a chat for our app..."
            disabled={isLoading}
            className="flex-1 bg-transparent text-base text-zinc-100 placeholder-zinc-500 focus:outline-none px-1.5 py-1.5 disabled:opacity-60 font-sans font-normal"
          />

          <button
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
            className="w-8 h-8 rounded-full bg-[#2563eb] hover:bg-blue-500 disabled:bg-blue-600/40 disabled:cursor-not-allowed flex items-center justify-center text-white transition-colors shrink-0 shadow-sm cursor-pointer"
            title="Send Message"
          >
            <ArrowUp className="w-4 h-4 stroke-[2.5]" />
          </button>
        </div>
      </div>
    </div>
  );
}
