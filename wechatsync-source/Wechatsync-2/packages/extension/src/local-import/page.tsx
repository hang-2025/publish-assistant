import { useEffect, useMemo, useRef, useState } from 'react'
import { preprocessForMultiplePlatforms } from '../lib/content-processor'
import { documentFile, filePath, importDocument, previewDocument, withoutDuplicateTitle, type ImportedArticle } from './importer'

type Platform = { id: string; name: string; homepage: string; capabilities?: string[]; isAuthenticated?: boolean; username?: string }
type Result = { platform: string; platformName?: string; success: boolean; postUrl?: string; error?: string }
const supportedDrafts = new Set(['sohu', 'zhihu', 'juejin', 'csdn', 'bilibili', 'weixin', 'cnblogs', 'cto51', 'imooc', 'oschina', 'segmentfault'])
const send = (message: unknown) => chrome.runtime.sendMessage(message)

export function LocalImport() {
  const [files, setFiles] = useState<File[]>([])
  const [chosen, setChosen] = useState('')
  const [article, setArticle] = useState<ImportedArticle | null>(null)
  const [title, setTitle] = useState('')
  const [removeTitle, setRemoveTitle] = useState(true)
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('仅导入和预览不会上传文件。')
  const [results, setResults] = useState<Result[]>([])
  const operation = useRef(0)
  const active = useRef(false)
  const documents = useMemo(() => files.filter(documentFile), [files])
  const html = useMemo(() => article ? (removeTitle ? withoutDuplicateTitle(article.html, title) : article.html) : '', [article, title, removeTitle])
  const preview = useMemo(() => previewDocument(html), [html])

  useEffect(() => {
    send({ type: 'GET_PLATFORMS' }).then(r => {
      setPlatforms((r.platforms || []).filter((p: Platform) => supportedDrafts.has(p.id)))
    }).catch(e => setError(`无法连接插件后台：${e.message}`))
  }, [])
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (active.current) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  function chooseFiles(next: File[], append = false) {
    if (active.current) return
    if (next.length > 1000) { setError('文件太多，请只选择这一篇文章的发布包。'); return }
    operation.current++
    setFiles(append ? [...files, ...next] : next)
    if (!append) setChosen('')
    setArticle(null); setLoading(false); setResults([]); setError('')
    setStatus('请选择要导入的正文文件，再点击“读取并预览”。不会自动合并多个文章。')
  }
  async function read() {
    const file = documents.find(f => filePath(f) === chosen)
    if (!file) return
    const id = ++operation.current
    setLoading(true); setArticle(null); setError(''); setResults([])
    try {
      const imported = await importDocument(file, files)
      if (id !== operation.current) return
      setArticle(imported); setTitle(imported.title)
      setStatus(`已在本机读取：${file.name}；图片 ${imported.imageCount} 张。尚未上传。`)
    } catch (e) { if (id === operation.current) setError((e as Error).message) }
    finally { if (id === operation.current) setLoading(false) }
  }
  async function checkLogin() {
    setChecking(true); setError('')
    try {
      for (const id of selected) {
        const r = await send({ type: 'CHECK_AUTH', payload: { platformId: id } })
        setPlatforms(prev => prev.map(p => p.id === id ? { ...p, ...r.auth } : p))
      }
    } catch (e) { setError((e as Error).message) }
    finally { setChecking(false) }
  }
  async function sync() {
    if (active.current || !article || article.missing.length || !title.trim() || !selected.length) return
    const names = platforms.filter(p => selected.includes(p.id)).map(p => `${p.name}（${p.username || '账号待核对'}）`).join('、')
    if (!window.confirm(`把《${title}》及 ${article.imageCount} 张图片上传到 ${names} 的草稿箱？\n不会公开发布，也不会登记Excel或移动文件夹。`)) return
    active.current = true; setBusy(true); setError(''); setResults([])
    try {
      for (const id of selected) {
        setStatus(`正在同步到 ${platforms.find(p => p.id === id)?.name}，请保留本页…`)
        const auth = await send({ type: 'CHECK_AUTH', payload: { platformId: id } })
        if (!auth.auth?.isAuthenticated) throw new Error('登录失效，请在正常Chrome中登录目标平台，检查账号后再试。')
        if (auth.auth.username !== platforms.find(p => p.id === id)?.username) throw new Error('登录账号已变化，请重新检查账号并确认后再上传。')
        const response = await send({ type: 'GET_PREPROCESS_CONFIGS', platforms: [id] })
        const platformContents = preprocessForMultiplePlatforms(html, response.configs || {})
        if (!platformContents[id] || (platformContents[id].html.match(/<img\b/gi) || []).length !== article.imageCount) throw new Error('平台格式转换改变了图片数量，已停止上传，请检查文章格式。')
        const reply = await send({ type: 'SYNC_ARTICLE', payload: {
          article: { title: title.trim(), content: html, html, platformContents },
          platforms: [id], source: 'local-import', syncId: `local_${crypto.randomUUID()}`,
        } })
        const next: Result[] = reply.results || []
        if (!next.length) throw new Error(reply.error || '未收到平台确认。请先到草稿箱检查，不要立即重复上传。')
        setResults(prev => [...prev, ...next])
        if (next.some(r => !r.success)) { setStatus('同步失败，已停止后续平台。请先核对草稿箱，避免重复创建。'); return }
      }
      setStatus('草稿同步结束。请打开草稿检查图片、AI声明等设置，再由你点击发布。')
    } catch (e) { setError((e as Error).message); setStatus('已停止。结果不确定时请先检查草稿箱，不自动重试。') }
    finally { active.current = false; setBusy(false) }
  }
  return <main>
    <header><small>WECHATSYNC · LOCAL IMPORT</small><h1>把本地文章送到平台草稿箱</h1><p>Word / Markdown / HTML · 图片随正文上传 · 最后发布由你确认</p></header>
    <div className="layout"><section className="controls">
      <h2>1. 选择文件</h2>
      <fieldset disabled={busy || loading}>
        <label className="pick">选择文章和图片<input aria-label="选择文章和图片" type="file" multiple accept=".docx,.md,.markdown,.html,.htm,.png,.jpg,.jpeg,.gif,.webp" onChange={e => chooseFiles(Array.from(e.target.files || []))}/></label>
        <label className="pick secondary">选择发布包文件夹<input aria-label="选择发布包文件夹" type="file" {...{ webkitdirectory: '' } as any} multiple onChange={e => chooseFiles(Array.from(e.target.files || []))}/></label>
        <label className="pick secondary">补充本地图片<input type="file" multiple accept=".png,.jpg,.jpeg,.gif,.webp" onChange={e => chooseFiles(Array.from(e.target.files || []), true)}/></label>
        <p className="hint">只读取你选择的文件。MD/HTML请同时选择配图，或直接选择发布包文件夹；Word内嵌图片自动读取。不上传整个文件夹。</p>
        <label>正文文件<select aria-label="正文文件" value={chosen} onChange={e => { setChosen(e.target.value); setArticle(null); setResults([]) }}><option value="">请选择正文（不要选SEO或原文备份，除非它就是正文）</option>{documents.map((f,i) => <option key={`${filePath(f)}_${i}`} value={filePath(f)}>{filePath(f)}</option>)}</select></label>
        <button disabled={!chosen} onClick={read}>{loading ? '正在读取…' : '读取并预览'}</button>
      </fieldset>
      {article && <><h2>2. 核对文章</h2><label>标题<input aria-label="文章标题" disabled={busy} value={title} onChange={e => setTitle(e.target.value)}/></label>
        <label className="check"><input type="checkbox" disabled={busy} checked={removeTitle} onChange={e => setRemoveTitle(e.target.checked)}/>不重复发送正文开头与标题相同的一级标题</label>
        <p>{article.imageCount} 张图片 · 正文不做AI改写</p>
        {article.warnings.map((w,i) => <p className="hint" key={i}>{w}</p>)}
        {!!article.missing.length && <div className="error">有 {article.missing.length} 张图片未找到，暂不能同步。请选择包含配图的发布包或补充图片，再重新读取。网络图片也需先由你下载并选入。<ul>{article.missing.map((s,i) => <li key={i}>{s}</li>)}</ul></div>}
      </>}
      <h2>3. 选择目标平台</h2><p className="hint">本地试用入口仅开放已核对草稿路径的平台。头条号已进入受保护草稿验收，网易仍为草稿流程模拟，小红书尚未接入；官网与原百家号流程不变。</p>
      <fieldset disabled={busy || checking} className="platforms">{platforms.map(p => <label className="check" key={p.id}><input type="checkbox" checked={selected.includes(p.id)} onChange={() => setSelected(prev => prev.includes(p.id) ? prev.filter(id => id !== p.id) : [...prev, p.id])}/><span>{p.name}<small>{p.isAuthenticated ? `已登录：${p.username || '请核对账号'}` : '请检查登录'}</small></span><a href={p.homepage} target="_blank" rel="noreferrer">后台</a></label>)}</fieldset>
      <button className="secondary" disabled={!selected.length || checking || busy} onClick={checkLogin}>{checking ? '检查中…' : '检查所选平台登录状态'}</button>
      <button disabled={busy || checking || loading || !article || !!article.missing.length || !title.trim() || !selected.length || selected.some(id => !platforms.find(p => p.id === id)?.isAuthenticated)} onClick={sync}>{busy ? '同步中，请勿关闭' : '确认并同步到草稿'}</button>
      <p className="hint">请先检查登录账号。逐个平台处理，失败即停，不自动重复上传。</p>
    </section><section className="preview"><h2>文章预览</h2><p role="status">{status}</p>{error && <p role="alert" className="error">{error}</p>}
      {article ? <><h2>{title}</h2><iframe title="本地文章预览" sandbox="" srcDoc={preview}/></> : <div className="empty">选择一个正文文件，图片会按正文中的原位置显示。</div>}
      {results.map((r,i) => <div className={r.success ? 'result' : 'error'} key={i}>{r.platformName || r.platform}：{r.success ? '已保存草稿（尚未发布）' : `失败：${r.error}`}{r.success && /^https?:\/\//i.test(r.postUrl || '') && <a target="_blank" rel="noreferrer" href={r.postUrl}>打开检查</a>}</div>)}
    </section></div>
  </main>
}
