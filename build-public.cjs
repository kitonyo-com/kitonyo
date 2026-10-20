const fs=require('node:fs'),path=require('node:path');
const root=__dirname,out=path.join(root,'dist');
if(path.resolve(out)!==path.resolve(root,'dist')||path.dirname(path.resolve(out))!==path.resolve(root))throw Error('Unexpected output path');
fs.rmSync(out,{recursive:true,force:true});
fs.mkdirSync(out,{recursive:true});
// Explicit allowlist: never copy backend, git metadata, secrets or configuration.
for(const name of fs.readdirSync(root))if(/\.(html|css|js|jpg|jpeg|png|svg|ico)$/.test(name)||['robots.txt','sitemap.xml','_headers'].includes(name))fs.copyFileSync(path.join(root,name),path.join(out,name));
for(const name of ['cs','assets','.well-known'])if(fs.existsSync(path.join(root,name)))fs.cpSync(path.join(root,name),path.join(out,name),{recursive:true});
console.log('Public assets built in dist/');
