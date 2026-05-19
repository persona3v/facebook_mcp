import { chromium } from 'playwright';
const context=await chromium.launchPersistentContext('/Users/saber/.hermes/facebook-marketplace/browser-profile',{headless:false,viewport:{width:1440,height:1000}});
const page=context.pages()[0] ?? await context.newPage();
try{
 await page.goto('https://www.facebook.com/marketplace/you/selling',{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForTimeout(10000);
 const body=await page.evaluate(()=>document.body.innerText||'');
 const links=await page.locator('a[href*="/marketplace/item/"]').evaluateAll(els=>els.slice(0,20).map(a=>({href:a.href,text:(a.innerText||a.textContent||'').trim().replace(/\s+/g,' ').slice(0,300)}))).catch(()=>[]);
 const titleVisible=/Digital Glass Bathroom Scale/i.test(body);
 const priceVisible=/\$\s*12\b/.test(body);
 const householdNotif=/You listed an item in Household/i.test(body);
 const screenshot='/Users/saber/.hermes/facebook-marketplace/screenshots/verify_selling_'+new Date().toISOString().replace(/[-:.]/g,'').replace('T','_').slice(0,15)+'.png';
 await page.screenshot({path:screenshot, fullPage:true});
 console.log(JSON.stringify({url:page.url(), titleVisible, priceVisible, householdNotif, links, screenshot, excerpt:body.slice(0,2000)},null,2));
}finally{await context.close().catch(()=>{});}