function previewUrl(value) {
  const url = new URL(String(value));
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('预览仅支持 HTTP 或 HTTPS 网页');
  return url.href;
}
function previewDocument(content) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; script-src \'none\'; form-action \'none\'; base-uri \'none\'"><style>body{margin:24px;font-family:system-ui,sans-serif;color:#202428}svg{max-width:100%;height:auto}img{max-width:100%}</style></head><body>' + content + '</body></html>';
}
module.exports = { previewUrl, previewDocument };
