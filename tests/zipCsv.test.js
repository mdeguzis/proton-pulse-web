/**
 * Tests for js/shared/zip-csv.js (#410): the minimal ZIP reader behind the
 * MangoHud ZIP upload. Archives are built in-test with Node's zlib so the
 * fixtures are real deflate streams, not hand-rolled bytes.
 */
const zlib = require('zlib');

const { extractCsvsFromZip } = require('../js/shared/zip-csv.js');

// Build a real ZIP (method 8 deflate or method 0 stored) from {name: text}.
function buildZip(entries, { method = 8 } = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const enc = (s) => Buffer.from(s, 'utf-8');
  for (const [name, text] of Object.entries(entries)) {
    const nameBuf = enc(name);
    const raw = enc(text);
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0; // node >= 20.15
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);           // version
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(crc >>> 0, 14);
    lfh.writeUInt32LE(data.length, 18); // comp size
    lfh.writeUInt32LE(raw.length, 22);  // uncomp size
    lfh.writeUInt16LE(nameBuf.length, 26);
    chunks.push(lfh, nameBuf, data);

    const cdfh = Buffer.alloc(46);
    cdfh.writeUInt32LE(0x02014b50, 0);
    cdfh.writeUInt16LE(method, 10);
    cdfh.writeUInt32LE(crc >>> 0, 16);
    cdfh.writeUInt32LE(data.length, 20);
    cdfh.writeUInt32LE(raw.length, 24);
    cdfh.writeUInt16LE(nameBuf.length, 28);
    cdfh.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cdfh, nameBuf]));
    offset += lfh.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const buf = Buffer.concat([...chunks, centralBuf, eocd]);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const CSV = 'os,cpu,gpu\nfps,frametime\n60,16.6\n58,17.2\n';

describe('extractCsvsFromZip', () => {
  test('extracts deflated CSV members with their names and text', async () => {
    const zip = buildZip({ 'run1.csv': CSV, 'run2.CSV': CSV });
    const { files, skipped } = await extractCsvsFromZip(zip);
    expect(files.map(f => f.name).sort()).toEqual(['run1.csv', 'run2.CSV']);
    expect(files[0].text).toBe(CSV);
    expect(skipped).toEqual([]);
  });

  test('extracts stored (method 0) members too', async () => {
    const zip = buildZip({ 'stored.csv': CSV }, { method: 0 });
    const { files } = await extractCsvsFromZip(zip);
    expect(files).toHaveLength(1);
    expect(files[0].text).toBe(CSV);
  });

  test('ignores non-CSV members and directories', async () => {
    const zip = buildZip({ 'readme.txt': 'hi', 'runs/': '', 'runs/a.csv': CSV });
    const { files } = await extractCsvsFromZip(zip);
    expect(files.map(f => f.name)).toEqual(['runs/a.csv']);
  });

  test('throws a clear error on a non-ZIP buffer', async () => {
    const junk = new TextEncoder().encode('definitely,not,a,zip\n1,2,3,4\n').buffer;
    await expect(extractCsvsFromZip(junk)).rejects.toThrow(/Not a ZIP/);
  });

  test('rejects oversized archives before parsing', async () => {
    const big = new ArrayBuffer(51 * 1024 * 1024);
    await expect(extractCsvsFromZip(big)).rejects.toThrow(/too large/);
  });
});
