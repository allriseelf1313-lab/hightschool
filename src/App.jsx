import React, { useState } from 'react';
import Splash from './components/Splash';
import CharacterList from './components/CharacterList';
import StoryPanel from './components/StoryPanel';
import ChatPanel from './components/ChatPanel';
import SocialFeed from './components/SocialFeed';
import GameInfo from './components/GameInfo';
import { gameData } from './data/gameData';

export default function App() {
  const [gameStarted, setGameStarted] = useState(false);
  const [currentChapter, setCurrentChapter] = useState(0);
  const [relationships, setRelationships] = useState({
    "นาริ": 0,
    "กร": 0,
    "ขัน": 0,
    "วี": 0,
    "ตาออม": 0,
    "ซิม": 0,
    "รัก": 0,
  });
  const [activeTab, setActiveTab] = useState('story');

  const handleChoiceSelect = (choice) => {
    const newRelationships = { ...relationships };
    Object.keys(choice.affection).forEach((character) => {
      newRelationships[character] = Math.min(
        100,
        (newRelationships[character] || 0) + choice.affection[character]
      );
    });
    setRelationships(newRelationships);
    
    if (currentChapter < gameData.chapters.length - 1) {
      setTimeout(() => setCurrentChapter(currentChapter + 1), 500);
    }
  };

  if (!gameStarted) {
    return <Splash onStart={() => setGameStarted(true)} />;
  }

  const chapter = gameData.chapters[currentChapter];

  return (
    <div className="min-h-screen bg-gradient-to-br from-pink-200 via-sky-200 to-blue-300 text-slate-800 p-4 md:p-6">
      {/* Desktop Layout */}
      <div className="hidden lg:block">
        <div className="max-w-7xl mx-auto grid lg:grid-cols-4 gap-5">
          <CharacterList characters={gameData.characters} relationships={relationships} />

          <StoryPanel chapter={chapter} onChoiceSelect={handleChoiceSelect} />

          <div className="space-y-5">
            <ChatPanel
              initialChats={gameData.initialChats}
              aiResponses={gameData.aiResponses}
            />
            <SocialFeed initialFeed={gameData.initialFeed} />
            <GameInfo />
          </div>
        </div>
      </div>

      {/* Mobile Layout */}
      <div className="lg:hidden max-w-2xl mx-auto">
        <div className="mb-4 flex gap-2 justify-center flex-wrap">
          <button
            onClick={() => setActiveTab('story')}
            className={`px-4 py-2 rounded-2xl font-semibold transition ${
              activeTab === 'story'
                ? 'bg-pink-500 text-white'
                : 'bg-white/70 text-slate-800'
            }`}
          >
            📖 เรื่อง
          </button>
          <button
            onClick={() => setActiveTab('characters')}
            className={`px-4 py-2 rounded-2xl font-semibold transition ${
              activeTab === 'characters'
                ? 'bg-pink-500 text-white'
                : 'bg-white/70 text-slate-800'
            }`}
          >
            👥 ตัวละคร
          </button>
          <button
            onClick={() => setActiveTab('chat')}
            className={`px-4 py-2 rounded-2xl font-semibold transition ${
              activeTab === 'chat'
                ? 'bg-pink-500 text-white'
                : 'bg-white/70 text-slate-800'
            }`}
          >
            📱 แชท
          </button>
          <button
            onClick={() => setActiveTab('feed')}
            className={`px-4 py-2 rounded-2xl font-semibold transition ${
              activeTab === 'feed'
                ? 'bg-pink-500 text-white'
                : 'bg-white/70 text-slate-800'
            }`}
          >
            🌐 ฟีด
          </button>
        </div>

        {activeTab === 'story' && (
          <StoryPanel chapter={chapter} onChoiceSelect={handleChoiceSelect} />
        )}

        {activeTab === 'characters' && (
          <CharacterList characters={gameData.characters} relationships={relationships} />
        )}

        {activeTab === 'chat' && (
          <ChatPanel
            initialChats={gameData.initialChats}
            aiResponses={gameData.aiResponses}
          />
        )}

        {activeTab === 'feed' && (
          <div className="space-y-5">
            <SocialFeed initialFeed={gameData.initialFeed} />
            <GameInfo />
          </div>
        )}
      </div>
    </div>
  );
}
