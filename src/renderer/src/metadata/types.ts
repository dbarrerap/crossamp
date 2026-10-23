/**
 * Metadatos de audio.
 *
 * Alcance Fase 1: solo MP3 (ID3v2). FLAC y OGG Vorbis se añaden después.
 * La feature branch `feature/metadata-mp3` implementa el parser.
 */
export interface TrackMetadata {
  title: string | null;
  artist: string | null;
  album: string | null;
  duration: number | null;
  /** Carátula como data URL, si existe. */
  picture: string | null;
}
