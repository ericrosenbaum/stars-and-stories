import { useState, useEffect, useRef } from 'react';
import { Users, MapPin, Search, Sparkles, BookOpen } from 'lucide-react';
import { motion } from 'motion/react';
import { CanonicalEntity, assetUrl } from '../data';

export default function WorldInventory({
  type,
  entities,
  storyTitles,
  onNavigateToStory,
  highlightId,
}: {
  type: 'characters' | 'places';
  entities: CanonicalEntity[];
  storyTitles: Record<string, string>;
  onNavigateToStory: (id: string) => void;
  highlightId?: string | null;
  onClearHighlight?: () => void;
}) {
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (highlightId) {
      const el = document.getElementById(`entity-${highlightId}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightId, entities]);

  const filtered = entities
    .filter((e) => e.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (b.storyIds?.length || 0) - (a.storyIds?.length || 0));

  const recurring = filtered.filter((e) => (e.storyIds?.length || 0) >= 2);
  const others = filtered.filter((e) => (e.storyIds?.length || 0) < 2);

  const title = type === 'characters' ? 'Cast of Characters' : 'Atlas of Places';
  const Icon = type === 'characters' ? Users : MapPin;

  const renderCard = (entity: CanonicalEntity) => (
    <div key={entity.id} id={`entity-${entity.id}`}>
      <EntityCard entity={entity} storyTitles={storyTitles} onNavigateToStory={onNavigateToStory} isHighlighted={highlightId === entity.id} />
    </div>
  );

  return (
    <div className="p-8 max-w-6xl mx-auto relative z-10">
      <header className="mb-12">
        <h1 className="text-4xl font-serif font-bold text-foreground">
          {title} ({entities.length})
        </h1>
      </header>

      <div className="relative mb-12">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-muted w-5 h-5" />
        <input
          type="text"
          placeholder={`Search for a ${type === 'characters' ? 'character' : 'place'}...`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-12 pr-4 py-4 bg-surface border border-border text-foreground rounded-2xl focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent shadow-sm transition-all"
        />
      </div>

      <div className="space-y-16">
        {recurring.length > 0 && (
          <section>
            <div className="flex items-center gap-3 mb-8">
              <div className="w-10 h-10 bg-background rounded-xl flex items-center justify-center text-brand">
                <Sparkles className="w-6 h-6" />
              </div>
              <h2 className="text-2xl font-serif font-bold text-foreground">
                Recurring {type === 'characters' ? 'Characters' : 'Places'} ({recurring.length})
              </h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">{recurring.map(renderCard)}</div>
          </section>
        )}

        <section>
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 bg-background rounded-xl flex items-center justify-center text-brand">
              <Icon className="w-6 h-6" />
            </div>
            <h2 className="text-2xl font-serif font-bold text-foreground">
              {recurring.length > 0 ? `Other ${type === 'characters' ? 'Characters' : 'Places'}` : `All ${type === 'characters' ? 'Characters' : 'Places'}`} ({others.length})
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {others.length === 0 && recurring.length === 0 ? <p className="text-muted italic">No {type} found yet.</p> : others.map(renderCard)}
          </div>
        </section>
      </div>
    </div>
  );
}

function EntityCard({
  entity,
  storyTitles,
  onNavigateToStory,
  isHighlighted,
}: {
  entity: CanonicalEntity;
  storyTitles: Record<string, string>;
  onNavigateToStory: (id: string) => void;
  isHighlighted: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedStories, setExpandedStories] = useState(false);
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const storiesContainerRef = useRef<HTMLDivElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const [needsStoryTruncation, setNeedsStoryTruncation] = useState(false);

  useEffect(() => {
    if (descriptionRef.current) {
      const { scrollHeight, clientHeight } = descriptionRef.current;
      setIsTruncated(scrollHeight > clientHeight);
    }
  }, [entity.description, isExpanded]);

  useEffect(() => {
    const check = () => {
      if (storiesContainerRef.current) setNeedsStoryTruncation(storiesContainerRef.current.scrollHeight > 100);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [entity.storyIds]);

  return (
    <motion.div
      layout
      className={`bg-surface border rounded-2xl p-6 shadow-sm hover:shadow-md group ${
        isHighlighted ? 'border-brand ring-2 ring-brand ring-opacity-20 scale-[1.02]' : 'border-border'
      }`}
    >
      <div className="flex gap-4">
        {entity.image && (
          <div className="w-24 h-24 md:w-28 md:h-28 rounded-xl overflow-hidden border border-border bg-background shrink-0">
            <img src={assetUrl(entity.image)} alt={entity.name} loading="lazy" className="w-full h-full object-cover" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h3 className="text-xl font-serif font-bold text-foreground flex items-center gap-2 mb-3">
            {entity.name}
            {entity.storyIds && entity.storyIds.length > 0 && (
              <span className="text-[10px] bg-brand/10 text-brand px-2 py-0.5 rounded-full font-sans font-bold">
                {entity.storyIds.length} {entity.storyIds.length === 1 ? 'story' : 'stories'}
              </span>
            )}
          </h3>

          <div className="relative">
            <p ref={descriptionRef} className={`text-muted text-sm leading-relaxed italic mb-2 ${!isExpanded ? 'line-clamp-3' : ''}`}>
              {entity.description || 'No description yet.'}
            </p>
            {(isTruncated || isExpanded) && (
              <button onClick={() => setIsExpanded(!isExpanded)} className="text-[10px] font-bold uppercase tracking-widest text-brand hover:text-foreground transition-colors">
                {isExpanded ? 'Show Less' : 'Read More'}
              </button>
            )}
          </div>
        </div>
      </div>

      {entity.storyIds && entity.storyIds.length > 0 && (
        <div className="pt-4 mt-4 border-t border-background">
          <span className="text-[10px] uppercase tracking-widest text-brand font-bold w-full mb-2 block">Appears in:</span>
          <div ref={storiesContainerRef} className={`flex flex-wrap gap-2 overflow-hidden ${!expandedStories ? 'max-h-[100px]' : 'max-h-[1000px]'}`}>
            {entity.storyIds.map((sid) => (
              <motion.button
                whileTap={{ scale: 0.95 }}
                key={sid}
                onClick={() => onNavigateToStory(sid)}
                className="flex items-center gap-2 bg-surface border border-border px-4 py-2 rounded-full text-[11px] font-medium text-foreground/90 hover:bg-brand hover:text-white dark:hover:text-background transition-all group/chip touch-manipulation"
              >
                <BookOpen className="w-3.5 h-3.5 opacity-60 group-hover/chip:opacity-100" />
                {storyTitles[sid] || 'Unknown Story'}
              </motion.button>
            ))}
          </div>
          {needsStoryTruncation && (
            <button onClick={() => setExpandedStories(!expandedStories)} className="mt-2 text-[10px] font-bold uppercase tracking-widest text-brand hover:text-foreground transition-colors">
              {expandedStories ? 'Show Less' : `Show All ${entity.storyIds.length} Stories`}
            </button>
          )}
        </div>
      )}
    </motion.div>
  );
}
