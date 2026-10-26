/**
 * Metadatos de audio.
 *
 * Alcance Fase 1: solo MP3 (ID3v2). FLAC y OGG Vorbis se añaden después.
 * La feature branch `feature/metadata-mp3` implementa el parser.
 *
 * Dos capas, inspiradas en el flujo de cliamp (tags crudos → resolución):
 *
 *  - ParsedTags: salida cruda del parser. Trae la carátula como bytes en
 *    bruto y NO estimate duración (VBR es engañoso; la aporta el engine).
 *  - TrackMetadata: estado ya resuelto para la UI (vive en el store). La
 *    carátula es una object URL (blob:) y su ciclo de vida —crear y
 *    revocar— es del PlayerController.
 */

/** Bytes de una carátula embebida, sin resolver. */
export interface EmbeddedPicture {
  /** MIME declarado en el tag (p. ej. 'image/png'). */
  mime: string;
  /** Copia propia de los bytes de la imagen. `ArrayBuffer` (no Shared) para poder ir a Blob. */
  data: Uint8Array<ArrayBuffer>;
}

/** Salida cruda de parseID3(). */
export interface ParsedTags {
  title: string | null;
  artist: string | null;
  album: string | null;
  picture: EmbeddedPicture | null;
}

/** Metadatos ya resueltos para la UI. */
export interface TrackMetadata {
  title: string | null;
  artist: string | null;
  album: string | null;
  /**
   * object URL (blob:) de la carátula, o null. Dueño: PlayerController
   * (la revoca al cambiar de pista y en dispose()).
   */
  picture: string | null;
}

/** Campos editables por el editor de tags (Alt+3). */
export interface TagEdit {
  title: string;
  artist: string;
  album: string;
}

/** Resultado de guardar tags en disco (IPC). */
export interface TagWriteResult {
  ok: boolean;
  error?: string;
}
