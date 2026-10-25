/**
 * Zona de drop de archivos para un elemento del DOM.
 *
 * Solo se activa cuando el arrastre trae archivos (no texto/HTML) y marca el
 * elemento con `.drag-over` para que el CSS lo resalte. La política de qué
 * hacer con los archivos la decide el llamador (player = reemplazar,
 * playlist = agregar).
 */
export function attachFileDrop(
  element: HTMLElement,
  onFiles: (files: File[]) => void
): void {
  const carriesFiles = (event: DragEvent): boolean =>
    event.dataTransfer?.types.includes('Files') ?? false;

  element.addEventListener('dragover', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    element.classList.add('drag-over');
  });

  element.addEventListener('dragleave', (event) => {
    // Si el puntero pasa a un hijo del mismo panel, no quitamos el realce.
    if (
      event.relatedTarget instanceof Node &&
      element.contains(event.relatedTarget)
    ) {
      return;
    }
    element.classList.remove('drag-over');
  });

  element.addEventListener('drop', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    element.classList.remove('drag-over');

    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) onFiles(files);
  });
}
