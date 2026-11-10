# Zlotika collector

Collects publicly visible promotions from Polish retailer websites once a day and writes `out/deals.json` (the app's Deals feed) plus `out/config.json` (the remote off switch).

## Rules this collector follows
- **Server side only:** runs once a day and never from users' phones.
- **robots.txt is obeyed** (`src/http.ts`), with at least 1.5 s between requests and an honest `ZlotikaBot` user agent.
- **No getting around blocks.** A 403, challenge page or CAPTCHA just fails that source. Kaufland, Carrefour, Action and Hebe block bots, so the app offers only their official leaflet links.
- **A failing source keeps yesterday's data**, so one broken site never empties the app.

## Sources (2026-11-10)
| Chain | Source | Items |
|---|---|---|
| Aldi | `aldi.pl/oferty` and next week (Next.js data) | ~60 |
| Rossmann | `rossmann.pl/products/v3/api/Products?Statuses=promotion` (first 8 pages) | ~770 |
| Lidl | `lidl.pl/h/...` category pages (`data-grid-data`), including Lidl Plus conditions | ~220 valid |

Not collected yet:
- **Biedronka:** leaflet images only, so it needs OCR.
- **Dino, Netto:** no shop in Suwałki.

## Run
```bash
npm run collect          # all sources
npm run one -- lidl      # one source
```
Node 24 or newer, with no dependencies. `--max-http-header-size` is raised because Lidl sends very large response headers.

## Turning things off
Edit `config.json` and push. The app picks it up on its next refresh:
```json
{ "collectedEnabled": false, "disabledChains": ["lidl"] }
```

## Schedule
`.github/workflows/collect.yml` runs daily at 04:17 UTC and publishes `out/` to GitHub Pages.
