import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const root = path.dirname(fileURLToPath(import.meta.url))
const requireCore = createRequire(path.join(root,'packages/core/package.json'))
const JSZip = requireCore('jszip')
const out = path.resolve(root,'../../outputs/wechatsync-local-20260903')
await fs.mkdir(out,{recursive:true})
await fs.cp(path.join(root,'packages/extension/dist'),path.join(out,'安装插件'),{recursive:true})
await fs.copyFile(path.join(root,'LOCAL-IMPORT-说明.md'),path.join(out,'安装与使用说明.md'))
await fs.copyFile(path.join(root,'LICENSE'),path.join(out,'安装插件/LICENSE'))
const buildZip = new JSZip()
const sourceZip = new JSZip()
async function addTree(zip,dir,base,source=false) {
  for(const entry of await fs.readdir(dir,{withFileTypes:true})) {
    if(['node_modules','.git','dist'].includes(entry.name) || (source && /\.png$/.test(entry.name) && entry.name==='local-import-preview.png')) continue
    const filename = path.join(dir,entry.name)
    if(entry.isDirectory()) await addTree(zip,filename,base,source)
    else zip.file(path.relative(base,filename).replaceAll('\\','/'),await fs.readFile(filename))
  }
}
await addTree(buildZip,path.join(out,'安装插件'),out)
buildZip.file('安装与使用说明.md',await fs.readFile(path.join(out,'安装与使用说明.md')))
await fs.writeFile(path.join(out,'文章同步助手-本地导入试用版.zip'),await buildZip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}))
await addTree(sourceZip,root,root,true)
await fs.writeFile(path.join(out,'对应源码-GPL3.zip'),await sourceZip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}))
console.log(out)
