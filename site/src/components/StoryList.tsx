import { useState, ReactNode } from 'react';
import { Calendar, ChevronRight, Search, BookOpen, ArrowUpDown, SortAsc, SortDesc, AlignLeft, AlignRight, User, Baby } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { StoryIndexItem, assetUrl } from '../data';

type SortOption = 'newest' | 'oldest' | 'shortest' | 'longest' | 'izzy' | 'dad';

export default function StoryList({
  stories,
  onSelectStory,
}: {
  stories: StoryIndexItem[];
  onSelectStory: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('newest');
  const [isSortOpen, setIsSortOpen] = useState(false);

  const sortedStories = [...stories].sort((a, b) => {
    switch (sortBy) {
      case 'newest':
        return new Date(b.date).getTime() - new Date(a.date).getTime();
      case 'oldest':
        return new Date(a.date).getTime() - new Date(b.date).getTime();
      case 'shortest':
        return a.wordCount - b.wordCount;
      case 'longest':
        return b.wordCount - a.wordCount;
      case 'izzy':
        return b.izzyWordCount - a.izzyWordCount;
      case 'dad':
        return b.dadWordCount - a.dadWordCount;
      default:
        return 0;
    }
  });

  const filteredStories = sortedStories.filter(
    (s) =>
      s.title.toLowerCase().includes(search.toLowerCase()) ||
      s.summary?.toLowerCase().includes(search.toLowerCase()),
  );

  const sortOptions: { value: SortOption; label: string; icon: ReactNode }[] = [
    { value: 'newest', label: 'Newest First', icon: <SortDesc className="w-4 h-4" /> },
    { value: 'oldest', label: 'Oldest First', icon: <SortAsc className="w-4 h-4" /> },
    { value: 'longest', label: 'Longest Story', icon: <AlignLeft className="w-4 h-4" /> },
    { value: 'shortest', label: 'Shortest Story', icon: <AlignRight className="w-4 h-4" /> },
    { value: 'izzy', label: 'More Izzy', icon: <Baby className="w-4 h-4" /> },
    { value: 'dad', label: 'More Dad', icon: <User className="w-4 h-4" /> },
  ];

  return (
    <div className="p-8 max-w-5xl mx-auto relative z-10">
      <header className="mb-12">
        <h1 className="text-4xl font-serif font-bold text-foreground">Stories ({stories.length})</h1>
      </header>

      <div className="flex flex-col md:flex-row gap-4 mb-8">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-muted w-5 h-5" />
          <input
            type="text"
            placeholder="Search for a memory..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-12 pr-4 py-4 bg-surface border border-border text-foreground rounded-2xl focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent shadow-sm transition-all"
          />
        </div>

        <div className="relative">
          <motion.button
            whileTap={{ scale: 0.98 }}
            onClick={() => setIsSortOpen(!isSortOpen)}
            className="h-full px-6 py-4 bg-surface border border-border text-foreground rounded-2xl flex items-center gap-3 hover:border-brand transition-all shadow-sm min-w-[200px] touch-manipulation"
          >
            {sortOptions.find((o) => o.value === sortBy)?.icon}
            <span className="font-medium flex-1 text-left">{sortOptions.find((o) => o.value === sortBy)?.label}</span>
            <ArrowUpDown className="w-4 h-4 text-muted" />
          </motion.button>

          <AnimatePresence>
            {isSortOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setIsSortOpen(false)} />
                <motion.div
                  initial={{ opacity: 0, y: 10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.95 }}
                  className="absolute right-0 top-full mt-2 w-64 bg-surface border border-border rounded-2xl shadow-2xl z-50 overflow-hidden p-2"
                >
                  {sortOptions.map((option) => (
                    <motion.button
                      whileTap={{ backgroundColor: 'var(--background)' }}
                      key={option.value}
                      onClick={() => {
                        setSortBy(option.value);
                        setIsSortOpen(false);
                      }}
                      className={`w-full flex items-center gap-3 px-5 py-4 rounded-xl transition-colors text-sm touch-manipulation ${
                        sortBy === option.value ? 'bg-brand text-white dark:text-background font-bold' : 'hover:bg-background text-foreground'
                      }`}
                    >
                      {option.icon}
                      {option.label}
                      {sortBy === option.value && <div className="ml-auto w-1.5 h-1.5 bg-white dark:bg-background rounded-full" />}
                    </motion.button>
                  ))}
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>

      {filteredStories.length === 0 ? (
        <div className="bg-surface border border-dashed border-border rounded-3xl p-16 text-center">
          <BookOpen className="w-12 h-12 text-border mx-auto mb-4" />
          <p className="text-muted font-serif italic text-lg">No stories found.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {filteredStories.map((story, idx) => (
            <motion.button
              key={story.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(idx, 12) * 0.05 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => onSelectStory(story.id)}
              className="group bg-surface border border-border rounded-3xl overflow-hidden text-left hover:shadow-xl hover:border-brand transition-all duration-300 flex flex-col h-full touch-manipulation"
            >
              {story.headerImage && (
                <div className="w-full h-48 overflow-hidden relative">
                  <img
                    src={assetUrl(story.headerImage)}
                    alt={story.title}
                    loading="lazy"
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent" />
                </div>
              )}

              <div className="p-6 flex flex-col flex-1">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 bg-background rounded-xl flex items-center justify-center text-brand group-hover:bg-brand group-hover:text-white dark:group-hover:text-background transition-colors">
                    <Calendar className="w-5 h-5" />
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-medium text-muted uppercase tracking-wider">
                      {new Date(story.date).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}
                    </p>
                  </div>
                </div>

                <h3 className="text-2xl font-serif font-bold text-foreground mb-3 group-hover:text-brand transition-colors">{story.title}</h3>

                {story.summary && (
                  <p className="text-foreground text-sm leading-relaxed mb-6 line-clamp-3 italic opacity-80">{story.summary}</p>
                )}

                <div className="mt-auto flex items-center text-brand text-sm font-medium">
                  <span>View Transcript</span>
                  <ChevronRight className="w-4 h-4 ml-1 group-hover:translate-x-1 transition-transform" />
                </div>
              </div>
            </motion.button>
          ))}
        </div>
      )}
    </div>
  );
}
