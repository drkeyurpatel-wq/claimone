/**
 * Text out of a PDF, with where each piece sits on the page — read on the user's own device with the open-source
 * pdf.js (via unpdf). No server, no API key, no cost. Works for PDFs that carry real text (bank statements, letters
 * downloaded from a portal); a scan or a phone photo has no text in it.
 */
export interface PdfItem { page: number; x: number; y: number; str: string }

export async function pdfItems(data: ArrayBuffer | Uint8Array): Promise<PdfItem[]> {
  const { getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(data instanceof Uint8Array ? data : new Uint8Array(data));
  const out: PdfItem[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const it of content.items as { str?: string; transform?: number[] }[]) {
      if (!it.str || !it.str.trim() || !it.transform) continue;
      out.push({ page: p, x: it.transform[4], y: it.transform[5], str: it.str });
    }
  }
  return out;
}

/** Pieces → the lines of each page, top to bottom, each line's pieces left to right. */
export function pdfLines(items: PdfItem[]): PdfItem[][] {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines: PdfItem[][] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && last[0].page === it.page && Math.abs(last[0].y - it.y) <= 2.5) last.push(it);
    else lines.push([it]);
  }
  for (const l of lines) l.sort((a, b) => a.x - b.x);
  return lines;
}
