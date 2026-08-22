// zip-csv.js -- minimal ZIP reader that extracts .csv entries as text.
// Dependency-free: walks the central directory per the PKZIP spec and
// inflates method-8 (deflate) entries with the browser-native
// DecompressionStream('deflate-raw'); method-0 (stored) entries are a
// straight slice. Anything else (encrypted, zip64, other methods) is
// skipped with a reason so the caller can tell the user.
//
// Scope: MangoHud benchmark archives (FlightlessSomething downloads are
// ZIPs of per-run CSVs). These are small, flat archives -- not a general
// unzip. 50 MB input cap + 200 entry cap keep a hostile file from
// ballooning memory.

const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 200;

const EOCD_SIG = 0x06054b50;
const CDFH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/**
 * Extract every .csv file from a ZIP archive.
 * @param {ArrayBuffer} buf - the archive bytes
 * @returns {Promise<{files: Array<{name: string, text: string}>, skipped: string[]}>}
 * @throws {Error} when the buffer is not a readable ZIP at all
 */
export async function extractCsvsFromZip(buf) {
  if (buf.byteLength > MAX_ZIP_BYTES) throw new Error('ZIP is too large (50 MB max)');
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // End-of-central-directory: scan back from the tail (comment can pad it).
  let eocd = -1;
  const scanFrom = Math.max(0, buf.byteLength - 22 - 65535);
  for (let i = buf.byteLength - 22; i >= scanFrom; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (no central directory)');
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const files = [];
  const skipped = [];
  const decoder = new TextDecoder('utf-8');
  for (let n = 0; n < Math.min(entryCount, MAX_ENTRIES); n++) {
    if (offset + 46 > buf.byteLength || view.getUint32(offset, true) !== CDFH_SIG) break;
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const lfhOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;

    if (!/\.csv$/i.test(name) || name.endsWith('/')) continue;
    // Local file header repeats name/extra lengths; data follows it.
    if (view.getUint32(lfhOffset, true) !== LFH_SIG) { skipped.push(`${name} (corrupt header)`); continue; }
    const lfhNameLen = view.getUint16(lfhOffset + 26, true);
    const lfhExtraLen = view.getUint16(lfhOffset + 28, true);
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);

    try {
      if (method === 0) {
        files.push({ name, text: decoder.decode(raw) });
      } else if (method === 8) {
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        files.push({ name, text: await new Response(stream).text() });
      } else {
        skipped.push(`${name} (unsupported compression method ${method})`);
      }
    } catch (e) {
      skipped.push(`${name} (${(e && e.message) || 'inflate failed'})`);
    }
  }
  return { files, skipped };
}
