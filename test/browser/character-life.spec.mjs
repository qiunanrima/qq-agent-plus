import { test, expect } from '@playwright/test';
import { login, switchTo } from './helpers.mjs';

test('生命系统实验入口、开关和节律图可用', async ({page}) => {
  await login(page);
  await page.goto('/');
  await switchTo(page,'settings');
  await page.click('button[data-section="experiments"]');
  const toggle = page.locator('#life-experiment-enabled');
  await toggle.check();
  await expect.poll(async()=> (await (await page.request.get('/api/character-life/status')).json()).enabled).toBe(true);
  await page.locator('#life-open').click();
  await expect(page.locator('#character-life-page h2')).toBeVisible();
  await expect(page.locator('[aria-label="全天精力"] div')).toHaveCount(24);
  await expect(page.locator('[aria-label="全天聊天意愿"] div')).toHaveCount(24);
  await expect(page.getByRole('heading', { name: '实时情绪' })).toBeVisible();
  await expect(page.locator('#life-live').getByRole('meter')).toHaveCount(6);
  const start = page.locator('#life-schedule input[name="start"]');
  const original = await start.inputValue();
  const firstBar = page.locator('[aria-label="全天精力"] div').first();
  const before = await firstBar.getAttribute('title');
  await start.fill('04:00');
  await page.getByRole('button', { name: '保存作息' }).click();
  await expect(page.locator('#life-schedule-status')).toHaveText('已保存');
  await expect(firstBar).not.toHaveAttribute('title', before);
  await start.fill(original);
  await page.getByRole('button', { name: '保存作息' }).click();
  await expect(firstBar).toHaveAttribute('title', before);
  await switchTo(page,'settings');
  await page.click('button[data-section="experiments"]');
  await page.locator('#life-graduate').click();
  await page.locator('[data-confirm-accept]').last().click();
  await expect(page.locator('[data-feature-nav="character-life"]')).toBeVisible();
  await toggle.uncheck();
  await expect.poll(async()=> (await (await page.request.get('/api/character-life/status')).json()).enabled).toBe(false);
  await page.locator('#life-graduate').click();
  await page.locator('[data-confirm-accept]').last().click();
  await expect(page.locator('[data-feature-nav="character-life"]')).toBeHidden();
});
test('窄屏真实页面渲染六维读数、动机强度与关联记录',async ({page})=>{
  await login(page);
  await page.setViewportSize({width:390,height:844});
  await page.clock.install();
  let pleasure = 72;
  await page.route('**/api/character-life/status',route=>route.fulfill({json:{
    enabled:true,rhythm:Array.from({length:24},(_,h)=>30+h),willingness:Array.from({length:24},(_,h)=>20+h),
    profiles:[{role:'茉雪儿',activity:'整理自己的日常',willingness:71,dimensions:{'愉悦':pleasure,'悲伤':20,'愤怒':15,'精力':65,'安全感':80,'孤独感':12},
      goals:[{title:'继续聊约好的剧集',chat:'private:1',strength:85}],events:[{at:Date.now(),kind:'称赞',chat:'private:1'}],reflections:[],
      associations:[{chat:'private:1',actor:'1',memory:'sample-memory-id',count:2}]}]
  }}));
  await page.route('**/api/living-memory/graph?*', route => route.fulfill({ json: {
    nodes: [{id:'rain',type:'entity',label:'打雷'}, {id:'thunder',type:'entity',label:'雷鸣'},
      {id:'person',type:'entity',label:'QQ:42'}, {id:'memory:episode',type:'memory',label:'一起等到雨停'}],
    edges: [{source:'rain',target:'person',type:'陪伴',memoryId:'episode'},
      {source:'thunder',target:'person',type:'陪伴',memoryId:'episode'}]
  } }));
  await page.goto('/');
  await switchTo(page,'character-life');
  await expect(page.locator('#life-live').getByRole('meter')).toHaveCount(7);
  await expect(page.locator('#character-life-page')).toContainText('整理自己的日常');
  const mood = page.getByRole('meter', { name:'愉悦' });
  await expect(mood).toHaveAttribute('aria-valuenow','72');
  const interactions = page.locator('.life-interactions');
  await expect(interactions).not.toHaveAttribute('open');
  await interactions.locator('summary').click();
  await expect(interactions).toHaveAttribute('open', '');
  pleasure = 81;
  await page.clock.fastForward(10500);
  await expect(mood).toHaveAttribute('aria-valuenow','81');
  await expect(interactions).toHaveAttribute('open', '');
  await expect(page.locator('#character-life-page')).toContainText('sample-memory-id');
  await page.selectOption('#life-graph-scope','private:1');
  await expect(page.locator('.life-graph-diagram svg line')).toHaveCount(1);
  await page.locator('[data-life-neighbor]').click();
  await expect(page.locator('.life-graph-detail')).toContainText('一起等到雨停');
  await page.locator('[data-life-explore]').click();
  await expect(page.locator('.life-graph-center')).toHaveText('QQ:42');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
