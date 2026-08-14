# dsh-billing — 实时计费插件（随书代码）

> 《深入拆解 DeepSeek Harness》第 11–15 章的完整可运行代码。这是一个**独立的插件仓库**，刻意**不**集成进官方 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 仓库——它是教材的随书示例，可以独立演进、独立测试。

事件溯源实时计费：`ctx.billing.spend(session)` 把持久化的 `assistant/message` usage 事件按**峰谷价格表**折叠成账单；`billing_status` 工具让模型自查花费（含高峰/空闲拆分）；预算守卫在超支时硬停循环。

## 特性

- **账单 = f(日志, 峰谷价格表, 调用时刻)** —— 分文不存的纯投影：重载、回放、换进程，账单与分桶都分毫不差（「模型可见 ⟺ 已记入日志」）。
- **峰谷计价** —— 每个模型 `{ offPeak, peak }` 两个价格桶，按调用**日志时间**（北京时间，可配时区偏移）落在哪个桶计哪个价；高峰时段默认北京 09:00–12:00、14:00–18:00（右开区间）。
- **三个角色一个插件** —— Service（`ctx.billing`）+ Consumer（`billing_status` 工具）+ Policy（`agent/pre-step` 预算守卫）。
- **配置即策略** —— 价格、峰谷窗口、预算全部来自 `cordis.yml`，代码里零硬编码。
- **独立事实核对** —— `./invariant` 伴生插件用第二份折叠拒绝负 usage 事件。

## 依赖

基于 DeepSeek Harness 的**已发布 npm 包**（`0.1.0-rc.6` 系）：

- `@deepseek-ai/cordis` 4.0.1、`@deepseek-ai/schemastery` 3.18.1
- `@deepseek-ai/dsh-agent` / `dsh-llm` / `dsh-session` / `dsh-tools` / `dsh-invariants`
- 测试另需：`dsh-agent-loop`、`dsh-agent-loop-testkit`、`dsh-system-prompt`、`cordis-plugin-loader`、`cordis-plugin-include`、`vitest`、`typescript`

```sh
npm install
npm test        # 22 个测试：纯函数峰谷分桶 + 真实 agent-loop + 真实 Loader 组合
npm run build   # tsc 产出 lib/
```

## 挂载进 dsh

在任意 profile 的 `cordis.patch.yml` 或你自己的 `cordis.yml` 里加一行（示例见 [cordis.yml](cordis.yml)）：

```yaml
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
```

`dsh --profile <你的profile> --dump-config` 确认这一行出现在插件树里。此后模型随时可调 `billing_status`；累计花费达到 `budget` 时下一步被拒绝，日志里多一条预算耗尽通知。

## 配置字段

| 字段 | 默认 | 含义 |
|---|---|---|
| `currency` | `CNY` | 币种代码。 |
| `prices` | `{}` | 按模型 id 的 `{ offPeak: {…}, peak: {…}, effectiveFrom? }`；桶内为每百万 token 的 `{ inputPerMillion, outputPerMillion, cacheReadPerMillion?, cacheWritePerMillion? }`。缺省模型计零。`effectiveFrom`（Unix 毫秒）是生效门槛：此前的调用计零。 |
| `peakWindows` | `[[9, 12], [14, 18]]` | 整点 `[start, end)` 峰时窗口（配置时钟）；畸形窗口加载即 fail loud。 |
| `utcOffsetMinutes` | `480` | 东偏 UTC 分钟数（480 = 北京 UTC+8，无夏令时）。 |
| `budget` | 未设 | per-session 硬上限；须为正有限数。 |

## 目录结构

```
src/
  types.ts       公开类型（ModelPrice / Bill / byBucket …）
  pricing.ts     纯定价：priceBucket / clockHour / isPeakTime / bucketForTime / priceCall
  fold.ts        纯折叠：applyBillingEvent（逐事件推进，读 event.time 分桶）
  index.ts       BillingService（Service + billing_status 工具 + agent/pre-step 守卫）
  invariant.ts   独立折叠：拒绝负 usage 事件
tests/
  mock-adapter.ts             脚本化 LLM 适配器（vendored，MIT）
  billing.spec.ts             19 个单元测试
  loader-composition.spec.ts  3 个真实 Loader 组合测试
cordis.yml                    挂载示例
```

## 书籍对照

- 设计原理（为什么账单是日志的纯函数）→ 《深入拆解 DeepSeek Harness》第 12 章
- 代码解剖（pricing / fold / service / tool / guard）→ 第 13–14 章
- 挂载与测试证据 → 第 15 章
- 插件分类学（为什么一个插件三种角色）→ 第 8 章

## License

MIT。mock-adapter 改编自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）。
