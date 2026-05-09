"use client";

import { useState } from "react";

type Item = { q: string; a: string };

export function Accordion({ items }: { items: Item[] }) {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="divide-y divide-line border-y border-line">
      {items.map((item, i) => {
        const isOpen = open === i;
        return (
          <div key={i}>
            <button
              onClick={() => setOpen(isOpen ? null : i)}
              className="w-full flex items-center justify-between text-left py-6 group"
              aria-expanded={isOpen}
            >
              <span className="text-lg md:text-xl font-medium pr-6">{item.q}</span>
              <span
                className={`flex-shrink-0 w-8 h-8 rounded-full border border-line flex items-center justify-center transition-transform duration-300 ${
                  isOpen ? "rotate-45 bg-ink text-white border-ink" : "text-ink"
                }`}
                aria-hidden
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </span>
            </button>
            <div
              className={`grid transition-all duration-300 ease-out ${
                isOpen ? "grid-rows-[1fr] opacity-100 pb-6" : "grid-rows-[0fr] opacity-0"
              }`}
            >
              <div className="overflow-hidden">
                <p className="text-muted text-base md:text-lg leading-relaxed max-w-3xl">{item.a}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
