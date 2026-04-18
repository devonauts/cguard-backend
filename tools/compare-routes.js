const fs = require('fs');
const path = require('path');
function walk(dir){
  let res=[];
  for(const f of fs.readdirSync(dir)){
    const p=path.join(dir,f);
    if(fs.statSync(p).isDirectory()) res=res.concat(walk(p));
    else res.push(p);
  }
  return res;
}
const files=walk('e:/cguard/cguard-backend/src/api').filter(f=>f.endsWith('index.ts'));
const routes=new Set();
for(const file of files){
  const s=fs.readFileSync(file,'utf8');
  const re=/app\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`\n]+)['"`]/g;
  let m;
  while((m=re.exec(s))){
    let r=m[2].trim();
    r=r.replace(/:([a-zA-Z0-9_]+)/g,'{$1}');
    routes.add(r);
  }
}
const j=require('e:/cguard/cguard-backend/src/api/documentation/openapi.json');
const openPaths=new Set(Object.keys(j.paths));
const missing=Array.from(routes).filter(r=>!openPaths.has(r)).sort();
const out={routesCount:routes.size,openPathsCount:openPaths.size,missingCount:missing.length,missing};
fs.writeFileSync('e:/cguard/cguard-backend/tmp/routes_diff.json',JSON.stringify(out,null,2));
console.log('wrote e:/cguard/cguard-backend/tmp/routes_diff.json');
