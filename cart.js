(()=>{'use strict';
const cs=document.documentElement.lang==='cs',lang=cs?'cs':'en',prefix=cs?'../':'';
const t=(en,cz)=>cs?cz:en;
const api=document.querySelector('meta[name="kitonyo-api"]')?.content||'';
const products={setup:[3000,'Domain & Setup','Doména a nastavení'],basic:[5000,'Basic One-Page Site','Základní jednostránkový web'],signature:[9000,'Signature One-Page Site','Jednostránkový web na míru'],logo:[2000,'Custom Logo Design','Vlastní návrh loga'],page:[3000,'Additional Website Page','Další stránka webu'],domain:[650,'Domain registration · first year','Registrace domény · první rok']};
const TERMS='2026-10-20-paynecta-v2',storageKey='kitonyo-cart-v1',activeKey='kitonyo-active-checkout-v1';
const money=n=>'KSh '+n.toLocaleString(cs?'cs-CZ':'en-KE');
let cart=[],active=null,catalog=null,timer,busy=false;
let botToken='',botWidget,botScriptLoading=false;
const linePrice=line=>line.id==='domain'?line.amount/100:products[line.id][0]*line.quantity;
try{cart=JSON.parse(localStorage.getItem(storageKey)||'[]');if(!Array.isArray(cart))cart=[];cart=cart.filter(x=>x&&Object.hasOwn(products,x.id)&&Number.isInteger(x.quantity)&&x.quantity>0&&x.quantity<=10);if(new Set(cart.map(x=>x.id)).size!==cart.length)cart=[];}catch{cart=[];}
try{active=JSON.parse(sessionStorage.getItem(activeKey)||'null');if(active&&(!/^[a-f0-9-]{36}$/.test(active.id)||! /^[a-f0-9]{64}$/.test(active.token)))active=null;}catch{active=null;}
cart=cart.filter(x=>x.id!=='domain'||(x.quantity===1&&Number.isSafeInteger(x.amount)&&x.amount>=65000&&x.amount<=25000000&&x.amount%100===0&&typeof x.domain==='string'));
function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function persist(){try{localStorage.setItem(storageKey,JSON.stringify(cart));}catch{}updateCount();}
function saveActive(){sessionStorage.setItem(activeKey,JSON.stringify(active));}
const launch=el('button','', 'toolbtn cart-launch');launch.type='button';
document.querySelector('.navtools')?.append(launch);
const dialog=el('dialog',undefined,'cart-dialog');dialog.setAttribute('aria-labelledby','cart-title');
// Only fixed interface text is inserted as markup. Customer and product data use textContent.
dialog.innerHTML=`<div class="cart-head"><div><p class="cart-eyebrow">KITONYO CHECKOUT</p><h2 id="cart-title">${t('Your basket','Váš košík')}</h2></div><button type="button" class="cart-close" aria-label="${t('Close basket','Zavřít košík')}">×</button></div>
<ol class="cart-steps" aria-label="${t('Checkout progress','Průběh objednávky')}"><li aria-current="step">1 · ${t('Basket','Košík')}</li><li>2 · ${t('Details','Údaje')}</li><li>3 · ${t('Payment','Platba')}</li></ol>
<div class="cart-edit"><div class="cart-basket"><ul class="cart-lines"></ul><p class="cart-empty">${t('Choose a package to get started.','Začněte výběrem balíčku.')}</p><div class="cart-total"><span>${t('Total','Celkem')}</span><span class="cart-amount"></span></div>
<p class="cart-note">${t('One-time service fees in KSh. Three revision rounds within the selected scope. Delivery normally within 7 days after payment and all materials. Hosting and renewals are agreed separately.','Jednorázové ceny v KSh. Tři kola úprav v dohodnutém rozsahu. Dodání obvykle do 7 dnů od platby a dodání podkladů. Hosting a obnovy sjednáváme zvlášť.')}</p><button type="button" class="btn cart-next">${t('Continue to details →','Pokračovat k údajům →')}</button></div>
<form class="cart-form" hidden><div class="cart-detail-head"><button type="button" class="cart-back">← ${t('Edit basket','Upravit košík')}</button><strong class="cart-review-total"></strong></div><fieldset><div class="cart-fields"><label>${t('Your name','Vaše jméno')}<input name="name" autocomplete="name" required minlength="2" maxlength="120"></label><label>${t('Email for your order','E-mail k objednávce')}<input name="email" type="email" autocomplete="email" required maxlength="254"></label></div><label>${t('Business name and project requirements','Název firmy a požadavky na projekt')}<textarea name="brief" required minlength="10" maxlength="2000"></textarea></label>
<label class="cart-check"><input name="terms" type="checkbox" required><span>${t('I agree to the','Souhlasím s')} <a href="terms.html" target="_blank" rel="noopener">${t('Terms','obchodními podmínkami')}</a> ${t('and have read the','a beru na vědomí')} <a href="privacy.html" target="_blank" rel="noopener">${t('Privacy notice','informace o ochraně osobních údajů')}</a>. ${t('I have reviewed the selected services and total.','Zkontroloval(a) jsem vybrané služby a celkovou cenu.')}</span></label>
<label class="cart-check"><input name="early" type="checkbox"><span>${t('Optional: I expressly request work to start during the 14-day withdrawal period. If I withdraw after work begins, I pay a proportionate amount for work performed. Once the service is fully performed, my withdrawal right ends.','Volitelné: Výslovně žádám o zahájení služby ve 14denní lhůtě pro odstoupení. Při odstoupení po zahájení uhradím poměrnou část provedené práce. Po úplném poskytnutí služby mé právo odstoupit zaniká.')}</span></label>
<p class="cart-note">${t('Without this request, work starts after the withdrawal period where it applies. M-Pesa payments are securely processed by PayNecta.','Bez této žádosti začneme po uplynutí lhůty pro odstoupení, pokud se uplatní. Platbu M-Pesa bezpečně zpracuje PayNecta.')}</p></fieldset><div class="cart-bot"></div><button class="btn cart-pay" type="submit" disabled></button></form>
<button type="button" class="cart-convert" hidden>${t('Switch prices to KSh','Přepnout ceny na KSh')}</button></div>
<div class="cart-payment" hidden><p class="cart-reference"></p><div class="cart-frame-wrap"></div><button type="button" class="cart-resume cart-close">${t('Resume the same payment','Pokračovat ve stejné platbě')}</button><button type="button" class="cart-check-status cart-close">${t('Check payment status','Ověřit stav platby')}</button><p class="cart-note">${t('Closing this window does not cancel a payment. Do not pay again while verification is pending.','Zavření okna nezruší rozpracovanou platbu. Dokud čekáme na ověření, neplaťte znovu.')}</p></div>
<p class="cart-status" role="status" aria-live="polite" hidden></p><button class="cart-new cart-close" type="button" hidden>${t('Continue shopping','Pokračovat v nákupu')}</button>`;
document.body.append(dialog);
const $=s=>dialog.querySelector(s),form=$('.cart-form'),status=$('.cart-status'),pay=$('.cart-pay');
const currency=()=>document.documentElement.dataset.currency||'KES';
function step(number){dialog.dataset.step=number;dialog.querySelectorAll('.cart-steps li').forEach((e,i)=>{if(i===number-1)e.setAttribute('aria-current','step');else e.removeAttribute('aria-current');});$('.cart-basket').hidden=number!==1;form.hidden=number!==2;dialog.scrollTop=0;if(number===2)setupBot();}
function setupBot(){if(!catalog?.botRequired||!catalog.siteKey||botWidget!==undefined)return;if(!window.turnstile){if(!botScriptLoading){botScriptLoading=true;const script=el('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;script.onload=setupBot;script.onerror=()=>message(t('Security check could not load. Refresh and try again.','Bezpečnostní kontrolu nelze načíst. Obnovte stránku a zkuste to znovu.'));document.head.append(script);}return;}botWidget=window.turnstile.render($('.cart-bot'),{sitekey:catalog.siteKey,action:'checkout',theme:'dark',language:lang,callback:token=>{botToken=token;render();},'expired-callback':()=>{botToken='';render();},'error-callback':()=>{botToken='';render();}});}
function resetBot(){botToken='';if(botWidget!==undefined&&window.turnstile)window.turnstile.reset(botWidget);}
function message(text){status.hidden=false;status.textContent=text;}
function updateCount(){launch.textContent=t('Basket','Košík')+' ('+cart.reduce((n,x)=>n+x.quantity,0)+')';}
function render(){
 updateCount();const list=$('.cart-lines');list.replaceChildren();
 for(const line of cart){const p=products[line.id],li=el('li',undefined,'cart-line'),name=el('div',p[cs?2:1]);name.append(el('small',money(linePrice(line))));
 const domain=line.id==='domain',q=el('input');q.type='number';q.step='1';q.min=domain?'650':'1';q.max=domain?'250000':'10';q.value=domain?line.amount/100:line.quantity;q.setAttribute('aria-label',domain?t('Registration amount in KSh','Cena registrace v KSh'):t('Quantity: ','Počet: ')+p[cs?2:1]);q.disabled=!!active;
 q.addEventListener('input',()=>{const n=Number(q.value);if(!Number.isInteger(n)||n<Number(q.min)||n>Number(q.max))return;if(domain)line.amount=n*100;else line.quantity=n;name.querySelector('small').textContent=money(linePrice(line));$('.cart-amount').textContent=money(cart.reduce((sum,x)=>sum+linePrice(x),0));$('.cart-review-total').textContent=$('.cart-amount').textContent;pay.textContent=t('Order and pay ','Objednat a zaplatit ')+$('.cart-amount').textContent;if(catalog?.enabled!==true)pay.textContent=t('Online payment is being prepared','Online platbu připravujeme');persist();});
 q.addEventListener('change',()=>{q.value=domain?line.amount/100:line.quantity;});
 q.addEventListener('input',()=>{if(currency()!=='KES')pay.textContent=t('Other currencies coming soon','Ostatní měny připravujeme');});
 const remove=el('button',t('Remove','Odebrat'),'cart-remove');remove.type='button';remove.disabled=!!active;remove.addEventListener('click',()=>{cart=cart.filter(x=>x.id!==line.id);persist();render();});const control=el('label',domain?t('Amount · KSh','Cena · KSh'):t('Qty','Počet'),'cart-quantity');control.append(q);li.append(name,control,remove);
 if(domain){li.classList.add('cart-domain');const label=el('label',t('Your domain name','Název vaší domény'),'cart-domain-name'),input=el('input');input.type='text';input.required=true;input.maxLength=253;input.pattern='(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+[a-zA-Z]{2,63}';input.placeholder='yourbusiness.com';input.value=line.domain;input.disabled=!!active;input.addEventListener('input',()=>{line.domain=input.value.trim().toLowerCase();persist();});label.append(input);li.append(label,el('p',t('Minimum KSh 650 for the first year. Enter your agreed registration price. Availability and registrar cost are confirmed before registration; if your choice is unavailable or costs more, we will agree an alternative or refund. Renewal is quoted separately.','Minimum 650 KSh za první rok. Zadejte dohodnutou cenu registrace. Dostupnost a cenu registrátora ověříme před registrací; při nedostupnosti nebo vyšší ceně dohodneme alternativu nebo vrácení platby. Obnovu naceníme zvlášť.'),'cart-note cart-domain-note'));}
 list.append(li);}
 const domainInput=$('.cart-domain-name input');if(domainInput)domainInput.pattern='(?:[a-zA-Z0-9](?:[a-zA-Z0-9\\-]{0,61}[a-zA-Z0-9])?\\.)+[a-zA-Z]{2,63}';
 $('.cart-basket > .cart-note').hidden=cart.length>0&&cart.every(x=>x.id==='domain');
 const total=cart.reduce((n,x)=>n+linePrice(x),0);$('.cart-amount').textContent=money(total);$('.cart-review-total').textContent=money(total);$('.cart-empty').hidden=cart.length>0;$('.cart-next').disabled=!cart.length||!!active;
 const kes=currency()==='KES';$('.cart-convert').hidden=kes;form.querySelector('fieldset').disabled=!!active;
 pay.disabled=busy||!!active||!cart.length||!kes||catalog?.enabled!==true||(catalog?.botRequired&&!botToken);
 pay.textContent=!kes?t('Other currencies coming soon','Ostatní měny připravujeme'):catalog?.enabled!==true?t('Online payment is being prepared','Online platbu připravujeme'):t('Order and pay ','Objednat a zaplatit ')+money(total);
 if(kes&&catalog?.enabled===true&&catalog.botRequired&&!botToken)pay.textContent=t('Complete the security check','Dokončete bezpečnostní kontrolu');
 document.querySelectorAll('[data-cart-add]').forEach(b=>{b.textContent=kes?t('Add to basket','Přidat do košíku'):t('Payments coming soon','Platby připravujeme');b.disabled=!kes||!!active;});
}
async function request(path,options={}){const res=await fetch(api+path,{...options,cache:'no-store',signal:AbortSignal.timeout(30000)});let data;try{data=await res.json();}catch{throw Error('payments_not_ready');}if(!res.ok)throw Error(data.error||'temporarily_unavailable');return data;}
async function loadCatalog(){try{catalog=await request('/api/catalog');if(catalog.termsVersion!==TERMS||Object.entries(products).some(([id,p])=>catalog.products?.[id]?.amount!==p[0]*100))catalog.enabled=false;}catch{catalog={enabled:false};}render();if(dialog.dataset.step==='2')setupBot();}
function frame(){
 if(!active?.url)return;
 let u;try{u=new URL(active.url);}catch{return;}
 if(u.origin!=='https://pay.paynecta.co.ke'||!u.pathname.startsWith('/s/chk_'))return;
 const f=el('iframe');f.id='paynecta-frame';f.title=t('Secure M-Pesa payment by PayNecta','Zabezpečená platba M-Pesa přes PayNecta');f.allow='payment';f.referrerPolicy='no-referrer';f.src=u.href;
 $('.cart-frame-wrap').replaceChildren(f);$('.cart-payment').hidden=false;$('.cart-edit').hidden=true;step(3);
 $('.cart-reference').textContent=t('Order: ','Objednávka: ')+active.id;
}
async function check(){if(!active)return;try{const data=await request('/api/orders/'+active.id,{headers:{Authorization:'Bearer '+active.token}});
 if(data.state==='paid'){clearTimeout(timer);active.state='paid';saveActive();cart=[];persist();$('.cart-frame-wrap').replaceChildren();$('.cart-payment').hidden=true;$('.cart-edit').hidden=true;$('.cart-new').hidden=false;message(t('Payment verified. Thank you!\nOrder: ','Platba ověřena. Děkujeme!\nObjednávka: ')+data.id+'\n'+t('Payment reference: ','Reference platby: ')+data.paymentReference+'\n'+t('Keep this reference. For project details contact info@kitonyo.com.','Referenci si uschovejte. Podrobnosti projektu řešíme na info@kitonyo.com.'));return;}
 message(t('Payment has not been confirmed yet. Your order remains pending. Do not start another payment.','Platba zatím není potvrzena. Objednávka čeká na ověření. Nezahajujte další platbu.'));
 }catch{message(t('We could not verify the payment right now. Keep your order reference and contact info@kitonyo.com if needed. Do not pay again.','Stav platby teď nelze ověřit. Uschovejte si číslo objednávky a případně kontaktujte info@kitonyo.com. Neplaťte znovu.'));}
 clearTimeout(timer);if(dialog.open)timer=setTimeout(check,15000);
}
function open(){if(!dialog.open)dialog.showModal();if(!active)step(1);render();loadCatalog();if(active?.state==='paid'){check();}else if(active){$('.cart-payment').hidden=false;$('.cart-edit').hidden=true;frame();check();}}
launch.addEventListener('click',open);$('.cart-head .cart-close').addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>clearTimeout(timer));
$('.cart-next').addEventListener('click',()=>{for(const input of $('.cart-basket').querySelectorAll('input'))if(!input.reportValidity())return;step(2);form.querySelector('input').focus();});$('.cart-back').addEventListener('click',()=>step(1));
$('.cart-convert').addEventListener('click',()=>{document.dispatchEvent(new CustomEvent('kitonyo:set-currency',{detail:'KES'}));render();});
async function resume(){if(!active||busy)return;if(active.url){frame();return;}if(!active.body){check();return;}busy=true;try{const data=await request('/api/checkout',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+active.token,'Idempotency-Key':active.id},body:JSON.stringify(active.body)});active={id:active.id,token:active.token,url:data.url,sessionId:data.sessionId};saveActive();frame();check();}catch{message(t('This order still needs verification. Contact info@kitonyo.com with reference ','Tato objednávka stále vyžaduje ověření. Kontaktujte info@kitonyo.com s číslem ')+active.id);}finally{busy=false;render();}}
$('.cart-check-status').addEventListener('click',check);$('.cart-resume').addEventListener('click',resume);
$('.cart-new').addEventListener('click',()=>{active=null;sessionStorage.removeItem(activeKey);$('.cart-edit').hidden=false;$('.cart-new').hidden=true;status.hidden=true;form.reset();resetBot();step(1);render();});
form.addEventListener('submit',async event=>{event.preventDefault();if(busy||active||!cart.length||currency()!=='KES'||catalog?.enabled!==true||(catalog?.botRequired&&!botToken))return;if(!form.reportValidity())return;
 busy=true;render();
 try{const values=new FormData(form),token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
 active={id:crypto.randomUUID(),token,body:{items:cart.map(x=>({...x})),botToken,currency:'KES',language:lang,termsVersion:TERMS,acceptTerms:values.get('terms')==='on',earlyStart:values.get('early')==='on',customer:{name:values.get('name'),email:values.get('email'),brief:values.get('brief')}}};saveActive();
 const data=await request('/api/checkout',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+active.token,'Idempotency-Key':active.id},body:JSON.stringify(active.body)});
 active={id:active.id,token:active.token,url:data.url,sessionId:data.sessionId};saveActive();frame();check();
 }catch(error){
 if(['invalid_cart','invalid_domain','choose_one_website','amount_limit','customer_required','terms_required','invalid_language','currency_unavailable','rate_limited','payments_not_ready','bot_verification_failed','bot_unavailable'].includes(error.message)){active=null;sessionStorage.removeItem(activeKey);resetBot();message(t('Please check your details and security check, or try again later. No payment was started.','Zkontrolujte údaje a bezpečnostní kontrolu nebo to zkuste později. Platba nebyla zahájena.'));return;}
 // Preserve the same order capability across uncertain responses; never create another session silently.
 $('.cart-edit').hidden=true;$('.cart-payment').hidden=false;message(t('Checkout could not be opened. Keep order reference ','Platební okno se nepodařilo otevřít. Uschovejte si číslo objednávky ')+(active?.id||'')+t(' and contact info@kitonyo.com. Resume retries only this same order. Do not submit a second payment.',' a kontaktujte info@kitonyo.com. Pokračování zkouší pouze tutéž objednávku. Nezadávejte druhou platbu.'));
 }finally{busy=false;render();}});
window.addEventListener('message',event=>{const f=$('#paynecta-frame');if(event.origin!=='https://pay.paynecta.co.ke'||!f||event.source!==f.contentWindow||event.data?.type!=='paynecta:checkout'||event.data?.id!==active?.sessionId)return;if(event.data.outcome==='cancelled')$('.cart-frame-wrap').replaceChildren();check();});
function add(id){if(active)return;if((id==='basic'&&cart.some(x=>x.id==='signature'))||(id==='signature'&&cart.some(x=>x.id==='basic'))){open();message(t('Choose one website package. Remove the existing website package first.','Vyberte jeden webový balíček. Nejprve odeberte stávající webový balíček.'));return;}const line=cart.find(x=>x.id===id);if(line&&id!=='domain')line.quantity=Math.min(10,line.quantity+1);else if(!line)cart.push({id,quantity:1,...(id==='domain'?{amount:65000,domain:''}:{})});persist();open();}
const cards=[...document.querySelectorAll('article.card')];
['setup','basic','signature','logo','page'].forEach((id,i)=>{if(!cards[i])return;const button=el('button','', 'btn secondary cart-add');button.type='button';button.dataset.cartAdd=id;button.addEventListener('click',()=>add(id));cards[i].append(button);});
const domainBox=document.querySelector('.domainbox');if(domainBox){const b=el('button','', 'btn cart-add');b.type='button';b.dataset.cartAdd='domain';b.addEventListener('click',()=>add('domain'));domainBox.append(b);}
if(!cards.length&&document.querySelector('.price[data-kes="3000"]')){const target=document.querySelector('.checkout-actions');if(target){const b=el('button','', 'btn cart-add');b.type='button';b.dataset.cartAdd='page';b.addEventListener('click',()=>add('page'));target.replaceChildren(b);}}
document.querySelectorAll('.checkout-actions .payment-soon').forEach(span=>{const button=el('button',t('View basket','Zobrazit košík'),'btn');button.type='button';button.addEventListener('click',open);span.replaceWith(button);});
document.addEventListener('kitonyo:currency',render);
persist();render();loadCatalog();
if(location.pathname.includes('payment-success')){document.querySelector('#order-title')?.replaceChildren(document.createTextNode(t('Payment verification','Ověření platby')));if(active)open();}
})();
