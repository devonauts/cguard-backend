const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'api', 'auth', 'authSignIn.ts');
const content = fs.readFileSync(file,'utf8');
const jsdocRegex = /\/\*\*([\s\S]*?)\*\//g;
let m;
while ((m = jsdocRegex.exec(content)) !== null) {
  const block = m[1];
  if (block.indexOf('@openapi') !== -1) {
    const idx = block.indexOf('@openapi');
    const after = block.slice(idx + '@openapi'.length).trim();
    const jsonStart = after.indexOf('{');
    const jsonEnd = after.lastIndexOf('}');
    console.log('AFTER:', after);
    if (jsonStart>=0 && jsonEnd>jsonStart) {
      const jsonText = after.slice(jsonStart, jsonEnd+1);
      console.log('JSON TEXT:', jsonText);
      try { console.log('PARSED:', JSON.parse(jsonText)); } catch (e) { console.log('PARSE ERROR', e.message); }
    }
  }
}
