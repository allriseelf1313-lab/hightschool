# Cloud University - Interactive Novel Game Website

A fully interactive visual novel game built with React and Tailwind CSS featuring an engaging story set in a Thai university environment.

## 🎮 Features

- **Interactive Story System** - Multiple choice-driven narrative that affects character relationships
- **Character Relationship System** - Track and build relationships with 7+ characters
- **Chat System** - Communicate with characters through a mobile-like interface
- **Social Feed** - View character posts and interactions
- **Responsive Design** - Works seamlessly on desktop and mobile devices
- **Glassmorphism UI** - Modern design with backdrop blur effects
- **Multiple Chapters** - Expanding story content with branching paths

## 🚀 Quick Start

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

The game will open automatically at `http://localhost:5173`

### Build for Production

```bash
npm run build
```

## 📁 Project Structure

```
.
├── src/
│   ├── components/
│   │   ├── CharacterList.jsx      # Character panel with relationships
│   │   ├── StoryPanel.jsx         # Main story and choices
│   │   ├── ChatPanel.jsx          # Message system
│   │   ├── SocialFeed.jsx         # Character posts
│   │   ├── GameInfo.jsx           # Game features
│   │   └── Splash.jsx             # Intro splash screen
│   ├── data/
│   │   └── gameData.js            # Characters, chapters, and story content
│   ├── App.jsx                    # Main game component
│   ├── main.jsx                   # React entry point
│   └── index.css                  # Global styles
├── index.html                     # HTML entry point
├── package.json
├── vite.config.js
├── tailwind.config.js
└── postcss.config.js
```

## 🎭 Characters

1. **นาริ (Nari)** - 1st year Engineering, the protagonist
2. **กร (Kor)** - 2nd year Engineering, Senior
3. **ขัน (Khan)** - Friend, tall and warm-hearted
4. **วี (Wee)** - Friend, mischievous and rich
5. **ตาออม (Tao Aom)** - Friend, kind-hearted
6. **ซิม (Sim)** - Friend, gentle and interested in Nari
7. **รัก (Rak)** - Small and playful friend

## 📖 Story

The game starts on the first day of university when the main character arrives at Cloud University. Through choices and interactions, you'll build relationships with various characters and uncover the story behind mysterious events.

## 🎨 Technology Stack

- **React 18** - UI library
- **Vite** - Build tool
- **Tailwind CSS** - Utility-first CSS framework
- **JavaScript** - Game logic

## 🔧 Customization

### Adding New Chapters

Edit `src/data/gameData.js` and add new chapter objects to the `chapters` array:

```javascript
{
  id: 3,
  title: "บทที่ 3 — ...",
  location: "...",
  backgroundImage: "...",
  content: [...],
  choices: [...]
}
```

### Modifying Characters

Update character data in `src/data/gameData.js` to change names, roles, descriptions, or avatars.

### Changing Colors

All Tailwind color classes are easily customizable in components and `tailwind.config.js`.

## 📱 Responsive Breakpoints

- **Mobile** (< 1024px): Tab-based navigation
- **Desktop** (≥ 1024px): 4-column grid layout

## 🎯 Future Enhancements

- [ ] AI-powered character responses using GPT/Claude API
- [ ] Save/Load game system with localStorage
- [ ] Achievement system
- [ ] Multiple endings based on final relationship scores
- [ ] Character-specific dialogue trees
- [ ] Battle or mini-game system
- [ ] Soundtrack integration
- [ ] Character customization

## 📝 License

Open source - feel free to modify and expand!

## 👨‍💻 Development

Created for the Cloud University interactive novel game project. This is a React-based implementation providing a modern, responsive interface for the visual novel experience.

---

**Start your university adventure now! 🎓✨**
