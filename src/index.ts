/**
 * @dsh-external/dsh-fs-extra — 补齐 DSH 文件工具缺失的能力。
 *
 * 背景：DSH 的文件工具（write/edit）只有【写入】能力，没有删除/建目录/移动；
 *       而 shell 通路（ops_bash / pwsh）受会话工作区沙箱限制，工作区外删不掉。
 *       本插件走【进程内】fs 通路，和文件工具同级，不受 shell 沙箱限制。
 *
 * 规范：资源注册挂 ctx.effect（fiber dispose 自动注销）。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = "dsh-fs-extra"
export const inject = ['tools']

export interface Config {
  /** 是否允许对盘根/系统关键目录操作（默认 false，安全阀）。 */
  allowSystemPaths: boolean
}

export const Config = z.object({
  allowSystemPaths: z.boolean().default(false),
})

const SENSITIVE = [
  'c:\\windows', 'c:\\program files', 'c:\\program files (x86)',
  'c:\\programdata', '\\system volume information', '$recycle.bin',
]

function assertSafe(target: string, allowSystemPaths: boolean): string {
  const abs = path.resolve(target)
  const lower = abs.toLowerCase()
  if (!allowSystemPaths) {
    if (/^[a-z]:\\?$/.test(lower)) throw new Error(`拒绝操作盘根: ${abs}（可用 allowSystemPaths 放开）`)
    for (const s of SENSITIVE) {
      if (lower === s || lower.startsWith(s + '\\')) throw new Error(`拒绝操作系统目录: ${abs}`)
    }
  }
  return abs
}

function render(value: unknown) {
  return [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

export function apply(ctx: Context, config: Config): void {
  const allow = config.allowSystemPaths === true

  // ── fsx_delete：删除文件或目录（目录递归）────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'fsx_delete',
    description: '删除文件或目录（目录递归删除）。用于文件工具无法删除的场景。',
    parameters: {
      path: { type: 'string', required: true, description: '要删除的文件或目录的绝对路径' },
      dryRun: { type: 'boolean', description: '只报告将删除什么，不实际删除' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => render(v) },
    async execute(args: { path: string; dryRun?: boolean }) {
      const abs = assertSafe(args.path, allow)
      if (!fs.existsSync(abs)) return `不存在: ${abs}`
      const st = fs.lstatSync(abs)
      const kind = st.isDirectory() ? '目录' : '文件'
      if (args.dryRun === true) {
        const n = st.isDirectory() ? countFiles(abs) : 1
        return `[dry-run] 将删除${kind}: ${abs}（含 ${n} 个条目）`
      }
      fs.rmSync(abs, { recursive: true, force: true })
      return fs.existsSync(abs) ? `❌ 删除后仍存在: ${abs}` : `✅ 已删除${kind}: ${abs}`
    },
  })), '@dsh-external/dsh-fs-extra: fsx_delete')

  // ── fsx_mkdir：建目录（可递归）───────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'fsx_mkdir',
    description: '创建目录（可递归建多级）。',
    parameters: {
      path: { type: 'string', required: true, description: '要创建的目录绝对路径' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => render(v) },
    async execute(args: { path: string }) {
      const abs = assertSafe(args.path, allow)
      if (fs.existsSync(abs)) return `已存在: ${abs}`
      fs.mkdirSync(abs, { recursive: true })
      return fs.existsSync(abs) ? `✅ 已创建目录: ${abs}` : `❌ 创建失败: ${abs}`
    },
  })), '@dsh-external/dsh-fs-extra: fsx_mkdir')

  // ── fsx_move：移动 / 改名（跨盘也可）────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'fsx_move',
    description: '移动或重命名文件/目录（支持跨盘）。',
    parameters: {
      from: { type: 'string', required: true, description: '源路径' },
      to: { type: 'string', required: true, description: '目标路径' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: unknown) => render(v) },
    async execute(args: { from: string; to: string }) {
      const src = assertSafe(args.from, allow)
      const dst = assertSafe(args.to, allow)
      if (!fs.existsSync(src)) return `源不存在: ${src}`
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      try {
        fs.renameSync(src, dst)
      } catch {
        // 跨盘 rename 会 EXDEV，退回 复制+删除
        fs.cpSync(src, dst, { recursive: true })
        fs.rmSync(src, { recursive: true, force: true })
      }
      return fs.existsSync(dst) && !fs.existsSync(src) ? `✅ 已移动: ${src} → ${dst}` : `⚠️ 结果不确定: ${src} → ${dst}`
    },
  })), '@dsh-external/dsh-fs-extra: fsx_move')
}

function countFiles(dir: string): number {
  let n = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      n++
      if (e.isDirectory()) n += countFiles(path.join(dir, e.name))
    }
  } catch { /* ignore */ }
  return n
}
