import React, { useState, useEffect, useMemo } from 'react';
import { BookOpen, Users, MapPin, ChevronRight, Sparkles, Home, Menu, Activity, X, Moon, Sun } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

import StoryList from './components/StoryList';
import StoryDetail from './components/StoryDetail';
import WorldInventory from './components/WorldInventory';
import StoryAnalysis from './components/StoryAnalysis';
import { getStoriesIndex, getCharacters, getPlaces, getWorldDna, StoryIndexItem, CanonicalEntity } from './data';

type View = 'dashboard' | 'analysis' | 'characters' | 'places' | 'story';

function parseHash(): { view: View; slug: string | null } {
  const h = location.hash.replace(/^#\/?/, '');
  if (!h) return { view: 'dashboard', slug: null };
  const [seg, slug] = h.split('/');
  if (seg === 'story' && slug) return { view: 'story', slug: decodeURIComponent(slug) };
  if (seg === 'analysis') return { view: 'analysis', slug: null };
  if (seg === 'characters') return { view: 'characters', slug: null };
  if (seg === 'places') return { view: 'places', slug: null };
  return { view: 'dashboard', slug: null };
}

const setHash = (h: string) => {
  if (location.hash !== h) location.hash = h;
};

export default function App() {
  const [stories, setStories] = useState<StoryIndexItem[]>([]);
  const [characters, setCharacters] = useState<CanonicalEntity[]>([]);
  const [places, setPlaces] = useState<CanonicalEntity[]>([]);
  const [worldDna, setWorldDna] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const initial = parseHash();
  const [view, setView] = useState<View>(initial.view);
  const [selectedStoryId, setSelectedStoryId] = useState<string | null>(initial.slug);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return (
        localStorage.getItem('theme') === 'dark' ||
        (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)
      );
    }
    return false;
  });

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [darkMode]);

  // Load the data bundle once.
  useEffect(() => {
    Promise.all([getStoriesIndex(), getCharacters(), getPlaces(), getWorldDna()])
      .then(([s, c, p, dna]) => {
        setStories(s);
        setCharacters(c);
        setPlaces(p);
        setWorldDna(dna);
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setLoadError(err.message || 'Failed to load the archive.');
        setLoading(false);
      });
  }, []);

  // Keep view/story in sync with the URL hash (shareable, refresh-safe links).
  useEffect(() => {
    const onHash = () => {
      const { view: v, slug } = parseHash();
      setView(v);
      setSelectedStoryId(slug);
      if (v !== 'characters' && v !== 'places') setHighlightId(null);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const storyTitles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of stories) map[s.id] = s.title;
    return map;
  }, [stories]);

  const goStory = (id: string) => setHash(`#/story/${encodeURIComponent(id)}`);
  const goHome = () => setHash('#/');
  const goView = (v: View) => setHash(v === 'dashboard' ? '#/' : `#/${v}`);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <motion.div
          animate={{ scale: [1, 1.1, 1] }}
          transition={{ repeat: Infinity, duration: 2 }}
          className="text-brand flex flex-col items-center gap-4"
        >
          <Sparkles className="w-12 h-12" />
          <p className="font-serif italic text-xl">Opening the storybook...</p>
        </motion.div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-8">
        <div className="text-center text-muted font-serif italic max-w-md">
          <p className="text-xl mb-2">The storybook wouldn't open.</p>
          <p className="text-sm not-italic font-sans opacity-70">{loadError}</p>
        </div>
      </div>
    );
  }

  const renderView = () => {
    switch (view) {
      case 'analysis':
        return (
          <StoryAnalysis
            stories={stories}
            characters={characters}
            places={places}
            worldDna={worldDna}
            onNavigateToStory={goStory}
          />
        );
      case 'characters':
        return (
          <WorldInventory
            type="characters"
            entities={characters}
            storyTitles={storyTitles}
            onNavigateToStory={goStory}
            highlightId={highlightId}
            onClearHighlight={() => setHighlightId(null)}
          />
        );
      case 'places':
        return (
          <WorldInventory
            type="places"
            entities={places}
            storyTitles={storyTitles}
            onNavigateToStory={goStory}
            highlightId={highlightId}
            onClearHighlight={() => setHighlightId(null)}
          />
        );
      case 'story':
        return selectedStoryId ? (
          <StoryDetail
            slug={selectedStoryId}
            onBack={goHome}
            onNavigateToCharacters={(id) => { setHighlightId(id || null); goView('characters'); }}
            onNavigateToPlaces={(id) => { setHighlightId(id || null); goView('places'); }}
          />
        ) : (
          <StoryList stories={stories} onSelectStory={goStory} />
        );
      case 'dashboard':
      default:
        return <StoryList stories={stories} onSelectStory={goStory} />;
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col md:flex-row relative overflow-hidden transition-colors duration-300">
      <div className="starry-bg" />
      {/* Mobile Header */}
      <header className="md:hidden flex items-center justify-between p-4 bg-surface border-b border-border sticky top-0 z-40">
        <button onClick={goHome} className="flex items-center gap-3">
          <div className="w-8 h-8 bg-brand rounded-lg flex items-center justify-center shadow-sm">
            <BookOpen className="text-white dark:text-background w-5 h-5" />
          </div>
          <span className="font-serif font-bold text-lg">Stars &amp; Stories</span>
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setDarkMode(!darkMode)}
            className="p-3 text-brand hover:bg-background rounded-xl transition-colors touch-manipulation active:scale-95"
            aria-label="Toggle dark mode"
          >
            {darkMode ? <Sun className="w-6 h-6" /> : <Moon className="w-6 h-6" />}
          </button>
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="p-3 text-brand hover:bg-background rounded-xl transition-colors touch-manipulation active:scale-95"
            aria-label="Toggle menu"
          >
            {isMenuOpen ? <X className="w-7 h-7" /> : <Menu className="w-7 h-7" />}
          </button>
        </div>
      </header>

      {/* Sidebar Overlay */}
      <AnimatePresence>
        {isMenuOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsMenuOpen(false)}
            className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 md:hidden"
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <AnimatePresence>
        {(isMenuOpen || (typeof window !== 'undefined' && window.innerWidth >= 768)) && (
          <motion.aside
            initial={typeof window !== 'undefined' && window.innerWidth < 768 ? { x: '-100%' } : false}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed md:sticky top-0 left-0 h-screen w-72 md:w-64 bg-surface border-r border-border flex flex-col z-50 md:z-30 shadow-2xl md:shadow-none transition-colors duration-300"
          >
            <button onClick={() => { goHome(); setIsMenuOpen(false); }} className="p-6 flex items-center gap-3 border-b border-border text-left">
              <div className="w-10 h-10 bg-brand rounded-xl flex items-center justify-center shadow-md">
                <BookOpen className="text-white dark:text-background w-6 h-6" />
              </div>
              <span className="font-serif font-bold text-xl">Stars &amp; Stories</span>
            </button>

            <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
              <NavItem active={view === 'dashboard' || view === 'story'} onClick={() => { goHome(); setIsMenuOpen(false); }} icon={<Home className="w-5 h-5" />} label="Stories" />
              <NavItem active={view === 'analysis'} onClick={() => { goView('analysis'); setIsMenuOpen(false); }} icon={<Activity className="w-5 h-5" />} label="Analysis" />
              <NavItem active={view === 'characters'} onClick={() => { setHighlightId(null); goView('characters'); setIsMenuOpen(false); }} icon={<Users className="w-5 h-5" />} label="Characters" />
              <NavItem active={view === 'places'} onClick={() => { setHighlightId(null); goView('places'); setIsMenuOpen(false); }} icon={<MapPin className="w-5 h-5" />} label="Places" />
            </nav>

            <div className="p-4 border-t border-border space-y-4">
              <button
                onClick={() => setDarkMode(!darkMode)}
                className="w-full flex items-center gap-3 p-3 text-muted hover:bg-background rounded-xl transition-colors text-sm font-medium"
              >
                {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                {darkMode ? 'Light Mode' : 'Dark Mode'}
              </button>
              <p className="text-[10px] text-muted/70 px-3 italic font-serif">A keepsake of stories told together.</p>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <main className="flex-1 relative min-w-0">
        <AnimatePresence mode="wait">
          <motion.div
            key={view + (selectedStoryId || '')}
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            transition={{ duration: 0.2 }}
            className="h-full"
          >
            {renderView()}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}

function NavItem({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <motion.button
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className={`w-full flex items-center gap-3 p-4 rounded-xl transition-all duration-200 touch-manipulation text-left ${
        active ? 'bg-brand text-white dark:text-background shadow-md' : 'text-muted hover:bg-background active:bg-background'
      }`}
    >
      <div className={active ? 'text-white dark:text-background' : 'text-brand'}>{icon}</div>
      <span className="font-medium flex-1">{label}</span>
      {active && <motion.div layoutId="active-pill" className="w-1.5 h-1.5 bg-white dark:bg-background rounded-full" />}
    </motion.button>
  );
}
