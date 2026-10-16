# dsh-fs-extra

**为 DeepSeek Harness 补齐文件工具缺失的删除 / 建目录 / 移动能力。**

DSH 内置的文件工具（`write` / `edit`）只有**写入**能力，没有删除、建目录、移动。
而能删除的 shell 通路（`ops_bash` / `pwsh`）受会话工作区沙箱限制，工作区外一律拒绝。

本插件补上这块，并且**严格遵守会话的沙箱档位**，不做越狱。

---

## 提供的工具

| 工具 | 用途 | 受档位限制 |
|---|---|---|
| `fsx_delete` | 删除文件或目录（目录递归） | ✅ 是 |
| `fsx_mkdir` | 创建目录（可递归多级） | ✅ 是 |
| `fsx_move` | 移动 / 重命名（支持跨盘） | ✅ 是（源和目标都要通过） |
| `fsx_list` | 列目录（含大小与类型） | ❌ 只读 |
| `fsx_policy` | 报告本会话解析到的档位与工作区根 | — 自检用 |

`fsx_delete` 支持 `dryRun`，便于先确认再动手。

---

## 权限模型（重点）

插件在每次调用时读取会话的沙箱档位
（`ctx.get('sandboxPolicy').resolve({ session })`，与 `dsh-ops` 同源），并按档位限制：

| 会话档位 | 插件行为 |
|---|---|
| `danger-full-access` | 允许任意路径 |
| `workspace-write` | **仅允许会话工作区（`workspaceRoot`）子树内**，区外抛错 |
| `read-only` | 写 / 删 / 建 / 移 **全部拒绝** |
| 档位无法确定 | 保守处理，按 `workspace-write` 限制 |

另外内置系统目录黑名单，任何档位下都拒绝操作
`C:\Windows`、`C:\Program Files`、`C:\ProgramData` 等。

**⇒ 把权限调成「工作区内可写」时，模型无法用本插件越狱。**

随时可用 `fsx_policy` 确认当前生效的边界：

```
沙箱档位: workspace-write
工作区根: E:\myproject
⇒ 本插件仅允许 E:\myproject 子树内操作
```

---

## 为什么需要它

一个真实场景（Windows）：

```
权限设为「完全权限」后，逐目录实测：
  ✅ E:\project        可写（已获沙箱授权，有 S-1-4-* ACE）
  ❌ C:\Users\me        拒绝
  ❌ C:\Users\me\Desktop 拒绝
  ❌ D:\               拒绝

⇒ shell 子进程被套了受限令牌（低完整性），只有带沙箱授权项的目录可写
⇒ 而文件工具虽然不受限，却只能写、不能删

结果：删文件 / 建目录 这两件最基础的事，在工作区外做不到。
```

本插件走**进程内 `node:fs`** 通路，与文件工具同级，不受子进程令牌限制，
同时保留沙箱档位的语义。

---

## 安装

### 作为 bundle（推荐，独立于任何注入器）

```powershell
dsh plugin --profile <profile> add "E:\path\to\dsh-fs-extra"
```

或在 profile 的 `package.json` 中加：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-fs-extra"]
    }
  },
  "dependencies": {
    "dsh-fs-extra": "link:E:/path/to/dsh-fs-extra"
  }
}
```

然后重启 DSH。

### 运行时注入（需要 `dsh-super-injector`）

```
dev_inject_plugin {"dir": "E:/path/to/dsh-fs-extra"}
```

---

## 兼容性

- 需要 `@deepseek-ai/dsh-tools`（工具注册）
- 需要 `@deepseek-ai/dsh-sandbox-policy`（档位解析）—— 缺失时会保守降级为工作区限制
- Node.js ≥ 22.19
- 在 DSH `0.2.0-rc.2`（Windows）上开发并实测通过

---

## 工具定义格式说明（给插件作者）

本插件的工具定义形状对齐 `dsh-ops/lib/shells.js`。
注意 `parameters` **必须是完整 JSON Schema**，简写会被拒绝：

```js
// ❌ 错误 —— 会报 'schema must be a JSON Schema of type: "object", got "type: null"'
parameters: { path: { type: 'string', required: true } }

// ✅ 正确
parameters: {
  type: 'object',
  properties: { path: { type: 'string', description: '...' } },
  required: ['path'],
  additionalProperties: false,
}
```

---

## License

MIT
