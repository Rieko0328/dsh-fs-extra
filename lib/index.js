/**
 * @dsh-external/dsh-fs-extra — 补齐 DSH 文件工具缺失的能力。
 *
 * 背景：DSH 的文件工具（write/edit）只有写入能力，没有删除/建目录/移动；
 *       而 shell 通路（ops_bash / pwsh）受会话工作区沙箱限制，工作区外删不掉。
 *       本插件走进程内 fs 通路，补上删除/建目录/移动/列目录。
 *
 * ★ 权限边界（重要）：
 *   本插件【遵守会话的 sandbox 档位】，不做越狱：
 *     danger-full-access → 允许任意路径
 *     workspace-write    → 只允许会话工作区内（workspaceRoot 子树）
 *     read-only          → 一切写/删/建/移都拒绝
 *     档位无法确定时     → 保守处理，按 workspace-write 限制
 *   依据: ctx.get('sandboxPolicy').resolve({ session }) —— 与 dsh-ops 同源。
 *
 * 工具定义形状对齐 dsh-ops/lib/shells.js。
 */
import fs from 'node:fs'
import path from 'node:path'

export const name = "dsh-fs-extra"
export const inject = ['tools']

const SENSITIVE = [
  'c:\\windows', 'c:\\program files', 'c:\\program files (x86)',
  'c:\\programdata', '\\system volume information', '$recycle.bin',
]

/** 从工具执行上下文解析本会话的沙箱档位与工作区根。 */
function resolvePolicy(ctx, exec) {
  try {
    const session = exec?.agent?.session
      ?? exec?.session
      ?? exec?.toolCall?.session
    if (!session) return { mode: 'unknown', root: undefined }
    const policy = ctx.get('sandboxPolicy')?.resolve?.({ session })
    return { mode: policy?.mode ?? 'unknown', root: policy?.workspaceRoot }
  } catch {
    return { mode: 'unknown', root: undefined }
  }
}

function isUnder(child, parent) {
  if (!parent) return false
  const a = path.resolve(child).toLowerCase()
  const b = path.resolve(parent).toLowerCase()
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
}

/**
 * 校验目标路径：先查系统目录黑名单，再按会话档位查工作区边界。
 * @param writer true 表示这是写/删/建/移（受档位限制）；false 表示只读。
 */
function guard(ctx, exec, target, isWrite) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new Error('invalid path: expected a non-empty string')
  }
  const abs = path.resolve(target)
  const lower = abs.toLowerCase()

  for (const s of SENSITIVE) {
    if (lower === s || lower.startsWith(s + '\\')) throw new Error(`拒绝操作系统目录: ${abs}`)
  }

  if (!isWrite) return abs

  const { mode, root } = resolvePolicy(ctx, exec)
  if (mode === 'danger-full-access') return abs
  if (mode === 'read-only') throw new Error(`本会话为 read-only，拒绝修改: ${abs}`)
  if (mode === 'workspace-write') {
    if (isUnder(abs, root)) return abs
    throw new Error(`本会话为 workspace-write，仅允许会话工作区内: ${root}（拒绝 ${abs}）`)
  }
  // 档位未知 → 保守：按 workspace-write 处理
  if (root && isUnder(abs, root)) return abs
  throw new Error(`无法确定本会话的沙箱档位，保守拒绝工作区外操作: ${abs}`)
}

function countFiles(dir) {
  let n = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      n++
      if (e.isDirectory()) n += countFiles(path.join(dir, e.name))
    }
  } catch { /* ignore */ }
  return n
}

const OUT = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

export function apply(ctx, config) {
  ctx.effect(() => ctx.tools.register({
    name: 'fsx_delete',
    description: '删除文件或目录（递归）。遵守会话权限档位：完全权限可任意位置，工作区内可写仅限工作区。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要删除的文件或目录绝对路径。' },
        dryRun: { type: 'boolean', description: 'true 时只报告将删除什么，不实际删除。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: OUT,
    async execute(args, exec) {
      const abs = guard(ctx, exec, args?.path, true)
      if (!fs.existsSync(abs)) return `不存在: ${abs}`
      const st = fs.lstatSync(abs)
      const kind = st.isDirectory() ? '目录' : '文件'
      if (args?.dryRun === true) {
        const n = st.isDirectory() ? countFiles(abs) : 1
        return `[dry-run] 将删除${kind}: ${abs}（含 ${n} 个条目）`
      }
      fs.rmSync(abs, { recursive: true, force: true })
      return fs.existsSync(abs) ? `❌ 删除后仍存在: ${abs}` : `✅ 已删除${kind}: ${abs}`
    },
  }), '@dsh-external/dsh-fs-extra: fsx_delete')

  ctx.effect(() => ctx.tools.register({
    name: 'fsx_mkdir',
    description: '创建目录（可递归）。遵守会话权限档位。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要创建的目录绝对路径。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: OUT,
    async execute(args, exec) {
      const abs = guard(ctx, exec, args?.path, true)
      if (fs.existsSync(abs)) return `已存在: ${abs}`
      fs.mkdirSync(abs, { recursive: true })
      return fs.existsSync(abs) ? `✅ 已创建目录: ${abs}` : `❌ 创建失败: ${abs}`
    },
  }), '@dsh-external/dsh-fs-extra: fsx_mkdir')

  ctx.effect(() => ctx.tools.register({
    name: 'fsx_move',
    description: '移动或重命名文件/目录（支持跨盘）。遵守会话权限档位（源和目标都要通过）。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源路径。' },
        to: { type: 'string', description: '目标路径。' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    output: OUT,
    async execute(args, exec) {
      const src = guard(ctx, exec, args?.from, true)
      const dst = guard(ctx, exec, args?.to, true)
      if (!fs.existsSync(src)) return `源不存在: ${src}`
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      try {
        fs.renameSync(src, dst)
      } catch {
        fs.cpSync(src, dst, { recursive: true })
        fs.rmSync(src, { recursive: true, force: true })
      }
      return fs.existsSync(dst) && !fs.existsSync(src)
        ? `✅ 已移动: ${src} → ${dst}`
        : `⚠️ 结果不确定: ${src} → ${dst}`
    },
  }), '@dsh-external/dsh-fs-extra: fsx_move')

  ctx.effect(() => ctx.tools.register({
    name: 'fsx_list',
    description: '列目录（含大小与类型）。只读，不受档位限制。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录绝对路径。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: OUT,
    async execute(args, exec) {
      const abs = guard(ctx, exec, args?.path, false)
      if (!fs.existsSync(abs)) return `不存在: ${abs}`
      const rows = fs.readdirSync(abs, { withFileTypes: true }).map((e) => {
        let size = '?'
        try { size = e.isDirectory() ? '<dir>' : String(fs.statSync(path.join(abs, e.name)).size) } catch { /* ignore */ }
        return `${e.isDirectory() ? 'd' : '-'} ${size.padStart(12)}  ${e.name}`
      })
      return `${abs}\n` + rows.join('\n')
    },
  }), '@dsh-external/dsh-fs-extra: fsx_list')

  // 自检工具：报告本会话解析到的档位与工作区根（便于确认边界生效）
  ctx.effect(() => ctx.tools.register({
    name: 'fsx_policy',
    description: '报告本会话当前解析到的沙箱档位与工作区根（用于确认插件是否正确遵守权限）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: OUT,
    async execute(_args, exec) {
      const { mode, root } = resolvePolicy(ctx, exec)
      return `沙箱档位: ${mode}\n工作区根: ${root ?? '(未解析到)'}\n` +
        (mode === 'danger-full-access'
          ? '⇒ 本插件允许任意路径操作'
          : mode === 'workspace-write'
            ? `⇒ 本插件仅允许 ${root} 子树内操作`
            : mode === 'read-only'
              ? '⇒ 本插件的写/删/建/移全部拒绝'
              : '⇒ 档位未知，保守按 workspace-write 处理')
    },
  }), '@dsh-external/dsh-fs-extra: fsx_policy')
}
