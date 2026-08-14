#!/usr/bin/env node
/**
 * Generates 3 placeholder PNGs in ./test-docs/ for the document-upload step
 * (Social Security Card, Address Verification, Government Issued ID).
 *
 * apply-bff rejects files under 10KB client-side, so these are padded with
 * noise well past that floor. They will still fail the automated
 * image-quality check ("photo isn't clear enough to read") — apply-flow.js's
 * uploadDocuments() clicks through the resulting "Keep File" override.
 *
 * Usage: node generate-placeholder-docs.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

function chunk(tag, data) {
  const tagBuf = Buffer.from(tag, 'ascii');
  const combined = Buffer.concat([tagBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(combined) : crc32(combined), 0);
  return Buffer.concat([len, combined, crc]);
}

// Node's zlib doesn't expose crc32 pre-v21; fall back to a small table-based impl.
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[n] = c;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writePlaceholderPng(filePath, width = 1200, height = 1600) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // bit depth
  ihdrData.writeUInt8(2, 9); // color type: RGB
  const ihdr = chunk('IHDR', ihdrData);

  const seed = crypto.randomBytes(width * 3);
  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter byte: none
    offset += 1;
    for (let x = 0; x < width * 3; x += 1) {
      raw[offset] = (seed[x % seed.length] + y) % 256;
      offset += 1;
    }
  }
  const idat = chunk('IDAT', zlib.deflateSync(raw, { level: 1 }));
  const iend = chunk('IEND', Buffer.alloc(0));

  fs.writeFileSync(filePath, Buffer.concat([sig, ihdr, idat, iend]));
}

const outDir = path.join(__dirname, 'test-docs');
fs.mkdirSync(outDir, { recursive: true });

for (const name of ['ssn-card', 'address-verification', 'gov-id']) {
  const filePath = path.join(outDir, `${name}.png`);
  writePlaceholderPng(filePath);
  console.log(`Wrote ${filePath} (${(fs.statSync(filePath).size / 1024).toFixed(0)}KB)`);
}
