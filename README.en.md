# dsh-billing — Real-time billing plugin for DeepSeek Harness

Companion code of the book 《深入拆解 DeepSeek Harness》: an event-sourced real-time billing plugin (peak/off-peak price table). The bill is a pure function of the session log plus the deployment price table — no model-context injection; a draggable water-fill gauge in the bottom-right corner of the web client shows the live bill for the **current single session** (it reflects the currently selected session only, not a total across all sessions).

![Floating water-fill bill gauge](assets/demo.png)

## Installation

Download the packaged artifact from GitHub Releases (it contains only the built `lib/` — no source build required), then install it into your dsh deployment:

```sh
# 1. Download the release artifact (replace v0.1.0 with the latest version)
curl -LO https://github.com/imeepos/dsh-billing-plugin/releases/latest/download/dsh-billing-0.1.0.tgz
# 2. Install into the dsh deployment directory (writes the dependency so the cordis loader resolves the plugin)
npm install ./dsh-billing-0.1.0.tgz
```

> Note: if GitHub is unreachable from the target machine (e.g. behind the GFW), copy the tarball from a machine that can reach it instead — the install step itself only needs the local file.

> Installing from source (development): `git clone <repo-url> && cd billing-plugin && npm install && npm run build && npm run build:client && npm install <path>/dsh-billing-0.1.0.tgz`

## Configuration

Append the following to your profile's `cordis.patch.yml` (`~/.dsh/profiles/<your-profile>/`); **you must use the `- insert:` list** — the patch layer only overrides existing entries, top-level entries fail with `entry "billing" not found`:

```yaml
- insert:
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

Then verify the plugin is mounted (an `id: billing` entry should appear under the `# == ...cordis.patch.yml` section):

```sh
dsh --profile <your-profile> --dump-config   # an `id: billing` entry should appear in the plugin tree
```

## One-click install (send to an AI assistant)

Copy the whole block below to any AI assistant (Claude Code / Codex / dsh itself) and it will install and configure the plugin for you (verified on a real server):

````markdown
Please install and configure dsh-billing (the DeepSeek Harness real-time billing plugin):

1. Download the plugin artifact to a temp dir on the target machine:
   curl -LO https://github.com/imeepos/dsh-billing-plugin/releases/latest/download/dsh-billing-0.1.0.tgz
   (If this URL is unreachable, ask me to transfer dsh-billing-0.1.0.tgz to the machine first)

2. Install into the dsh profile directory (e.g. the headless profile):
   cd ~/.dsh/profiles/<your-profile>
   cp /tmp/dsh-billing-0.1.0.tgz .
   npm install ./dsh-billing-0.1.0.tgz
   Check that ~/.dsh/profiles/<your-profile>/package.json now has
   "dsh-billing": "file:dsh-billing-0.1.0.tgz" in dependencies.

3. Edit ~/.dsh/profiles/<your-profile>/cordis.patch.yml and append
   (if the file only contains comments, replace them with the block below;
   the insert-list syntax is mandatory):

   - insert:
       - id: billing
         name: dsh-billing
         config:
           currency: CNY
           budget: 0.05
           prices:
             deepseek-v4-flash:
               offPeak: { inputPerMillion: 1.5, outputPerMillion: 4.5, cacheReadPerMillion: 0.05 }
               peak: { inputPerMillion: 3.0, outputPerMillion: 9.0, cacheReadPerMillion: 0.10 }
             deepseek-v4-pro:
               offPeak: { inputPerMillion: 4.5, outputPerMillion: 13.5, cacheReadPerMillion: 0.15 }
               peak: { inputPerMillion: 9.0, outputPerMillion: 27.0, cacheReadPerMillion: 0.30 }

4. Verify the mount: dsh --profile <your-profile> --dump-config
   An id: billing entry should appear in the plugin tree (sourced from cordis.patch.yml).

5. If step 4 fails with `patch: entry "billing" not found`,
   the entry was not put inside the insert list — go back to step 3.
   If any step fails, paste the full error and I will fix and retry.
````

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
