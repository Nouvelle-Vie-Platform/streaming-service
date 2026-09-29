import { stagedSourcePath } from '#transcodes/support/hls'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Ce qu'un rapatriement a produit : où, et combien. */
export interface StagedSource {
  path: string
  bytes: number
}

/**
 * **Rapatrie une source distante sur le disque avant de l'encoder.**
 *
 * ## Pourquoi, et ce que ça mesure
 *
 * ffmpeg lit très bien une URL. Il la lit **pendant** l'encodage, et les deux
 * durées se confondent alors dans un seul chiffre : mesuré en production,
 * 978 s pour 5533 s d'audio, soit 5,7× le temps réel — là où la même échelle
 * encodée depuis un fichier local fait 55× sur une machine comparable.
 *
 * Six fois et demie d'écart que le nombre de cœurs n'explique pas. Un dépôt peut
 * peser 2 Go (`MEDIA_DEPOSIT_MAX_BYTES` côté portail) : à 2 Mo/s, son transfert
 * seul vaut mille secondes. Séparer les deux étapes, c'est d'abord **savoir**
 * laquelle coûte — et, si c'est bien le transfert, l'avoir déjà réparé.
 *
 * ## Ce que ça ne change pas
 *
 * **Le régime d'ingestion.** Une source rapatriée reste une ingestion par URL :
 * le master vit dans RustFS, le service n'en garde aucune archive (ADR-0007) et
 * le portail ne purge jamais la source d'un dépôt rattaché (son ADR-0033).
 * Laisser cette copie de travail faire croire à un téléversement ferait produire
 * une archive FLAC que personne n'a demandée, et pour laquelle il n'y a pas de
 * place.
 *
 * ## Ce que ça coûte
 *
 * Jusqu'à 2 Go sur le disque, le temps d'un transcodage, multipliés par
 * `WORKER_CONCURRENCY`. Sur les 296 Go du VPS, c'est une pointe de 4 Go. La
 * copie est effacée dès l'encodage terminé, **réussi ou non** : une source
 * abandonnée sur le disque ne se rattrape par aucun nettoyage — rien ne la
 * référence.
 */
export class SourceStaging {
  /**
   * Descend [url] dans le fichier de travail de [id] et rend sa taille.
   *
   * **En flux, jamais en mémoire** : un `Buffer` de 2 Go tiendrait, et ferait
   * tomber le worker le jour où deux transcodages se croisent.
   */
  async fetch(url: string, id: string): Promise<StagedSource> {
    const path = stagedSourcePath(id)
    await mkdir(dirname(path), { recursive: true })

    const response = await globalThis.fetch(url)
    if (!response.ok || !response.body) {
      throw new Error(`source fetch failed with ${response.status} for transcode ${id}`)
    }

    // Pas de minuterie globale : 2 Go sur un lien modeste durent légitimement
    // des minutes, et couper au bout d'un délai rond transformerait un gros
    // sermon en échec récurrent. Une coupure réelle fait échouer le flux, et
    // c'est cette panne-là qu'on veut voir remonter.
    await pipeline(Readable.fromWeb(response.body), createWriteStream(path))

    const { size } = await stat(path)
    return { path, bytes: size }
  }

  /**
   * Efface la copie de travail. Ne lève jamais : elle est appelée dans un
   * `finally`, et un nettoyage qui échoue n'a pas à masquer l'erreur qui l'a
   * déclenché.
   */
  async discard(id: string): Promise<void> {
    await rm(stagedSourcePath(id), { force: true }).catch(() => {})
  }
}
