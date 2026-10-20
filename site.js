(()=>{
const language=document.documentElement.lang==='cs'?'cs':'en';
const order=['KES','CZK','USD','EUR'],labels={KES:'KSh',CZK:'Kč',USD:'US$',EUR:'€'},rates={KES:1,CZK:.168,USD:.00772,EUR:.00689};
const defaultCurrency=language==='cs'?'CZK':'KES';
let currency=defaultCurrency;
const preferenceKey='kitonyo-currency-preference-v2';
function savePreference(){try{localStorage.setItem(preferenceKey,JSON.stringify({language,currency}));localStorage.setItem('kitonyo-language',language)}catch{}}
function loadPreference(){
currency=defaultCurrency;
try{const saved=JSON.parse(localStorage.getItem(preferenceKey));if(saved?.language===language&&order.includes(saved.currency))currency=saved.currency}catch{}
savePreference();
}
// Rounded domain prices approved by the owner, 18 October 2026.
const domainPrices={USD:5,KES:650,CZK:110,EUR:4.5};
loadPreference();
function render(){document.querySelectorAll('.price[data-kes], [data-inline-kes]').forEach(el=>{const suffix=el.querySelector('small')?.cloneNode(true);let value=Number(el.dataset.kes??el.dataset.inlineKes)*rates[currency];value=currency==='KES'?Math.round(value/100)*100:currency==='CZK'?Math.round(value/50)*50:Math.round(value);el.textContent=labels[currency]+' '+value.toLocaleString(language==='cs'?'cs-CZ':'en-GB');if(suffix){el.append(' ',suffix)}});const button=document.getElementById('currencyToggle');if(button)button.textContent=labels[currency]+' ▾'}
const renderPackages=render;
render=function(){renderPackages();document.querySelectorAll('[data-domain-usd]').forEach(el=>{const value=domainPrices[currency];el.textContent=labels[currency]+' '+value.toLocaleString(language==='cs'?'cs-CZ':'en-GB',{minimumFractionDigits:currency==='EUR'?2:0,maximumFractionDigits:currency==='EUR'?2:0})});document.documentElement.dataset.currency=currency;document.dispatchEvent(new CustomEvent('kitonyo:currency',{detail:currency}))};
document.addEventListener('kitonyo:set-currency',event=>{if(order.includes(event.detail)){currency=event.detail;savePreference();render()}});
function next(){currency=order[(order.indexOf(currency)+1)%order.length];savePreference();render()}
document.getElementById('currencyToggle')?.addEventListener('click',next);
document.querySelectorAll('.price[data-kes]').forEach(el=>{el.addEventListener('click',next);el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();next()}})});
render();
window.addEventListener('pageshow',event=>{if(event.persisted){loadPreference();render()}});
})();
