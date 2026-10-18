(()=>{
const language=document.documentElement.lang==='cs'?'cs':'en';
const order=['KES','CZK','USD','EUR'],labels={KES:'KSh',CZK:'Kč',USD:'US$',EUR:'€'},rates={KES:1,CZK:.168,USD:.00772,EUR:.00689};
let currency='KES';
try{const saved=localStorage.getItem('kitonyo-currency');if(order.includes(saved))currency=saved;localStorage.setItem('kitonyo-language',language)}catch{}
function render(){document.querySelectorAll('.price[data-kes]').forEach(el=>{const suffix=el.querySelector('small')?.cloneNode(true);let value=Number(el.dataset.kes)*rates[currency];value=currency==='KES'?Math.round(value/100)*100:currency==='CZK'?Math.round(value/50)*50:Math.round(value);el.textContent=labels[currency]+' '+value.toLocaleString(language==='cs'?'cs-CZ':'en-GB');if(suffix){el.append(' ',suffix)}});const button=document.getElementById('currencyToggle');if(button)button.textContent=labels[currency]+' ▾'}
function next(){currency=order[(order.indexOf(currency)+1)%order.length];try{localStorage.setItem('kitonyo-currency',currency)}catch{}render()}
document.getElementById('currencyToggle')?.addEventListener('click',next);
document.querySelectorAll('.price[data-kes]').forEach(el=>{el.addEventListener('click',next);el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();next()}})});
render();
})();
