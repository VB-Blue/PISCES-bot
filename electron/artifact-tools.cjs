module.exports=[
  {type:'function',function:{name:'create_artifact',description:'让核心创建并校验真实 Word 文档、SVG 图形或 HTML 页面，输出会自动在侧栏展示。不会覆盖原文件。',parameters:{type:'object',properties:{format:{type:'string',enum:['docx','svg','html']},title:{type:'string'},content:{type:'string',description:'DOCX 使用正文文本，# 开头表示节标题；SVG/HTML 使用完整源码。'}},required:['format','title','content'],additionalProperties:false}}},
  {type:'function',function:{name:'open_artifact',description:'在本机 Microsoft Word 中打开本任务真实生成的 DOCX。只接受 create_artifact 的回执 ID，不能传路径或命令。用户要求 Word 或打开文档时使用。',parameters:{type:'object',properties:{receipt_id:{type:'string'}},required:['receipt_id'],additionalProperties:false}}},
];
