import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Play, Pause, Sparkles, Users, MapPin, MessageSquare, History, Wand2, Calendar } from 'lucide-react';
import { motion } from 'motion/react';
import { getStory, assetUrl, StoryFull } from '../data';

export default function StoryDetail({
  slug,
  onBack,
  onNavigateToCharacters,
  onNavigateToPlaces,
}: {
  slug: string;
  onBack: () => void;
  onNavigateToCharacters: (id?: string) => void;
  onNavigateToPlaces: (id?: string) => void;
}) {
  const [story, setStory] = useState<StoryFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [expandedCharacters, setExpandedCharacters] = useState(false);
  const [expandedPlaces, setExpandedPlaces] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const charactersContainerRef = useRef<HTMLDivElement>(null);
  const placesContainerRef = useRef<HTMLDivElement>(null);
  const [needsCharacterTruncation, setNeedsCharacterTruncation] = useState(false);
  const [needsPlaceTruncation, setNeedsPlaceTruncation] = useState(false);

  useEffect(() => {
    setLoading(true);
    setNotFound(false);
    setStory(null);
    setIsPlaying(false);
    setCurrentTime(0);
    getStory(slug)
      .then((s) => {
        setStory(s);
        setLoading(false);
      })
      .catch(() => {
        setNotFound(true);
        setLoading(false);
      });
  }, [slug]);

  useEffect(() => {
    const checkTruncation = () => {
      if (charactersContainerRef.current) setNeedsCharacterTruncation(charactersContainerRef.current.scrollHeight > 180);
      if (placesContainerRef.current) setNeedsPlaceTruncation(placesContainerRef.current.scrollHeight > 180);
    };
    checkTruncation();
    window.addEventListener('resize', checkTruncation);
    return () => window.removeEventListener('resize', checkTruncation);
  }, [story]);

  const togglePlay = () => {
    if (audioRef.current) {
      if (isPlaying) audioRef.current.pause();
      else audioRef.current.play();
      setIsPlaying(!isPlaying);
    }
  };

  const skipTo = (time: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      audioRef.current.play();
      setIsPlaying(true);
    }
  };

  const getStats = () => {
    if (!story?.transcript) return null;
    let izzyWords = 0;
    let dadWords = 0;
    story.transcript.forEach((item) => {
      const wordCount = item.text.trim().split(/\s+/).filter(Boolean).length;
      const speaker = item.speaker.toLowerCase();
      if (speaker.includes('izzy')) izzyWords += wordCount;
      else if (speaker.includes('dad') || speaker.includes('eric')) dadWords += wordCount;
    });
    const totalWords = izzyWords + dadWords;
    const ratio = totalWords > 0 ? ((izzyWords / totalWords) * 100).toFixed(0) + '%' : '0%';
    return { izzyWords, dadWords, ratio };
  };
  const stats = getStats();

  const formatTime = (time: number) => {
    if (isNaN(time) || time === Infinity) return '0:00';
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (loading) return <div className="p-12 text-center font-serif italic text-brand">Opening the storybook...</div>;
  if (notFound || !story) return <div className="p-12 text-center font-serif italic text-brand">Story not found.</div>;

  const quoteHasTime = story.highlightQuote && story.highlightQuote.timestamp != null;

  return (
    <div className="h-full flex flex-col bg-background relative z-10">
      {/* Header */}
      <header className="p-6 border-b border-border bg-surface flex items-center justify-between sticky top-0 z-10 transition-colors duration-300">
        <div className="flex items-center gap-4">
          <motion.button whileTap={{ scale: 0.9 }} onClick={onBack} className="p-3 hover:bg-background rounded-full transition-colors text-brand touch-manipulation">
            <ArrowLeft className="w-7 h-7" />
          </motion.button>
          <div>
            <h1 className="text-2xl font-serif font-bold text-foreground">{story.title}</h1>
            <p className="text-sm text-muted italic flex items-center gap-1.5 mt-1">
              <Calendar className="w-3.5 h-3.5" />
              {new Date(story.date).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}
            </p>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-8 max-w-4xl mx-auto w-full">
        {/* Header Image */}
        {story.headerImage && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="w-full aspect-video rounded-3xl overflow-hidden mb-12 shadow-lg border border-border relative"
          >
            <img src={assetUrl(story.headerImage)} alt={story.title} className="w-full h-full object-cover" />
          </motion.div>
        )}

        {/* Summary Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-surface border border-border rounded-3xl p-8 shadow-sm mb-12 relative overflow-hidden transition-colors duration-300"
        >
          <div className="absolute top-0 right-0 p-4 opacity-10">
            <Sparkles className="w-24 h-24 text-brand" />
          </div>

          {story.highlightQuote && (
            <div className="mb-8 pb-8 border-b border-background">
              <div className="flex items-start gap-4">
                {quoteHasTime ? (
                  <button
                    onClick={() => skipTo(story.highlightQuote!.timestamp as number)}
                    className="mt-1 w-10 h-10 bg-background text-brand rounded-full flex items-center justify-center hover:bg-brand hover:text-white dark:hover:text-background transition-all active:scale-95 flex-shrink-0"
                    title="Play Quote"
                  >
                    <Play className="w-4 h-4 ml-0.5" />
                  </button>
                ) : (
                  <div className="mt-1 w-10 h-10 bg-background text-brand/40 rounded-full flex items-center justify-center flex-shrink-0">
                    <Sparkles className="w-4 h-4" />
                  </div>
                )}
                <div className="flex-1">
                  <p className="text-xs font-bold text-brand uppercase tracking-widest mb-2">Izzy says...</p>
                  <p className="text-2xl font-serif font-bold text-foreground leading-tight">"{story.highlightQuote.text}"</p>
                </div>
              </div>
            </div>
          )}

          <h2 className="text-xl font-serif font-bold text-foreground mb-4 flex items-center gap-2">
            <Wand2 className="w-5 h-5 text-brand" />
            The Tale in Brief
          </h2>
          <p className="text-foreground leading-relaxed italic text-lg opacity-90">{story.summary}</p>
        </motion.div>

        {/* Characters & Places */}
        {(story.characters.length > 0 || story.places.length > 0) && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
            {story.characters.length > 0 && (
              <div className="space-y-4">
                <h3 className="text-lg font-serif font-bold text-foreground flex items-center gap-2">
                  <Users className="w-5 h-5 text-brand" />
                  Characters in this Story
                </h3>
                <div className="relative">
                  <div
                    ref={charactersContainerRef}
                    className={`flex flex-wrap gap-2 transition-all duration-500 overflow-hidden ${!expandedCharacters ? 'max-h-[180px]' : 'max-h-[2000px]'}`}
                  >
                    {story.characters.map((char) => (
                      <button
                        key={char.id}
                        onClick={() => onNavigateToCharacters(char.id)}
                        className="bg-surface border border-border px-4 py-2 rounded-full text-sm font-medium text-foreground/90 shadow-sm hover:bg-brand hover:text-white dark:hover:text-background transition-all active:scale-95"
                      >
                        {char.name}
                      </button>
                    ))}
                  </div>
                  {needsCharacterTruncation && (
                    <button onClick={() => setExpandedCharacters(!expandedCharacters)} className="mt-2 text-[10px] font-bold uppercase tracking-widest text-brand hover:text-foreground transition-colors">
                      {expandedCharacters ? 'Show Less' : 'Show All Characters'}
                    </button>
                  )}
                </div>
              </div>
            )}
            {story.places.length > 0 && (
              <div className="space-y-4">
                <h3 className="text-lg font-serif font-bold text-foreground flex items-center gap-2">
                  <MapPin className="w-5 h-5 text-brand" />
                  Places Visited
                </h3>
                <div className="relative">
                  <div
                    ref={placesContainerRef}
                    className={`flex flex-wrap gap-2 transition-all duration-500 overflow-hidden ${!expandedPlaces ? 'max-h-[180px]' : 'max-h-[2000px]'}`}
                  >
                    {story.places.map((place) => (
                      <button
                        key={place.id}
                        onClick={() => onNavigateToPlaces(place.id)}
                        className="bg-surface border border-border px-4 py-2 rounded-full text-sm font-medium text-foreground/90 shadow-sm hover:bg-brand hover:text-white dark:hover:text-background transition-all active:scale-95"
                      >
                        {place.name}
                      </button>
                    ))}
                  </div>
                  {needsPlaceTruncation && (
                    <button onClick={() => setExpandedPlaces(!expandedPlaces)} className="mt-2 text-[10px] font-bold uppercase tracking-widest text-brand hover:text-foreground transition-colors">
                      {expandedPlaces ? 'Show Less' : 'Show All Places'}
                    </button>
                  )}
                </div>
              </div>
            )}
          </motion.div>
        )}

        {/* Audio Player */}
        <div className="bg-brand dark:bg-zinc-900 text-white rounded-3xl p-6 mb-12 shadow-xl flex flex-col gap-4 transition-colors duration-300">
          <div className="flex items-center gap-6">
            <button
              onClick={togglePlay}
              className="w-14 h-14 bg-surface text-brand dark:bg-white dark:text-zinc-900 rounded-full flex items-center justify-center shadow-lg hover:scale-105 transition-transform active:scale-95"
            >
              {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6 ml-1" />}
            </button>
            <div className="flex-1">
              <div className="flex justify-between text-xs font-medium mb-2 opacity-80">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>
              <input
                type="range"
                min="0"
                max={duration || 0}
                value={currentTime}
                onChange={(e) => {
                  if (audioRef.current) audioRef.current.currentTime = Number(e.target.value);
                }}
                className="w-full accent-white h-1.5 rounded-full cursor-pointer opacity-80 hover:opacity-100 transition-opacity"
              />
            </div>
            <audio
              key={story.audio}
              ref={audioRef}
              src={assetUrl(story.audio)}
              onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime || 0)}
              onLoadedMetadata={() => setDuration(audioRef.current?.duration || 0)}
              onEnded={() => setIsPlaying(false)}
            />
          </div>
        </div>

        {/* Word Count Stats */}
        {stats && (stats.izzyWords > 0 || stats.dadWords > 0) && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-12 p-6 bg-surface border border-dashed border-brand/30 rounded-3xl flex flex-wrap items-center justify-around gap-6 text-center"
          >
            <div className="flex-1 min-w-[120px]">
              <p className="text-[10px] uppercase tracking-widest text-muted font-bold mb-1">Izzy's Words</p>
              <p className="text-2xl font-serif font-bold text-brand">{stats.izzyWords.toLocaleString()}</p>
            </div>
            <div className="w-px h-12 bg-border hidden sm:block" />
            <div className="flex-1 min-w-[120px]">
              <p className="text-[10px] uppercase tracking-widest text-muted font-bold mb-1">Dad's Words</p>
              <p className="text-2xl font-serif font-bold text-brand">{stats.dadWords.toLocaleString()}</p>
            </div>
            <div className="w-px h-12 bg-border hidden sm:block" />
            <div className="flex-1 min-w-[120px]">
              <p className="text-[10px] uppercase tracking-widest text-muted font-bold mb-1">Izzy's Share</p>
              <p className="text-2xl font-serif font-bold text-brand">{stats.ratio}</p>
            </div>
          </motion.div>
        )}

        {/* Transcript */}
        <div className="space-y-8 mb-20">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-serif font-bold text-foreground flex items-center gap-2">
              <MessageSquare className="w-6 h-6 text-brand" />
              Transcript
            </h2>
          </div>

          <div className="space-y-6">
            {story.transcript.map((item, idx) => (
              <motion.div key={idx} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(idx, 20) * 0.02 }} className="group flex gap-6">
                <div className="w-24 flex-shrink-0 pt-1">
                  <button
                    onClick={() => skipTo(item.timestamp)}
                    className="text-xs font-mono text-brand hover:text-foreground flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity"
                  >
                    <History className="w-3 h-3" />
                    {Math.floor(item.timestamp / 60)}:{Math.floor(item.timestamp % 60).toString().padStart(2, '0')}
                  </button>
                </div>
                <div className="flex-1">
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-brand uppercase tracking-wider">{item.speaker}</p>
                    <p className="text-xl text-foreground leading-relaxed font-serif">{item.text}</p>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
