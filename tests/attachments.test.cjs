const {test}=require('node:test');
const assert=require('node:assert/strict');
const {zipSync,strToU8}=require('fflate');
const {extractDocument,boundedText}=require('../electron/attachments.cjs');

test('Word upload extracts literal paragraph content and refuses missing or external-entity bodies',async()=>{
  const docx=xml=>Buffer.from(zipSync({'word/document.xml':strToU8(xml)}));
  const body=await extractDocument('工作报告.docx',docx('<w:document><w:body><w:p><w:r><w:t>真实 &amp; 中文</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>'));
  assert.equal(body.text,'真实 & 中文\n第二段');assert.equal(body.kind,'Word 正文');assert.equal(body.truncated,false);
  await assert.rejects(extractDocument('broken.docx',Buffer.from(zipSync({'other.xml':strToU8('empty')}))),/正文缺失/);
  await assert.rejects(extractDocument('entity.docx',docx('<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///secret">]><w:document/>')),/外部实体/);
});

test('attachment bounds preserve Unicode and refuse binary data',async()=>{
  const bounded=boundedText('中'.repeat(20000));assert.equal(Buffer.byteLength(bounded.text),48000);assert.equal(bounded.truncated,true);assert.ok(!bounded.text.includes('\uFFFD'));
  await assert.rejects(extractDocument('binary.txt',Buffer.from([0,1,2])),/二进制/);
  await assert.rejects(extractDocument('unknown.exe',Buffer.from('binary')),/暂不支持/);
});

// A real, minimal PDF with its own object offsets and selectable page text.
function textPdf(text){
  const content=`BT /F1 18 Tf 40 100 Td (${text}) Tj ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
test('PDF upload parses actual page text and rejects pages without extractable content',async()=>{
  const document=await extractDocument('receipt.pdf',textPdf('Actual receipt 42'));
  assert.match(document.text,/Actual receipt 42/);assert.equal(document.kind,'PDF 正文');assert.equal(document.truncated,false);
  await assert.rejects(extractDocument('blank.pdf',textPdf('')),/没有可提取正文/);
});
