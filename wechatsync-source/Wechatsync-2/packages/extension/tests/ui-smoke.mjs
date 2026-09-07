import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
const server = http.createServer(async (req,res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0]))
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return }
  try {
    const data = await fs.readFile(file)
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream')
    res.end(data)
  } catch { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(0,'127.0.0.1',r))
let browser
try {
  browser = await chromium.launch({channel:'chrome', headless:true})
  const page = await browser.newPage({viewport:{width:1440,height:1050}})
  const errors = []
  page.on('pageerror',e => { errors.push(e.message); console.error('UI ERROR:',e.message) })
  await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:') ? route.continue() : route.abort())
  await page.addInitScript(() => {
    globalThis.sent = []
    globalThis.chrome = {runtime:{sendMessage:async m => {
      sent.push(m)
      if(m.type==='GET_PLATFORMS') return {platforms:[{id:'sohu',name:'搜狐号',homepage:'https://mp.sohu.com'},{id:'zhihu',name:'知乎',homepage:'https://www.zhihu.com'},{id:'netease',name:'网易号'}]}
      if(m.type==='CHECK_AUTH') return {auth:{isAuthenticated:true,username:'本地测试账号'}}
      if(m.type==='GET_PREPROCESS_CONFIGS') return {configs:{[m.platforms[0]]:{outputFormat:'html'}}}
      if(m.type==='SYNC_ARTICLE') return {results:[{platform:m.payload.platforms[0],success:true,draftOnly:true,postUrl:'https://mp.sohu.com/test-draft'}]}
      throw new Error('Unexpected message '+m.type)
    }}}
  })
  await page.goto(`http://127.0.0.1:${server.address().port}/src/local-import/index.html`)
  await page.getByRole('checkbox',{name:/搜狐号/}).waitFor()
  assert.equal(await page.getByText('网易号',{exact:true}).count(),0)
  await page.getByLabel('选择文章和图片').setInputFiles([
    {name:'雷电文章.md',mimeType:'text/markdown',buffer:Buffer.from('# 雷电预警文章\n\n第一段中文正文。\n\n![现场说明](现场.png)\n\n图片下方说明。')},
    {name:'现场.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=','base64')}
  ])
  await page.getByLabel('正文文件').selectOption('雷电文章.md')
  await page.getByRole('button',{name:'读取并预览'}).click()
  await page.getByLabel('文章标题').waitFor()
  assert.equal(await page.getByLabel('文章标题').inputValue(),'雷电预警文章')
  const frame = page.frameLocator('iframe')
  await frame.locator('img').waitFor()
  assert.equal(await frame.locator('img').getAttribute('alt'),'现场说明')
  assert.equal(await frame.locator('h1').count(),0)
  assert.equal(await page.evaluate(() => sent.filter(m=>m.type==='SYNC_ARTICLE').length),0)
  await page.getByLabel('搜狐号').check()
  await page.getByRole('button',{name:'检查所选平台登录状态'}).click()
  await page.getByText('已登录：本地测试账号').waitFor()
  page.once('dialog',d=>d.dismiss())
  await page.getByRole('button',{name:'确认并同步到草稿'}).click()
  assert.equal(await page.evaluate(() => sent.filter(m=>m.type==='SYNC_ARTICLE').length),0)
  page.once('dialog',d=>d.accept())
  await page.getByRole('button',{name:'确认并同步到草稿'}).click()
  await page.getByText('已保存草稿（尚未发布）',{exact:false}).waitFor()
  const requests = await page.evaluate(() => sent.filter(m=>m.type==='SYNC_ARTICLE'))
  assert.equal(requests.length,1)
  assert.deepEqual(requests[0].payload.platforms,['sohu'])
  assert.match(requests[0].payload.article.platformContents.sohu.html,/data:image\/png;base64,/)
  await page.screenshot({path:path.resolve(root,'../local-import-preview.png'),fullPage:true})
  // A new file invalidates old preview; a missing image blocks upload.
  await page.getByLabel('选择文章和图片').setInputFiles({name:'缺图.md',mimeType:'text/markdown',buffer:Buffer.from('# 缺图\n![missing](no.png)')})
  await page.getByLabel('正文文件').selectOption('缺图.md')
  await page.getByRole('button',{name:'读取并预览'}).click()
  await page.getByText('有 1 张图片未找到',{exact:false}).waitFor()
  assert.equal(await page.getByRole('button',{name:'确认并同步到草稿'}).isDisabled(),true)
  assert.deepEqual(errors,[])
  console.log('UI PASS: local file selection, Chinese Markdown + image preview, no upload before confirmation, cancel, draft payload, missing-image block. All platform requests mocked; no account access.')
} finally {
  await browser?.close()
  await new Promise(r => server.close(r))
}
