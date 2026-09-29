/**
 * Les étiquettes d'un média source — titre, artiste, album — telles que la sonde
 * les rend au portail.
 *
 * Elles ne décrivent pas ce que ce service produit : elles décrivent ce qu'il a
 * reçu. Le portail les proposera à l'administrateur comme **valeurs par défaut**
 * au dépôt, « s'ils sont disponibles et que l'utilisateur les connaît » — donc
 * une absence est normale, jamais une erreur, et chaque champ est nullable
 * séparément (un fichier peut porter un titre sans album).
 */
export interface MediaTags {
  title: string | null
  artist: string | null
  album: string | null
}

/** Aucune étiquette — la forme retournée quand le conteneur n'en porte pas. */
export const NO_TAGS: MediaTags = { title: null, artist: null, album: null }

/**
 * Relit une étiquette **sans se soucier de la casse de sa clé**.
 *
 * ⚠️ **La panne évitée.** Les conteneurs ne s'accordent pas sur la casse : MP4 et
 * ID3 rendent `title`, tandis qu'un commentaire Vorbis (FLAC, Ogg) est écrit
 * `TITLE` et ressort tel quel de la sonde. Une lecture directe `tags.title`
 * marcherait donc sur un MP3 et rendrait `null` sur un FLAC — un trou qui ne se
 * voit qu'avec le bon fichier, c'est-à-dire en production.
 */
function pick(tags: Record<string, string> | undefined, name: string): string | null {
  if (!tags) return null
  for (const [key, value] of Object.entries(tags)) {
    if (key.toLowerCase() !== name) continue
    const trimmed = value?.trim()
    // Une étiquette vide est une étiquette absente : la proposer comme valeur
    // par défaut ferait remplir un champ avec du vide.
    if (trimmed) return trimmed
  }
  return null
}

/**
 * Les trois étiquettes retenues, prises **d'abord** sur le conteneur puis sur la
 * piste audio.
 *
 * Les deux niveaux existent et ne portent pas la même chose selon le format :
 * MP4 et MP3 rangent les métadonnées au niveau du conteneur, un Ogg les range
 * sur le flux. Ne lire que `format_tags` perdrait donc silencieusement les
 * étiquettes d'un Ogg — le conteneur, lui, répondrait « rien à signaler ».
 */
export function readTags(
  formatTags?: Record<string, string>,
  streamTags?: Record<string, string>
): MediaTags {
  return {
    title: pick(formatTags, 'title') ?? pick(streamTags, 'title'),
    artist: pick(formatTags, 'artist') ?? pick(streamTags, 'artist'),
    album: pick(formatTags, 'album') ?? pick(streamTags, 'album'),
  }
}
