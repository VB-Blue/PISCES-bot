// Builds a real .docx from light Markdown, so a document task is one tool call instead of
// hand-written Python, a library install and a separate verification script.
const { zipSync, strToU8 } = require('fflate');

const escapeXml = text => String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// **bold** and *italic* inside a line; everything else is literal text.
function runs(text) {
  const out = [];
  const pattern = /(\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
  let last = 0, match;
  const run = (value, props = '') => value && out.push('<w:r>' + (props ? '<w:rPr>' + props + '</w:rPr>' : '') + '<w:t xml:space="preserve">' + escapeXml(value) + '</w:t></w:r>');
  while ((match = pattern.exec(text))) {
    run(text.slice(last, match.index));
    if (match[2]) run(match[2], '<w:b/>'); else run(match[3], '<w:i/>');
    last = pattern.lastIndex;
  }
  run(text.slice(last));
  return out.join('');
}
const paragraph = (text, style) => '<w:p>' + (style ? '<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>' : '') + runs(text) + '</w:p>';

function parse(title, content) {
  const blocks = [];
  if (title) blocks.push({ style: 'Title', text: title });
  let buffer = [];
  // Wrapped lines of one paragraph: Chinese joins directly, other scripts need a space.
  const cjk = /[　-鿿＀-￯]/;
  const join = lines => lines.reduce((text, line) => text + (text && !cjk.test(text.at(-1)) && !cjk.test(line[0]) ? ' ' : '') + line, '');
  const flush = () => { if (buffer.length) blocks.push({ style: '', text: join(buffer) }); buffer = []; };
  for (const raw of String(content).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    let match;
    if (!line) { flush(); continue; }
    if ((match = /^(#{1,3})\s+(.+)$/.exec(line))) {
      flush();
      // A leading "# 标题" that repeats the title is not printed twice.
      if (!(match[1].length === 1 && title && match[2].trim() === title.trim() && blocks.length === 1)) blocks.push({ style: 'Heading' + match[1].length, text: match[2] });
      continue;
    }
    if ((match = /^[-*•]\s+(.+)$/.exec(line))) { flush(); blocks.push({ style: 'ListBullet', text: '• ' + match[1] }); continue; }
    if ((match = /^(\d+[.、)])\s*(.+)$/.exec(line)) && !/^\d+[.、)]\d/.test(line)) { flush(); blocks.push({ style: 'ListNumber', text: match[1] + ' ' + match[2] }); continue; }
    buffer.push(line);
  }
  flush();
  return blocks;
}

const FONT = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" w:cs="Calibri"/>';
const HEAD_FONT = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="黑体" w:cs="Calibri"/>';
const style = (id, name, ppr, rpr) => '<w:style w:type="paragraph" w:styleId="' + id + '"><w:name w:val="' + name + '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr>' + ppr + '</w:pPr><w:rPr>' + rpr + '</w:rPr></w:style>';
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  + '<w:docDefaults><w:rPrDefault><w:rPr>' + FONT + '<w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:firstLineChars="200" w:firstLine="480"/><w:jc w:val="both"/></w:pPr></w:style>'
  + style('Title', 'Title', '<w:ind w:firstLine="0"/><w:jc w:val="center"/><w:spacing w:before="240" w:after="360"/>', HEAD_FONT + '<w:b/><w:sz w:val="36"/><w:szCs w:val="36"/>')
  + style('Heading1', 'heading 1', '<w:keepNext/><w:ind w:firstLine="0"/><w:spacing w:before="360" w:after="160"/><w:outlineLvl w:val="0"/>', HEAD_FONT + '<w:b/><w:sz w:val="30"/><w:szCs w:val="30"/>')
  + style('Heading2', 'heading 2', '<w:keepNext/><w:ind w:firstLine="0"/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="1"/>', HEAD_FONT + '<w:b/><w:sz w:val="28"/><w:szCs w:val="28"/>')
  + style('Heading3', 'heading 3', '<w:keepNext/><w:ind w:firstLine="0"/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/>', HEAD_FONT + '<w:b/><w:sz w:val="24"/><w:szCs w:val="24"/>')
  + style('ListBullet', 'List Bullet', '<w:ind w:left="480" w:hanging="240" w:firstLine="0"/><w:spacing w:after="60"/>', '')
  + style('ListNumber', 'List Number', '<w:ind w:left="480" w:hanging="240" w:firstLine="0"/><w:spacing w:after="60"/>', '')
  + '</w:styles>';

function buildDocx({ title = '', content = '' }) {
  const blocks = parse(String(title).trim(), content);
  const body = blocks.map(block => paragraph(block.text, block.style)).join('');
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>'
    + body + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>';
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'word/document.xml': document,
    'word/styles.xml': STYLES,
    'docProps/core.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + escapeXml(title) + '</dc:title><dc:creator>PISCES AI</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created></cp:coreProperties>',
  };
  const bytes = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), { level: 6 });
  return { bytes: Buffer.from(bytes), headings: blocks.filter(block => /^Heading/.test(block.style)).length, paragraphs: blocks.length };
}

module.exports = { buildDocx };
