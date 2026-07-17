import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { getWorlds, assetUrl, WorldsDoc, World } from '../data';
// Framework-agnostic orrery engine shared with the published artifact.
// @ts-expect-error - plain .js module (no types)
import { mountOrrery } from '../orrery.js';
import '../orrery.css';

export default function CosmologyView() {
  const [doc, setDoc] = useState<WorldsDoc | null>(null);
  const [error, setError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    getWorlds()
      .then((d) => { if (alive) setDoc(d); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!doc || !ref.current) return;
    const cleanup = mountOrrery(ref.current, doc, (w: World) => (w.image ? assetUrl(w.image) : null));
    return cleanup as () => void;
  }, [doc]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted font-serif italic p-8 text-center">
        The cosmos wouldn't load.
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="min-h-screen flex items-center justify-center text-brand">
        <div className="flex flex-col items-center gap-3">
          <Sparkles className="w-10 h-10" />
          <p className="font-serif italic">Charting the cosmos…</p>
        </div>
      </div>
    );
  }
  // mountOrrery adds the `.cosmos` class and builds the map inside this element.
  return <div ref={ref} />;
}
