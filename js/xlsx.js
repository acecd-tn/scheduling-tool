/*
 * PSAP Scheduler — minimal .xlsx reader (no dependencies).
 *
 * An .xlsx file is a zip of XML files. This reads the zip directory, inflates entries
 * with the platform's DecompressionStream ('deflate-raw'), and turns each worksheet
 * into a grid of strings (rows × columns). Formatting, formulas and merged-cell
 * spans are ignored; a merged cell's value is in its top-left cell.
 *
 *   PSAPXlsx.read(arrayBuffer) → Promise<[{ name, rows: string[][] }]>
 */
(function (global) {
  'use strict';

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  /** Zip directory → { name: { method, offset, size } } */
  function zipEntries(b) {
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Not an .xlsx file (no zip directory found)');
    const count = u16(b, eocd + 10);
    let p = u32(b, eocd + 16);
    const out = {};
    const dec = new TextDecoder();
    for (let k = 0; k < count; k++) {
      if (u32(b, p) !== 0x02014b50) throw new Error('Damaged .xlsx file');
      const method = u16(b, p + 10), size = u32(b, p + 20), nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32), local = u32(b, p + 42);
      const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
      out[name] = { method, size, local };
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }

  async function inflate(data) {
    const ds = new DecompressionStream('deflate-raw');
    const buf = await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function entryText(b, e) {
    const nlen = u16(b, e.local + 26), xlen = u16(b, e.local + 28);
    const start = e.local + 30 + nlen + xlen;
    const raw = b.subarray(start, start + e.size);
    const bytes = e.method === 0 ? raw : e.method === 8 ? await inflate(raw) : null;
    if (!bytes) throw new Error('Unsupported compression in .xlsx');
    return new TextDecoder().decode(bytes);
  }

  const unescape = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, x) => {
    const k = x.toLowerCase();
    if (k === 'lt') return '<'; if (k === 'gt') return '>'; if (k === 'amp') return '&'; if (k === 'quot') return '"'; if (k === 'apos') return "'";
    return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  });
  /** All the text in <t> elements inside a fragment (rich text runs joined). */
  const textOf = (frag) => { let s = ''; frag.replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (m, t) => { s += t; return m; }); return unescape(s); };

  function colIndex(ref) {
    const m = /^([A-Z]+)/.exec(ref);
    let n = 0;
    for (const ch of m ? m[1] : 'A') n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  async function read(buffer) {
    const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const entries = zipEntries(b);
    const get = (n) => (entries[n] ? entryText(b, entries[n]) : Promise.resolve(''));
    const shared = [];
    (await get('xl/sharedStrings.xml')).replace(/<si>([\s\S]*?)<\/si>/g, (m, si) => { shared.push(textOf(si)); return m; });
    const wb = await get('xl/workbook.xml');
    const rels = await get('xl/_rels/workbook.xml.rels');
    const target = {};
    rels.replace(/<Relationship\s[^>]*?>/g, (tag) => {
      const id = /Id="([^"]+)"/.exec(tag), t = /Target="([^"]+)"/.exec(tag);
      if (id && t) target[id[1]] = t[1].replace(/^\/?xl\//, '').replace(/^\//, '');
      return tag;
    });
    const sheets = [];
    const list = [];
    wb.replace(/<sheet\s[^>]*?\/?>/g, (tag) => {
      const name = /name="([^"]*)"/.exec(tag), rid = /r:id="([^"]+)"/.exec(tag);
      if (name && rid) list.push({ name: unescape(name[1]), path: 'xl/' + (target[rid[1]] || '') });
      return tag;
    });
    for (const sh of list) {
      const xml = await get(sh.path);
      const rows = [];
      xml.replace(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g, (m, inner, off) => {
        const rn = /r="(\d+)"/.exec(m);
        const r = rn ? +rn[1] - 1 : rows.length;
        const row = rows[r] || (rows[r] = []);
        (inner || '').replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (cm, attrs, body) => {
          const ref = /r="([A-Z]+\d+)"/.exec(attrs);
          const t = (/t="([^"]+)"/.exec(attrs) || [])[1];
          body = body || '';
          let v = '';
          const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
          if (t === 's') v = vm ? (shared[+vm[1]] ?? '') : '';
          else if (t === 'inlineStr') v = textOf(body);
          else if (vm) v = unescape(vm[1]);
          row[ref ? colIndex(ref[1]) : row.length] = v;
          return cm;
        });
        return m;
      });
      const grid = [];
      for (let i = 0; i < rows.length; i++) { const r = rows[i] || []; grid.push(Array.from({ length: r.length }, (_, j) => (r[j] == null ? '' : String(r[j])))); }
      sheets.push({ name: sh.name, rows: grid });
    }
    return sheets;
  }

  const api = { read };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PSAPXlsx = api;
})(typeof window !== 'undefined' ? window : globalThis);
