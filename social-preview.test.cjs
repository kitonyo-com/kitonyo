// Build first: node build-public.cjs && node --test social-preview.test.cjs
// Optional public deployment checks: set KITONYO_VERIFY_ORIGIN to its HTTPS origin.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');

const root=__dirname,dist=path.join(root,'dist');
const publicOrigin='https://kitonyo.com';
const imagePaths={
  en:'/assets/social/kitonyo-og-en-v1.png',
  cs:'/assets/social/kitonyo-og-cs-v1.png'
};
const pages=['','cs'].flatMap(dir=>fs.readdirSync(path.join(root,dir))
  .filter(name=>name.endsWith('.html'))
  .map(name=>dir?dir+'/'+name:name)).sort();

function attributes(tag){
  const values={};
  for(const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)){
    values[match[1].toLowerCase()]=match[2]??match[3]??match[4];
  }
  return values;
}
function headTags(html,tag){
  const head=html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  assert.ok(head,'HTML must contain a head');
  return [...head[1].matchAll(new RegExp('<'+tag+'\\b[^>]*>','gi'))].map(match=>attributes(match[0]));
}
function oneMeta(tags,key,label){
  const found=tags.filter(tag=>(tag.property||tag.name||'').toLowerCase()===key);
  assert.equal(found.length,1,label+': exactly one '+key+' is required');
  assert.ok(found[0].content?.trim(),label+': '+key+' must have content');
  return found[0].content;
}
function checkMetadata(html,page,label){
  const language=page.startsWith('cs/')?'cs':'en';
  const htmlTag=html.match(/<html\b[^>]*>/i);
  assert.ok(htmlTag,label+': HTML element is required');
  assert.equal(attributes(htmlTag[0]).lang,language,label+': page language');
  const metas=headTags(html,'meta');
  const value=key=>oneMeta(metas,key,label);
  const image=publicOrigin+imagePaths[language];
  assert.equal(value('og:image'),image,label+': localized Open Graph image');
  assert.equal(value('twitter:image'),image,label+': localized Twitter image');
  assert.equal(value('og:image:secure_url'),image,label+': secure image URL');
  assert.equal(new URL(image).protocol,'https:',label+': absolute HTTPS image URL');
  assert.equal(value('og:image:type'),'image/png',label+': image type');
  assert.equal(value('og:image:width'),'1200',label+': image width');
  assert.equal(value('og:image:height'),'630',label+': image height');
  const alt=value('og:image:alt');
  assert.ok(alt.trim().length>=20,label+': meaningful image description');
  assert.equal(value('twitter:image:alt'),alt,label+': matching image description');
  assert.equal(value('twitter:card'),'summary_large_image',label+': large-image card');
  const canonical=headTags(html,'link').filter(tag=>(tag.rel||'').toLowerCase().split(/\s+/).includes('canonical'));
  assert.equal(canonical.length,1,label+': exactly one canonical URL');
  assert.equal(value('og:url'),canonical[0].href,label+': Open Graph and canonical URLs agree');
  const canonicalURL=new URL(canonical[0].href);
  assert.equal(canonicalURL.origin,publicOrigin,label+': production canonical origin');
  assert.equal(canonicalURL.pathname.startsWith('/cs/'),language==='cs',label+': canonical language');
  if(page.endsWith('payment-success.html')){
    const robots=value('robots').toLowerCase().split(/[\s,]+/);
    assert.ok(robots.includes('noindex'),label+': payment return remains noindex');
    assert.ok(robots.includes('follow'),label+': payment return remains follow');
  }
  return {image,alt};
}
function checkPNG(buffer,label){
  assert.ok(buffer.length>1024,label+': image must contain real image data');
  assert.ok(buffer.length<1024*1024,label+': image must be smaller than 1 MiB');
  assert.deepEqual(buffer.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]),label+': PNG signature');
  assert.equal(buffer.readUInt32BE(8),13,label+': IHDR length');
  assert.equal(buffer.toString('ascii',12,16),'IHDR',label+': PNG starts with IHDR');
  assert.equal(buffer.readUInt32BE(16),1200,label+': actual width');
  assert.equal(buffer.readUInt32BE(20),630,label+': actual height');
}
function walkFiles(directory,prefix=''){
  return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const relative=prefix?prefix+'/'+entry.name:entry.name;
    return entry.isDirectory()?walkFiles(path.join(directory,entry.name),relative):[relative];
  });
}
const digest=buffer=>createHash('sha256').update(buffer).digest('hex');

test('all EN/CZ public pages are covered by the build',()=>{
  assert.ok(fs.existsSync(dist),'Run node build-public.cjs before this suite');
  for(const name of ['index','add','contact','payments','terms','privacy','complaints','payment-success']){
    assert.ok(pages.includes(name+'.html'),'Missing English page: '+name);
    assert.ok(pages.includes('cs/'+name+'.html'),'Missing Czech page: '+name);
  }
  const builtPages=walkFiles(dist).filter(file=>file.endsWith('.html')).sort();
  assert.deepEqual(builtPages,pages,'Every source page must reach the public build');
  const en=checkMetadata(fs.readFileSync(path.join(root,'index.html'),'utf8'),'index.html','English source');
  const cs=checkMetadata(fs.readFileSync(path.join(root,'cs/index.html'),'utf8'),'cs/index.html','Czech source');
  assert.notEqual(en.alt,cs.alt,'Image descriptions must be localized');
});

for(const [directory,label] of [[root,'source'],[dist,'build']]){
  for(const page of pages)test(label+' social metadata: '+page,()=>{
    const metadata=checkMetadata(fs.readFileSync(path.join(directory,page),'utf8'),page,label+'/'+page);
    const assetPath=new URL(metadata.image).pathname.slice(1);
    assert.ok(fs.statSync(path.join(dist,assetPath)).isFile(),page+': referenced image exists in dist');
  });
}

for(const [language,relative] of Object.entries(imagePaths))test(language+' image is a published 1200×630 PNG',()=>{
  const source=fs.readFileSync(path.join(root,relative.slice(1)));
  const built=fs.readFileSync(path.join(dist,relative.slice(1)));
  checkPNG(source,language+' source');
  checkPNG(built,language+' build');
  assert.deepEqual(built,source,language+': build must preserve image bytes');
});

test('the complete assets tree is copied recursively without changing bytes',()=>{
  const sourceFiles=walkFiles(path.join(root,'assets')).sort();
  assert.deepEqual(walkFiles(path.join(dist,'assets')).sort(),sourceFiles);
  for(const relative of sourceFiles){
    assert.deepEqual(fs.readFileSync(path.join(dist,'assets',relative)),fs.readFileSync(path.join(root,'assets',relative)),relative);
  }
});

test('the public build excludes backend, credentials, configuration and tests',()=>{
  const files=walkFiles(dist);
  for(const file of files){
    assert.doesNotMatch(file,/(^|\/)(?:backend|node_modules|\.git|\.wrangler)(\/|$)/,'Private directory published: '+file);
    assert.doesNotMatch(file,/(^|\/)(?:\.env[^/]*|\.dev\.vars[^/]*|wrangler[^/]*|build-public\.cjs)$/,'Configuration published: '+file);
    assert.doesNotMatch(file,/(?:\.test\.|\.(?:cjs|mjs|jsonc|sql|toml)$)/,'Source or tests published: '+file);
  }
});

if(process.env.KITONYO_VERIFY_ORIGIN){
  const origin=new URL(process.env.KITONYO_VERIFY_ORIGIN);
  assert.equal(origin.protocol,'https:','Public verification requires an HTTPS origin');
  assert.equal(origin.username+origin.password,'','Do not include credentials in the verification origin');
  assert.equal(origin.pathname,'/','Set KITONYO_VERIFY_ORIGIN to an origin without a path');
  assert.equal(origin.search+origin.hash,'','Verification origin must not contain a query or fragment');
  test('public HTML serves all '+pages.length+' pages with correct localized social metadata',{timeout:35000},async()=>{
    await Promise.all(pages.map(async page=>{
      const response=await fetch(new URL('/'+page,origin),{redirect:'follow',signal:AbortSignal.timeout(30000)});
      assert.equal(response.status,200,page+': public HTTP status');
      assert.match(response.headers.get('content-type')||'',/^text\/html(?:\s*;|$)/i,page+': public content type');
      checkMetadata(await response.text(),page,origin.origin+'/'+page);
    }));
  });
  for(const [language,relative] of Object.entries(imagePaths))test('public '+language+' PNG is accessible without authentication and matches source',{timeout:35000},async()=>{
    const response=await fetch(new URL(relative,origin),{redirect:'follow',signal:AbortSignal.timeout(30000)});
    assert.equal(response.status,200,relative+': public HTTP status');
    assert.match(response.headers.get('content-type')||'',/^image\/png(?:\s*;|$)/i,relative+': public content type');
    const buffer=Buffer.from(await response.arrayBuffer());
    checkPNG(buffer,origin.origin+relative);
    assert.equal(digest(buffer),digest(fs.readFileSync(path.join(root,relative.slice(1)))),relative+': deployed SHA-256 matches source');
  });
}
