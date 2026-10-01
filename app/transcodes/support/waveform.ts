/**
 * **La forme d'onde d'un Spark** — trente-six hauteurs entières, de 0 à 100.
 *
 * Le client en affiche 28 à 40 selon la largeur dont il dispose ; 36 tombe au
 * milieu de cette fourchette et se sous-échantillonne proprement vers 18 ou 12.
 *
 * ## Pourquoi la calculer ici, et pas la laisser au client
 *
 * Le client **sait déjà** se replier sur un hachage déterministe du texte quand
 * la forme d'onde manque. Ce repli a l'avantage d'être stable et joli, et le
 * défaut d'être **faux** : il dessine des collines là où le Spark commence par
 * trois secondes de silence, et l'auditeur qui voit une barre haute au tout début
 * croit que la lecture a démarré alors qu'elle n'a encore rien joué. Une forme
 * d'onde qui ment est pire qu'une absence, parce qu'on ne peut pas la distinguer
 * d'une vraie.
 *
 * Or les échantillons ne sont sous la main **qu'une fois** : pendant la passe
 * d'analyse de `loudnorm`, qui lit déjà le fichier d'un bout à l'autre. Les
 * relire plus tard coûterait un décodage complet pour trente-six entiers.
 */

/** Le nombre de barres publiées. Voir l'en-tête pour le choix de 36. */
export const WAVEFORM_BARS = 36

/**
 * Le plancher de l'échelle, en dB sous la barre la plus forte du fichier.
 *
 * ⚠️ **Une échelle linéaire en amplitude ne marche pas.** Un passage parlé normal
 * est 20 à 30 dB sous les crêtes ; en amplitude brute il sort à 3 ou 5 sur 100,
 * c'est-à-dire invisible, et la forme d'onde ne montre plus que les deux ou trois
 * coups les plus forts. L'échelle est donc en **décibels**, où l'oreille écoute :
 * la barre la plus forte vaut 100, une barre 48 dB plus bas vaut 0, et tout ce
 * qu'il y a entre se répartit linéairement en dB.
 *
 * -48 dB plutôt que -60 : en dessous on remonte le bruit de fond d'un
 * enregistrement au téléphone, et le silence cesse de se lire comme un silence —
 * ce qui était précisément le reproche fait au repli par hachage.
 */
export const WAVEFORM_FLOOR_DB = -48

/**
 * Trente-six hauteurs, calculées sur du PCM **mono 16 bits petit-boutiste**.
 *
 * Rend `null` quand il n'y a pas de quoi remplir les barres — une source plus
 * courte que `bars` échantillons n'a rien à dessiner, et une barre inventée
 * serait exactement le mensonge qu'on cherche à éviter.
 *
 * Un fichier **entièrement silencieux** rend trente-six zéros et **non** `null` :
 * c'est une mesure, et elle est juste.
 *
 * Chaque barre est l'**efficace (RMS)** de sa tranche, pas sa crête : une crête
 * isolée — un clic, un coup sur le micro — ferait une barre pleine au milieu du
 * silence. L'efficace décrit ce qu'on entend.
 */
export function waveformFromPcm(pcm: Buffer, bars: number = WAVEFORM_BARS): number[] | null {
  const samples = Math.floor(pcm.length / 2)
  if (samples < bars || bars <= 0) return null

  // L'efficace de chaque tranche, en fraction de la pleine échelle.
  const rms: number[] = []
  for (let bar = 0; bar < bars; bar += 1) {
    const from = Math.floor((bar * samples) / bars)
    const to = Math.floor(((bar + 1) * samples) / bars)
    let sum = 0
    for (let at = from; at < to; at += 1) {
      const value = pcm.readInt16LE(at * 2) / 32_768
      sum += value * value
    }
    rms.push(to > from ? Math.sqrt(sum / (to - from)) : 0)
  }

  // **Relatif à la barre la plus forte du fichier**, et non à la pleine échelle :
  // le niveau absolu est l'affaire de `loudnorm`, qui l'égalise ensuite de toute
  // façon. Ce qu'une forme d'onde doit montrer, c'est le relief *dans* le média.
  const peak = Math.max(...rms)
  if (peak <= 0) return rms.map(() => 0)

  return rms.map((value) => {
    if (value <= 0) return 0
    const db = 20 * Math.log10(value / peak)
    if (db <= WAVEFORM_FLOOR_DB) return 0
    return Math.round((100 * (db - WAVEFORM_FLOOR_DB)) / -WAVEFORM_FLOOR_DB)
  })
}
