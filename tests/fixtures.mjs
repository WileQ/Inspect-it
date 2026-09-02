// Fixture generators for the Inspect This test suite.
// Fixtures are real files (or structurally valid containers) generated in
// memory so the repository stays small and CI needs no network access.
import JSZip from 'jszip';
import { gzipSync, zlibSync } from 'fflate';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import { encode as encodeJpeg } from 'jpeg-js';
import { renderTextPng, renderTextRgba } from './ocr-font.mjs';

export function toItem(name, bytes, mimeType = 'application/octet-stream') {
  const file = new File([bytes], name, { type: mimeType, lastModified: 1_700_000_000_000 });
  return {
    kind: 'file',
    name,
    path: name,
    size: file.size,
    lastModified: file.lastModified,
    mimeType,
    file
  };
}

export function textItem(name, text, mimeType = 'text/plain') {
  return toItem(name, new TextEncoder().encode(text), mimeType);
}

export function concatBytes(parts) {
  const total = parts.reduce((acc, part) => acc + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Archives
// ---------------------------------------------------------------------------

export async function makeZipItem() {
  const zip = new JSZip();
  zip.file('hello.txt', 'hello world');
  zip.folder('docs').file('readme.md', '# Readme\n');
  zip.folder('docs').file('data.csv', 'a,b\n1,2\n');
  const nested = new JSZip();
  nested.file('inner.txt', 'inner');
  zip.file('nested.zip', await nested.generateAsync({ type: 'uint8array' }));
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return toItem('sample.zip', bytes, 'application/zip');
}

export async function makeGzipZipItem() {
  const zipItem = await makeZipItem();
  const bytes = gzipSync(new Uint8Array(await zipItem.file.arrayBuffer()));
  return toItem('sample.zip.gz', bytes, 'application/gzip');
}

function tarHeader(name, size, typeflag = '0') {
  const buf = new Uint8Array(512);
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name).slice(0, 100);
  buf.set(nameBytes, 0);
  buf.set(enc.encode('0000644\0'), 100);
  buf.set(enc.encode('0000000\0'), 108);
  buf.set(enc.encode('0000000\0'), 116);
  buf.set(enc.encode(size.toString(8).padStart(11, '0') + '\0'), 124);
  buf.set(enc.encode('00000000000\0'), 136);
  buf.set(enc.encode('        '), 148);
  buf[156] = typeflag.charCodeAt(0);
  buf.set(enc.encode('ustar\0'), 257);
  buf.set(enc.encode('00'), 263);
  let sum = 0;
  for (const value of buf) sum += value;
  const checksum = sum.toString(8).padStart(6, '0') + '\0 ';
  buf.set(enc.encode(checksum), 148);
  return buf;
}

function tarEntry(name, content) {
  const data = new TextEncoder().encode(content);
  const header = tarHeader(name, data.length);
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return concatBytes([header, padded]);
}

function tarLongNameEntry(name) {
  const data = new TextEncoder().encode(name + '\0');
  const header = tarHeader('placeholder-name', data.length, 'L');
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return concatBytes([header, padded]);
}

export function makeTarItem() {
  const parts = [];
  parts.push(tarEntry('hello.txt', 'hello tar'));
  parts.push(tarEntry('../../evil.sh', 'echo pwned'));
  parts.push(tarEntry('data.bin', 'x'.repeat(2000)));
  parts.push(tarLongNameEntry('very/long/path/with/many/segments/document-file.txt'));
  parts.push(tarEntry('placeholder-name', 'long name content'));
  parts.push(new Uint8Array(1024)); // end-of-archive zero blocks
  return toItem('sample.tar', concatBytes(parts), 'application/x-tar');
}

export function makeGzipTextItem() {
  const bytes = gzipSync(new TextEncoder().encode('compressed payload '.repeat(200)));
  return toItem('sample.txt.gz', bytes, 'application/gzip');
}

export async function makeGzipTarItem() {
  const tar = makeTarItem();
  const bytes = gzipSync(new Uint8Array(await tar.file.arrayBuffer()));
  return toItem('sample.tar.gz', bytes, 'application/gzip');
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function pdfHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function latin1Bytes(value) {
  const out = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    out[index] = value.charCodeAt(index) & 0xff;
  }
  return out;
}

export async function makePdfItem() {
  const enc = new TextEncoder();
  const page1 = zlibSync(enc.encode('BT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET'));
  const page2 = zlibSync(enc.encode('BT /F1 12 Tf 72 700 Td (Second page text) Tj ET'));
  const toLatin1 = (value) => [...value].map((char) => String.fromCharCode(char & 0xff)).join('');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Annots [7 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R >>',
    `<< /Length ${page1.length} /Filter /FlateDecode >>\nstream\n${toLatin1(page1)}\nendstream`,
    `<< /Length ${page2.length} /Filter /FlateDecode >>\nstream\n${toLatin1(page2)}\nendstream`,
    '<< /Type /Annot /Subtype /Link /A << /S /URI /URI (https://example.com/report) >> >>',
    '<< /Title (Sample Report) /Author (Inspect This) /Producer (Test Suite) >>'
  ];
  const parts = [latin1Bytes('%PDF-1.4\n')];
  const offsets = [0];
  objects.forEach((obj, index) => {
    offsets.push(parts.reduce((acc, part) => acc + part.length, 0));
    parts.push(latin1Bytes(`${index + 1} 0 obj\n${obj}\nendobj\n`));
  });
  const xrefStart = parts.reduce((acc, part) => acc + part.length, 0);
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (let index = 1; index <= objects.length; index += 1) {
    xref += offsets[index].toString().padStart(10, '0') + ' 00000 n \n';
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 8 0 R /ID [<28F7E8A2B3C4D5E6F7A8B9C0D1E2F3A4> <28F7E8A2B3C4D5E6F7A8B9C0D1E2F3A4>] >>\nstartxref\n${xrefStart}\n%%EOF`;
  parts.push(latin1Bytes(xref));
  return toItem('sample.pdf', concatBytes(parts), 'application/pdf');
}

export async function makeHexPdfItem() {
  const enc = new TextEncoder();
  // Hex-encoded string (<48656C6C6F> = "Hello") plus a literal string on a new
  // line, exercising both the pdfjs path and the regex fallback extractor.
  const page1 = zlibSync(enc.encode('BT /F1 12 Tf 72 720 Td <48656C6C6F> Tj 0 -18 Td (World) Tj ET'));
  const toLatin1 = (value) => [...value].map((char) => String.fromCharCode(char & 0xff)).join('');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    `<< /Length ${page1.length} /Filter /FlateDecode >>\nstream\n${toLatin1(page1)}\nendstream`,
    '<< /Title (Hex Report) /Author (Fixture) >>'
  ];
  const parts = [latin1Bytes('%PDF-1.4\n')];
  const offsets = [0];
  objects.forEach((obj, index) => {
    offsets.push(parts.reduce((acc, part) => acc + part.length, 0));
    parts.push(latin1Bytes(`${index + 1} 0 obj\n${obj}\nendobj\n`));
  });
  const xrefStart = parts.reduce((acc, part) => acc + part.length, 0);
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (let index = 1; index <= objects.length; index += 1) {
    xref += offsets[index].toString().padStart(10, '0') + ' 00000 n \n';
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  parts.push(latin1Bytes(xref));
  return toItem('hex.pdf', concatBytes(parts), 'application/pdf');
}
// Minimal JPEG: SOI + APP1/Exif + SOF0 (so the header parser sees dimensions)
// + EOI. Used to exercise EXIF extraction without shipping a large binary.
export function makeExifJpegItem(name = 'photo.jpg') {
  const tiff = [];
  const push8 = (value) => tiff.push(value & 0xff);
  const push16 = (value) => tiff.push(value & 0xff, (value >> 8) & 0xff);
  const push32 = (value) => tiff.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff);
  const ascii = (value) => [...value].map((char) => char.charCodeAt(0));
  // TIFF header: little-endian ("II"), magic 42, IFD0 at offset 8.
  push8(0x49); push8(0x49); push16(0x2a); push32(8);
  const ifd0Start = tiff.length; // 8
  push16(4); // IFD0 entry count
  const make = ascii('Test\0');
  const model = ascii('Camera\0');
  const dateTime = ascii('2023:01:02 03:04:05\0');
  // IFD0 size = count(2) + 4 entries * 12 + next(4) = 54 bytes.
  const dataStart = ifd0Start + 54;
  const makeOffset = dataStart;
  const modelOffset = makeOffset + make.length;
  const dateTimeOffset = modelOffset + model.length;
  const gpsIfdOffset = dateTimeOffset + dateTime.length;
  const entry = (tag, type, count, value, inline) => {
    push16(tag); push16(type); push32(count);
    if (inline) {
      for (let i = 0; i < 4; i += 1) push8(value[i] ?? 0);
    } else {
      push32(value);
    }
  };
  entry(0x010f, 2, make.length, makeOffset, false);    // Make
  entry(0x0110, 2, model.length, modelOffset, false);  // Model
  entry(0x0132, 2, dateTime.length, dateTimeOffset, false); // DateTime
  entry(0x8825, 4, 1, gpsIfdOffset, false);            // GPS IFD pointer
  push32(0); // next IFD
  for (const value of make) push8(value);
  for (const value of model) push8(value);
  for (const value of dateTime) push8(value);
  if (tiff.length % 2 !== 0) push8(0);
  // GPS IFD: LatRef, Lat, LonRef, Lon.
  const gpsDataStart = gpsIfdOffset + 2 + 4 * 12 + 4;
  const latDataOffset = gpsDataStart;
  const lonDataOffset = gpsDataStart + 24;
  push16(4);
  entry(0x0001, 2, 2, [78, 0, 0, 0], true); // 'N'
  entry(0x0002, 5, 3, latDataOffset, false);
  entry(0x0003, 2, 2, [69, 0, 0, 0], true); // 'E'
  entry(0x0004, 5, 3, lonDataOffset, false);
  push32(0); // next IFD
  // Rationals: latitude 52 13 47, longitude 21 0 44 (degrees minutes seconds).
  for (const numerator of [52, 13, 47, 21, 0, 44]) {
    push32(numerator);
    push32(1);
  }
  // JPEG: SOI + APP1/Exif + SOF0 (1x1 so the header parser sees dimensions) + EOI.
  const exifHeader = ascii('Exif\0\0');
  const app1Length = 2 + exifHeader.length + tiff.length;
  const out = [0xff, 0xd8, 0xff, 0xe1, (app1Length >> 8) & 0xff, app1Length & 0xff, ...exifHeader, ...tiff];
  out.push(0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00);
  out.push(0xff, 0xd9);
  return toItem(name, Uint8Array.from(out), 'image/jpeg');
}

export function makeOcrTextItem(name = 'ocr-text.png', text = 'HELLO WORLD', scale = 10) {
  const { bytes } = renderTextPng(text, { scale, pad: 24 });
  return toItem(name, bytes, 'image/png');
}

function buildImagePdfItem(imageBytes, width, height, name, filter = null, streamBytes = imageBytes) {
  // Builds a single-page PDF whose page renders one image XObject. `filter` is
  // the optional PDF filter name (e.g. /DCTDecode); when null the stream is
  // stored raw. `streamBytes` is what goes into the stream. Used for the
  // scanned-PDF OCR fixtures.
  const toLatin1 = (value) => [...value].map((char) => String.fromCharCode(char & 0xff)).join('');
  const filterPart = filter ? ` /Filter ${filter}` : '';
  const imageStream = `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8${filterPart} /Length ${streamBytes.length} >>\nstream\n`;
  const content = `q ${width} 0 0 ${height} 0 0 cm /Im1 Do Q`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>`,
    imageStream + toLatin1(Buffer.from(streamBytes)) + '\nendstream',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ];
  const parts = [latin1Bytes('%PDF-1.4\n')];
  const offsets = [0];
  objects.forEach((obj, index) => {
    offsets.push(parts.reduce((acc, part) => acc + part.length, 0));
    parts.push(latin1Bytes(`${index + 1} 0 obj\n${obj}\nendobj\n`));
  });
  const xrefStart = parts.reduce((acc, part) => acc + part.length, 0);
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (let index = 1; index <= objects.length; index += 1) {
    xref += offsets[index].toString().padStart(10, '0') + ' 00000 n \n';
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  parts.push(latin1Bytes(xref));
  return toItem(name, concatBytes(parts), 'application/pdf');
}

/**
 * A scanned PDF whose page image is a PNG stored uncompressed in the image
 * stream. PNG decoding is uniform across every tesseract.js-core WASM variant,
 * so this is the deterministic scanned-PDF OCR fixture. The stream is NOT
 * zlib-compressed so the deterministic path never depends on deflate
 * decompression (which proved environment-sensitive in CI); the extractor
 * detects the PNG by its magic bytes.
 */
export function makeScannedPdfItem() {
  const { bytes: png, width, height } = renderTextPng('HELLO WORLD', { scale: 12, pad: 24 });
  return buildImagePdfItem(png, width, height, 'scanned.pdf', null, png);
}

/** A scanned PDF whose page image is a JPEG (DCTDecode), like real scanners. */
export function makeJpegScannedPdfItem() {
  const { data, width, height } = renderTextRgba('HELLO WORLD', { scale: 12, pad: 24 });
  const jpeg = Buffer.from(encodeJpeg({ data: Buffer.from(data), width, height }, 92).data);
  return buildImagePdfItem(jpeg, width, height, 'scanned-jpeg.pdf', '/DCTDecode', jpeg);
}

export function makeCorruptScannedPdfItem() {
  // A scanned PDF whose "JPEG" page image is corrupt: it starts with the JPEG
  // SOI marker (FFD8) but is otherwise garbage. The OCR path must attempt it,
  // fail to decode it, and report the degraded state honestly - never
  // fabricating text.
  const garbage = new Uint8Array(2 + 1024);
  garbage[0] = 0xff;
  garbage[1] = 0xd8;
  for (let index = 2; index < garbage.length; index += 1) garbage[index] = 0xab;
  return buildImagePdfItem(garbage, 64, 64, 'corrupt-scan.pdf', '/DCTDecode', garbage);
}

export function makeInvalidPdfItem() {
  const bytes = new Uint8Array(512);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 13) % 256;
  return toItem('broken.pdf', bytes, 'application/pdf');
}

function coreProps(title, creator) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
<dc:title>${title}</dc:title><dc:creator>${creator}</dc:creator><cp:lastModifiedBy>Inspector</cp:lastModifiedBy></cp:coreProperties>`;
}

function contentTypesXml(parts) {
  const defaults = new Set(parts.map((part) => part.split('.').pop()));
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`;
  for (const ext of defaults) {
    xml += `<Default Extension="${ext}" ContentType="application/octet-stream"/>`;
  }
  xml += '</Types>';
  return xml;
}

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54,
  0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01,
  0xe5, 0x27, 0xd4, 0xa8, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
]);

export async function makeDocxItem() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypesXml(['xml', 'rels', 'png']));
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Main Title</w:t></w:r></w:p>
<w:p><w:r><w:t>Regular paragraph text.</w:t></w:r></w:p>
<w:p><w:r><w:vanish/><w:t>Hidden note</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/docs" TargetMode="External"/></Relationships>`);
  zip.file('word/comments.xml', `<?xml version="1.0" encoding="UTF-8"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="1" w:author="Reviewer"><w:p><w:r><w:t>Check this</w:t></w:r></w:p></w:comment></w:comments>`);
  zip.file('word/media/image1.png', PNG_BYTES);
  zip.file('docProps/core.xml', coreProps('Sample Document', 'Alice'));
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return toItem('sample.docx', bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

export async function makePptxItem() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypesXml(['xml', 'rels', 'png']));
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId4"/></p:sldIdLst></p:presentation>`);
  zip.file('ppt/slides/slide1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Welcome Slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  zip.file('ppt/slides/slide2.xml', `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Second Slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  zip.file('ppt/slides/slide3.xml', `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>`);
  zip.file('ppt/notesSlides/notesSlide1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:notes>`);
  zip.file('ppt/media/image1.png', PNG_BYTES);
  zip.file('docProps/core.xml', coreProps('Sample Deck', 'Bob'));
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return toItem('sample.pptx', bytes, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
}

export async function makeXlsxItem() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypesXml(['xml', 'rels']));
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="Data" sheetId="1" r:id="rId1"/>
<sheet name="HiddenSheet" sheetId="2" state="hidden" r:id="rId2"/>
</sheets>
<definedNames><definedName name="MyRange">Data!$A$1:$A$5</definedName></definedNames>
</workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`);
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:D4"/>
<cols><col min="1" max="1" width="12" hidden="1"/></cols>
<sheetData>
<row r="1"><c r="A1"><v>10</v></c><c r="B1"><f>SUM(A1:A3)</f><v>15</v></c><c r="C1" t="e"><v>#DIV/0!</v></c><c r="D1" t="inlineStr"><is><t>hello</t></is></c></row>
<row r="2" hidden="1"><c r="A2"><v>20</v></c><c r="B2"><v>5</v></c></row>
<row r="3"><c r="A3"><v>30</v></c><c r="B3"><v>7</v></c></row>
<row r="4"><c r="A4"><v>30</v></c><c r="B4"><v>7</v></c></row>
</sheetData>
<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>
</worksheet>`);
  zip.file('xl/worksheets/sheet2.xml', `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B1"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`);
  zip.file('xl/externalLinks/externalLink1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><externalBook r:id="rId1"/></externalLink>`);
  zip.file('docProps/core.xml', coreProps('Sales Workbook', 'Carol'));
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return toItem('sample.xlsx', bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

export function makeEmlItem() {
  const eml = [
    'From: Alice <alice@example.com>',
    'To: Bob <bob@example.org>',
    'Cc: Carol <carol@example.net>',
    'Subject: =?utf-8?B?SGVsbG8gd29ybGQ=?=',
    'Date: Mon, 12 Aug 2024 10:00:00 +0200',
    'Message-ID: <abc123@example.com>',
    'Reply-To: Alice <alice@example.com>',
    'Return-Path: <alice@example.com>',
    'DKIM-Signature: v=1; a=rsa-sha256; d=example.com',
    'Received-SPF: pass (example.com: domain of alice@example.com)',
    'Content-Type: multipart/mixed; boundary="BOUNDARY123"',
    'MIME-Version: 1.0',
    '',
    '--BOUNDARY123',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    'Hello Bob,',
    'Please find the report attached.',
    '--BOUNDARY123',
    'Content-Type: text/html; charset="utf-8"',
    '',
    '<html><body><p>Hello Bob,</p><a href="https://example.com/report">Report</a></body></html>',
    '--BOUNDARY123',
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    '',
    '%PDF-1.4 fake attachment bytes',
    '--BOUNDARY123--',
    ''
  ].join('\r\n');
  return toItem('mail.eml', new TextEncoder().encode(eml), 'message/rfc822');
}

export async function makeEpubItem() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Sample Ebook</dc:title><dc:creator>Jane Author</dc:creator><dc:language>en</dc:language><dc:identifier id="bookid">urn:isbn:1234567890</dc:identifier></metadata><manifest><item id="chap1" href="chap1.xhtml" media-type="application/xhtml+xml"/><item id="chap2" href="chap2.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="cover.png" media-type="image/png"/><item id="css" href="style.css" media-type="text/css"/></manifest><spine><itemref idref="chap1"/><itemref idref="chap2"/></spine></package>');
  zip.file('OEBPS/chap1.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter One</title></head><body><p>Once upon a time there was a brave knight.</p></body></html>');
  zip.file('OEBPS/chap2.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter Two</title></head><body><p>The dragon slept beneath the mountain.</p></body></html>');
  zip.file('OEBPS/cover.png', PNG_BYTES);
  zip.file('OEBPS/style.css', 'body { font-family: serif; }');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return toItem('book.epub', bytes, 'application/epub+zip');
}

export function makeLegacyXlsItem() {
  return toItem('legacy.xls', Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]), 'application/vnd.ms-excel');
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

export async function makeSqliteItem() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT);');
  db.run('CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), total REAL);');
  db.run('CREATE INDEX idx_users_name ON users(name);');
  db.run("INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com'), ('Bob', NULL), ('Alice', 'alice@example.com');");
  db.run('INSERT INTO orders (user_id, total) VALUES (1, 10.5), (1, 20.0), (2, NULL), (2, 5.0), (NULL, 99.0);');
  const bytes = db.export();
  db.close();
  return toItem('sample.sqlite', bytes, 'application/vnd.sqlite3');
}

export function makeInvalidSqliteItem() {
  return toItem('broken.sqlite', new TextEncoder().encode('this is not a sqlite database at all'), 'application/vnd.sqlite3');
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export function makeWavItem() {
  const sampleRate = 44100;
  const channels = 2;
  const bits = 16;
  const duration = 0.25;
  const dataSize = Math.floor(sampleRate * duration) * channels * (bits / 8);
  const byteRate = sampleRate * channels * (bits / 8);
  const header = new Uint8Array(44);
  const enc = new TextEncoder();
  header.set(enc.encode('RIFF'), 0);
  new DataView(header.buffer).setUint32(4, 36 + dataSize, true);
  header.set(enc.encode('WAVE'), 8);
  header.set(enc.encode('fmt '), 12);
  new DataView(header.buffer).setUint32(16, 16, true);
  new DataView(header.buffer).setUint16(20, 1, true);
  new DataView(header.buffer).setUint16(22, channels, true);
  new DataView(header.buffer).setUint32(24, sampleRate, true);
  new DataView(header.buffer).setUint32(28, byteRate, true);
  new DataView(header.buffer).setUint16(32, channels * (bits / 8), true);
  new DataView(header.buffer).setUint16(34, bits, true);
  header.set(enc.encode('data'), 36);
  new DataView(header.buffer).setUint32(40, dataSize, true);
  const bytes = concatBytes([header, new Uint8Array(dataSize)]);
  return toItem('sample.wav', bytes, 'audio/wav');
}

function syncsafe(value) {
  return [
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f
  ];
}

function id3Frame(id, text) {
  const payload = new TextEncoder().encode('\x03' + text);
  const frame = new Uint8Array(10 + payload.length);
  const enc = new TextEncoder();
  frame.set(enc.encode(id), 0);
  new DataView(frame.buffer).setUint32(4, payload.length, false);
  frame.set(payload, 10);
  return frame;
}

export function makeMp3Item() {
  const frames = [
    id3Frame('TIT2', 'Test Title'),
    id3Frame('TPE1', 'Test Artist'),
    id3Frame('TALB', 'Test Album')
  ];
  const tagPayload = concatBytes(frames);
  const tag = new Uint8Array(10 + tagPayload.length);
  const enc = new TextEncoder();
  tag.set(enc.encode('ID3'), 0);
  tag[3] = 4; tag[4] = 0; tag[5] = 0;
  tag.set(syncsafe(tagPayload.length), 6);
  tag.set(tagPayload, 10);
  const mpeg = new Uint8Array(4 + 417);
  mpeg[0] = 0xff; mpeg[1] = 0xfb; mpeg[2] = 0x90; mpeg[3] = 0x00;
  return toItem('sample.mp3', concatBytes([tag, mpeg]), 'audio/mpeg');
}

export function makeFlacItem() {
  const streaminfo = new Uint8Array(34);
  const view = new DataView(streaminfo.buffer);
  view.setUint16(0, 0x1000, false); // min blocksize
  view.setUint16(2, 0x1000, false); // max blocksize
  // bytes 4-6 min frame size 0, bytes 7-9 max frame size 0
  // STREAMINFO starts at file offset 8; the packed sample-rate/channels/bps/total
  // field occupies streaminfo[10..17] (file[18..25]).
  streaminfo[10] = 0x0a; // sample rate top bits (44100 = 0x0AC44)
  streaminfo[11] = 0xc4; // sample rate
  streaminfo[12] = 0x42; // sample rate low nibble + channels(2) + bps bit
  streaminfo[13] = 0xf0; // bps + total samples top nibble
  streaminfo[16] = 0xac;
  streaminfo[17] = 0x44;
  const header = new Uint8Array(4);
  header[0] = 0x80; // last metadata block, type 0 (streaminfo)
  header[1] = 0; header[2] = 0; header[3] = 34; // 24-bit length
  const bytes = concatBytes([new TextEncoder().encode('fLaC'), header, streaminfo]);
  return toItem('sample.flac', bytes, 'audio/flac');
}

function box(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, 8 + payload.length, false);
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  return out;
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

export function makeMp4Item() {
  const ftyp = box('ftyp', concatBytes([
    new TextEncoder().encode('isom'),
    u32(0),
    new TextEncoder().encode('isom'),
    new TextEncoder().encode('mp42')
  ]));
  const mvhdPayload = new Uint8Array(100);
  const mvhdView = new DataView(mvhdPayload.buffer);
  mvhdView.setUint32(4, 0, false); // creation
  mvhdView.setUint32(8, 0, false); // modification
  mvhdView.setUint32(12, 1000, false); // timescale
  mvhdView.setUint32(16, 5000, false); // duration -> 5 seconds
  const mvhd = box('mvhd', mvhdPayload);
  const tkhdPayload = new Uint8Array(84);
  const tkhdView = new DataView(tkhdPayload.buffer);
  tkhdView.setUint32(8, 1, false); // track id
  tkhdView.setUint32(16, 5000, false); // duration
  tkhdView.setUint32(76, 1920 << 16, false); // width 16.16 fixed
  tkhdView.setUint32(80, 1080 << 16, false); // height
  const tkhd = box('tkhd', tkhdPayload);
  const trak = box('trak', concatBytes([tkhd]));
  const moov = box('moov', concatBytes([mvhd, trak]));
  const mdat = box('mdat', new Uint8Array(64));
  return toItem('sample.mp4', concatBytes([ftyp, moov, mdat]), 'video/mp4');
}

export function makeWebMItem() {
  const bytes = concatBytes([
    Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]),
    new TextEncoder().encode('webm container test')
  ]);
  return toItem('sample.webm', bytes, 'video/webm');
}

// ---------------------------------------------------------------------------
// Code / manifests / logs
// ---------------------------------------------------------------------------

export function makeTypeScriptItem() {
  return textItem('app.ts', `import { readFile } from 'node:fs';
import { join } from 'node:path';

interface Options { verbose: boolean }

export class Runner {
  count = 0;
  run(): void {
    const options: Options = { verbose: true };
    // TODO: handle edge cases
    this.count += 1;
  }
}

export function main(): void {
  const runner = new Runner();
  runner.run();
}
`, 'text/typescript');
}

export function makePythonItem() {
  return textItem('module.py', `import os
import sys

class Widget:
    def __init__(self, name):
        self.name = name

def helper(value):
    return value * 2

def main():
    # FIXME: refactor this
    print(helper(21))
`, 'text/x-python');
}

export function makePackageJsonItem() {
  return textItem('package.json', JSON.stringify({
    name: 'demo',
    version: '1.0.0',
    dependencies: { lodash: '^4.17.21', react: '^18.0.0' },
    devDependencies: { typescript: '^5.0.0' }
  }, null, 2), 'application/json');
}

export function makeRequirementsItem() {
  return textItem('requirements.txt', 'flask==2.3.0\nrequests>=2.28\n# comment line\nnumpy', 'text/plain');
}

export function makeLogItem() {
  return textItem('app.log', [
    '2024-01-15 10:00:01 INFO request_id=abc123 service=api started',
    '2024-01-15 10:00:02 ERROR request_id=abc123 service=api ConnectionTimeout',
    '2024-01-15 10:00:03 WARN request_id=abc123 service=api retrying',
    '2024-01-15 10:00:04 ERROR request_id=def456 service=api ConnectionTimeout',
    '2024-01-15 10:00:05 ERROR request_id=ghi789 service=api ConnectionTimeout',
    '2024-01-15 10:00:06 ERROR request_id=def456 service=api ConnectionTimeout',
    '2024-01-15 10:00:07 ERROR request_id=ghi789 service=api ConnectionTimeout',
    '2024-01-15 10:00:08 ERROR request_id=def456 service=api ConnectionTimeout',
    '2024-01-15 10:00:09 ERROR request_id=ghi789 service=api ConnectionTimeout',
    '2024-01-15 10:00:10 ERROR request_id=def456 service=api ConnectionTimeout',
    '2024-01-15 10:00:11 ERROR request_id=ghi789 service=api ConnectionTimeout',
    '2024-01-15 10:00:12 ERROR service=api boom',
    '    at Object.<anonymous> (/app/src/index.js:1:1)',
    '    at Module._compile (node:internal/modules/cjs/loader.js:1:1)'
  ].join('\n'), 'text/plain');
}

// ---------------------------------------------------------------------------
// Git repository (synthetic)
// ---------------------------------------------------------------------------

export function makeGitFolderItem() {
  const head = new File(['ref: refs/heads/main'], 'HEAD', { type: 'text/plain', lastModified: 1_700_000_000_000 });
  const mainRef = new File(['a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'], 'main', { type: 'text/plain', lastModified: 1_700_000_000_000 });
  const featureRef = new File(['b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3'], 'feature', { type: 'text/plain', lastModified: 1_700_000_000_000 });
  const logHead = new File([[
'0000000000000000000000000000000000000000 a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 Alice <alice@example.com> 1700000000 +0100\tInitial commit',
'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 1111111111111111111111111111111111111111 Bob <bob@example.com> 1700000100 +0100\tAdd feature',
'1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 Alice <alice@example.com> 1700000200 +0100\tFix bug'
  ].join('\n')], 'HEAD', { type: 'text/plain', lastModified: 1_700_000_000_000 });
  const logMain = new File([[
    '0000000000000000000000000000000000000000 a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 Alice <alice@example.com> 1700000000 +0100\tInitial commit',
    'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 1111111111111111111111111111111111111111 Bob <bob@example.com> 1700000100 +0100\tAdd feature'  ].join('\n')], 'HEAD', { type: 'text/plain', lastModified: 1_700_000_000_000 });
  const logFeature = new File([[
    '0000000000000000000000000000000000000000 b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3 Eve <eve@example.com> 1700000300 +0100\tStart feature'  ].join('\n')], 'HEAD', { type: 'text/plain', lastModified: 1_700_000_000_000 });
  const source = new File(['export function ping() { return "pong"; }'], 'src/ping.ts', { type: 'text/typescript', lastModified: 1_700_000_000_000 });

  const refsFolder = {
    kind: 'folder',
    name: 'heads',
    path: 'sample/.git/refs/heads',
    children: [
      { kind: 'file', name: 'main', path: 'sample/.git/refs/heads/main', size: mainRef.size, lastModified: mainRef.lastModified, mimeType: 'text/plain', file: mainRef },
      { kind: 'file', name: 'feature', path: 'sample/.git/refs/heads/feature', size: featureRef.size, lastModified: featureRef.lastModified, mimeType: 'text/plain', file: featureRef }
    ]
  };
  const refsFolderParent = {
    kind: 'folder',
    name: 'refs',
    path: 'sample/.git/refs',
    children: [refsFolder]
  };
  const logsRefsFolder = {
    kind: 'folder',
    name: 'heads',
    path: 'sample/.git/logs/refs/heads',
    children: [
      { kind: 'file', name: 'main', path: 'sample/.git/logs/refs/heads/main', size: logMain.size, lastModified: logMain.lastModified, mimeType: 'text/plain', file: logMain },
      { kind: 'file', name: 'feature', path: 'sample/.git/logs/refs/heads/feature', size: logFeature.size, lastModified: logFeature.lastModified, mimeType: 'text/plain', file: logFeature }
    ]
  };
  const logsFolder = {
    kind: 'folder',
    name: 'logs',
    path: 'sample/.git/logs',
    children: [
      { kind: 'file', name: 'HEAD', path: 'sample/.git/logs/HEAD', size: logHead.size, lastModified: logHead.lastModified, mimeType: 'text/plain', file: logHead },
      logsRefsFolder
    ]
  };
  const gitFolder = {
    kind: 'folder',
    name: '.git',
    path: 'sample/.git',
    children: [
      { kind: 'file', name: 'HEAD', path: 'sample/.git/HEAD', size: head.size, lastModified: head.lastModified, mimeType: 'text/plain', file: head },
      refsFolderParent,
      logsFolder
    ]
  };
  return {
    kind: 'folder',
    name: 'sample',
    path: 'sample',
    children: [
      gitFolder,
      { kind: 'file', name: 'ping.ts', path: 'sample/src/ping.ts', size: source.size, lastModified: source.lastModified, mimeType: 'text/typescript', file: source }
    ]
  };
}

// ---------------------------------------------------------------------------
// Malformed inputs
// ---------------------------------------------------------------------------

export function makeTruncatedZipItem() {
  const bytes = new Uint8Array(2048);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 7) % 251;
  return toItem('corrupt.zip', bytes, 'application/zip');
}

export function makeCorruptGzipItem() {
  return toItem('corrupt.gz', new TextEncoder().encode('not gzip at all'), 'application/gzip');
}

export function makeRandomBinItem() {
  const bytes = new Uint8Array(256);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31) % 256;
  return toItem('mystery.bin', bytes, 'application/octet-stream');
}

export function makeRichCsvItem() {
  return textItem('rich.csv', [
    'id,name,alias,city,email',
    '1,Alice,Alice,NYC,alice@example.com',
    '1,Alice,Alice,NYC,alice@example.com',
    '2,Bob,Bob,LA,bob@example.com',
    '3,Carol,Carol,NYC,carol@example.com',
    '4,Dave,Dave,NYC,dave@example.com',
    '5,Eve,Eve,NYC,eve@example.com'
  ].join('\n'), 'text/csv');
}

export function makeDuplicateFolderItem() {
  const dup = new File(['same content'], 'dup.txt', { type: 'text/plain', lastModified: 1_700_000_000_000 });
  const unique = new File(['unique'], 'unique.txt', { type: 'text/plain', lastModified: 1_700_000_000_000 });
  return {
    kind: 'folder',
    name: 'dups',
    path: 'dups',
    children: [
      { kind: 'file', name: 'dup.txt', path: 'dups/a/dup.txt', size: dup.size, lastModified: dup.lastModified, mimeType: 'text/plain', file: dup },
      { kind: 'file', name: 'dup.txt', path: 'dups/b/dup.txt', size: dup.size, lastModified: dup.lastModified, mimeType: 'text/plain', file: dup },
      { kind: 'file', name: 'unique.txt', path: 'dups/unique.txt', size: unique.size, lastModified: unique.lastModified, mimeType: 'text/plain', file: unique }
    ]
  };
}

export function makeEmptyTextItem() {
  return textItem('empty.txt', '', 'text/plain');
}

// ---------------------------------------------------------------------------
// Mock web server for website analyzer tests (no external network needed)
// ---------------------------------------------------------------------------

import http from 'node:http';

export async function startMockWebServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /private');
      return;
    }
    if (url.pathname === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/</loc></url></urlset>');
      return;
    }
    if (url.pathname === '/data.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"hello":"world","count":3}');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'",
      'x-content-type-options': 'nosniff'
    });
    res.end(`<!doctype html>
<html lang="en">
<head><title>Test Site</title>
<meta name="description" content="A test page">
<link rel="canonical" href="https://example.com/"></head>
<body>
<h1>Welcome</h1>
<h2>Sub Heading</h2>
<a href="/page2">Page 2</a>
<a href="https://external.example/x">External</a>
<img src="/img.png" alt="img">
<script src="/app.js"></script>
</body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    port: address.port,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export function urlItem(url) {
  const parsed = new URL(url);
  return {
    kind: 'url',
    name: parsed.hostname,
    path: url,
    url
  };
}

// ---------------------------------------------------------------------------
// Milestone 03 fixtures: deep analysis
// ---------------------------------------------------------------------------

// Minimal PNG encoder (RGBA, 8-bit) for deterministic image fixtures.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.slice(4, 8 + data.length)), false);
  return out;
}

export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const idat = zlibSync(raw);
  return concatBytes([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', new Uint8Array(0))
  ]);
}

function makePattern(size, seed = 1) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  const last = Math.max(size - 1, 1);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      // Smooth gradient so adjacent pixels differ slightly (dHash-friendly).
      const horizontal = (x * 255) / last;
      const vertical = (y * 160) / last;
      rgba[index] = Math.round((horizontal + vertical) % 255);
      rgba[index + 1] = Math.round(horizontal);
      rgba[index + 2] = Math.round(255 - horizontal);
      rgba[index + 3] = 255;
      // A distinguishing feature for other seeds.
      if (seed === 7 && x < size / 2 && y < size / 2) {
        rgba[index] = 10;
        rgba[index + 1] = 200;
        rgba[index + 2] = 40;
      }
    }
  }
  return rgba;
}

export function makePatternPngItem(name = 'pattern-a.png', size = 16, seed = 1) {
  const bytes = encodePng(size, size, makePattern(size, seed));
  return toItem(name, bytes, 'image/png');
}

function downscale(rgba, width, height, target) {
  const out = new Uint8ClampedArray(target * target * 4);
  const scale = width / target;
  for (let y = 0; y < target; y += 1) {
    for (let x = 0; x < target; x += 1) {
      const x0 = Math.floor(x * scale);
      const y0 = Math.floor(y * scale);
      const x1 = Math.min(width - 1, Math.floor((x + 1) * scale));
      const y1 = Math.min(height - 1, Math.floor((y + 1) * scale));
      const dst = (y * target + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        let sum = 0;
        let count = 0;
        for (let sy = y0; sy <= y1; sy += 1) {
          for (let sx = x0; sx <= x1; sx += 1) {
            sum += rgba[(sy * width + sx) * 4 + c];
            count += 1;
          }
        }
        out[dst + c] = count ? sum / count : 0;
      }
    }
  }
  return out;
}

export function makeTextLikePngItem(name = 'document.png') {
  // White background with rows of dark "text line" strokes so pixel analysis
  // classifies it as document/screenshot-like (high contrast, edge-rich).
  const width = 480;
  const height = 160;
  const rgba = new Uint8ClampedArray(width * height * 4);
  rgba.fill(255); // white background
  const rows = 8;
  const gap = Math.floor(height / (rows + 1));
  for (let row = 1; row <= rows; row += 1) {
    const baseline = row * gap;
    const lineHeight = 4;
    const segments = 3 + (row % 3);
    for (let segment = 0; segment < segments; segment += 1) {
      const startX = 24 + segment * 140;
      const length = 90 + (segment % 2) * 40;
      for (let y = baseline; y < baseline + lineHeight; y += 1) {
        for (let x = startX; x < startX + length; x += 1) {
          if (x < width && y < height) {
            const index = (y * width + x) * 4;
            rgba[index] = 20;
            rgba[index + 1] = 20;
            rgba[index + 2] = 20;
          }
        }
      }
    }
  }
  return toItem(name, encodePng(width, height, rgba), 'image/png');
}

export function makePatternPngResizedItem(name = 'pattern-b.png', seed = 1) {
  // 9x9 matches the dHash grid, so resizing is a near-identity operation.
  const original = makePattern(16, seed);
  const bytes = encodePng(9, 9, downscale(original, 16, 16, 9));
  return toItem(name, bytes, 'image/png');
}

export function makeDeepCsvItem() {
  const rows = ['id,category,score,status,note'];
  for (let index = 1; index <= 30; index += 1) {
    // score is highly skewed: mostly small, a few huge values.
    const score = index % 5 === 0 ? 1000 + index * 50 : 1 + (index % 4);
    // category is nearly constant (28/30 share one value).
    const category = index % 15 === 0 ? 'rare' : 'common';
    // status is duplicate-heavy (only 2 values).
    const status = index % 2 === 0 ? 'ok' : 'pending';
    // note is mostly empty.
    const note = index % 4 === 0 ? 'see ticket' : '';
    rows.push(`${index},${category},${score},${status},${note}`);
  }
  return textItem('deep.csv', rows.join('\n'), 'text/csv');
}

export function makeComplexCodeItem() {
  return textItem('complex.ts', `export function processData(items: number[]): number {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const value = items[i];
    if (value > 100) {
      if (value > 500) {
        if (value > 1000) {
          total += value * 2;
        } else {
          total += value;
        }
      } else if (value % 2 === 0) {
        total += value / 2;
      } else {
        total -= value;
      }
    } else if (value < 0) {
      for (let j = 0; j < 3; j++) {
        total -= j;
      }
    } else {
      switch (value % 3) {
        case 0: total += 1; break;
        case 1: total += 2; break;
        default: total += 3; break;
      }
    }
    total = value > 50 && value < 200 ? total * 2 : total;
  }
  return total;
}
`, 'text/typescript');
}

export function makeProjectWithManifests() {
  const appPkg = new File([JSON.stringify({
    name: 'app',
    dependencies: { lodash: '^4.17.21', react: '^18.0.0' }
  }, null, 2)], 'package.json', { type: 'application/json', lastModified: 1_700_000_000_000 });
  const toolPkg = new File([JSON.stringify({
    name: 'tools',
    dependencies: { lodash: '^3.10.1' }
  }, null, 2)], 'package.json', { type: 'application/json', lastModified: 1_700_000_000_000 });
  const req = new File(['numpy==1.24.0\npandas'], 'requirements.txt', { type: 'text/plain', lastModified: 1_700_000_000_000 });
  const aTs = new File(['import { helper } from \'./b\';\nexport const x = helper();'], 'a.ts', { type: 'text/typescript', lastModified: 1_700_000_000_000 });
  const bTs = new File(['export function helper() { return 1; }'], 'b.ts', { type: 'text/typescript', lastModified: 1_700_000_000_000 });
  return {
    kind: 'folder',
    name: 'project',
    path: 'project',
    children: [
      { kind: 'file', name: 'package.json', path: 'project/app/package.json', size: appPkg.size, lastModified: appPkg.lastModified, mimeType: 'application/json', file: appPkg },
      { kind: 'file', name: 'package.json', path: 'project/tools/package.json', size: toolPkg.size, lastModified: toolPkg.lastModified, mimeType: 'application/json', file: toolPkg },
      { kind: 'file', name: 'requirements.txt', path: 'project/requirements.txt', size: req.size, lastModified: req.lastModified, mimeType: 'text/plain', file: req },
      { kind: 'file', name: 'a.ts', path: 'project/src/a.ts', size: aTs.size, lastModified: aTs.lastModified, mimeType: 'text/typescript', file: aTs },
      { kind: 'file', name: 'b.ts', path: 'project/src/b.ts', size: bTs.size, lastModified: bTs.lastModified, mimeType: 'text/typescript', file: bTs }
    ]
  };
}

export function makeLogSpikeItem() {
  const lines = [];
  // 40 buckets of 100 lines; bucket 6 carries 30 errors, others carry 1.
  for (let bucket = 0; bucket < 40; bucket += 1) {
    const errors = bucket === 6 ? 30 : 1;
    for (let i = 0; i < errors; i += 1) {
      lines.push(`2024-01-15 10:0${bucket}:0${i % 10} ERROR request_id=req${bucket}${i} ConnectionTimeout`);
    }
    while (lines.length < (bucket + 1) * 100) {
      lines.push(`2024-01-15 10:0${bucket}:59 INFO heartbeat message ${lines.length}`);
    }
  }
  return textItem('spike.log', lines.join('\n'), 'text/plain');
}

export function makeXlsxDeepItem() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypesXml(['xml', 'rels']));
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:C6"/>
<sheetData>
<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>SUM(C1:C6)</f><v>30</v></c><c r="C1"><v>10</v></c></row>
<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f>AVERAGE(C1:C6)</f><v>5</v></c><c r="C2"><v>10</v></c></row>
<row r="3"><c r="A3"><v>3</v></c><c r="B3"><f>SUM(C1:C6)</f><v>30</v></c><c r="C3"><v>10</v></c></row>
<row r="4"><c r="A4"><v>4</v></c><c r="B4"><f>AVERAGE(C1:C6)</f><v>5</v></c><c r="C4"><v>10</v></c></row>
<row r="5"><c r="A5"><v>5</v></c><c r="B5"><f>SUM(C1:C6)</f><v>30</v></c><c r="C5"><v>10</v></c></row>
<row r="6"><c r="A6"><v>6</v></c><c r="B6"><f>SUM(C1:C6)</f><v>30</v></c><c r="C6"><v>10</v></c></row>
</sheetData>
</worksheet>`);
  return (async () => {
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    return toItem('deep.xlsx', bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  })();
}

export function makeMultiSelectionFolder() {
  const dupA = new File(['identical bytes'], 'report.txt', { type: 'text/plain', lastModified: 1_700_000_000_000 });
  const dupB = new File(['identical bytes'], 'report.txt', { type: 'text/plain', lastModified: 1_700_000_000_000 });
  const sameName = new File(['different content'], 'notes.txt', { type: 'text/plain', lastModified: 1_700_000_000_000 });
  const referrer = new File(['see notes for details and check report.txt'], 'summary.txt', { type: 'text/plain', lastModified: 1_700_000_000_000 });
  return {
    kind: 'folder',
    name: 'Selection (4)',
    path: 'selection://4',
    children: [
      { kind: 'file', name: 'report.txt', path: 'selection://4/report-a.txt', size: dupA.size, lastModified: dupA.lastModified, mimeType: 'text/plain', file: dupA },
      { kind: 'file', name: 'report.txt', path: 'selection://4/report-b.txt', size: dupB.size, lastModified: dupB.lastModified, mimeType: 'text/plain', file: dupB },
      { kind: 'file', name: 'notes.txt', path: 'selection://4/notes-a.txt', size: sameName.size, lastModified: sameName.lastModified, mimeType: 'text/plain', file: sameName },
      { kind: 'file', name: 'summary.txt', path: 'selection://4/summary.txt', size: referrer.size, lastModified: referrer.lastModified, mimeType: 'text/plain', file: referrer }
    ]
  };
}


