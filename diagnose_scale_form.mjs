import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
const draft=JSON.parse(await fs.readFile('/Users/saber/.hermes/facebook-marketplace/drafts/draft_20260514_141057_o9p1.json','utf8'));
const context=await chromium.launchPersistentContext('/Users/saber/.hermes/facebook-marketplace/browser-profile',{headless:false,viewport:{width:1440,height:1000}});
const page=context.pages()[0] ?? await context.newPage();
const notes=[];
async function shot(tag){const p=path.join('/Users/saber/.hermes/facebook-marketplace/screenshots',`${draft.draft_id}_${tag}_${new Date().toISOString().replace(/[-:.]/g,'').replace('T','_').slice(0,15)}.png`); await page.screenshot({path:p, fullPage:true}); return p;}
try{
 await page.goto('https://www.facebook.com/marketplace/create/item',{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForTimeout(8000);
 await page.locator('input[type="file"]').first().setInputFiles(draft.photos).catch(e=>notes.push('photo:'+e.message));
 await page.waitForTimeout(1500);
 const labels=await page.evaluate(()=>Array.from(document.querySelectorAll('label')).map((el,i)=>{const r=el.getBoundingClientRect(); return {i,text:(el.textContent||'').trim().replace(/\s+/g,' '), role:el.getAttribute('role'), tag:el.tagName, rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)], visible:!!(r.width&&r.height)}}).filter(x=>x.text||x.role).slice(0,200));
 const inputs=await page.evaluate(()=>Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]')).map((el,i)=>{const r=el.getBoundingClientRect(); return {i,tag:el.tagName,type:el.getAttribute('type'),aria:el.getAttribute('aria-label'),placeholder:el.getAttribute('placeholder'),text:(el.textContent||'').trim().slice(0,50),value:el.value||'',rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)],visible:!!(r.width&&r.height)}}).slice(0,200));
 const screenshot=await shot('diagnose_initial');
 console.log(JSON.stringify({url:page.url(),screenshot,labels,inputs,notes},null,2));
}finally{await context.close().catch(()=>{});}