# dsh-billing — Real-time billing plugin for DeepSeek Harness

Companion code of the book 《深入拆解 DeepSeek Harness》: an event-sourced real-time billing plugin (peak/off-peak price table). The bill is a pure function of the session log plus the deployment price table — no model-context injection; a draggable water-fill gauge in the bottom-right corner of the web client shows the live bill for the **current single session** (it reflects the currently selected session only, not a total across all sessions).

![Floating water-fill bill gauge](assets/demo.png)

## Installation

```sh
git clone <this-repo-url> billing-plugin
cd billing-plugin
npm install
npm run build          # emits lib/
npm run build:client   # emits lib/client.js (web gauge)
npm test               # optional: 21 tests verify the environment
```

## Configuration

Add the following entry to your profile's `cordis.patch.yml` (`~/.dsh/profiles/<your-profile>/`); see [cordis.yml](cordis.yml) for a full example:

```yaml
- id: billing
  name: dsh-billing
  config:
      currency: CNY
      budget: 0.05                      # per-session budget
      prices:
        deepseek-v4-flash:
          offPeak: { inputPerMillion: 1.5, outputPerMillion: 4.5, cacheReadPerMillion: 0.05 }
          peak:    { inputPerMillion: 3.0, outputPerMillion: 9.0, cacheReadPerMillion: 0.10 }
        deepseek-v4-pro:
          offPeak: { inputPerMillion: 4.5, outputPerMillion: 13.5, cacheReadPerMillion: 0.15 }
          peak:    { inputPerMillion: 9.0, outputPerMillion: 27.0, cacheReadPerMillion: 0.30 }
```

Then verify the plugin is mounted:

```sh
dsh --profile <your-profile> --dump-config   # an `id: billing` entry should appear in the plugin tree
```

### Configuration fields

| Field | Default | Meaning |
|---|---|---|
| `currency` | `CNY` | Currency code used for every monetary value. |
| `prices` | `{}` | Per-model peak/off-peak price table (see below); models not listed price at zero. |
| `peakWindows` | `[[9, 12], [14, 18]]` | Peak windows as whole-hour `[start, end)` ranges, in the configured clock. |
| `utcOffsetMinutes` | `480` | Clock offset east of UTC in minutes; 480 = Beijing time (UTC+8). |
| `budget` | unset | Optional per-session spend cap; a statistics field only (`budget` / `remaining` / `exhausted`) for UI display, with no enforcement. |

Price bucket fields inside each model's `prices` entry (`offPeak` outside peak windows, `peak` during them):

| Field | Meaning |
|---|---|
| `inputPerMillion` | Price per million input tokens (cache miss). |
| `outputPerMillion` | Price per million output tokens. |
| `cacheReadPerMillion` | Price per million cache-hit input tokens (omitted prices as zero). |
| `cacheWritePerMillion` | Price per million cache-write tokens (omitted prices as zero). |
| `effectiveFrom` | Unix epoch ms before which this table is not yet in effect (prices zero); deploy new tables ahead of their announced date. |

## Usage

A draggable water-fill gauge appears in the bottom-right corner of the web client once the session starts. It shows statistics for **the currently selected single session only** (switching to another session refreshes the gauge to that session's bill — costs are never summed across sessions):

- **Water level**: percentage of the budget consumed by the current session; four colour tiers: green (<25%), blue (25–50%), orange (50–75%), red (≥75%).
- **Click the gauge**: toggle the detail panel — cost and remaining budget, cache-hit / miss / output shares with token counts, and call count.
- **Drag the gauge**: reposition it; the position is persisted in browser `localStorage`.

Without a configured `budget` the water level stays at 0, but the detail panel still shows the full cost and token breakdown of the current session.

## License

MIT.
