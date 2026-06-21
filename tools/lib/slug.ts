/**
 * Slugify a title to match the export's folder-naming scheme:
 * non-alphanumeric runs (except hyphens) collapse to a single underscore.
 * e.g. "Slime-Ka-Bye: The Beard-Dweller's Adventure"
 *   -> "Slime-Ka-Bye_The_Beard-Dweller_s_Adventure"
 */
export function slugify(title: string): string {
  return title
    .replace(/[^A-Za-z0-9-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
}

/** A slug guaranteed not to collide, appending -2, -3, ... if needed. */
export function uniqueSlug(title: string, exists: (s: string) => boolean): string {
  const base = slugify(title) || 'story';
  if (!exists(base)) return base;
  let i = 2;
  while (exists(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
