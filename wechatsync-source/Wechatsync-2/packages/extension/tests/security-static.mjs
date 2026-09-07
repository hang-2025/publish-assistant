import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = await fs.readFile(path.join(root, 'src/content/api.ts'), 'utf8')
const guard = source.indexOf('if (!isTrustedApiEvent(evt)) return')
const parse = source.indexOf('const action = JSON.parse(evt.data)')
const addTask = source.indexOf("action.method === 'addTask'")
const magicCall = source.indexOf("action.method === 'magicCall'")

assert.ok(guard >= 0 && guard < parse, '网页消息必须先校验来源再解析/处理')
assert.ok(parse < addTask && parse < magicCall, '所有写操作必须位于来源校验之后')
assert.match(source, /evt\.source !== window/)
assert.match(source, /https:\/\/www\.wechatsync\.com/)
assert.doesNotMatch(source, /任何页面可调用/)

const assets = await fs.readdir(path.join(root, 'dist/assets'))
const apiBundle = assets.find((name) => /^api\.ts-.*\.js$/.test(name) && !name.includes('loader'))
assert.ok(apiBundle, '构建产物应包含网页 API 桥')
const built = await fs.readFile(path.join(root, 'dist/assets', apiBundle), 'utf8')
assert.match(built, /www\.wechatsync\.com/, '生产构建应保留官方来源白名单')
assert.doesNotMatch(built, /http:\/\/localhost:8080/, '生产构建不得开放 localhost 开发来源')

console.log('SECURITY PASS: page bridge rejects untrusted window/origin before account reads, sync tasks or image uploads; production bundle contains only official origins.')
