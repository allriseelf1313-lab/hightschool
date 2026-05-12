import React, { useState } from 'react';

export default function SocialFeed({ initialFeed }) {
  const [feed, setFeed] = useState(initialFeed);
  const [liked, setLiked] = useState(new Set());

  const toggleLike = (index) => {
    const newLiked = new Set(liked);
    if (newLiked.has(index)) {
      newLiked.delete(index);
    } else {
      newLiked.add(index);
    }
    setLiked(newLiked);
  };

  return (
    <div className="bg-white/70 backdrop-blur-xl rounded-3xl shadow-2xl p-5 border border-white/50">
      <h2 className="font-bold text-xl mb-4">🌐 Social Feed</h2>

      <div className="space-y-4 max-h-[400px] overflow-auto pr-2">
        {feed.map((post, index) => (
          <div
            key={index}
            className="bg-white rounded-2xl p-4 shadow hover:shadow-lg transition animate-fadeIn"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-sky-600">@{post.user}</h3>
              <span className="text-xs text-slate-400">CloudTalk</span>
            </div>
            <p className="mt-2 text-sm text-slate-600">{post.content}</p>
            <div className="mt-3 flex gap-4 text-sm">
              <button
                onClick={() => toggleLike(index)}
                className={`transition ${
                  liked.has(index)
                    ? 'text-red-500 font-bold'
                    : 'text-slate-400 hover:text-red-400'
                }`}
              >
                ❤ ถูกใจ
              </button>
              <button className="text-slate-400 hover:text-sky-400 transition">
                💬 ตอบกลับ
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
