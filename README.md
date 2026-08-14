# dsh-billing — DeepSeek Harness 实时计费插件

《深入拆解 DeepSeek Harness》随书代码：事件溯源实时计费（峰谷价格表）。账单是"会话日志 + 部署价格表"的纯函数，零上下文注入；Web 客户端右下角的悬浮水满仪表实时显示**当前单个会话**的账单（统计的是当前选中的会话，不是全部会话的费用汇总）。

![悬浮水满账单仪表](assets/demo.png)

## 安装

```sh
git clone <本仓库地址> billing-plugin
cd billing-plugin
npm install
npm run build          # 产出 lib/
npm run build:client   # 产出 lib/client.js（Web 端悬浮仪表）
npm test               # 可选：21 个测试验证环境
```

## 配置

在 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/<你的profile>/`）中加入以下条目（完整示例见 [cordis.yml](cordis.yml)）：

```yaml
- id: billing
  name: dsh-billing
  config:
      currency: CNY
      budget: 0.05                      # 每 session 预算
      prices:
        deepseek-v4-flash:
          offPeak: { inputPerMillion: 1.5, outputPerMillion: 4.5, cacheReadPerMillion: 0.05 }
          peak:    { inputPerMillion: 3.0, outputPerMillion: 9.0, cacheReadPerMillion: 0.10 }
        deepseek-v4-pro:
          offPeak: { inputPerMillion: 4.5, outputPerMillion: 13.5, cacheReadPerMillion: 0.15 }
          peak:    { inputPerMillion: 9.0, outputPerMillion: 27.0, cacheReadPerMillion: 0.30 }
```

然后用下面的命令确认插件已挂载：

```sh
dsh --profile <你的profile> --dump-config   # 插件树中应出现 id: billing
```

### 配置字段说明

| 字段 | 默认值 | 含义 |
|---|---|---|
| `currency` | `CNY` | 币种代码，所有金额均以此显示。 |
| `prices` | `{}` | 按模型 id 的峰谷价格表（见下表）；未配置的模型按 0 计费。 |
| `peakWindows` | `[[9, 12], [14, 18]]` | 峰时窗口，`[start, end)` 整点区间（配置时钟）。 |
| `utcOffsetMinutes` | `480` | 东偏 UTC 分钟数，480 = 北京时间（UTC+8）。 |
| `budget` | 未设置 | 每 session 预算：仅作为账单字段（`budget` / `remaining` / `exhausted`）供 UI 展示，不做任何限制。 |

`prices` 中每个模型的价格桶（`offPeak` 非峰、`peak` 峰时）字段：

| 字段 | 含义 |
|---|---|
| `inputPerMillion` | 每百万输入 token（缓存未命中）价格。 |
| `outputPerMillion` | 每百万输出 token 价格。 |
| `cacheReadPerMillion` | 每百万缓存命中输入 token 价格（省略按 0）。 |
| `cacheWritePerMillion` | 每百万缓存写入 token 价格（省略按 0）。 |
| `effectiveFrom` | 价格表生效时间（Unix 毫秒时间戳），此前的调用按 0 计费，用于提前部署新价格表。 |

## 使用

启动后 Web 客户端右下角出现可拖动的悬浮水满仪表，**只统计当前选中的单个会话**（切换到其他会话后，仪表会实时刷新为该会话的账单，不会累加所有会话的费用）：

- **水满高度**：当前会话费用占预算的百分比；按消耗分四档颜色：绿（<25%）、蓝（25–50%）、橙（50–75%）、红（≥75%）。
- **单击仪表**：展开/收起明细面板，显示当前会话的费用与剩余预算、缓存命中 / 未命中 / 输出占比及 token 数、调用次数。
- **拖动仪表**：移动位置，位置保存在浏览器 localStorage。

未配置 `budget` 时仪表高度恒为 0，明细面板仍显示当前会话的完整费用与 token 分解。

## License

MIT。
