import { useState, useEffect } from 'react';
import { ArrowLeft, Calendar, Images } from 'lucide-react';
import { motion } from 'motion/react';
import { getStoryboard, assetUrl, Storyboard } from '../data';

export default function StoryboardView({ slug, onBack }: { slug: string; onBack: () => void }) {
  const [storyboard, setStoryboard] = useState<Storyboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    setLoading(true);
    setNotFound(false);
    setStoryboard(null);
    getStoryboard(slug)
      .then((sb) => {
        setStoryboard(sb);
        setLoading(false);
      })
      .catch(() => {
        setNotFound(true);
        setLoading(false);
      });
  }, [slug]);

  if (loading) return <div className="p-12 text-center font-serif italic text-brand">Opening the storybook...</div>;
  if (notFound || !storyboard) return <div className="p-12 text-center font-serif italic text-brand">This story has no storyboard yet.</div>;

  return (
    <div className="h-full flex flex-col bg-background relative z-10">
      {/* Header */}
      <header className="p-6 border-b border-border bg-surface flex items-center justify-between sticky top-0 z-10 transition-colors duration-300">
        <div className="flex items-center gap-4">
          <motion.button whileTap={{ scale: 0.9 }} onClick={onBack} className="p-3 hover:bg-background rounded-full transition-colors text-brand touch-manipulation">
            <ArrowLeft className="w-7 h-7" />
          </motion.button>
          <div>
            <p className="text-xs font-bold text-brand uppercase tracking-widest flex items-center gap-1.5">
              <Images className="w-3.5 h-3.5" />
              Storyboard
            </p>
            <h1 className="text-2xl font-serif font-bold text-foreground">{storyboard.title}</h1>
            <p className="text-sm text-muted italic flex items-center gap-1.5 mt-1">
              <Calendar className="w-3.5 h-3.5" />
              {new Date(storyboard.date).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}
            </p>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-8 max-w-4xl mx-auto w-full">
        <div className="space-y-12 mb-20">
          {storyboard.scenes.map((scene, idx) => (
            <motion.div
              key={scene.index}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(idx, 6) * 0.06 }}
              className="bg-surface border border-border rounded-3xl p-6 shadow-sm transition-colors duration-300"
            >
              <div className="w-full aspect-video rounded-2xl overflow-hidden mb-6 shadow-lg border border-border">
                <img src={assetUrl(scene.image)} alt={scene.caption} loading="lazy" className="w-full h-full object-cover" />
              </div>
              <p className="text-xs font-bold text-brand uppercase tracking-widest mb-2">Scene {scene.index}</p>
              <p className="text-xl font-serif text-foreground leading-relaxed mb-4">{scene.caption}</p>
              {scene.quote?.text && (
                <div className="pt-4 border-t border-background">
                  <p className="text-xs font-bold text-brand uppercase tracking-widest mb-2">{scene.quote.speaker} says...</p>
                  <p className="text-2xl font-serif font-bold text-foreground leading-tight">"{scene.quote.text}"</p>
                </div>
              )}
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
