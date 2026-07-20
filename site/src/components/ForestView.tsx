import { useEffect, useRef, useState } from 'react';
import { TreePine } from 'lucide-react';
import { getForest, assetUrl, ForestDoc, ForestLocation } from '../data';
// Framework-agnostic forest-map engines (both plain .js, no types).
// New: a painted Tolkien-style landscape with clickable SVG markers overlaid.
// Legacy: the procedural SVG renderer, used until a landscape is selected.
// @ts-expect-error - plain .js module (no types)
import { mountForest } from '../forest.js';
// @ts-expect-error - plain .js module (no types)
import { mountForestLegacy } from '../forest-legacy.js';
import '../forest.css';

export default function ForestView() {
  const [doc, setDoc] = useState<ForestDoc | null>(null);
  const [error, setError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    getForest()
      .then((d) => { if (alive) setDoc(d); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!doc || !ref.current) return;
    const resolve = (loc: ForestLocation, field: 'art' | 'image' | 'vignette') =>
      loc[field] ? assetUrl(loc[field] as string) : null;
    const cleanup = doc.meta.landscape
      ? mountForest(ref.current, doc, resolve, assetUrl(doc.meta.landscape.image))
      : mountForestLegacy(ref.current, doc, resolve);
    return cleanup as () => void;
  }, [doc]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted font-serif italic p-8 text-center">
        The forest path was overgrown.
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="min-h-screen flex items-center justify-center text-brand">
        <div className="flex flex-col items-center gap-3">
          <TreePine className="w-10 h-10" />
          <p className="font-serif italic">Walking into the woods…</p>
        </div>
      </div>
    );
  }
  // mountForest adds the `.forest-map` class and builds the map inside this element.
  return <div ref={ref} />;
}
