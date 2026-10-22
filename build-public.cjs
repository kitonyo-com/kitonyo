const fs=require('node:fs'),path=require('node:path');
const root=__dirname,out=path.join(root,'dist');
if(path.resolve(out)!==path.resolve(root,'dist')||path.dirname(path.resolve(out))!==path.resolve(root))throw Error('Unexpected output path');
fs.rmSync(out,{recursive:true,force:true});
fs.mkdirSync(out,{recursive:true});
// Explicit allowlist: never copy backend, git metadata, secrets or configuration.
for(const name of fs.readdirSync(root))if(/\.(html|css|js|jpg|jpeg|png|svg|ico)$/.test(name)||['robots.txt','sitemap.xml','_headers'].includes(name))fs.copyFileSync(path.join(root,name),path.join(out,name));
for(const name of ['cs','assets','.well-known'])if(fs.existsSync(path.join(root,name)))fs.cpSync(path.join(root,name),path.join(out,name),{recursive:true});
console.log('Public assets built in dist/');

// Version checkout assets by content so existing devices receive checkout fixes.
const crypto=require('node:crypto');
const versions=Object.fromEntries(['cart.js','checkout.css'].map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(out,name))).digest('hex').slice(0,12)]));
function versionHtml(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())versionHtml(file);else if(entry.name.endsWith('.html')){const html=fs.readFileSync(file,'utf8').replace(/(cart[.]js|checkout[.]css)(?:[?][^"'\s<>]*)?/g,(_,name)=>name+'?v='+versions[name]);fs.writeFileSync(file,html);}}}
versionHtml(out);
