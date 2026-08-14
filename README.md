# dsh-billing — DeepSeek Harness 实时计费插件

《深入拆解 DeepSeek Harness》第 11–15 章随书代码：事件溯源实时计费（峰谷价格表），纯统计服务零上下文注入，右下角悬浮水满仪表实时显示账单。

## 效果图

![悬浮水满账单仪表](assets/demo.png)

## 安装

```sh
git clone <本仓库地址> billing-plugin
cd billing-plugin
npm install
npm run build        # tsc 产出 lib/
npm test             # 可选：21 个测试验证环境
```

## 配置

在 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/<你的profile>/`）里加入（完整示例见 [cordis.yml](cordis.yml)）：

```yaml
- id: billing
  name: dsh-billing
  config:
      currency: CNY
      budget: 0.05                      # 每 session 预算：仅作账单字段供 UI 展示
      prices:
        deepseek-v4-flash:
          offPeak: { inputPerMillion: 1.5, outputPerMillion: 4.5, cacheReadPerMillion: 0.05 }
          peak:    { inputPerMillion: 3.0, outputPerMillion: 9.0, cacheReadPerMillion: 0.10 }
        deepseek-v4-pro:
          offPeak: { inputPerMillion: 4.5, outputPerMillion: 13.5, cacheReadPerMillion: 0.15 }
          peak:    { inputPerMillion: 9.0, outputPerMillion: 27.0, cacheReadPerMillion: 0.30 }
      # peakWindows: [[9, 12], [14, 18]]   # 峰时窗口（默认即此，整点 [start, end)）
      # utcOffsetMinutes: 480              # 北京时间 UTC+8（默认即此）
```

然后验证挂载成功：

```sh
dsh --profile <你的profile> --dump-config   # 确认 billing 出现在插件树里
```

### 配置字段

| 字段 | 默认 | 含义 |
|---|---|---|
| `currency` | `CNY` | 币种代码。 |
| `prices` | `{}` | 按模型 id 的 `{ offPeak, peak, effectiveFrom? }`，桶内为每百万 token 价格 `{ inputPerMillion, outputPerMillion, cacheReadPerMillion?, cacheWritePerMillion? }`。缺省模型计零。 |
| `peakWindows` | `[[9, 12], [14, 18]]` | 峰时窗口 `[start, end)`（配置时钟）。 |
| `utcOffsetMinutes` | `480` | 东偏 UTC 分钟数（480 = 北京时间）。 |
| `budget` | 未设 | per-session 预算：仅作账单字段（`budget/remaining/exhausted`）供 UI 展示。 |

## 一键安装配置提示词

把下面整段复制发给你的 AI 助手（Claude Code / Codex 等），它会替你完成安装与配置（把 `<仓库路径>` 和 `<你的profile>` 替换成实际值）：

````markdown
请帮我安装并配置 dsh-billing（DeepSeek Harness 实时计费插件，仓库在 <仓库路径>）：

1. 进入 <仓库路径>，执行 `npm install` 和 `npm run build`，确认产出 lib/ 目录。
2. 编辑 ~/.dsh/profiles/<你的profile>/cordis.patch.yml，追加以下插件条目
   （若文件不存在则创建，保持既有内容不变）：

   - id: billing
     name: dsh-billing
     config:
         currency: CNY
         budget: 0.05
         prices:
           deepseek-v4-flash:
             offPeak: { inputPerMillion: 1.5, outputPerMillion: 4.5, cacheReadPerMillion: 0.05 }
             peak:    { inputPerMillion: 3.0, outputPerMillion: 9.0, cacheReadPerMillion: 0.10 }
           deepseek-v4-pro:
             offPeak: { inputPerMillion: 4.5, outputPerMillion: 13.5, cacheReadPerMillion: 0.15 }
             peak:    { inputPerMillion: 9.0, outputPerMillion: 27.0, cacheReadPerMillion: 0.30 }

3. 执行 `dsh --profile <你的profile> --dump-config`，确认插件树中出现 id: billing。
4. 告诉我结果；如果任何一步失败，贴出完整报错再继续。
````

## License

MIT。

