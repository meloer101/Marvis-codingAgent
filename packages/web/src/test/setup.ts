/**
 * What jsdom lacks that ProseMirror (the composer's editor) measures with:
 * client rects of ranges, for scrolling the caret into view, and the element
 * under a point. Nothing is laid out in jsdom, so empty answers do.
 */

const emptyRects = (): DOMRectList => Object.assign([], { item: () => null }) as unknown as DOMRectList;

if (typeof Range !== 'undefined') {
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  Range.prototype.getClientRects ??= emptyRects;
}
if (typeof document !== 'undefined') {
  document.elementFromPoint ??= () => null;
}
