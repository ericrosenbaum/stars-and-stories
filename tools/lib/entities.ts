import type { StoryRecord, CanonicalEntity, EmbeddedEntity } from './types.ts';

/**
 * Recompute storyIds (as slugs) and firstAppearanceStoryId for canonical
 * entities, from which stories embed each entity id. The export's own
 * storyIds reference unmappable Firestore doc ids, so we rebuild them here.
 */
export function recomputeEntityLinks(
  canonical: { id: string; name: string; description: string }[],
  stories: StoryRecord[],
  field: 'characters' | 'places',
): CanonicalEntity[] {
  const links = new Map<string, { storyIds: string[]; firstDate: number; firstSlug: string | null }>();
  for (const c of canonical) {
    links.set(c.id, { storyIds: [], firstDate: Infinity, firstSlug: null });
  }

  const sorted = [...stories].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  for (const story of sorted) {
    const seen = new Set<string>();
    for (const e of ((story as any)[field] as EmbeddedEntity[]) || []) {
      if (!e?.id || seen.has(e.id)) continue;
      seen.add(e.id);
      const link = links.get(e.id);
      if (!link) continue; // embedded id not present in canonical list
      link.storyIds.push(story.id);
      const t = new Date(story.date).getTime();
      if (t < link.firstDate) {
        link.firstDate = t;
        link.firstSlug = story.id;
      }
    }
  }

  return canonical.map((c) => {
    const link = links.get(c.id)!;
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      storyIds: link.storyIds,
      firstAppearanceStoryId: link.firstSlug,
    };
  });
}
